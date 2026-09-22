import path from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  publicBaseUrl: URL;
  resourceUrl: URL;
  protectedResourceMetadataUrl: URL;
  saveRoot: string;
  stateFile: string;
  authPassword: string;
  accessTokenTtlSeconds: number;
  maxFileBytes: number;
  downloadTimeoutMs: number;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseIntegerSetting(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function requireSecurePublicUrl(raw: string, allowInsecure: boolean): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP_PUBLIC_BASE_URL must not contain credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (url.protocol === "https:") return url;

  const isLoopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (allowInsecure && isLoopback) return url;

  throw new Error("MCP_PUBLIC_BASE_URL must use HTTPS (HTTP is allowed only for loopback tests)");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowInsecure = env.MCP_ALLOW_INSECURE_HTTP === "1";
  const publicBaseUrl = requireSecurePublicUrl(
    env.MCP_PUBLIC_BASE_URL ?? "http://127.0.0.1:8765",
    allowInsecure,
  );

  const authPassword = env.MCP_AUTH_PASSWORD ?? "";
  if (authPassword.length < 12) {
    throw new Error("MCP_AUTH_PASSWORD must be at least 12 characters");
  }

  const resourceUrl = new URL("/mcp", publicBaseUrl);
  const protectedResourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    publicBaseUrl,
  );

  const ttl = Number(env.MCP_ACCESS_TOKEN_TTL_SECONDS ?? "3600");
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error("MCP_ACCESS_TOKEN_TTL_SECONDS must be between 60 and 86400");
  }

  const maxFileBytes = parseIntegerSetting(
    "MCP_MAX_FILE_BYTES",
    env.MCP_MAX_FILE_BYTES,
    25 * 1024 * 1024,
    1,
    1024 * 1024 * 1024,
  );
  const downloadTimeoutMs = parseIntegerSetting(
    "MCP_DOWNLOAD_TIMEOUT_MS",
    env.MCP_DOWNLOAD_TIMEOUT_MS,
    30_000,
    1_000,
    10 * 60_000,
  );

  return {
    host: env.MCP_HOST ?? "127.0.0.1",
    port: parsePort(env.MCP_PORT),
    publicBaseUrl,
    resourceUrl,
    protectedResourceMetadataUrl,
    saveRoot: path.resolve(env.FILE_SAVE_ROOT ?? path.join(process.cwd(), "imports")),
    stateFile: path.resolve(
      env.MCP_STATE_FILE ?? path.join(process.cwd(), ".web-gpt-file-save", "oauth-state.json"),
    ),
    authPassword,
    accessTokenTtlSeconds: ttl,
    maxFileBytes,
    downloadTimeoutMs,
  };
}
