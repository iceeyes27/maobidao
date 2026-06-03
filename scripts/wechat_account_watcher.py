#!/usr/bin/env python3
"""Poll a WeChat account history endpoint and submit newly found article links."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "wechat_watcher.local.json"
DEFAULT_STATE = ROOT / ".wechat_watcher_state.json"
WECHAT_PREFIX = "https://mp.weixin.qq.com/"
MAX_SUBMIT_LINKS = 50


def now_string() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")


def load_json_file(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON file: {path} ({exc})") from exc


def write_json_file(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_headers(headers: dict[str, Any]) -> dict[str, str]:
    return {str(key): str(value) for key, value in headers.items() if value is not None}


def update_query(url: str, values: dict[str, Any]) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    for key, value in values.items():
        query[key] = str(value)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def decode_wechat_url(url: str) -> str:
    value = html.unescape(str(url or "")).replace("\\/", "/").strip()
    if value.startswith("http://mp.weixin.qq.com/"):
        value = "https://" + value.removeprefix("http://")
    return value if value.startswith(WECHAT_PREFIX) else ""


def extract_from_app_msg(info: dict[str, Any]) -> list[str]:
    links = []
    content_url = decode_wechat_url(info.get("content_url", ""))
    if content_url:
        links.append(content_url)

    for item in info.get("multi_app_msg_item_list", []) or []:
        if isinstance(item, dict):
            item_url = decode_wechat_url(item.get("content_url", ""))
            if item_url:
                links.append(item_url)

    return links


def extract_links_from_general_msg_list(value: Any) -> list[str]:
    if not value:
        return []

    if isinstance(value, str):
        value = value.replace("\\/", "/")
        data = json.loads(value)
    elif isinstance(value, dict):
        data = value
    else:
        return []

    links = []
    for item in data.get("list", []) or []:
        if not isinstance(item, dict):
            continue
        app_msg = item.get("app_msg_ext_info")
        if isinstance(app_msg, dict):
            links.extend(extract_from_app_msg(app_msg))

    return links


def extract_links(payload: Any) -> list[str]:
    links = []

    if isinstance(payload, dict):
        links.extend(extract_links_from_general_msg_list(payload.get("general_msg_list")))
    elif isinstance(payload, str):
        matches = re.findall(r'"content_url"\s*:\s*"([^"]+)"', payload)
        links.extend(decode_wechat_url(match) for match in matches)

    seen = set()
    output = []
    for link in links:
        if link and link not in seen:
            seen.add(link)
            output.append(link)
    return output


def fetch_history_page(session: requests.Session, url: str, headers: dict[str, str], timeout: int) -> dict[str, Any]:
    response = session.get(url, headers=headers, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("WeChat history response is not a JSON object")
    base_resp = data.get("base_resp") if isinstance(data, dict) else None
    ret = base_resp.get("ret") if isinstance(base_resp, dict) else data.get("ret")
    if ret not in (None, 0, "0"):
        message = base_resp.get("err_msg") if isinstance(base_resp, dict) else data.get("errmsg", "")
        raise RuntimeError(f"WeChat history request failed: ret={ret} {message}".strip())
    return data


def submit_links(submit_url: str, password: str, links: list[str], timeout: int) -> dict[str, Any]:
    response = requests.post(
        submit_url,
        json={"password": password, "links": links},
        timeout=timeout,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"success": False, "message": response.text}

    if response.status_code >= 400 or not data.get("success"):
        message = data.get("message") or f"HTTP {response.status_code}"
        raise RuntimeError(f"Submit failed: {message}")
    return data


def discover_links(config: dict[str, Any]) -> list[str]:
    profile_url = config["profile_ext_url"]
    headers = normalize_headers(config.get("headers", {}))
    max_pages = int(config.get("max_pages", 1))
    timeout = int(config.get("timeout_seconds", 20))
    pause_seconds = float(config.get("page_pause_seconds", 1))

    session = requests.Session()
    offset = None
    links = []

    for page_index in range(max_pages):
        page_url = profile_url if offset is None else update_query(profile_url, {"offset": offset})
        data = fetch_history_page(session, page_url, headers, timeout)
        links.extend(extract_links(data))

        next_offset = data.get("next_offset")
        if next_offset in (None, "", offset):
            break
        offset = next_offset

        if page_index + 1 < max_pages:
            time.sleep(pause_seconds)

    seen = set()
    output = []
    for link in links:
        if link not in seen:
            seen.add(link)
            output.append(link)
    return output


def run_once(config: dict[str, Any], state_path: Path) -> int:
    state = load_json_file(state_path, {"seen_links": []})
    seen_links = set(state.get("seen_links", []))

    links = discover_links(config)
    new_links = [link for link in links if link not in seen_links]
    if not new_links:
        print(f"{now_string()} no new links")
        return 0

    submit_url = config["submit_url"]
    submit_password = config["submit_password"]
    timeout = int(config.get("timeout_seconds", 20))

    submitted = 0
    for start in range(0, len(new_links), MAX_SUBMIT_LINKS):
        chunk = new_links[start : start + MAX_SUBMIT_LINKS]
        result = submit_links(submit_url, submit_password, chunk, timeout)
        submitted += len(chunk)
        print(f"{now_string()} submitted {len(chunk)} links: {result.get('message', 'ok')}")

    state["seen_links"] = list(dict.fromkeys([*new_links, *state.get("seen_links", [])]))
    state["last_checked_at"] = now_string()
    state["last_submitted_count"] = submitted
    write_json_file(state_path, state)
    return submitted


def require_config(config: dict[str, Any]) -> None:
    required = ["profile_ext_url", "submit_url", "submit_password"]
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise SystemExit(f"Missing config keys: {', '.join(missing)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Watch a WeChat account history request and submit new links.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Path to local config JSON.")
    parser.add_argument("--state", default=str(DEFAULT_STATE), help="Path to local watcher state JSON.")
    parser.add_argument("--once", action="store_true", help="Run one check and exit.")
    args = parser.parse_args()

    config_path = Path(args.config)
    state_path = Path(args.state)
    config = load_json_file(config_path, {})
    require_config(config)

    if args.once:
        run_once(config, state_path)
        return 0

    interval = max(60, int(config.get("interval_seconds", 1800)))
    while True:
        try:
            run_once(config, state_path)
        except Exception as exc:
            print(f"{now_string()} error: {exc}", file=sys.stderr)
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
