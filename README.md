# 文章链接归档网站

这是一个部署在 Cloudflare Pages 上的静态归档网站，用于保存用户手动提交的公开文章链接，并通过 GitHub Actions 生成静态网页。

## 功能边界

本项目用于归档用户提交的公开文章链接，**优先适配微信公众号文章**，也提供可选的本地监听导入脚本。

不支持模拟微信登录。  
不支持抓取评论。  
不支持抓取阅读量、点赞数、在看数。  

核心网站不会保存微信 Cookie、Token 或登录态。可选的本地监听脚本只读取本机配置文件，不会把登录态提交到 GitHub 或 Cloudflare。

## 目录结构

```text
.
├── README.md
├── requirements.txt
├── urls.txt
├── data/
│   └── links.json
├── scripts/
│   ├── wechat_to_site.py
│   └── wechat_account_watcher.py
├── functions/
│   └── api/
│       ├── submit.js
│       └── visitor-ip-check.js
├── public/
│   ├── index.html
│   ├── submit.html
│   ├── articles/
│   ├── assets/
│   │   └── style.css
│   └── data/
│       └── articles.json
└── .github/
    └── workflows/
        └── build.yml
```

Cloudflare Pages 发布目录设置为 `public`。

如果使用 Cloudflare Workers Static Assets 的 Git 同步部署，本仓库也提供了 `wrangler.toml` 和 `worker.js`。静态资源仍从 `public/` 发布，`/api/submit` 与 `/api/visitor-ip-check` 都由 Worker 入口转发到同一套后端逻辑。

## 本地运行

安装依赖：

```bash
python -m pip install -r requirements.txt
```

生成静态网站：

```bash
python scripts/wechat_to_site.py
```

生成结果位于 `public/`。可以直接打开 `public/index.html` 查看归档首页。

## 本地监听公众号新文章

本地监听脚本可以定时读取已登录微信环境中的公众号历史列表请求，发现新文章后自动提交到 `/api/submit`。

复制配置模板：

```powershell
Copy-Item wechat_watcher.example.json wechat_watcher.local.json
```

编辑 `wechat_watcher.local.json`：

- `profile_ext_url`：公众号历史列表的 `mp/profile_ext?action=getmsg` 请求 URL。
- `headers.Cookie`：同一次请求里的 Cookie。
- `submit_url`：站点提交接口，例如 `https://你的域名/api/submit`。
- `submit_password`：提交页管理密码。
- `interval_seconds`：检查间隔，建议不低于 `1800`。

单次检查：

```bash
python scripts/wechat_account_watcher.py --once
```

持续监听：

```bash
python scripts/wechat_account_watcher.py
```

`wechat_watcher.local.json` 和 `.wechat_watcher_state.json` 已加入 `.gitignore`。

## urls.txt 格式

`urls.txt` 用于手动维护或本地兼容运行。每行一个链接：

```text
https://mp.weixin.qq.com/s/xxxxxx
https://example.com/article
```

空行会被忽略，以 `#` 开头的注释行会被忽略。只有 `http://` 或 `https://` 开头的链接会被处理。

## data/links.json 格式

网页提交的链接保存在 `data/links.json`：

```json
{
  "links": [
    {
      "url": "https://mp.weixin.qq.com/s/xxxxxx",
      "created_at": "2026-05-27 12:00:00",
      "source": "submit_page"
    }
  ]
}
```

生成脚本会同时读取 `data/links.json` 和 `urls.txt`，合并去重后生成网站。

## 抓取策略

- 微信公众号文章：优先按微信页面结构提取标题、公众号名、发布时间和正文。
- 其他网页文章：使用通用 HTML 结构做尽力抓取，效果取决于目标站点页面结构。
- 单篇文章抓取失败不会影响其他文章，失败原因会显示在归档页中。

## GitHub Actions

工作流文件位于 `.github/workflows/build.yml`。触发条件：

