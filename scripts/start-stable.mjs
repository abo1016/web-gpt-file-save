import { spawn, spawnSync } from "node:child_process";
import { loadRuntimeSettings, validateStablePublicUrl } from "./runtime-settings.mjs";

const settings = await loadRuntimeSettings();
if (!settings.stablePublicBaseUrl) {
  throw new Error("Stable URL is not configured. Run: npm run configure -- --stable-url https://files.example.com");
}
const publicBaseUrl = validateStablePublicUrl(settings.stablePublicBaseUrl);
if (!["127.0.0.1", "localhost", "::1"].includes(settings.host)) {
  throw new Error("Stable Named Tunnel mode requires MCP_HOST to be loopback");
}

const serverEnv = {
  ...process.env,
  MCP_PUBLIC_BASE_URL: publicBaseUrl,
  MCP_AUTH_PASSWORD: settings.authPassword,
  MCP_HOST: settings.host,
  MCP_PORT: String(settings.stablePort),
  FILE_SAVE_ROOT: settings.saveRoot,
  MCP_STATE_FILE: settings.stateFile,
};

const preflight = spawnSync(process.execPath, ["scripts/production-preflight.mjs"], {
  env: serverEnv,
  stdio: "inherit",
});
if (preflight.error) throw preflight.error;
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

const server = spawn(process.execPath, ["dist/src/server.js"], {
  env: serverEnv,
  stdio: "inherit",
});

function stopChild(child, signal = "SIGTERM") {
  if (child && child.exitCode === null && !child.killed) child.kill(signal);
}

async function waitForHealth(timeoutMs = 15_000) {
  const host = settings.host === "::1" ? "[::1]" : settings.host;
  const healthUrl = `http://${host}:${settings.stablePort}/healthz`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`MCP server exited before becoming healthy (code ${server.exitCode})`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for local MCP health check at ${healthUrl}`);
}

try {
  await waitForHealth();
} catch (error) {
  stopChild(server);
  throw error;
}

const tunnelArgs = ["tunnel"];
if (settings.cloudflaredConfig) {
  tunnelArgs.push("--config", settings.cloudflaredConfig);
} else {
  const originHost = settings.host === "::1" ? "[::1]" : settings.host;
  tunnelArgs.push("--url", `http://${originHost}:${settings.stablePort}`);
}
tunnelArgs.push("--no-autoupdate", "run", settings.stableTunnelName);

const tunnel = spawn("cloudflared", tunnelArgs, { stdio: "inherit" });

console.error("\n=== web-gpt-file-save: STABLE MODE ===");
console.error(`ChatGPT MCP URL: ${publicBaseUrl}/mcp`);
console.error(`OAuth password: ${settings.authPassword}`);
console.error(`Local project root: ${settings.saveRoot}`);
console.error(`Local port: ${settings.stablePort}`);
console.error(`Named Tunnel: ${settings.stableTunnelName}`);
console.error(`Settings file: ${settings.settingsFile}`);
if (settings.cloudflaredConfig) console.error(`cloudflared config: ${settings.cloudflaredConfig}`);
console.error("The stable hostname should remain unchanged across service restarts.\n");

let stopping = false;
function shutdown(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  stopChild(server, signal);
  stopChild(tunnel, signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const [winner, code, error] = await Promise.race([
  new Promise((resolve) => server.once("exit", (exitCode) => resolve(["server", exitCode, null]))),
  new Promise((resolve) => server.once("error", (spawnError) => resolve(["server", 1, spawnError]))),
  new Promise((resolve) => tunnel.once("exit", (exitCode) => resolve(["tunnel", exitCode, null]))),
  new Promise((resolve) => tunnel.once("error", (spawnError) => resolve(["tunnel", 1, spawnError]))),
]);

shutdown();
if (error) console.error(`${winner} failed to start: ${error.message}`);
else console.error(`${winner} exited with code ${code ?? 0}`);
process.exitCode = code ?? 0;
