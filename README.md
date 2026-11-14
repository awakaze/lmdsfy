# lmdsfy — 让我帮你 DeepSeek 一下

把「Let Me Google That For You」的整蛊玩法搬到 DeepSeek 上：生成一个链接甩给伸手党，对方打开后先看一段「手把手教程」动画，再进入复刻官方风格的聊天页，用流式输出实时回答。

线上地址：https://lmdsfy.awakaze.com

## 目录结构

```
lmdsfy/
├─ worker.js            # Cloudflare Worker 入口：聊天 API + 静态资源
├─ media-worker.js      # 流式文件上传、语音识别、语音合成
├─ wrangler.toml        # Worker 配置（名称 / 兼容日期 / 静态资源绑定 / 环境变量）
├─ public/
│  ├─ index.html        # 首页：复刻 www.deepseek.com 浅色风格
│  ├─ chat.html         # 聊天与交互
│  ├─ chat.css          # 官方风格布局、浅色／深色与移动端侧栏
│  ├─ media.js          # 附件、麦克风录音、分段朗读
│  └─ recorder-worklet.js # PCM 采集
├─ .dev.vars.example    # 本地开发密钥模板（复制为 .dev.vars 使用）
└─ .gitignore
```

## 页面与流程

| 页面 | 文件 | 作用 |
|---|---|---|
| 首页（落地页） | `public/index.html` | 复刻 www.deepseek.com 浅色风格。输入问题 + 勾选开关 → 生成分享链接（复制 / 预览）；带 `?q=` 时播放整蛊教程动画 |
| 聊天页 | `public/chat.html` | DeepSeek 风格聊天页，浅色／深色主题、文件与图片、语音、流式回答及多轮追问 |

整蛊流程：首页输入问题 → 生成链接 → 甩给伸手党 → 对方打开看到「鼠标指针指示器 + 逐字输入 + 点击发送」教程动画 → 跳转聊天页拿到答案。

## 功能特性

- **流式输出**：Worker 直连 DeepSeek `/chat/completions`（`stream: true`），SSE 透传，前端逐字渲染。
- **多轮对话**：聊天页把本地保存的完整消息历史通过 POST 交给后端，模型能记住上下文。
- **深度思考**：开关映射 DeepSeek 的 `thinking: { type: 'enabled' | 'disabled' }`，思考过程（`reasoning_content`）折叠展示。
- **智能搜索**：开关声明原生 `deepseek_web_search` 工具。模型自主决定搜索、阅读网页与查找正文；前端展示「正在搜索」状态、来源卡片列表，回答中的 `[1]`、`[2]` 引用可点击跳转原文。
- **整蛊教程动画**：鼠标指针样式指示器 + 点击涟漪，逐字输入问题后指向发送按钮。
- **「快停下，我是自己人」**：教程旁路按钮，中断动画并恢复正常页面交互。
- **本地历史会话**：会话存 localStorage，侧边栏可切换；Markdown 渲染、代码块一键复制。

## URL 参数

