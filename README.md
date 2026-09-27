# lmdsfy — 让我帮你 DeepSeek 一下

把「Let Me Google That For You」的整蛊玩法搬到 DeepSeek 上：生成一个链接甩给伸手党，对方打开后先看一段「手把手教程」动画，再进入复刻官方风格的聊天页，用流式输出实时回答。

线上地址：https://lmdsfy.awakaze.com

## 目录结构

```
lmdsfy/
├─ worker.js            # Cloudflare Worker 入口：API 转发 + 托管静态资源
├─ wrangler.toml        # Worker 配置（名称 / 兼容日期 / 静态资源绑定 / 环境变量）
├─ public/
│  ├─ index.html        # 首页：复刻 www.deepseek.com 浅色风格
│  └─ chat.html         # 聊天页：复刻 chat.deepseek.com 深色风格
├─ .dev.vars.example    # 本地开发密钥模板（复制为 .dev.vars 使用）
└─ .gitignore
```

## 页面与流程

| 页面 | 文件 | 作用 |
|---|---|---|
| 首页（落地页） | `public/index.html` | 复刻 www.deepseek.com 浅色风格。输入问题 + 勾选开关 → 生成分享链接（复制 / 预览）；带 `?q=` 时播放整蛊教程动画 |
| 聊天页 | `public/chat.html` | 复刻 chat.deepseek.com 深色风格。接收参数发起流式请求，逐字渲染回答，支持多轮追问 |

整蛊流程：首页输入问题 → 生成链接 → 甩给伸手党 → 对方打开看到「鼠标指针指示器 + 逐字输入 + 点击发送」教程动画 → 跳转聊天页拿到答案。

## 功能特性

- **流式输出**：Worker 直连 DeepSeek `/chat/completions`（`stream: true`），SSE 透传，前端逐字渲染。
- **多轮对话**：聊天页把本地保存的完整消息历史通过 POST 交给后端，模型能记住上下文。
- **深度思考**：开关映射 DeepSeek 的 `thinking: { type: 'enabled' | 'disabled' }`，思考过程（`reasoning_content`）折叠展示。
- **整蛊教程动画**：鼠标指针样式指示器 + 点击涟漪，逐字输入问题后指向发送按钮。
- **「快停下，我是自己人」**：教程旁路按钮，中断动画并恢复正常页面交互。
- **本地历史会话**：会话存 localStorage，侧边栏可切换；Markdown 渲染、代码块一键复制。

## URL 参数

| 参数 | 含义 | 取值 |
|---|---|---|
| `q` | 要问的问题 | 任意文本（URL 编码） |
| `think` | 开启深度思考 | `true` / `false`，缺省 `false` |
| `search` | 开启智能搜索 | `true` / `false`，缺省 `false`（当前仅 UI 占位） |

首页生成的链接形如 `chat.html?q=xxx&think=true`；两个开关默认都**不勾选**。

## API

### `POST /api/chat`（多轮）

```json
{
  "messages": [
    { "role": "user", "content": "你好" },
    { "role": "assistant", "content": "你好！有什么可以帮你的？" },
    { "role": "user", "content": "那它呢？" }
  ],
  "think": false
}
```

返回 `text/event-stream`，原样透传 DeepSeek 的 SSE 分片。后端会：

- 在最前面拼接 `SYSTEM_PROMPT`（system 消息）；
- 只保留 `user` / `assistant` 的纯文本内容，**思考链 `reasoning` 不回传**给模型；
- 按 `think` 显式设置 `thinking`（DeepSeek 默认开启思考，关闭时必须显式 `disabled`）。

### `GET /api/chat?q=xxx&think=true`（单轮）

兼容直链的简化入口，等价于只传一条 user 消息。

## 技术实现

- **后端**：Cloudflare Worker（`worker.js`）
  - `/api/chat` → 转发 DeepSeek 并 SSE 流式回传
  - 其余路径 → `env.ASSETS.fetch()` 交给 `public/` 静态资源
- **前端**：原生 HTML/CSS/JS 单文件页，无构建步骤；Markdown 用 `marked`（CDN）。两页的配色/圆角/尺寸令牌均从官方样式表提取（首页取 www.deepseek.com，聊天页取 chat.deepseek.com 的 `--dsw-*` 令牌）。
- **模型**：默认 `deepseek-flash`，即 **DeepSeek-V4.1-Flash**（官方推荐模型名）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | — | DeepSeek API 密钥，用 secret 注入 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | API 基地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-flash` | 模型名 |
| `SYSTEM_PROMPT` | 否 | 内置中文助手提示词 | 系统提示词 |

## 本地运行

```powershell
# 1. 配置本地密钥：复制模板并填入真实 key
Copy-Item .dev.vars.example .dev.vars

# 2. 启动本地服务
npx wrangler dev
# 打开 http://localhost:8787 体验两页流程
```

只想预览静态页（不调后端）时，也可以在 `public/` 下起个静态服务器：

```powershell
python -m http.server 8755
```

## 部署

本项目采用 **Cloudflare Git 集成（Workers Builds）** 自动部署：向 `main` 分支 push 即触发构建与发布，无需本地手动执行 deploy。

1. 本地改动提交后 `git push origin main`；
2. Cloudflare 拉取仓库并执行构建命令 `npx wrangler deploy`，完成后线上 Worker 即为最新版本；
3. 构建记录可在控制台 **Workers & Pages → lmdsfy → Deployments** 查看。

Cloudflare 侧的一次性配置（在控制台完成）：

1. **Workers & Pages** → 选中 Worker `lmdsfy` → **Settings** → **Builds** → **Connect Git**；
2. 授权并选择仓库 `awakaze/lmdsfy`、生产分支 `main`；
3. **Root directory** 留空（仓库根即项目根），**Build command** 填 `npx wrangler deploy`；
4. 保存后主动 push 一次，即完成首次自动部署并转为 Git 集成模式。

紧急情况仍可本地手动部署（会覆盖同一 Worker）：

```powershell
npx wrangler deploy
```

- Worker 名 `lmdsfy`、自定义域名 `lmdsfy.awakaze.com` 均已在 Cloudflare 侧配置好。
- `DEEPSEEK_API_KEY` 等 secret 存在 **Cloudflare 账户的该 Worker 上**，不在本仓库，Git 集成构建不会覆盖它；更换本地目录或重新克隆都不影响线上，无需重复注入。需要更新时才执行：

```powershell
npx wrangler secret put DEEPSEEK_API_KEY
```

## 已知限制

- **智能搜索未真正接入**：DeepSeek API 无内置联网搜索，需通过 Function Calling 集成第三方搜索 API（如 Bing / Serper）后 `search` 才会生效，当前仅切换前端按钮状态。
- **历史不截断**：多轮会把全部历史发给模型，超长对话可能触达 DeepSeek 上下文上限，后续可加滑动窗口截断。
- **免费档配额**：Cloudflare 免费 Worker 为 10ms CPU/请求，等待 DeepSeek 的 I/O 时间不计入 CPU，流式透传几乎不耗 CPU，常规使用足够。