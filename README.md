# 微信公众号文章链接归档网站

这是一个部署在 Cloudflare Pages 上的静态归档网站，用于保存用户手动提交的公开微信公众号文章链接，并通过 GitHub Actions 生成静态网页。

## 功能边界

本项目仅用于用户手动提交的公开微信公众号文章链接归档。

不支持自动扫描公众号历史文章。  
不支持模拟微信登录。  
不支持抓取评论。  
不支持抓取阅读量、点赞数、在看数。  
不使用微信私有接口。

本项目不会使用微信 Cookie、Token 或登录态，也不包含绕过微信反爬或风控的逻辑。

## 目录结构

```text
.
├── README.md
├── requirements.txt
├── urls.txt
├── data/
│   └── links.json
├── scripts/
│   └── wechat_to_site.py
├── functions/
│   └── api/
│       └── submit.js
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

## urls.txt 格式

`urls.txt` 用于手动维护或本地兼容运行。每行一个链接：

```text
https://mp.weixin.qq.com/s/xxxxxx
https://mp.weixin.qq.com/s/yyyyyy
```

空行会被忽略，以 `#` 开头的注释行会被忽略。只有 `https://mp.weixin.qq.com/` 开头的链接会被处理。

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

保留 `functions/api/submit.js`，Cloudflare Pages 会将其作为 Pages Function 暴露为：

```text
POST /api/submit
```

## Pages Functions 环境变量

在 Cloudflare Pages 项目中配置：

```text
GITHUB_TOKEN
GITHUB_OWNER
GITHUB_REPO
GITHUB_BRANCH
SUBMIT_PASSWORD
```

说明：

- `GITHUB_TOKEN`：GitHub Personal Access Token，只授予目标仓库 `contents:write` 权限。
- `GITHUB_OWNER`：GitHub 用户名或组织名。
- `GITHUB_REPO`：GitHub 仓库名。
- `GITHUB_BRANCH`：通常是 `main`，未设置时默认使用 `main`。
- `SUBMIT_PASSWORD`：提交页面管理密码。

`GITHUB_TOKEN` 只在 Pages Function 后端使用，不会出现在前端源码中。

## 通过提交页添加链接

访问：

```text
/submit.html
```

输入管理密码，并在文本框中每行粘贴一个公开微信公众号文章链接。前端会做基础校验和去重，然后调用 `POST /api/submit`。提交成功后，Pages Function 会更新 GitHub 仓库中的 `data/links.json`，随后 GitHub Actions 会重新生成 `public/` 静态网站。

## 常见问题排查

### 提交返回 401

检查 `SUBMIT_PASSWORD` 是否已在 Cloudflare Pages 环境变量中正确配置，并确认页面输入的密码一致。

### 提交返回服务端配置不完整

检查 `GITHUB_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO`、`SUBMIT_PASSWORD` 是否都已配置。`GITHUB_BRANCH` 可选，默认是 `main`。

### 提交成功但网站没有更新

检查 GitHub Actions 是否已启用，查看 `Build WeChat Archive Site` 工作流是否运行成功。还需要确认 Cloudflare Pages 已连接该 GitHub 仓库，并且发布目录是 `public`。

### GitHub API 更新失败

检查 `GITHUB_TOKEN` 是否有目标仓库的 `contents:write` 权限，`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH` 是否正确。

### 某篇文章抓取失败

单篇文章抓取失败不会影响其他文章。失败信息会写入 `public/data/articles.json`，首页也会显示该条链接的失败状态。微信公众号页面可能因公开访问限制、临时网络问题或页面结构变化导致抓取失败。

### 首页没有文章

检查 `data/links.json` 或 `urls.txt` 是否包含 `https://mp.weixin.qq.com/` 开头的链接，然后重新运行：

```bash
python scripts/wechat_to_site.py
```
