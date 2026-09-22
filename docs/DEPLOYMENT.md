# 公网部署模式

[**中文**](DEPLOYMENT.md) | [English](DEPLOYMENT.en.md)

项目同时保留两种公网模式：Quick Tunnel 用于临时测试和快速接入，Named Tunnel / 固定 HTTPS hostname 用于长期稳定使用。

README 中的推荐日常命令是：

```bash
npm run quick   # 临时随机域名
npm run stable  # 固定域名
```

两种模式共用 `.web-gpt-file-save/settings.json`。先运行一次 `npm run configure` 即可保存本地项目根目录和 OAuth 授权密码。Quick URL 改变后需要在 ChatGPT 重新连接/授权；Stable hostname 不变时可持续复用连接。

## Quick 临时域名

无需 Cloudflare 账号或 DNS 配置，安装 `cloudflared` 后直接运行：

```bash
npm run quick
```

脚本会自动创建 Quick Tunnel、读取随机 `trycloudflare.com` 地址、启动 MCP，并打印 ChatGPT 使用的 `/mcp` URL。停止时按 `Ctrl+C`。

## Stable 固定域名

长期使用推荐固定 HTTPS 域名，例如 `https://files.example.com`，并通过 Cloudflare Named Tunnel 转发到本机 Stable 默认端口 `127.0.0.1:8878`。

### 1. 创建 Named Tunnel

以下命令会修改你的 Cloudflare 账户，仅在你确定目标账户和域名后执行：

```bash
cloudflared tunnel create web-gpt-file-save
cloudflared tunnel route dns web-gpt-file-save files.example.com
```

复制 `deploy/cloudflared/config.example.yml` 到私有配置位置，并替换 Tunnel UUID、用户名和域名。Cloudflare 凭据 JSON 不应提交到仓库。

`FILE_SAVE_ROOT` 是部署时一次性绑定的本地项目路径，不需要用户在每个 ChatGPT 对话里重复提供。连接后，模型应调用零参数 `get_project_context` 获取已配置项目根目录，并让 `save_file` 仅使用相对路径（或省略 `destination`）。

### 2. 配置服务

```bash
# 本地项目根目录只配置一次；默认是当前目录
npm run configure -- --save-root /absolute/path/to/project

# 固定域名 / Tunnel 也只配置一次
npm run configure -- \
  --stable-url https://files.example.com \
  --tunnel-name web-gpt-file-save \
  --cloudflared-config ~/.cloudflared/web-gpt-file-save.yml

# 日常启动
npm run stable
```

`npm run stable` 会自动执行稳定模式预检并启动本地服务和 Named Tunnel。也可以单独运行 `npm run preflight:stable`。Quick Tunnel 不经过这个稳定模式预检，因为它由 `npm run quick` 单独管理。

### 3. 日常启动

以后只需要：

```bash
npm run stable
```

然后在 ChatGPT 中把 MCP 地址固定为：

```text
https://files.example.com/mcp
```

切换稳定地址时需要重新连接/授权一次。之后服务正常重启时 OAuth client 和未过期 token 会从 `MCP_STATE_FILE` 恢复。
