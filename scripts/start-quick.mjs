import { spawn } from "node:child_process";
import { loadRuntimeSettings } from "./runtime-settings.mjs";

const quickEnv = { ...process.env };
delete quickEnv.MCP_PUBLIC_BASE_URL;
const settings = await loadRuntimeSettings({ env: quickEnv });
if (!["127.0.0.1", "localhost", "::1"].includes(settings.host)) {
  throw new Error("Quick mode requires MCP_HOST to be loopback");
}

const originHost = settings.host === "::1" ? "[::1]" : settings.host;
const origin = `http://${originHost}:${settings.quickPort}`;
const tunnel = spawn("cloudflared", [
  "tunnel",
  "--no-autoupdate",
  "--url",
  origin,
], {
  stdio: ["ignore", "pipe", "pipe"],
});

tunnel.stdout.pipe(process.stdout);
tunnel.stderr.pipe(process.stderr);

function stopChild(child, signal = "SIGTERM") {
  if (child && child.exitCode === null && !child.killed) child.kill(signal);
}

async function waitForQuickUrl(child, timeoutMs = 30_000) {
  return await new Promise((resolve, reject) => {
    const regex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for Cloudflare Quick Tunnel URL")), timeoutMs);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      value instanceof Error ? reject(value) : resolve(value);
    };
    const onData = (chunk) => {
      const match = String(chunk).match(regex);
      if (match) finish(match[0]);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`cloudflared exited before publishing a URL (code ${code})`));

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

let publicBaseUrl;
try {
  publicBaseUrl = await waitForQuickUrl(tunnel);
} catch (error) {
  stopChild(tunnel);
  throw error;
}

const serverEnv = {
  ...process.env,
  MCP_PUBLIC_BASE_URL: publicBaseUrl,
  MCP_AUTH_PASSWORD: settings.authPassword,
  MCP_HOST: settings.host,
  MCP_PORT: String(settings.quickPort),
  FILE_SAVE_ROOT: settings.saveRoot,
  MCP_STATE_FILE: settings.stateFile,
};

const server = spawn(process.execPath, ["dist/src/server.js"], {
  env: serverEnv,
  stdio: "inherit",
});

console.error("\n=== web-gpt-file-save: QUICK MODE ===");
console.error(`ChatGPT MCP URL: ${publicBaseUrl}/mcp`);
console.error(`OAuth password: ${settings.authPassword}`);
console.error(`Local project root: ${settings.saveRoot}`);
console.error(`Local port: ${settings.quickPort}`);
console.error(`Settings file: ${settings.settingsFile}`);
console.error("This Quick Tunnel URL is temporary. If it changes, reconnect the ChatGPT MCP app.\n");

let stopping = false;
function shutdown(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  stopChild(server, signal);
  stopChild(tunnel, signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const [winner, code] = await Promise.race([
  new Promise((resolve) => server.once("exit", (exitCode) => resolve(["server", exitCode]))),
  new Promise((resolve) => tunnel.once("exit", (exitCode) => resolve(["tunnel", exitCode]))),
]);

shutdown();
if (!stopping || code) {
  console.error(`${winner} exited with code ${code ?? 0}`);
}
process.exitCode = code ?? 0;
