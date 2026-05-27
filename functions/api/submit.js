const MAX_LINKS_PER_SUBMIT = 50;
const WECHAT_PREFIX = "https://mp.weixin.qq.com/";
const LINKS_PATH = "data/links.json";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeLink(link) {
  return String(link || "").trim();
}

function isValidLink(link) {
  return link.startsWith(WECHAT_PREFIX);
}

function uniqueValidLinks(links) {
  const seen = new Set();
  const output = [];

  for (const item of links) {
    const link = normalizeLink(item);
    if (!link || !isValidLink(link) || seen.has(link)) {
      continue;
    }
    seen.add(link);
    output.push(link);
  }

  return output;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wechat-archive-submit-function",
  };
}

function decodeBase64Utf8(content) {
  const binary = atob(String(content || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function readGithubFile(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${LINKS_PATH}?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(env.GITHUB_TOKEN),
  });

  if (response.status === 404) {
    return { sha: null, data: { links: [] } };
  }

  if (!response.ok) {
    throw new Error("读取链接库失败");
  }

  const file = await response.json();
  const decoded = decodeBase64Utf8(file.content);
  let data;
  try {
    data = JSON.parse(decoded);
  } catch {
    data = { links: [] };
  }

  if (!Array.isArray(data.links)) {
    data.links = [];
  }

  return { sha: file.sha, data };
}

async function writeGithubFile(env, sha, data) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${LINKS_PATH}`;
  const content = encodeBase64Utf8(`${JSON.stringify(data, null, 2)}\n`);
  const body = {
    message: "Add submitted WeChat article links",
    content,
    branch,
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(env.GITHUB_TOKEN),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("更新链接库失败");
  }
}

function validateEnv(env) {
  const required = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "SUBMIT_PASSWORD"];
  return required.every((key) => Boolean(env[key]));
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return jsonResponse({ success: false, message: "只支持 POST 请求。" }, 405);
  }

  if (!validateEnv(env)) {
    return jsonResponse({ success: false, message: "服务端配置不完整。" }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, message: "请求 JSON 格式无效。" }, 400);
  }

  if (payload.password !== env.SUBMIT_PASSWORD) {
    return jsonResponse({ success: false, message: "管理密码错误。" }, 401);
  }

  if (!Array.isArray(payload.links)) {
    return jsonResponse({ success: false, message: "links 必须是数组。" }, 400);
  }

  if (payload.links.length === 0) {
    return jsonResponse({ success: false, message: "请提交至少一个链接。" }, 400);
  }

  if (payload.links.length > MAX_LINKS_PER_SUBMIT) {
    return jsonResponse({ success: false, message: "单次最多提交 50 条链接。" }, 400);
  }

  const links = uniqueValidLinks(payload.links);
  if (links.length === 0) {
    return jsonResponse({ success: false, message: "没有有效的微信公众号文章链接。" }, 400);
  }

  try {
    const { sha, data } = await readGithubFile(env);
    const existingLinks = new Set(
      data.links
        .map((item) => normalizeLink(item && item.url ? item.url : item))
        .filter(Boolean),
    );
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const additions = [];

    for (const link of links) {
      if (existingLinks.has(link)) {
        continue;
      }
      existingLinks.add(link);
      additions.push({
        url: link,
        created_at: now,
        source: "submit_page",
      });
    }

    if (additions.length > 0) {
      data.links.push(...additions);
      await writeGithubFile(env, sha, data);
    }

    return jsonResponse({
      success: true,
      added: additions.length,
      total: data.links.length,
      message: "提交成功，稍后网站会自动更新。",
    });
  } catch {
    return jsonResponse({ success: false, message: "服务端更新失败，请稍后重试。" }, 500);
  }
}
