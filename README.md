# 文章链接归档网站

当前运行方式为 **Cloudflare Workers + SQLite Durable Objects + Workflows + D1 + R2**。搜索与文章列表使用云端直接请求，正文解析与图片完整性检查也由服务端处理；Browser Run 只用于扫码和人工安全验证。管理员可以配置公众号自动检查、按日期获取历史文章，也可以继续手动提交链接。新文章内容保存后直接由网站展示，不需要提交 Git 或重新部署代码。

## 云端采集管理

进入 `/admin`，使用原有提交管理密码登录。微信登录在管理页提供的云端浏览器中完成，登录数据加密保存；电脑和管理网页无需持续打开。

- **自动检查**：北京时间每天 21:30–23:30，每 5 分钟检查一次，23:30 为最后一轮。仅选择原文首次发布时间在 `[21:30,23:30)` 内、且不属于首次配置基线的文章。只允许一个自动启用的来源；多个来源可以用于手动历史采集。
- **每日一篇**：选定后固定同一篇，当晚更换来源或终止任务不会增加篇数。其他来源仍有未采完整的旧任务时，先完成或终止该任务再更换来源；新增公众号仍可用于历史采集。正文与全部图片保存成功后结束当天监控，网站发布失败只重试同篇。23:30 最后一轮可以完成首次采集，之后不发起新的检查或采集重试。
- **跨日恢复**：未采完整的自动任务在下一窗口优先继续，该晚不再选择新文章。已经采全的文章允许在窗口外继续发布。
- **历史范围**：起止日期使用北京时间，包含结束日；选择今天则截至任务创建时刻。范围创建后固定，暂停或隔日恢复不会扩大范围。单篇失败继续其他文章，分页失败保留原游标；部分失败不会显示全部完成。
- **统一去重**：自动、历史和贴链接共用来源标识、正文及网站地址。手动任务不直接修改自动配额；自动选中已经完成的同篇文章时复用结果，不继续选择第二篇。
- **登录失效**：任务进入待验证状态；管理员重新扫码或处理指定文章的官方验证后继续。保存的登录状态不代表微信永久认可登录。

`ARCHIVE_ENABLED` 控制网站内容和提交接口是否切换到云端数据；`ARCHIVE_AUTO_ENABLED` 单独控制每日定时采集。首次部署先完成数据导入；未添加自动启用且已完成基线的来源时，不会自动采集。来源准备及账号验证通过后，按每日窗口运行。

### 免费方案的定时运行

项目使用 `ARCHIVE_SCHEDULER` 对应的独立 Workflow 保存定时进度，每 5 分钟唤醒一次，不配置 Cron Trigger。实例按 UTC 日期拆分，公众号文章的筛选窗口和管理页日期始终使用北京时间。运行时提前安排下一日实例；关闭电脑或管理网页不会停止已经启动的云端定时任务。

部署流程负责首次启动。管理页显示最近成功检查时间；需要恢复时，登录后点击“启动或恢复定时检查”。这个操作使用受保护的 `POST /api/admin/scheduler/start`，重复操作复用当天实例。普通状态刷新只读记录，不会启动定时器或采集。迟到 5 分钟及以上的旧检查会跳过，不会在恢复后集中补跑；没有执行检查不能解释为公众号没有更新。