- push 到 `main` 分支，且 `scripts/**`、`data/**`、`urls.txt`、`public/submit.html` 或工作流文件变更。
- 手动运行 `workflow_dispatch`。

工作流会安装 Python 3.11，执行：

```bash
python scripts/wechat_to_site.py
```

如果 `public/`、`data/` 或 `urls.txt` 有变化，会自动 commit 并 push 回仓库。工作流包含 `if: github.actor != 'github-actions[bot]'`，避免由机器人提交触发循环构建。

## Cloudflare Pages 部署

Cloudflare Pages 推荐设置：

```text
Framework preset: None
Build command: 留空或不使用
Build output directory: public
```

保留 `functions/api/submit.js` 和 `functions/api/visitor-ip-check.js`，Cloudflare Pages 会将其作为 Pages Function 暴露为：

```text
POST /api/submit
GET /api/visitor-ip-check
GET /api/visitor-ip-check?health=1
```

## Cloudflare Workers Static Assets 部署

如果部署后的域名是 `*.workers.dev`，通常说明项目走的是 Workers Static Assets。此时 Cloudflare 会读取仓库根目录的 `wrangler.toml`：

```toml
main = "worker.js"

[assets]
directory = "./public"
binding = "ASSETS"
```

`worker.js` 会把 `/api/submit` 和 `/api/visitor-ip-check` 转发给 `functions/api/` 下的接口，其他路径交给 `public/` 静态资源。

部署后可以访问：

```text
/api/submit
/api/visitor-ip-check?health=1
```

如果 `/api/submit` 返回 `Submit API 已部署，环境变量已配置。`，说明提交通道已生效。  
如果 `/api/visitor-ip-check?health=1` 返回 `Visitor IP Check API 已部署...`，说明访客 IP 检测接口已上线；即使缺少部分 key，接口仍可以返回当前访问者 IP。

## Cloudflare 运行时环境变量

按实际部署类型配置运行时变量：

- Cloudflare Pages：在 Pages 项目的生产环境变量中配置。
- Workers Static Assets：在对应 Worker 的 Variables and Secrets 中配置。

```text
GITHUB_TOKEN
GITHUB_OWNER
GITHUB_REPO
GITHUB_BRANCH
SUBMIT_PASSWORD
ABUSEIPDB_API_KEY
IP2LOCATION_API_KEY
IPDATA_API_KEY
```

说明：

- `GITHUB_TOKEN`：GitHub Personal Access Token，只授予目标仓库 `contents:write` 权限。
- `GITHUB_OWNER`：GitHub 用户名或组织名。
- `GITHUB_REPO`：GitHub 仓库名。
- `GITHUB_BRANCH`：通常是 `main`，未设置时默认使用 `main`。
- `SUBMIT_PASSWORD`：提交页面管理密码。
- `ABUSEIPDB_API_KEY`：AbuseIPDB 官方 API key。
- `IP2LOCATION_API_KEY`：IP2Location 官方 API key。
- `IPDATA_API_KEY`：ipdata 官方 API key。

`GITHUB_TOKEN` 和三方 IP 查询 key 都只在后端运行时使用，不会出现在前端源码中。

如果项目使用 Workers Static Assets，`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH` 已写入 `wrangler.toml`。你至少需要在 Cloudflare Worker 的 Variables and Secrets 中添加 2 个必需 secret：`GITHUB_TOKEN`、`SUBMIT_PASSWORD`。如果你还想启用访客 IP 检测，再按需补充 3 个可选 secret：`ABUSEIPDB_API_KEY`、`IP2LOCATION_API_KEY`、`IPDATA_API_KEY`。

这 3 个 IP 检测 key 可以按需逐步补齐：

- 不配置任何 key：仍可显示当前访问者 IP 和大致位置。
- 只配置部分 key：已配置的检测项正常返回，未配置项显示“未配置”。
- 全部配置：滥用、家宽、风险三项都会完整检测。

