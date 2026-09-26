# lmdsfy — 让我帮你 DeepSeek 一下

把「Let Me Google That For You」的整蛊玩法搬到 DeepSeek 上：生成一个链接甩给伸手党，对方打开后先看到一段「手把手教程」动画，再进入复刻官方风格的聊天页，用流式输出实时回答。

线上地址：https://lmdsfy.awakaze.com

## 两页结构

| 页面 | 文件 | 作用 |
|---|---|---|
| 首页（落地页） | `public/index.html` | 复刻 www.deepseek.com 浅色风格；输入问题 + 勾选参数 → 生成链接（复制 / 预览）；带 `?q=` 时播放「箭头教程」动画 |
| 聊天页 | `public/chat.html` | 复刻 chat.deepseek.com 深色风格；接收参数并发起流式请求，逐字渲染回答 |

## 功能特性

- 流式输出：Worker 直连 DeepSeek `/chat/completions`（`stream: true`），SSE 透传，前端逐字渲染。
- 深度思考：勾选后透传 `?think=1`，启用 `thinking` 模式，思考过程（`reasoning_content`）折叠展示。
- 智能搜索：界面按钮 + `?search=1` 参数已透传到前端；当前后端未真正接入联网搜索（见「已知限制」）。
- 本地历史会话（localStorage）、Markdown 渲染、代码块一键复制。

## 参数说明

| 参数 | 含义 | 取值 |
|---|---|---|
| `q` | 要问的问题 | 任意文本（URL 编码） |
| `think` | 开启深度思考 | `1` 开启，缺省关闭 |
| `search` | 开启智能搜索 | `1` 开启，缺省关闭（当前仅 UI 占位） |

首页生成的链接形如 `?q=xxx&think=1&search=1`；默认两个开关都**不勾选**。

## 技术实现

- 后端：Cloudflare Worker（`worker.js`），路由：
  - `GET /api/chat?q=...` → 调 DeepSeek，SSE 流式回传
  - 其余路径 → 交给静态资源（`public/`，经 `[assets]` 绑定为 `ASSETS`）
- 环境变量（见 `wrangler.toml` 注释）：`DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `SYSTEM_PROMPT` 可选；`DEEPSEEK_API_KEY` 为密钥，务必用 secret 注入。

## 本地运行

```powershell
cd C:\tool\lmgtfy-tools\lmdsfy
npx wrangler secret put DEEPSEEK_API_KEY   # 首次需注入密钥
npx wrangler dev
# 打开 http://localhost:8787 体验两页流程
```

## 部署（Cloudflare Workers + Git 集成）

1. 注入密钥（在 `lmdsfy/` 目录执行）：

```powershell
npx wrangler secret put DEEPSEEK_API_KEY
# 可选：npx wrangler secret put DEEPSEEK_BASE_URL / DEEPSEEK_MODEL / SYSTEM_PROMPT
```

2. 在 Cloudflare 控制台用 Git 集成建 Worker 项目，**Root directory 指向子目录 `lmdsfy`**（`wrangler.toml` 即在该目录内）。

3. 绑定自定义域名 `lmdsfy.awakaze.com`（Cloudflare 会自动建 DNS 记录、签发证书）。

4. 之后每次 `git push` 到 main 触发自动部署。

> 注意：本仓库一次 push 会同时触发 lmbtfy / lmgtfy 两个 Pages 及本 Worker 的自动部署，为省部署次数，仅在用户明确要求时才 push（见根目录 `agent.md`）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | — | DeepSeek API 密钥（secret 注入） |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | API 基地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-flash` | 模型名 |
| `SYSTEM_PROMPT` | 否 | 内置中文助手提示词 | 系统提示词 |

## 已知限制 / 待办

- **智能搜索未真正接入**：DeepSeek API 无内置联网搜索，需通过 Function Calling 集成第三方搜索 API（如 Bing / Serper）后，`search` 参数才会真正生效。当前 `?search=1` 仅切换前端按钮状态。
- **免费档超时**：Cloudflare 免费 Worker 有约 30s wall-time 限制；常规短/中长回答够用，若长期开启深度思考导致长回答被截断，可升级 Paid（$5/月）并调整 `cpu_ms`。