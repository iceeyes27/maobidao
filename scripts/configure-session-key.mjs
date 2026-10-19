import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const key = randomBytes(32).toString("base64");
if (process.argv.includes("--local")) {
  await writeFile(new URL("../.dev.vars", import.meta.url), `SUBMIT_PASSWORD="local-integration-only"\nARCHIVE_SESSION_KEY="${key}"\n`, { encoding: "utf8", flag: "wx" });
  console.log("已创建仅供本地验证的配置。");
} else {
  const executable = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  const listing = spawnSync(process.execPath, [fileURLToPath(executable), "secret", "list"], {
    encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  let existing;
  try { existing = JSON.parse(listing.stdout); } catch { throw new Error("无法核实既有配置，未更改会话密钥。"); }
  if (listing.status !== 0 || !Array.isArray(existing)) throw new Error("无法核实既有配置，未更改会话密钥。");
  if (existing.some((item) => item.name === "ARCHIVE_SESSION_KEY")) {
    console.log("会话加密密钥已存在，未更改。");
    process.exit(0);
  }
  const child = spawnSync(process.execPath, [fileURLToPath(executable), "secret", "put", "ARCHIVE_SESSION_KEY"], {
    input: `${key}\n`, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  if (child.status !== 0) {
    console.error("会话加密配置失败，请检查 Cloudflare 登录和连接状态。");
    process.exitCode = 1;
  } else console.log("会话加密密钥已安全配置，未显示密钥内容。");
}