| 参数 | 含义 | 取值 |
|---|---|---|
| `q` | 要问的问题 | 任意文本（URL 编码） |
| `think` | 开启深度思考 | `true` / `false`，缺省 `false` |
| `search` | 开启智能搜索 | `true` / `false`，缺省 `false` |

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
  "think": false,
  "search": false
}
```

返回 `text/event-stream`。后端会：

- 在最前面拼接 `SYSTEM_PROMPT`（system 消息）；
- `search` 开启时声明 `deepseek_web_search`，由服务端执行搜索；配合 `think` 开启深度思考搜索；
- 始终声明 `deepseek_read_url`，允许模型读取用户发送的链接；
- 保留 assistant 的 `server_tool_calls`（包括网页签名），让后续追问能使用此前读过的网页；
- 启用自动会话标题与 `safety_check`；
- 原样透传 SSE。前端消费 `server_tool_event` 展示搜索／阅读进度，从最终 `delta.annotations` 按 Unicode 位置渲染引用，并保存最终 `server_tool_calls`。

参考：[官方网页工具协议](https://api-docs.deepseek.com/guides/web_tools/)。

### `GET /api/chat?q=xxx&think=true&search=true`（单轮）

兼容直链的简化入口，等价于只传一条 user 消息。

## 技术实现

- **后端**：Cloudflare Worker（`worker.js`）
  - `/api/chat` → 转发 DeepSeek 并 SSE 流式回传；通过原生网页工具完成搜索及链接阅读（工具调用单独计费，以官方定价为准）
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

- **历史不截断**：多轮会把全部历史发给模型，超长对话可能触达 DeepSeek 上下文上限，后续可加滑动窗口截断。
- **免费档配额**：Cloudflare 免费 Worker 为 10ms CPU/请求，等待 DeepSeek 的 I/O 时间不计入 CPU，流式透传几乎不耗 CPU，常规使用足够。
## 本次升级（2026-11-14）

保留整蛊分享和教程流程，升级原生联网搜索、深度思考搜索、链接阅读、官方引用、自动标题，以及保留网页签名的多轮对话。聊天页支持浅色／深色主题、停止生成、附件上传（选择／拖放／粘贴）、录音识别、分段语音朗读、会话重命名／删除及重新生成。Markdown 输出经过清洗，依赖及图标本地托管。

验证：`npm test`。真实 API 联调需要配置 `DEEPSEEK_API_KEY` 后启动 `npx wrangler dev`。

界面已依据登录后的官方主站 DOM、计算样式及官方样式表进行对照：侧栏 261px，桌面输入容器 840px、左右留白 32px、输入框 776px，输入框圆角 24px。支持桌面侧栏收起、历史搜索、随系统初始化的深浅主题和手机侧栏。聊天页不展示整蛊入口或项目宣传内容；首页保留链接生成与教程流程。

### 文件与语音

- `POST /api/files`：multipart 流式转发到官方 `/files`，不在 Worker 内存中缓存整份文件；前端先写 purpose 再写 file。PDF／Word／PPT 使用 `rich_layout_recognition`；图片、文本、表格和电子书使用 `user_data`。支持每段对话最多 20 份附件，图片 64 MiB、文本／表格 32 MiB。考虑 Cloudflare 请求体上限，解析型文档限制 95 MiB。文件自动在 30 天后过期，追问过期附件时提示重新上传。
- `POST /api/transcribe`：转发官方 `/v1/tools/asr`。用户点击麦克风录音，再点击结束，识别文字填回输入框供修改。AudioWorklet 采集为单声道 PCM16 WAV，最长 119 秒；结束或离开页面时释放麦克风。
- `POST /api/speech`：转发官方 `/v1/tools/tts`，默认 Stella 音色。回答下方点「朗读」播放，再点停止；长回答自动分段，切换对话时停止。
- 麦克风需要 HTTPS（本地 localhost 也可）及用户授权；语音与文件服务使用已有的服务端 `DEEPSEEK_API_KEY`，不会把密钥交给浏览器。工具调用以官方定价计费。

参考：[文件 API](https://api-docs.deepseek.com/guides/files_api/)、[语音识别](https://api-docs.deepseek.com/guides/asr/)、[语音合成](https://api-docs.deepseek.com/guides/tts/)。

开发：`npm ci` 后运行 `npm run dev`；检查：`npm test` 和 `npx wrangler deploy --dry-run`。推送 main 后由现有 Cloudflare Workers Builds 自动发布。

### 回答版本与朗读兼容

重新生成会保留旧回答及其后续追问，通过回答下方的左右箭头切换版本；版本与各自分支随本地历史保存。生成失败不会截断旧对话。复制、朗读、重新生成使用图标，名称通过悬停提示和无障碍标签提供。朗读会修复流式 WAV 的未知长度字段，并在用户点击时启用音频上下文；加载、播放、停止各有对应图标状态。
