import { spawnSync } from "node:child_process";
import { loadRuntimeSettings, validateStablePublicUrl } from "./runtime-settings.mjs";

const settings = await loadRuntimeSettings();
if (!settings.stablePublicBaseUrl) {
  throw new Error("Stable URL is not configured. Run: npm run configure -- --stable-url https://files.example.com");
}

const env = {
  ...process.env,
  MCP_PUBLIC_BASE_URL: validateStablePublicUrl(settings.stablePublicBaseUrl),
  MCP_AUTH_PASSWORD: settings.authPassword,
  MCP_HOST: settings.host,
  MCP_PORT: String(settings.stablePort),
  FILE_SAVE_ROOT: settings.saveRoot,
  MCP_STATE_FILE: settings.stateFile,
};

const result = spawnSync(process.execPath, ["scripts/production-preflight.mjs"], {
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
