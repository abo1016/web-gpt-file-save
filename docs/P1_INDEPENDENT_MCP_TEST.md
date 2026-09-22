# P1 — ChatGPT to local filesystem end-to-end test

## Runtime architecture

```text
ChatGPT
  -> public HTTPS /mcp endpoint
  -> Streamable HTTP MCP server on this Mac
  -> OAuth 2.0 authorization code + PKCE
  -> save_file(file, destination?) [import_file remains a compatibility alias]
  -> temporary download_url
  -> validated DNS result + pinned connection IP
  -> FILE_SAVE_ROOT/<destination-or-original-file-name>
```

## What is already verified

Local automated tests prove the importer, MCP tool metadata, OAuth discovery, dynamic client registration, PKCE token exchange, and authenticated MCP calls. A public-side smoke test additionally proves that a temporary HTTPS tunnel can reach `/healthz`, OAuth metadata, `/mcp`, `listTools`, `openai/fileParams`, and the unauthenticated OAuth challenge.

Run the standard suite:

```bash
npm test
```

## Temporary public HTTPS setup

A Cloudflare Quick Tunnel is enough for P1 feasibility testing and does not require a Cloudflare account. Initialize local settings once, then start Quick mode:

```bash
npm run configure
npm run quick
```

The command builds the project, starts a Quick Tunnel on the Quick-mode local port (default `8765`), starts the MCP server, and prints both the temporary `https://<random>.trycloudflare.com/mcp` URL and the OAuth approval password.

Verify the public MCP endpoint before connecting ChatGPT:

```bash
P1_PUBLIC_BASE_URL='https://<random>.trycloudflare.com' npm run test:public
```

The approval password can also be displayed locally with `npm run auth:show`.

The current server lists `save_file`, `import_file`, `get_project_context`, and `show_config`. It verifies `_meta["openai/fileParams"] == ["file"]`; file writes and local-path/config discovery require OAuth and return an authorization challenge when called anonymously.

## ChatGPT developer-mode test

Connect the public URL ending in `/mcp` as a developer-mode MCP app. Complete the OAuth flow using the approval password printed by `npm run quick` (or `npm run auth:show`).

Then test a user-uploaded attachment first:

```text
Call save_file with this conversation attachment and save it as p1/uploaded-file.<ext>.
```

If ChatGPT injects the host file object correctly, this MCP receives `download_url`, `file_id`, and optional `mime_type`/`file_name`, downloads the temporary URL, and writes the bytes below `FILE_SAVE_ROOT`.

After the uploaded attachment works, repeat with an image generated inside the ChatGPT conversation. Keeping those two cases separate isolates any generated-image materialization limitation from MCP transport or local filesystem behavior.

## Acceptance criteria

P1 is complete only when a real ChatGPT call causes a conversation file to appear under the configured local root through this MCP service.

### Verified real ChatGPT host-file result

On 2026-09-22, the connected ChatGPT MCP App called the original `import_file` feasibility tool with a real conversation-hosted text file. That path is still supported as a compatibility alias; `save_file` is now the primary tool. ChatGPT materialized the file as a host file id and supplied it to the MCP file parameter. The server wrote:

```text
imports/p1/p1-chatgpt-host-file.txt
```

Independent local verification reported exactly 60 bytes and SHA-256:

```text
6a66f7d8672e853434b02d326ced7f5beb45e39db15321aed429a0c361c9648a
```

The content matched the ChatGPT-side test file exactly. This proves the core path `ChatGPT host file -> openai/fileParams -> temporary download -> local Mac filesystem` end to end. The same session subsequently verified both a user-uploaded attachment and a ChatGPT-generated image as compatibility cases.

Verify locally:

```bash
find imports/p1 -maxdepth 1 -type f -print
shasum -a 256 imports/p1/*
```

The boundary under test is:

```text
ChatGPT host file
  -> _meta["openai/fileParams"] injection
  -> this MCP receives download_url/file_id
  -> this MCP downloads the temporary URL
  -> this MCP writes the bytes locally
```

For ongoing use, configure a fixed HTTPS hostname / Named Tunnel and run `npm run stable`. Stable mode defaults to local port `8878`, while Quick mode defaults to `8765`, so both modes can coexist. See `deploy/cloudflared/config.example.yml` and the bilingual `docs/DEPLOYMENT.md` guide.
