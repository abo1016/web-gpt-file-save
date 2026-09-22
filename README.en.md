# web-gpt-file-save

[![CI](https://github.com/abo1016/web-gpt-file-save/actions/workflows/ci.yml/badge.svg)](https://github.com/abo1016/web-gpt-file-save/actions/workflows/ci.yml)
[MIT License](LICENSE)

[中文](README.md) | **English**

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

The more focused deployment reference is `docs/DEPLOYMENT.en.md`.

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
