import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { loadRuntimeSettings, updateRuntimeSettings, validateStablePublicUrl } from "./runtime-settings.mjs";

function usage() {
  console.log(`Usage:
  npm run configure
  npm run configure -- --save-root <path>
  npm run configure -- --stable-url <https://host>
  npm run configure -- --tunnel-name <name>
  npm run configure -- --cloudflared-config <path>
  npm run configure -- --auth-password <password>
  npm run configure -- --quick-port <port>
  npm run configure -- --stable-port <port>

Options may be combined. Running without options initializes local settings with the
current directory as FILE_SAVE_ROOT and generates a reusable OAuth approval password.`);
}

const args = process.argv.slice(2);
const patch = {};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  index += 1;

  if (arg === "--save-root") patch.saveRoot = value;
  else if (arg === "--stable-url") patch.stablePublicBaseUrl = validateStablePublicUrl(value);
  else if (arg === "--tunnel-name") patch.stableTunnelName = value;
  else if (arg === "--cloudflared-config") patch.cloudflaredConfig = value;
  else if (arg === "--auth-password") patch.authPassword = value;
  else if (arg === "--quick-port") patch.quickPort = Number(value);
  else if (arg === "--stable-port") patch.stablePort = Number(value);
  else throw new Error(`Unknown option: ${arg}`);
}

if (patch.saveRoot) {
  const expanded = patch.saveRoot === "~"
    ? os.homedir()
    : patch.saveRoot.startsWith("~/")
      ? path.join(os.homedir(), patch.saveRoot.slice(2))
      : patch.saveRoot;
  const resolved = path.resolve(process.cwd(), expanded);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`--save-root is not a directory: ${resolved}`);
}

if (Object.keys(patch).length > 0) {
  await updateRuntimeSettings(patch);
}

const summaryEnv = { ...process.env };
for (const key of [
  "FILE_SAVE_ROOT",
  "MCP_AUTH_PASSWORD",
  "MCP_PUBLIC_BASE_URL",
  "MCP_TUNNEL_NAME",
  "CLOUDFLARED_CONFIG",
  "MCP_STATE_FILE",
  "MCP_PORT",
  "MCP_QUICK_PORT",
  "MCP_STABLE_PORT",
]) {
  delete summaryEnv[key];
}
const settings = await loadRuntimeSettings({ env: summaryEnv });
console.log(JSON.stringify({
  ok: true,
  settingsFile: settings.settingsFile,
  saveRoot: settings.saveRoot,
  stablePublicBaseUrl: settings.stablePublicBaseUrl ?? null,
  stableTunnelName: settings.stableTunnelName,
  cloudflaredConfig: settings.cloudflaredConfig ?? null,
  authPasswordStored: true,
  stateFile: settings.stateFile,
  quickPort: settings.quickPort,
  stablePort: settings.stablePort,
}, null, 2));
console.log("\nOAuth approval password is stored locally. Run: npm run auth:show");