## 访问 IP 检测工具

访问：

```text
/visitor-ip
```

页面会在你点击按钮后请求 `/api/visitor-ip-check`，读取当前访问者公网 IP，并调用以下三方服务：

- AbuseIPDB：检查是否存在滥用记录。
- IP2Location：根据线路用途类型判断是否更接近家宽。
- ipdata：检查代理、Tor、匿名网络、数据中心等风险标记。

页面会展示：

- 当前访问 IP
- 访客大致位置（来自 Cloudflare 边缘）
- 运营商、ASN、网络类型
- 是否滥用
- 是否家宽
- IP 风险等级
- Tor / 代理 / 匿名网络 / 数据中心等风险标签
- 三个来源各自的状态、摘要与关键字段

页面也提供“开始检测”按钮；只有点击后才会向第三方服务发起查询。

> 注意：
> 点击检测后，当前访问者公网 IP 会被发送到上述第三方服务查询安全信息。请确保这符合你的站点使用场景和隐私预期。

## 通过提交页添加链接

访问：

```text
/submit.html
```

输入管理密码，并在文本框中每行粘贴一个公开文章链接。前端会做基础校验和去重，然后调用 `POST /api/submit`。提交成功后，Pages Function 会更新 GitHub 仓库中的 `data/links.json`，随后 GitHub Actions 会重新生成 `public/` 静态网站。

## 常见问题排查

### 提交返回 401

检查 `SUBMIT_PASSWORD` 是否已在 Cloudflare Pages 环境变量中正确配置，并确认页面输入的密码一致。

### 访客 IP 检测返回服务端配置不完整

现在缺少三方 key 时，接口不会再因为这个原因整体报错。它会继续返回当前访问者 IP，并把未配置的检测项标记为“未配置”。如果你想启用对应检测，再补上相应 key 即可。

### 访客 IP 检测接口返回 400

通常表示运行环境没有拿到可公开检测的访客公网 IP，例如本地模拟环境、某些代理链或请求头缺失。可以先访问 `/api/visitor-ip-check?health=1` 查看 Worker 实际识别到的 `visitor_ip`。

### 提交返回服务端配置不完整

检查当前生产运行环境是否有 `GITHUB_TOKEN`、`SUBMIT_PASSWORD` 两个 secret。如果是 Pages 部署，还要配置 `GITHUB_OWNER`、`GITHUB_REPO`；如果是 Workers Static Assets，这两个值已由 `wrangler.toml` 提供。

### 提交成功但网站没有更新

检查 GitHub Actions 是否已启用，查看 `Build WeChat Archive Site` 工作流是否运行成功。还需要确认 Cloudflare Pages 已连接该 GitHub 仓库，并且发布目录是 `public`。

### GitHub API 更新失败

检查 `GITHUB_TOKEN` 是否有目标仓库的 `contents:write` 权限，`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH` 是否正确。

### 某篇文章抓取失败

单篇文章抓取失败不会影响其他文章。失败信息会写入 `public/data/articles.json`，首页也会显示该条链接的失败状态。微信公众号页面可能因公开访问限制、临时网络问题或页面结构变化导致抓取失败；其他站点也可能因页面结构差异而无法完整提取正文。

### 首页没有文章

检查 `data/links.json` 或 `urls.txt` 是否包含 `http://` 或 `https://` 开头的链接，然后重新运行：

```bash
python scripts/wechat_to_site.py
```

### 首页 IP 检测全部失败

先访问 `/api/visitor-ip-check?health=1`，确认接口已部署。然后看返回里的 `missing_provider_keys`：

- 如果有值，说明只是对应检测 key 还没配，页面仍然可以显示当前访问者 IP。
- 如果为空但检测仍失败，再分别检查三家 key 是否有效、额度是否用尽，以及目标运行环境是否允许访问外部 API。

