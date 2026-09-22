const errors = [];
const warnings = [];

const rawPublicUrl = process.env.MCP_PUBLIC_BASE_URL ?? "";
let publicUrl;
try {
  publicUrl = new URL(rawPublicUrl);
} catch {
  errors.push("MCP_PUBLIC_BASE_URL must be an absolute HTTPS URL");
}

if (publicUrl) {
  if (publicUrl.protocol !== "https:") {
    errors.push("MCP_PUBLIC_BASE_URL must use HTTPS in stable mode");
  }
  if (publicUrl.hostname.endsWith(".trycloudflare.com")) {
    errors.push("Quick Tunnel URLs (*.trycloudflare.com) belong to quick mode and are rejected by stable-mode preflight");
  }
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    errors.push("MCP_PUBLIC_BASE_URL must not contain credentials, query, or fragment");
  }
}

if ((process.env.MCP_AUTH_PASSWORD ?? "").length < 12) {
  errors.push("MCP_AUTH_PASSWORD must be set and contain at least 12 characters");
}

if (!process.env.FILE_SAVE_ROOT) {
  errors.push("FILE_SAVE_ROOT must be explicitly set for stable mode");
}

if (!process.env.MCP_STATE_FILE) {
  warnings.push("MCP_STATE_FILE is not set; the default project-local .web-gpt-file-save/oauth-state.json will be used");
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  warnings.push(`MCP_HOST=${host} is not loopback; verify that direct network exposure is intentional`);
}

if (errors.length > 0) {
  console.error("Stable-mode preflight failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  publicBaseUrl: publicUrl.href.replace(/\/$/, ""),
  host,
  port: Number(process.env.MCP_PORT ?? "8765"),
  saveRoot: process.env.FILE_SAVE_ROOT,
  stateFile: process.env.MCP_STATE_FILE ?? ".web-gpt-file-save/oauth-state.json",
  warnings,
}, null, 2));