此配置以 Workers Free 为前提，不要求升级 Workers Paid。Workflow 负责定时、持久等待和任务编排；SQLite Durable Object 执行图文处理及需要浏览器的管理操作，正文处理不放在 Workflow 的短 CPU 步骤内。免费额度仍有边界：Workflows 每日提供 3,000 个步骤；Browser Run 每日提供 10 分钟浏览器时间、最多 3 个并发浏览器。普通自动采集与历史采集不消耗浏览器时间；扫码和人工安全验证使用浏览器额度。详见 [Workflows 限制](https://developers.cloudflare.com/workflows/reference/limits/)、[Workflows 计费](https://developers.cloudflare.com/workflows/reference/pricing/) 和 [Browser Run 免费额度](https://developers.cloudflare.com/browser-run/pricing/)。

遇到可识别的额度不足，任务显示“等待额度恢复”，保存当前文章、分页位置及最早重试时间。恢复后继续原任务，自动任务不会因此改选第二篇；重试时间在管理页转换为北京时间。R2、D1、网站请求和存储也受各自账号额度约束。

### 开发与验证

```powershell
npm ci
npm test
npm run check
node scripts/configure-session-key.mjs --local
npx wrangler d1 migrations apply ARCHIVE_DB --local
node scripts/import-archive.mjs
npx wrangler d1 execute ARCHIVE_DB --local --file .archive-import/legacy.sql
npm run dev
```

本地配置只使用测试密码，不能提交到仓库；脚本不会覆盖既有 `.dev.vars`。旧文章导入工具只生成 SQL，不执行远端操作，且可重复导入。旧文章 ID、访问地址、正文静态资源和 `STATS_KV` 阅读统计保留。

扫码使用可重连的浏览器默认上下文，断开管理请求不会销毁验证页。文章验证所需的 Cookie、本地存储和 IndexedDB 均在进入原文前恢复；对应兼容代码固定于 Playwright 1.3.6，升级 SDK 时需核对 `src/archive/vendor/` 的来源与恢复测试。

扫码和人工验证创建浏览器前会检查容量，遇临时容量限制单次最多等待 30 秒；每日浏览器时长耗尽则按下一 UTC 日恢复。搜索和列表复用加密保存的微信登录状态，以账号为单位控制请求间隔。正常请求以账号为单位保持至少 10 秒间隔；确认微信限流后至少等待 15 分钟。本地重复请求不延长等待。任务保存最早重试时间，后台持久等待，不前移分页、不消耗文章失败次数。等待时间用于减少无效请求，不代表微信届时必然恢复。

正文由有界静态 HTML/CSS 解析器提取，源页面脚本不会执行。PNG、JPEG、GIF、WebP 图片分别下载并完整解码，动画逐帧检查；每图由独立 Durable Object 处理。AVIF、APNG 和低位深交错 PNG 暂不支持完整校验，遇到时明确保留为未完成。

指定文章经人工验证后，已验证正文以精确地址和当前登录版本加密保存，24 小时内可供同篇挑战恢复使用。采集仍须重新下载、解码并保存全部图片，验证正文快照不代表采集完成。

`ARCHIVE_BROWSER_DAILY_BUDGET_SECONDS` 默认部署值为 `600`。新建浏览器被拒绝后，仅当近期正常或空闲关闭的会话在当天 UTC 日期内已达到此预算，才暂停至下一个 UTC 日期；这项保守运行预算不是 Cloudflare 完整计费用量。无法核实的历史或基础设施失败会话不计入预算。调整套餐后应同步调整此值，`0` 表示停用项目预算检查。

### 云端部署

所需资源在 `wrangler.toml` 中声明：`ARCHIVE_DB`、`ARCHIVE_BUCKET`、`ARCHIVE_BROWSER`、`ARCHIVE_EXECUTOR`、`ARCHIVE_WORKFLOW`、`ARCHIVE_SCHEDULER`。保留已有的 `SUBMIT_PASSWORD` 和统计配置。

```powershell
npx wrangler login
node scripts/configure-session-key.mjs
npx wrangler d1 migrations apply ARCHIVE_DB --remote
node scripts/import-archive.mjs
npx wrangler d1 execute ARCHIVE_DB --remote --file .archive-import/legacy.sql
npm run check
npm run deploy
```

会话密钥脚本通过标准输入配置加密密钥，不显示密钥，并保留已存在的密钥。R2 需由账号先在 Cloudflare 控制台启用。正文和图片必须全部写入并校验后才标为公开可见；私有登录对象不能通过网站媒体接口读取。

上线验收需要用真实账号确认：目标公众号搜索、历史分页、真实发布时间、正文及全部图片、扫码后恢复和重复发表防护。本期“发表”只指本网站可见，不包含公众号转载发表。Browser Run 的平台能力和单元测试不等于微信实号验收，CSS 背景图、音视频和附件不在当前图文采集范围内。

2026-10-19 本次部署验证：380 项自动化测试通过，已补齐已发表列表的固定请求参数。云端直接搜索及 PNG/JPEG/WebP 解码成功；现有公众号准备任务和历史任务仍收到微信限流，已保留来源与任务进度。来源已添加但基线尚未完成，完整的“发现新文→采集→网站发布”仍未通过实号验收。

持续 `200013` 可能涉及上游接口可用性；[同类项目维护者于 2026-07-30 报告其核心接口关闭](https://github.com/wechat-article/wechat-article-exporter/issues/200)，不能只按短期访问过快处理。微信读书通道也需要独立账号验证，未启用。

候选公开来源：[猫笔刀 RSS](https://wechat2rss.xlab.app/feed/33d986064f59be5263de2ca822fb3e0bdd59eb81.xml)。本次读取到 20 篇，最新为北京时间 2026-10-18 22:37；最新正文解析成功，6 张微信原图共 1,026,615 字节，在 Cloudflare 中全部解码成功。公开源图片代理在 Cloudflare 请求失败，本次使用其对应的微信公开原图完成验证。[提供者说明](https://wechat2rss.xlab.app/deploy/qa)允许 0–24 小时更新延迟，仅抓取最新 20 篇，且只收录群发消息（不包含非群发发表）；这会影响原定当晚完成、远期历史与全部发表文章的覆盖要求，尚未据此改造或切换采集来源。

下面保留原有静态归档脚本及接口的说明，供离线兼容和历史维护参考；云端新文章不经过该构建流程。

## 功能边界

本项目用于归档用户提交的公开文章链接，**优先适配微信公众号文章**，也提供可选的本地监听导入脚本。

旧静态模式不提供微信登录；云端扫码登录流程见上文。

不支持抓取评论。  
不支持抓取微信原文的阅读量、点赞数、在看数。  
站内可选统计的是**本归档站自己的浏览量 / 阅读量**，不是微信官方原文数据。

旧静态模式不会保存微信 Cookie、Token 或登录态。云端采集流程会加密保存登录状态；可选的本地监听脚本只读取本机配置文件，不会把登录态提交到 GitHub 或 Cloudflare。

## 目录结构

```text
.
├── README.md
├── requirements.txt
├── urls.txt
├── data/
│   ├── links.json
│   └── articles-cache.json
├── scripts/
│   ├── wechat_to_site.py
│   └── wechat_account_watcher.py
├── functions/
│   └── api/
│       ├── submit.js
│       ├── visitor-ip-check.js
│       └── stats.js
├── public/
│   ├── _headers
│   ├── index.html
│   ├── submit.html
│   ├── articles/
│   └── assets/
│       └── style.css
└── .github/
    └── workflows/
        └── build.yml
```

Cloudflare Pages 发布目录设置为 `public`。

如果使用 Cloudflare Workers Static Assets 的 Git 同步部署，本仓库也提供了 `wrangler.toml` 和 `worker.js`。静态资源仍从 `public/` 发布，`/api/submit`、`/api/visitor-ip-check` 与 `/api/stats` 都由 Worker 入口转发到同一套后端逻辑。

## 站内浏览量 / 阅读量统计

项目支持一套**站内自建**的轻量统计：

- 首页显示站点累计 **PV（浏览量）** 与 **今日 UV（按天去重访客）**
- 文章详情页显示该文章的累计 **阅读量**
- 统计口径只覆盖首页和文章详情页，不统计提交页与访客 IP 工具页
- 默认忽略明显机器人访问和预取 / 预渲染请求，尽量减少统计污染
说明：

- 这里统计的是**本归档站自己的访问数据**，不是微信原文后台数据。
- UV 基于站点一方匿名 cookie 按天去重，不读取微信登录态。
- 统计存储依赖 Cloudflare KV，绑定名为 `STATS_KV`。
- 统计接口会尽量忽略明显 bot 和 prefetch / prerender 请求。

## 本地运行

安装依赖：

```bash
python -m pip install -r requirements.txt
```

生成静态网站：

```bash
python scripts/wechat_to_site.py
```

生成脚本默认复用 `data/articles-cache.json` 里已有的成功抓取结果，只抓取新增链接或尚未成功归档的链接。需要强制全量重新抓取时运行：

```bash
REFETCH_ALL=1 python scripts/wechat_to_site.py
```

生成结果位于 `public/`。可以直接打开 `public/index.html` 查看归档首页。

> 维护约定：`public/` 下的 HTML、CSS 和 `_headers` 是部署产物/静态资源，页面内容主要由 `scripts/wechat_to_site.py` 生成。完整文章抓取缓存保存在 `data/articles-cache.json`，不会再发布到 `public/data/articles.json`。

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

## 提交接口防护建议

`/api/submit` 会在校验管理密码后更新 GitHub 仓库中的 `data/links.json`。除设置强密码外，建议在 Cloudflare 侧为该路径增加至少一种外层保护：

- WAF / Rate Limiting：限制同一 IP 对 `/api/submit` 的请求频率，尤其是 401 响应较多的请求。
- Turnstile：如果后续配置 `TURNSTILE_SECRET_KEY`，可在服务端增加 token 校验。
- Cloudflare Access：如果只有少数管理员使用，可直接把 `/submit` 和 `/api/submit` 放到 Access 后面。

## Cloudflare Pages 部署

Cloudflare Pages 是本项目的**唯一构建器**：每次向仓库 push 时，它会拉取代码、运行 `scripts/wechat_to_site.py` 生成静态页面，再发布 `public/` 目录。

推荐设置：

```text
Framework preset:        None
Build command:           pip install -r requirements.txt && python scripts/wechat_to_site.py
Build output directory:  public
```

构建期环境变量（Production 与 Preview 都要配）：

```text
SITE_BASE_URL    站点的绝对地址，例如 https://maobidao.com
PYTHON_VERSION   3.11
```

- `SITE_BASE_URL`：用于生成页面的 `canonical`、Open Graph `og:url` 与 JSON-LD 结构化数据里的绝对链接。**不配置时页面仍可正常工作**，只是省略这些绝对 URL（优雅降级）。
- `PYTHON_VERSION`：Cloudflare Pages 据此安装对应 Python，再由 `pip install -r requirements.txt` 装好构建依赖。

### GitHub Actions 的角色

`.github/workflows/build.yml` 已改为**仅手动触发**（`workflow_dispatch`），不再随 push 自动构建，以避免与 Cloudflare Pages 双重构建。它的用途收窄为：在需要时重新生成并提交文章抓取缓存 `data/articles-cache.json` 回仓库。

由于线上构建在 Cloudflare Pages 进行、缓存不会被自动持久化，新提交的文章会在每次 Cloudflare 构建时被重新抓取一次。如果文章变多导致构建变慢或触发来源站反爬，可手动运行该 workflow 刷新缓存。

保留 `functions/api/submit.js`、`functions/api/visitor-ip-check.js` 和 `functions/api/stats.js`，Cloudflare Pages 会将其作为 Pages Function 暴露为：

```text
POST /api/submit
POST /api/stats
GET /api/stats
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

`worker.js` 会把 `/api/submit`、`/api/visitor-ip-check` 和 `/api/stats` 转发给 `functions/api/` 下的接口，其他路径交给 `public/` 静态资源。

部署后可以访问：

```text
/api/submit
/api/stats
/api/visitor-ip-check?health=1
```

如果 `/api/submit` 返回 `Submit API 已部署，环境变量已配置。`，说明提交通道已生效。  
如果 `/api/stats` 的 `GET` 请求返回 `Stats API 已部署，KV 绑定已配置。`，说明浏览量统计接口与 KV 绑定已生效。  
如果 `/api/visitor-ip-check?health=1` 返回 `Visitor IP Check API 已部署...`，说明访客 IP 检测接口已上线；即使缺少部分 key，接口仍可以返回当前访问者 IP。

## Cloudflare 运行时 Secret / 绑定

按实际部署类型分别配置：

- Cloudflare Pages：在项目设置里配置环境变量 / secrets，并额外添加 KV binding。
- Workers Static Assets：在对应 Worker 的 Variables and Secrets 中配置 secret / 变量，并在 `wrangler.toml` 或控制台里配置 KV binding.

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

另需配置：

```text
STATS_KV (Cloudflare KV binding)
```

说明：

- `GITHUB_TOKEN`：GitHub Personal Access Token，只授予目标仓库 `contents:write` 权限。
- `GITHUB_OWNER`：GitHub 用户名或组织名。
- `GITHUB_REPO`：GitHub 仓库名。
- `GITHUB_BRANCH`：通常是 `main`，未设置时默认使用 `main`。
- `SUBMIT_PASSWORD`：提交页面管理密码。
- `STATS_KV`：Cloudflare KV 绑定，**由统计和访客 IP 检测共用**——保存站点 PV、按日 UV 和文章阅读量，同时缓存访客 IP 的第三方检测结果（默认 1 小时）。`/api/stats` 强依赖此绑定，未绑定时统计接口会返回"配置不完整"；`/api/visitor-ip-check` 不强依赖，缺少时仍可检测，只是每次都实时查询、不走缓存。建议在 Pages 项目里绑定。
- `ABUSEIPDB_API_KEY`：AbuseIPDB 官方 API key。
- `IP2LOCATION_API_KEY`：IP2Location 官方 API key。
- `IPDATA_API_KEY`：ipdata 官方 API key。

`GITHUB_TOKEN`、统计与 IP 缓存共用的 `STATS_KV` 绑定和三方 IP 查询 key 都只在后端运行时使用，不会出现在前端源码中。

如果项目使用 Workers Static Assets，`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH` 已写入 `wrangler.toml`。你至少需要在 Cloudflare Worker 的 Variables and Secrets 中添加 2 个必需 secret：`GITHUB_TOKEN`、`SUBMIT_PASSWORD`。如果你还想启用站内浏览量统计，请额外绑定一个名为 `STATS_KV` 的 Cloudflare KV namespace。如果你还想启用访客 IP 检测，再按需补充 3 个可选 secret：`ABUSEIPDB_API_KEY`、`IP2LOCATION_API_KEY`、`IPDATA_API_KEY`。

这 3 个 IP 检测 key 可以按需逐步补齐：

- 不配置任何 key：仍可显示当前访问者 IP 和大致位置。
- 只配置部分 key：已配置的检测项正常返回，未配置项显示“未配置”。
- 全部配置：滥用、家宽、风险三项都会完整检测。

## Cloudflare KV 统计配置

无论你使用 Cloudflare Pages 还是 Workers Static Assets，都需要额外准备一个 KV namespace 用于统计存储：

- 绑定名固定为 `STATS_KV`
- 用于保存站点累计 PV、按日 UV 和文章阅读量，以及匿名访客去重标记
- 当前口径是**按日 UV**，不是累计 UV
- 默认忽略明显机器人流量和 prefetch / prerender 请求，尽量减少统计污染

### 实际操作步骤

#### 方案 A：Cloudflare Pages

1. 进入 Cloudflare 控制台。
2. 打开 **Storage & Databases** → **KV**。
3. 创建一个新的 KV namespace，例如命名为 `maobidao-stats`。
4. 打开你的 Pages 项目 → **Settings** → **Bindings**。
5. 新增一个 **KV namespace binding**：
   - Variable name / Binding name：`STATS_KV`
   - Namespace：选择刚才创建的 KV namespace
6. 确认项目里原本的环境变量 / secrets 也都已配置：
   - `GITHUB_TOKEN`
   - `GITHUB_OWNER`
   - `GITHUB_REPO`
   - `GITHUB_BRANCH`
   - `SUBMIT_PASSWORD`
7. 重新部署一次 Pages 项目。
8. 部署完成后访问：
   - `https://你的域名/api/stats`
9. 如果返回 `Stats API 已部署，KV 绑定已配置。`，说明统计接口已经可用。
10. 再打开首页和任意文章页，确认：
    - 首页能显示“站点浏览量”和“今日访客”
    - 文章页能显示“阅读量”

#### 方案 B：Workers Static Assets

1. 进入 Cloudflare 控制台。
2. 打开 **Storage & Databases** → **KV**。
3. 创建一个新的 KV namespace，例如命名为 `maobidao-stats`。
4. 记下这个 namespace 的正式 id；如果你区分预览环境，也同时记下 preview id。
5. 打开项目根目录的 `wrangler.toml`，把下面占位值换成真实值：

```toml
[[kv_namespaces]]
binding = "STATS_KV"
id = "你的正式 namespace id"
preview_id = "你的 preview namespace id"
```

6. 确认 Worker 运行时 secret / 变量已配置：
   - `GITHUB_TOKEN`
   - `SUBMIT_PASSWORD`
   - 按需配置 `ABUSEIPDB_API_KEY`、`IP2LOCATION_API_KEY`、`IPDATA_API_KEY`
7. 重新部署 Worker。
8. 部署完成后访问：
   - `https://你的域名/api/stats`
9. 如果返回 `Stats API 已部署，KV 绑定已配置。`，说明统计接口已经可用。
10. 再打开首页和任意文章页，确认：
    - 首页能显示“站点浏览量”和“今日访客”
    - 文章页能显示“阅读量”

Workers Static Assets 可以直接在 `wrangler.toml` 的 `[[kv_namespaces]]` 中填写真实 namespace id；
Cloudflare Pages 则需要在项目设置里添加同名 KV binding：`STATS_KV`。

接口行为：

- `POST /api/stats`：写入一次访问并返回最新统计值
- `GET /api/stats`：检查统计接口和 KV 绑定是否已经配置完成
- `GET /api/stats` 的返回里会说明当前 UV 口径、时区，以及是否启用了 bot / prefetch 过滤

## 访问 IP 检测工具

访问：

```text
/visitor-ip
```

页面会在你点击按钮后请求 `/api/visitor-ip-check`，读取当前访问者公网 IP，并调用以下三方服务。同时页面会加载 `iplark.com` iframe 作为人工复核入口；如果对方站点不允许嵌入，可以点击页面上的按钮在新窗口打开。

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
- 浏览器、操作系统、User-Agent、语言、时区、屏幕、Cookie、DNT、WebRTC 可用性等浏览器本地环境信息
- 当前连接使用的是 IPv4 还是 IPv6（简单版，仅根据本次访问 IP 判断）
- WebRTC ICE 候选暴露检测（默认不配置 STUN 服务器，不额外连接第三方检测服务）
- 三个来源各自的状态、摘要与关键字段

页面也提供“开始检测”按钮；只有点击后才会向第三方服务发起查询并加载 `iplark.com` 复核页面。浏览器本地环境信息只在页面内渲染，不会额外发送给上述 IP 检测 API；WebRTC 检测只读取本地 ICE 候选，不使用公共 STUN 服务器。

> 注意：
> 点击检测后，当前访问者公网 IP 会被发送到上述第三方服务查询安全信息，并会加载 `iplark.com` 复核页面。请确保这符合你的站点使用场景和隐私预期。

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

单篇文章抓取失败不会影响其他文章。失败原因会写入 `data/articles-cache.json`，但首页只展示成功归档的文章。微信公众号页面可能因公开访问限制、临时网络问题或页面结构变化导致抓取失败；其他站点也可能因页面结构差异而无法完整提取正文。

### 首页没有文章

检查 `data/links.json` 或 `urls.txt` 是否包含 `http://` 或 `https://` 开头的链接，然后重新运行：

```bash
python scripts/wechat_to_site.py
```

### 首页 IP 检测全部失败

先访问 `/api/visitor-ip-check?health=1`，确认接口已部署。然后看返回里的 `missing_provider_keys`：

- 如果有值，说明只是对应检测 key 还没配，页面仍然可以显示当前访问者 IP。
- 如果为空但检测仍失败，再分别检查三家 key 是否有效、额度是否用尽，以及目标运行环境是否允许访问外部 API。

