# web-gpt-file-save

[![CI](https://github.com/abo1016/web-gpt-file-save/actions/workflows/ci.yml/badge.svg)](https://github.com/abo1016/web-gpt-file-save/actions/workflows/ci.yml)
[MIT License](LICENSE)

[中文](#中文) | [English](#english)

## 中文

一个独立的 MCP 服务，用于把 ChatGPT 对话中的附件、生成文件和图片可靠地保存到 macOS 本地项目目录。

```text
ChatGPT 对话文件
        -> 临时或固定公网 HTTPS MCP 地址
        -> 本 MCP 服务（Streamable HTTP）
        -> OAuth 2.0 authorization code + PKCE
        -> openai/fileParams
        -> save_file（import_file 保留为兼容别名）
        -> ChatGPT 临时 download_url
        -> DNS 校验 + 连接 IP 固定
        -> FILE_SAVE_ROOT/<destination 或原文件名>
```

### 当前实现

- `save_file` 是主要工具名，描述覆盖“保存 / 导出 / 下载 / 复制 / 持久化”等常见用户意图。
- `import_file` 保留为兼容别名，避免已有客户端在迁移过程中失效。
- `get_project_context` 是零参数项目定位工具：需要本地项目路径时应先调用它，不要让用户在每个新对话里重复输入绝对路径。
- `show_config` 也要求 OAuth 授权；公网匿名调用不会获得本地文件系统路径。
- 项目根目录由部署时的 `FILE_SAVE_ROOT` 一次性配置；对话中的 `save_file` 只使用相对路径，`destination` 还可以直接省略。
- 两个工具都通过 `_meta["openai/fileParams"]` 声明顶层 `file` 参数。
- `destination` 可省略；默认使用 ChatGPT 提供的原文件名，没有文件名时使用安全化后的 `file_id`。
- 写入路径限制在 `FILE_SAVE_ROOT` 下，并防护路径穿越、父目录符号链接和目标符号链接。
- 下载限制 HTTPS（测试时可显式允许 loopback HTTP）、重定向次数、最大文件大小和超时。
- DNS 解析结果会先检查私网/保留地址；实际网络连接使用已经校验的 IP，避免解析校验后再次 DNS 查询造成 rebinding 窗口。
- OAuth client 和未过期 access token 原子持久化到本地状态文件，正常服务重启不会无故丢失授权。
- 覆盖写入使用临时文件 + rename，降低部分写入风险。
- 成功和失败保存操作会输出结构化本地审计日志，但不会记录临时 `download_url`。

### 环境要求

- Node.js 20+（当前环境使用 Node 22）
- npm
- 如果需要公网稳定接入：Cloudflare Named Tunnel 或其他固定 HTTPS 反向代理

这台 Mac 的非交互 shell 可能需要：

```bash
export PATH=/opt/homebrew/bin:$PATH
```

### 安装与验证

```bash
npm install
npm test
```

测试包含五层：

1. `settings-smoke`：验证本地设置持久化、`0600` 权限、项目根目录复用以及 Quick/Stable 配置分离。
2. `security-smoke`：验证私网/保留地址阻断、DNS 混合结果拒绝和一次解析后的固定地址。
3. `importer-smoke`：验证真实本地 HTTP fixture 下载、SHA-256、自动文件名、覆盖写入、路径穿越和重复写入防护。
4. `protocol-smoke`：验证 `save_file`、`import_file`、`get_project_context`、受保护的 `show_config`、`openai/fileParams` 和 OAuth challenge。
5. `oauth-smoke`：验证动态 client 注册、PKCE-S256、token exchange、token 持久化重载和授权 MCP 调用。

### 本地开发运行

```bash
npm run build
MCP_AUTH_PASSWORD='replace-with-a-long-local-password' \
MCP_ALLOW_INSECURE_HTTP=1 \
MCP_PUBLIC_BASE_URL='http://127.0.0.1:8765' \
FILE_SAVE_ROOT="$PWD/imports" \
npm start
```

本地 MCP 地址为 `http://127.0.0.1:8765/mcp`。

### ChatGPT 文件参数

工具描述包含：

```ts
_meta: {
  "openai/fileParams": ["file"],
}
```

ChatGPT 调用时会提供类似：

```json
{
  "file": {
    "download_url": "https://...",
    "file_id": "file_...",
    "mime_type": "image/png",
    "file_name": "hero.png"
  },
  "destination": "assets/hero.png",
  "overwrite": false
}
```

`mime_type`、`file_name` 和 `destination` 都可以缺省。`destination` 缺省时，`save_file` 会自动推导安全文件名。

### 运行配置

- `MCP_PUBLIC_BASE_URL`：当前这次服务对外使用的 HTTPS base URL；Quick 模式自动生成，Stable 模式从本地设置读取。
- `MCP_AUTH_PASSWORD`：本地单用户 OAuth 授权密码，至少 12 字符。
- `MCP_HOST`：监听地址，Tunnel 场景建议 `127.0.0.1`。
- `MCP_PORT`：监听端口，默认 `8765`。
- `MCP_QUICK_PORT` / 本地设置 `quickPort`：Quick 模式端口，默认 `8765`。
- `MCP_STABLE_PORT` / 本地设置 `stablePort`：Stable 模式端口，默认 `8878`。
- `FILE_SAVE_ROOT`：允许写入的唯一文件系统根目录。
  - 这是服务部署时一次性设置，不是每次对话都要用户提供的参数。
  - ChatGPT 可通过零参数 `get_project_context` 获取已配置路径。
- `MCP_STATE_FILE`：OAuth 状态文件，默认 `.web-gpt-file-save/oauth-state.json`。
- `MCP_MAX_FILE_BYTES`：最大下载大小，默认 25 MiB。
- `MCP_DOWNLOAD_TIMEOUT_MS`：单次下载超时，默认 30000 ms。
- `MCP_ACCESS_TOKEN_TTL_SECONDS`：access token 生命周期，默认 3600 秒。

### 公网使用：Quick 临时域名和 Stable 固定域名都支持

两种模式都会使用同一个本地项目根目录、同一套 `save_file` / `get_project_context` 工具和同一个本地设置文件。区别只在公网入口的生命周期。

| 模式 | 启动命令 | 公网地址 | 适合场景 | ChatGPT 连接行为 |
| --- | --- | --- | --- | --- |
| Quick 临时域名 | `npm run quick` | 随机 `*.trycloudflare.com` | Demo、临时测试、换机器快速验证 | URL 变化后需要更新/重连并重新授权 |
| Stable 固定域名 | `npm run stable` | 自己的固定 HTTPS hostname | 日常长期使用 | hostname 不变时可持续复用连接；正常重启可恢复未过期 token |

#### 0. 两种模式共用：第一次只配置一次本地设置

先安装依赖：

```bash
npm install
```

然后初始化本地设置：

```bash
npm run configure
```

这会创建：

```text
.web-gpt-file-save/settings.json
```

文件权限为 `0600`，并且整个 `.web-gpt-file-save/` 已被 Git 忽略。第一次初始化会：

- 默认把**当前项目目录**保存为本地项目根目录；
- 自动生成并保存一个可重复使用的 OAuth 授权密码；
- 默认把 Named Tunnel 名称设为 `web-gpt-file-save`；
- OAuth 状态默认保存在 `.web-gpt-file-save/oauth-state.json`。
- Quick 默认使用本地端口 `8765`，Stable 默认使用 `8878`，因此两种模式可以同时保留运行而不抢端口。

如果文件需要保存到另一个本地项目，只需要配置一次：

```bash
npm run configure -- --save-root /Users/you/Documents/my-project
```

以后 ChatGPT 不需要再问这个绝对路径。需要查看路径时，模型应调用零参数：

```text
get_project_context()
```

需要查看 OAuth 授权密码时：

```bash
npm run auth:show
```

#### A. Quick 模式：临时随机域名，一条命令启动

适合：快速验证、临时使用、Demo，以及不想先配置 DNS/域名的场景。

先确认本机有 `cloudflared`：

```bash
cloudflared --version
```

macOS 如未安装，可使用 Homebrew 安装：

```bash
brew install cloudflared
```

启动：

```bash
npm run quick
```

这个命令会自动完成：

1. 编译项目；
2. 启动 Cloudflare Quick Tunnel；
3. 自动读取随机 `https://<random>.trycloudflare.com` 地址；
4. 把这个地址注入 `MCP_PUBLIC_BASE_URL`；
5. 使用已经保存的项目根目录和 OAuth 密码启动 MCP 服务；
6. 在终端打印可以直接填写到 ChatGPT 的 `/mcp` URL。

终端会看到类似：

```text
=== web-gpt-file-save: QUICK MODE ===
ChatGPT MCP URL: https://xxxx.trycloudflare.com/mcp
OAuth password: ...
Local project root: /Users/you/Documents/my-project
```

然后在 ChatGPT 中：

1. 新增或编辑开发者模式 MCP App；
2. MCP URL 填终端打印的 `https://xxxx.trycloudflare.com/mcp`；
3. 完成 OAuth 时输入终端打印的密码；
4. 之后直接说“保存这个文件”“保存刚生成的图片”即可；不需要再次提供本地绝对路径。

停止时按 `Ctrl+C`，脚本会同时停止本地 MCP 服务和 Quick Tunnel。

**Quick 模式的重要行为：** 随机 URL 在下次启动时可能改变。OAuth token 绑定具体 resource URL，因此 URL 改变后，旧 ChatGPT 连接可能显示工具不可用；这时把 MCP App 更新到新的 `/mcp` URL 并重新授权即可。本地设置、保存根目录和文件不会因此丢失。

#### B. Stable 模式：固定域名，日常长期使用

适合：希望 ChatGPT MCP 地址长期不变化、机器重启后仍继续使用的场景。

固定模式第一次需要先准备一个 Cloudflare Named Tunnel 和自己的 hostname。示例使用：

```text
https://files.example.com
```

如果这台机器**已经有用过的 Named Tunnel + 固定域名**，可以直接复用，不需要重新创建 Tunnel。只要把已有 hostname 和 tunnel name 写入本项目配置即可；如果没有单独的 YAML 配置文件，`npm run stable` 会自动把该 Named Tunnel 转发到当前本地 MCP 端口。

第一步，登录并创建 Tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create web-gpt-file-save
cloudflared tunnel route dns web-gpt-file-save files.example.com
```

第二步，复制示例配置：

```bash
cp deploy/cloudflared/config.example.yml ~/.cloudflared/web-gpt-file-save.yml
```

编辑这个私有文件，把下面三项替换成真实值：

- `<TUNNEL-UUID>`
- `/Users/<username>/.cloudflared/<TUNNEL-UUID>.json`
- `files.example.com`

第三步，把固定域名和 Tunnel 信息保存到本项目的本地设置里，只做一次：

```bash
npm run configure -- \
  --stable-url https://files.example.com \
  --tunnel-name web-gpt-file-save \
  --cloudflared-config ~/.cloudflared/web-gpt-file-save.yml
```

复用本机已有 Named Tunnel、且没有单独 YAML 时，可以更简单：

```bash
npm run configure -- \
  --stable-url https://existing-host.example.com \
  --tunnel-name existing-tunnel-name
```

此时不需要 `--cloudflared-config`。

第四步，日常启动只需要：

```bash
npm run stable
```

这个命令会自动：

1. 编译项目；
2. 运行 Stable 模式 preflight；
3. 使用已保存的项目根目录和 OAuth 密码启动本地 MCP；
4. 等待本地 `/healthz` 正常；
5. 启动配置好的 Cloudflare Named Tunnel；
6. 打印固定的 ChatGPT MCP URL。

在 ChatGPT 中固定配置：

```text
https://files.example.com/mcp
```

首次使用这个固定 hostname 时完成一次 OAuth 授权。之后只要 hostname 不变，普通服务重启会从 `MCP_STATE_FILE` 恢复已注册 client 和未过期 token，不需要因为本地进程重启而重新配置 URL。

可以单独检查 Stable 配置而不启动服务：

```bash
npm run preflight:stable
```

固定域名服务启动后，还可以从公网完整验证 OAuth（动态注册、PKCE、授权、token、授权后的 MCP 调用）：

```bash
P1_PUBLIC_BASE_URL='https://files.example.com' \
P1_AUTH_PASSWORD="$(npm run --silent auth:show)" \
npm run test:public:auth
```

该命令不会打印 OAuth 密码。

旧命令 `npm run preflight:production` 和 `npm run start:production` 继续保留，方便使用自定义反向代理而不是由本项目启动 Named Tunnel。

#### Quick 与 Stable 如何共存和切换

- 两种模式都保留，互不删除配置。
- 默认共用 `.web-gpt-file-save/settings.json`、项目根目录、OAuth 授权密码和 OAuth 状态文件。
- 可以在 ChatGPT 里分别保留两个 MCP App，例如“File Save Quick”和“File Save Stable”。
- Quick 默认使用 `8765`，Stable 默认使用 `8878`，因此两种模式可以同时运行；也可以通过 `--quick-port` / `--stable-port` 修改。
- 从 Quick URL 切到 Stable hostname，或者反过来，属于不同 OAuth resource；需要针对那个 URL 单独授权一次。
- Stable hostname 不变时，不会出现 Quick Tunnel 随机 URL 变化导致的“工具突然不可调用”。

#### 常用操作

修改本地项目根目录，只需执行一次并重启当前模式：

```bash
npm run configure -- --save-root /Users/you/Documents/another-project
```

修改固定域名：

```bash
npm run configure -- --stable-url https://new-files.example.com
```

修改 Named Tunnel 名称：

```bash
npm run configure -- --tunnel-name another-tunnel
```

修改 Quick / Stable 本地端口：

```bash
npm run configure -- --quick-port 8765 --stable-port 8878
```

查看当前本地设置摘要：

```bash
npm run configure
```

查看 OAuth 密码：

```bash
npm run auth:show
```

本地健康检查：

```bash
# Quick
curl http://127.0.0.1:8765/healthz

# Stable
curl http://127.0.0.1:8878/healthz
```

#### “工具突然不可调用”时优先检查

1. **Quick 模式**：看当前终端打印的 `trycloudflare.com/mcp` 是否和 ChatGPT App 中保存的 URL 一致。
2. **Stable 模式**：确认 `npm run stable` 仍在运行，并检查 Named Tunnel 的 hostname / DNS 没有改变。
3. 确认本地健康检查 `/healthz` 正常。
4. 如果公网 URL 改过，重新连接并授权，因为 OAuth token 会校验 resource URL。
5. 本地项目路径不需要重新输入；授权后调用 `get_project_context()` 即可读取当前配置。

更完整的部署说明也保留在 `docs/DEPLOYMENT.md`。

### 已验证状态

P0/P1 已验证：

- MCP Streamable HTTP 服务和 OAuth 流程；
- ChatGPT `openai/fileParams` 注入；
- ChatGPT host file 保存到本地；
- 用户上传附件保存；
- ChatGPT 对话中生成图片保存；
- 文件大小、内容和 SHA-256 本地验证。
- 复用本机既有 Cloudflare Named Tunnel / 固定 hostname 的公网 `/healthz`、OAuth metadata、MCP `listTools`、`openai/fileParams` 和 OAuth challenge 验证。

详细历史测试记录见 `docs/P1_INDEPENDENT_MCP_TEST.md`。

Phase 2 当前状态：

- [x] `save_file` 成为主工具，`import_file` 保留兼容。
- [x] `destination` 可省略并自动推导。
- [x] 增加零参数 `get_project_context`，新对话无需重复询问本地绝对路径。
- [x] 下载大小和超时可配置。
- [x] 下载后重新检查目标路径，覆盖写入使用临时文件 rename。
- [x] OAuth client/token 本地持久化。
- [x] 结构化保存审计事件。
- [x] DNS 私网/保留地址检查和连接 IP 固定，收紧 DNS rebinding 窗口。
- [x] 提供固定 HTTPS / Named Tunnel 的生产预检和配置模板。
- [x] Quick Tunnel 保留为一键临时模式，Stable Named Tunnel 保留为一键长期模式。
- [x] 验证可直接复用本机已有 Named Tunnel + 固定 hostname，无需重新创建域名或 YAML 配置。
- [x] 已绑定并验证实际固定 hostname / Named Tunnel；真实 ChatGPT 重连后使用 `save_file` 保存 host file，并在 Mac 上独立校验字节数、内容和 SHA-256。
- [ ] 按部署需要增加 MIME allowlist、速率限制和项目级写入策略。

---

## English

A standalone MCP server for reliably saving files from a ChatGPT conversation directly to a local project on macOS.

```text
ChatGPT conversation file
        -> public HTTPS MCP endpoint
        -> this MCP server (Streamable HTTP)
        -> OAuth 2.0 authorization code + PKCE
        -> openai/fileParams
        -> save_file (import_file remains as a compatibility alias)
        -> temporary download_url
        -> FILE_SAVE_ROOT/<destination-or-original-file-name>
```

## Current implementation

- `save_file` is the primary intent-oriented tool; `import_file` remains available for backward compatibility.
- `get_project_context` is a zero-argument project discovery tool. When the local project path is needed, the model should call it before asking the user for an absolute path.
- `show_config` also requires OAuth authorization; anonymous public callers do not receive the local filesystem path.
- The project root is configured once at deployment through `FILE_SAVE_ROOT`; conversational `save_file` calls use only relative destinations, and `destination` may be omitted entirely.
- Both tools advertise a top-level `file` parameter through `_meta["openai/fileParams"]`.
- `destination` is optional. When omitted, the server uses the original ChatGPT file name, or a safe `file_id` fallback.
- The server applies path traversal, parent symlink, overwrite, download-size, redirect, unsafe-protocol, private/reserved-network, and DNS-rebinding guards.
- DNS is validated once per hop and the actual HTTP(S) connection is made to the validated IP while preserving the original Host/SNI identity.
- File downloads have a configurable timeout and size limit.
- OAuth client registrations and unexpired access tokens are persisted atomically in a local 0600 state file so normal service restarts do not silently invalidate authorization.
- Successful and failed file-save calls emit structured local audit events without logging the temporary download URL.

The remaining production-hardening work is mainly deployment policy: bind this project to an actual stable HTTPS hostname / Named Tunnel, then add any desired MIME, rate-limit, or project-specific policies.

## Requirements

- Node.js 20+ (tested with Node 22)
- npm

On this Mac, non-interactive shells may need Homebrew Node added to PATH:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

## Install

```bash
npm install
```

## Validate locally

```bash
npm test
```

The test suite validates five layers:

1. `settings-smoke`: validates persisted local settings, `0600` permissions, reusable project-root configuration, and separation between Quick and Stable settings.
2. `security-smoke`: validates private/reserved-address blocking, mixed DNS-answer rejection, and a single validated DNS result suitable for connection pinning.
3. `importer-smoke`: starts a local HTTP fixture, downloads a mock attachment through the pinned connection path, validates SHA-256/content, automatic naming, overwrite behavior, path traversal, and duplicate-write rejection.
4. `protocol-smoke`: starts the Streamable HTTP MCP app, verifies `save_file`, the `import_file` compatibility alias, `get_project_context`, protected `show_config`, `openai/fileParams: ["file"]`, and unauthenticated OAuth challenges.
5. `oauth-smoke`: exercises dynamic client registration, authorization code + PKCE-S256, token exchange, persisted-token reload, and an authenticated MCP call.

## Run the MCP server locally

For a loopback-only development server, set a password and explicitly allow insecure HTTP:

```bash
npm run build
MCP_AUTH_PASSWORD='replace-with-a-long-local-password' \
MCP_ALLOW_INSECURE_HTTP=1 \
MCP_PUBLIC_BASE_URL='http://127.0.0.1:8765' \
FILE_SAVE_ROOT="$PWD/imports" \
npm start
```

The MCP endpoint is `http://127.0.0.1:8765/mcp`. For a real ChatGPT connection, expose the service through a public HTTPS URL and set `MCP_PUBLIC_BASE_URL` to that exact external base URL.

To point the service at a real project, set an explicit `FILE_SAVE_ROOT`. The model may provide a relative destination such as `public/assets/generated/hero.png`, or omit `destination` and let `save_file` use the original file name. It never needs an arbitrary absolute local path.

## ChatGPT file parameter

The important tool descriptor is:

```ts
_meta: {
  "openai/fileParams": ["file"],
}
```

At runtime ChatGPT is expected to supply:

```json
{
  "file": {
    "download_url": "https://...",
    "file_id": "file_...",
    "mime_type": "image/png",
    "file_name": "hero.png"
  },
  "destination": "assets/hero.png",
  "overwrite": false
}
```

`mime_type`, `file_name`, and `destination` may be absent. If `destination` is omitted, `save_file` derives a safe local name from `file_name` and then `file_id`.

Useful runtime settings:

- `MCP_STATE_FILE`: OAuth state file. Defaults to `.web-gpt-file-save/oauth-state.json`.
- `MCP_MAX_FILE_BYTES`: maximum downloaded file size. Defaults to 25 MiB.
- `MCP_DOWNLOAD_TIMEOUT_MS`: per-download request timeout. Defaults to 30000 ms.
- `FILE_SAVE_ROOT`: only filesystem root into which conversation files may be written.
  - This is a one-time deployment setting, not a path the user should repeat in every conversation.
  - ChatGPT can retrieve the configured path with zero-argument `get_project_context`.
- `MCP_QUICK_PORT` / local `quickPort`: Quick-mode local port, defaults to `8765`.
- `MCP_STABLE_PORT` / local `stablePort`: Stable-mode local port, defaults to `8878`.

## Public use: both Quick temporary URLs and Stable fixed URLs are supported

Both modes use the same local project root, the same `save_file` / `get_project_context` tools, and the same local settings file. Only the lifetime of the public endpoint differs.

| Mode | Start command | Public URL | Best for | ChatGPT behavior |
| --- | --- | --- | --- | --- |
| Quick temporary URL | `npm run quick` | Random `*.trycloudflare.com` | Demos, temporary testing, fast setup | Reconnect/re-authorize when the URL changes |
| Stable fixed URL | `npm run stable` | Your fixed HTTPS hostname | Long-term daily use | Reuses the same URL; normal restarts can restore unexpired tokens |

### 0. One-time local configuration shared by both modes

Install dependencies:

```bash
npm install
```

Initialize local settings:

```bash
npm run configure
```

This creates:

```text
.web-gpt-file-save/settings.json
```

The file is written with `0600` permissions and the entire `.web-gpt-file-save/` directory is ignored by Git. On first initialization it:

- uses the **current project directory** as the default local project root;
- generates and stores a reusable OAuth approval password;
- defaults the Named Tunnel name to `web-gpt-file-save`;
- stores OAuth state at `.web-gpt-file-save/oauth-state.json` by default.
- defaults Quick to local port `8765` and Stable to `8878`, so both modes can remain running without competing for the same port.

To save into a different local project, configure the path once:

```bash
npm run configure -- --save-root /Users/you/Documents/my-project
```

ChatGPT should not ask for that absolute path again. When it needs the path, it should call:

```text
get_project_context()
```

To display the OAuth approval password:

```bash
npm run auth:show
```

### A. Quick mode: temporary random hostname, one-command startup

Use this for fast validation, temporary work, demos, or whenever you do not want to configure DNS first.

Verify `cloudflared` is installed:

```bash
cloudflared --version
```

On macOS, if needed:

```bash
brew install cloudflared
```

Start everything with:

```bash
npm run quick
```

The command automatically:

1. builds the project;
2. starts a Cloudflare Quick Tunnel;
3. captures the random `https://<random>.trycloudflare.com` URL;
4. injects it as `MCP_PUBLIC_BASE_URL`;
5. starts the MCP server with the stored project root and OAuth password;
6. prints the exact `/mcp` URL to enter in ChatGPT.

Example output:

```text
=== web-gpt-file-save: QUICK MODE ===
ChatGPT MCP URL: https://xxxx.trycloudflare.com/mcp
OAuth password: ...
Local project root: /Users/you/Documents/my-project
```

In ChatGPT:

1. add or edit a developer-mode MCP App;
2. use the printed `https://xxxx.trycloudflare.com/mcp` URL;
3. enter the printed password during OAuth approval;
4. then ask to save an attachment or generated image without repeating the local absolute path.

Press `Ctrl+C` to stop both the local MCP process and the Quick Tunnel.

**Important Quick-mode behavior:** the random URL may change the next time you start it. OAuth access tokens are bound to the exact resource URL, so an old ChatGPT connection can appear unavailable after that change. Update the MCP App to the new `/mcp` URL and authorize it again. Local settings, the project root, and saved files remain intact.

### B. Stable mode: fixed hostname for long-term daily use

Use this when the ChatGPT MCP URL should remain unchanged across restarts.

The first setup needs a Cloudflare Named Tunnel and a hostname you control. The examples below use:

```text
https://files.example.com
```

If this machine **already has a previously used Named Tunnel and fixed hostname**, you can reuse them directly instead of creating a new tunnel. Store the existing hostname and tunnel name in this project's settings. If there is no dedicated YAML config file, `npm run stable` automatically forwards that Named Tunnel to the current local MCP port.

First, log in and create the tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create web-gpt-file-save
cloudflared tunnel route dns web-gpt-file-save files.example.com
```

Copy the example config:

```bash
cp deploy/cloudflared/config.example.yml ~/.cloudflared/web-gpt-file-save.yml
```

Edit the private copy and replace:

- `<TUNNEL-UUID>`;
- `/Users/<username>/.cloudflared/<TUNNEL-UUID>.json`;
- `files.example.com`.

Store the stable settings once:

```bash
npm run configure -- \
  --stable-url https://files.example.com \
  --tunnel-name web-gpt-file-save \
  --cloudflared-config ~/.cloudflared/web-gpt-file-save.yml
```

To reuse an existing local Named Tunnel without a dedicated YAML file, the shorter form is enough:

```bash
npm run configure -- \
  --stable-url https://existing-host.example.com \
  --tunnel-name existing-tunnel-name
```

No `--cloudflared-config` is required in that case.

For normal daily startup, run only:

```bash
npm run stable
```

That command automatically:

1. builds the project;
2. runs the Stable-mode preflight;
3. starts the local MCP with the stored project root and OAuth password;
4. waits for the local `/healthz` endpoint;
5. starts the configured Named Tunnel;
6. prints the fixed ChatGPT MCP URL.

Keep the ChatGPT MCP App URL at:

```text
https://files.example.com/mcp
```

Authorize once for that stable hostname. As long as the hostname does not change, normal service restarts can reload registered clients and unexpired tokens from `MCP_STATE_FILE` without changing the ChatGPT URL.

Validate Stable settings without starting the service:

```bash
npm run preflight:stable
```

Once the fixed-host service is running, you can also validate the full public OAuth path (dynamic registration, PKCE, approval, token exchange, and an authenticated MCP call):

```bash
P1_PUBLIC_BASE_URL='https://files.example.com' \
P1_AUTH_PASSWORD="$(npm run --silent auth:show)" \
npm run test:public:auth
```

The command does not print the OAuth password.

The compatibility commands `npm run preflight:production` and `npm run start:production` remain available for deployments that use a different reverse proxy instead of letting this project start the Named Tunnel.

### Keeping and switching between Quick and Stable

- Both modes remain supported; configuring one does not delete the other.
- By default they share `.web-gpt-file-save/settings.json`, the local project root, OAuth approval password, and OAuth state file.
- You may keep two ChatGPT MCP App entries, for example “File Save Quick” and “File Save Stable”.
- Quick defaults to `8765` and Stable defaults to `8878`, so both modes can run at the same time. Use `--quick-port` / `--stable-port` to customize them.
- Moving from a Quick URL to a Stable hostname, or vice versa, changes the OAuth resource URL and requires authorization for that URL.
- A Stable hostname avoids the “tool suddenly unavailable” symptom caused specifically by a Quick Tunnel receiving a new random URL.

### Common operations

Change the local project root once, then restart the active mode:

```bash
npm run configure -- --save-root /Users/you/Documents/another-project
```

Change the stable hostname:

```bash
npm run configure -- --stable-url https://new-files.example.com
```

Change the Named Tunnel name:

```bash
npm run configure -- --tunnel-name another-tunnel
```

Change the Quick / Stable local ports:

```bash
npm run configure -- --quick-port 8765 --stable-port 8878
```

Show the current non-secret configuration summary:

```bash
npm run configure
```

Show the OAuth password:

```bash
npm run auth:show
```

Check the local server:

```bash
# Quick
curl http://127.0.0.1:8765/healthz

# Stable
curl http://127.0.0.1:8878/healthz
```

### If the tool suddenly becomes unavailable

1. **Quick mode:** compare the current terminal's `trycloudflare.com/mcp` URL with the URL saved in the ChatGPT App.
2. **Stable mode:** confirm `npm run stable` is still running and the Named Tunnel hostname/DNS has not changed.
3. Verify the local `/healthz` endpoint.
4. If the public URL changed, reconnect and authorize again because OAuth validates the resource URL.
5. Do not re-enter the local project path in chat; after authorization, use `get_project_context()`.

The more focused bilingual deployment reference remains in `docs/DEPLOYMENT.md`.

## P0 / P1 feasibility checklist

### P0 — local protocol and write path

- [x] MCP server starts over Streamable HTTP.
- [x] `save_file` is listed by an MCP client; `import_file` remains a compatibility alias.
- [x] `openai/fileParams` metadata is present.
- [x] Mock download reaches a local allowed root.
- [x] SHA-256/content integrity is verified.
- [x] Basic path traversal and overwrite guards are exercised.
- [x] OAuth discovery, dynamic client registration, PKCE token exchange, and authenticated MCP calls are exercised locally.

### P1 — real ChatGPT -> independent MCP -> local filesystem

- [x] Expose the MCP server through a temporary public HTTPS URL and verify health/OAuth/MCP protocol from the public side.
- [x] Connect the `/mcp` endpoint as a ChatGPT developer-mode app.
- [x] Complete the OAuth authorization flow.
- [x] Call **this project's** file-save tool with a real ChatGPT host file.
- [x] Confirm ChatGPT injects a host file id plus `download_url`, `mime_type`, and `file_name` into the MCP file parameter.
- [x] Confirm the file is written under `FILE_SAVE_ROOT` and independently verify byte count, content, and SHA-256 on the Mac.
- [x] Repeat specifically with a user-uploaded attachment.
- [x] Repeat with an image generated inside the ChatGPT conversation.
- [x] Reconnect ChatGPT to a real fixed hostname / Named Tunnel, save a real host file through `save_file`, and independently verify byte count, content, and SHA-256 on the Mac.

### Phase 2 — implementation foundation

- [x] Promote `save_file` as the primary tool name and make its description match normal save/export/download requests.
- [x] Keep `import_file` as a compatibility alias so existing clients do not break during rollout.
- [x] Make `destination` optional and infer a safe name from the ChatGPT file metadata.
- [x] Add zero-argument `get_project_context` so new conversations do not need to ask for the local absolute path again.
- [x] Add configurable download byte and timeout limits.
- [x] Re-check the target path after the network wait and use a temporary-file rename for overwrite writes.
- [x] Persist OAuth clients and unexpired access tokens atomically with local-only file permissions.
- [x] Emit structured success/failure audit events without logging temporary download URLs.
- [x] Add stronger DNS pinning/rebinding protection for remote downloads by connecting to the validated IP.
- [x] Add production preflight plus a stable HTTPS / Named Tunnel configuration template.
- [x] Keep Quick Tunnel as a supported one-command temporary mode and Stable Named Tunnel as a supported one-command long-term mode.
- [x] Verify reuse of an existing local Named Tunnel + fixed hostname without creating a new hostname or requiring a YAML config.
- [x] Bind this project to an actual stable hostname / Named Tunnel and validate a real ChatGPT reconnect plus host-file save with independent local integrity checks.
- [ ] Add optional MIME, rate-limit, and project-specific policy controls if needed by the deployment.
