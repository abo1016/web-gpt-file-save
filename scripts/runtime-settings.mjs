import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const SETTINGS_VERSION = 1;
const DEFAULT_TUNNEL_NAME = "web-gpt-file-save";
const DEFAULT_QUICK_PORT = 8765;
const DEFAULT_STABLE_PORT = 8878;

function normalizePort(value, fallback, label) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return port;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function locations(cwd, env) {
  const settingsDir = path.resolve(cwd, expandHome(env.MCP_SETTINGS_DIR ?? ".web-gpt-file-save"));
  return {
    settingsDir,
    settingsFile: path.join(settingsDir, "settings.json"),
  };
}

async function readStoredSettings(settingsFile) {
  try {
    const parsed = JSON.parse(await readFile(settingsFile, "utf8"));
    if (parsed?.version !== SETTINGS_VERSION || typeof parsed !== "object") {
      throw new Error(`Unsupported settings file version in ${settingsFile}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeStoredSettings(settingsFile, value) {
  const dir = path.dirname(settingsFile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${settingsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, settingsFile);
    await chmod(settingsFile, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function normalizeStoredSettings(stored, cwd) {
  return {
    version: SETTINGS_VERSION,
    saveRoot: path.resolve(cwd, expandHome(stored?.saveRoot ?? cwd)),
    authPassword: typeof stored?.authPassword === "string" && stored.authPassword.length >= 12
      ? stored.authPassword
      : crypto.randomBytes(24).toString("base64url"),
    stablePublicBaseUrl: typeof stored?.stablePublicBaseUrl === "string"
      ? stored.stablePublicBaseUrl
      : undefined,
    stableTunnelName: typeof stored?.stableTunnelName === "string" && stored.stableTunnelName.trim()
      ? stored.stableTunnelName.trim()
      : DEFAULT_TUNNEL_NAME,
    cloudflaredConfig: typeof stored?.cloudflaredConfig === "string" && stored.cloudflaredConfig.trim()
      ? path.resolve(cwd, expandHome(stored.cloudflaredConfig))
      : undefined,
    quickPort: normalizePort(stored?.quickPort, DEFAULT_QUICK_PORT, "quickPort"),
    stablePort: normalizePort(stored?.stablePort, DEFAULT_STABLE_PORT, "stablePort"),
  };
}

async function ensureStoredSettings({ cwd = process.cwd(), env = process.env } = {}) {
  const { settingsFile, settingsDir } = locations(cwd, env);
  const current = await readStoredSettings(settingsFile);
  const normalized = normalizeStoredSettings(current, cwd);

  if (!current || JSON.stringify(current) !== JSON.stringify(normalized)) {
    await writeStoredSettings(settingsFile, normalized);
  }

  return { settingsFile, settingsDir, stored: normalized };
}

export function validateStablePublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("Stable public URL must use HTTPS");
  }
  if (url.hostname.endsWith(".trycloudflare.com")) {
    throw new Error("Stable public URL must not be a Quick Tunnel (*.trycloudflare.com) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Stable public URL must not contain credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href.replace(/\/$/, "");
}

export async function updateRuntimeSettings(patch, options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;
  const { settingsFile, stored } = await ensureStoredSettings({ cwd, env });
  const next = { ...stored };

  if (patch.saveRoot !== undefined) {
    next.saveRoot = path.resolve(cwd, expandHome(patch.saveRoot));
  }
  if (patch.authPassword !== undefined) {
    if (patch.authPassword.length < 12) throw new Error("Auth password must contain at least 12 characters");
    next.authPassword = patch.authPassword;
  }
  if (patch.stablePublicBaseUrl !== undefined) {
    next.stablePublicBaseUrl = validateStablePublicUrl(patch.stablePublicBaseUrl);
  }
  if (patch.stableTunnelName !== undefined) {
    const name = patch.stableTunnelName.trim();
    if (!name) throw new Error("Stable tunnel name must not be empty");
    next.stableTunnelName = name;
  }
  if (patch.quickPort !== undefined) {
    next.quickPort = normalizePort(patch.quickPort, DEFAULT_QUICK_PORT, "quickPort");
  }
  if (patch.stablePort !== undefined) {
    next.stablePort = normalizePort(patch.stablePort, DEFAULT_STABLE_PORT, "stablePort");
  }
  if (patch.cloudflaredConfig !== undefined) {
    next.cloudflaredConfig = patch.cloudflaredConfig
      ? path.resolve(cwd, expandHome(patch.cloudflaredConfig))
      : undefined;
  }

  await writeStoredSettings(settingsFile, next);
  return { settingsFile, stored: next };
}

export async function loadRuntimeSettings({ cwd = process.cwd(), env = process.env } = {}) {
  const { settingsFile, settingsDir, stored } = await ensureStoredSettings({ cwd, env });
  const saveRoot = path.resolve(cwd, expandHome(env.FILE_SAVE_ROOT ?? stored.saveRoot));
  const authPassword = env.MCP_AUTH_PASSWORD ?? stored.authPassword;
  if (authPassword.length < 12) throw new Error("MCP_AUTH_PASSWORD must contain at least 12 characters");

  const stablePublicBaseUrl = env.MCP_PUBLIC_BASE_URL
    ? validateStablePublicUrl(env.MCP_PUBLIC_BASE_URL)
    : stored.stablePublicBaseUrl;
  const stableTunnelName = (env.MCP_TUNNEL_NAME ?? stored.stableTunnelName).trim();
  const cloudflaredConfigRaw = env.CLOUDFLARED_CONFIG ?? stored.cloudflaredConfig;

  return {
    settingsFile,
    settingsDir,
    saveRoot,
    authPassword,
    stateFile: path.resolve(cwd, expandHome(env.MCP_STATE_FILE ?? path.join(settingsDir, "oauth-state.json"))),
    host: env.MCP_HOST ?? "127.0.0.1",
    port: normalizePort(env.MCP_PORT, DEFAULT_QUICK_PORT, "MCP_PORT"),
    quickPort: normalizePort(env.MCP_PORT ?? env.MCP_QUICK_PORT ?? stored.quickPort, DEFAULT_QUICK_PORT, "Quick port"),
    stablePort: normalizePort(env.MCP_PORT ?? env.MCP_STABLE_PORT ?? stored.stablePort, DEFAULT_STABLE_PORT, "Stable port"),
    stablePublicBaseUrl,
    stableTunnelName,
    cloudflaredConfig: cloudflaredConfigRaw
      ? path.resolve(cwd, expandHome(cloudflaredConfigRaw))
      : undefined,
  };
}
