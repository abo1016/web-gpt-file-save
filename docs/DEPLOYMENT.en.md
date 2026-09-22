# Public deployment modes

[中文](DEPLOYMENT.md) | **English**

The project intentionally supports both public modes: Quick Tunnel for temporary testing and fast access, and a Named Tunnel / fixed HTTPS hostname for long-term stable use.

The recommended daily commands are:

```bash
npm run quick   # temporary random hostname
npm run stable  # fixed hostname
```

Both modes share `.web-gpt-file-save/settings.json`. Run `npm run configure` once to persist the local project root and OAuth approval password. A changed Quick URL requires a ChatGPT reconnect/re-authorization; an unchanged Stable hostname can keep using the same connection.

## Quick temporary hostname

No Cloudflare account or DNS setup is required. Once `cloudflared` is installed, run:

```bash
npm run quick
```

The script creates a Quick Tunnel, captures the random `trycloudflare.com` URL, starts the MCP server, and prints the exact `/mcp` URL for ChatGPT. Press `Ctrl+C` to stop it.

## Stable fixed hostname

For long-term use, use a fixed HTTPS hostname such as `https://files.example.com` and route it to the Stable-mode default `127.0.0.1:8878` through a Cloudflare Named Tunnel.

### 1. Create a Named Tunnel

The following commands modify your Cloudflare account. Run them only after confirming the intended account and hostname:

```bash
cloudflared tunnel create web-gpt-file-save
cloudflared tunnel route dns web-gpt-file-save files.example.com
```

Copy `deploy/cloudflared/config.example.yml` to a private configuration location and replace the tunnel UUID, username, and hostname. Do not commit the Cloudflare credentials JSON file.

`FILE_SAVE_ROOT` is a one-time deployment binding for the local project path; users should not repeat that absolute path in every ChatGPT conversation. Once connected, the model should call zero-argument `get_project_context` to retrieve the configured root and use only relative `save_file` destinations (or omit `destination`).

### 2. Configure the service

```bash
# Configure the local project root once; the current directory is the default
npm run configure -- --save-root /absolute/path/to/project

# Configure the fixed hostname / tunnel once
npm run configure -- \
  --stable-url https://files.example.com \
  --tunnel-name web-gpt-file-save \
  --cloudflared-config ~/.cloudflared/web-gpt-file-save.yml

# Daily startup
npm run stable
```

`npm run stable` automatically runs the stable-mode preflight and starts both the local MCP service and the Named Tunnel. You can also run `npm run preflight:stable` by itself. Quick Tunnel intentionally bypasses stable-mode preflight because it is managed separately by `npm run quick`.

### 3. Daily startup

After the first setup, run only:

```bash
npm run stable
```

Then keep the ChatGPT MCP URL fixed at:

```text
https://files.example.com/mcp
```

A one-time reconnect/authorization is expected when moving to the stable hostname. Normal service restarts after that preserve registered clients and unexpired tokens through `MCP_STATE_FILE`.
