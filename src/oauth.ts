import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Express, Request, Response, NextFunction } from "express";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { AppConfig } from "./config.js";

interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource: string;
  expiresAt: number;
}

interface AuthorizationCode extends PendingAuthorization {
  code: string;
}

interface AccessTokenRecord {
  token: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface PersistedOAuthState {
  version: 1;
  clients: RegisteredClient[];
  tokens: AccessTokenRecord[];
}

function loadOAuthState(stateFile: string): PersistedOAuthState {
  let raw: string;
  try {
    raw = readFileSync(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, clients: [], tokens: [] };
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Partial<PersistedOAuthState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.clients) || !Array.isArray(parsed.tokens)) {
    throw new Error(`Invalid OAuth state file: ${stateFile}`);
  }

  return parsed as PersistedOAuthState;
}

const SUPPORTED_SCOPES = new Set(["files:write", "files:read"]);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function timingSafePasswordEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pkceS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

export class SingleUserOAuth {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly tokens = new Map<string, AccessTokenRecord>();

  constructor(private readonly config: AppConfig) {
    const state = loadOAuthState(config.stateFile);
    for (const client of state.clients) {
      if (client?.client_id && Array.isArray(client.redirect_uris)) {
        this.clients.set(client.client_id, client);
      }
    }
    for (const token of state.tokens) {
      if (token?.token && token.expiresAt > nowSeconds()) {
        this.tokens.set(token.token, token);
      }
    }
  }

  private persist(): void {
    const dir = path.dirname(this.config.stateFile);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.config.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const state: PersistedOAuthState = {
      version: 1,
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((token) => token.expiresAt > nowSeconds()),
    };

    try {
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, this.config.stateFile);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  install(app: Express): void {
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        issuer: this.config.publicBaseUrl.href.replace(/\/$/, ""),
        authorization_endpoint: new URL("/authorize", this.config.publicBaseUrl).href,
        token_endpoint: new URL("/token", this.config.publicBaseUrl).href,
        registration_endpoint: new URL("/register", this.config.publicBaseUrl).href,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...SUPPORTED_SCOPES],
        authorization_response_iss_parameter_supported: true,
      });
    });

    const resourceMetadata = (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        resource: this.config.resourceUrl.href,
        authorization_servers: [this.config.publicBaseUrl.href.replace(/\/$/, "")],
        scopes_supported: [...SUPPORTED_SCOPES],
      });
    };

    app.get("/.well-known/oauth-protected-resource", resourceMetadata);
    app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

    app.post("/register", (req, res) => this.register(req, res));
    app.get("/authorize", (req, res) => this.beginAuthorize(req, res));
    app.post("/authorize", (req, res) => this.finishAuthorize(req, res));
    app.post("/token", (req, res) => this.exchangeToken(req, res));
  }

  optionalBearerMiddleware() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const header = req.header("authorization");
      if (!header) {
        next();
        return;
      }

      const [scheme, token, ...extra] = header.trim().split(/\s+/);
      if (scheme?.toLowerCase() !== "bearer" || !token || extra.length > 0) {
        this.writeBearerError(res, "invalid_token", "Malformed bearer token");
        return;
      }

      try {
        (req as Request & { auth?: AuthInfo }).auth = await this.verifyAccessToken(token);
        next();
      } catch {
        this.writeBearerError(res, "invalid_token", "Access token is invalid or expired");
      }
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.tokens.get(token);
    if (!record || record.expiresAt <= nowSeconds()) {
      if (record) {
        this.tokens.delete(token);
        this.persist();
      }
      throw new Error("invalid_token");
    }
    if (record.resource !== this.config.resourceUrl.href) {
      throw new Error("wrong_resource");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
    };
  }

  hasScope(auth: AuthInfo | undefined, scope: string): boolean {
    return Boolean(auth?.scopes.includes(scope));
  }

  challenge(error: "invalid_token" | "insufficient_scope", description: string, scope = "files:write"): string {
    return [
      "Bearer",
      `resource_metadata="${this.config.protectedResourceMetadataUrl.href}"`,
      `scope="${scope}"`,
      `error="${error}"`,
      `error_description="${description.replaceAll('"', "'")}"`,
    ].join(", ");
  }

  private writeBearerError(res: Response, error: "invalid_token" | "insufficient_scope", description: string): void {
    res.setHeader("WWW-Authenticate", this.challenge(error, description));
    oauthError(res, error === "invalid_token" ? 401 : 403, error, description);
  }

  private register(req: Request, res: Response): void {
    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.filter((v: unknown): v is string => typeof v === "string")
      : [];

    if (redirectUris.length === 0 || redirectUris.length > 10) {
      oauthError(res, 400, "invalid_client_metadata", "redirect_uris is required");
      return;
    }

    try {
      for (const uri of redirectUris) {
        const parsed = new URL(uri);
        const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
        if (parsed.protocol !== "https:" && !loopback) {
          throw new Error("redirect URI must use HTTPS or loopback HTTP");
        }
      }
    } catch (error) {
      oauthError(res, 400, "invalid_client_metadata", error instanceof Error ? error.message : "invalid redirect URI");
      return;
    }

    const tokenAuthMethod = req.body?.token_endpoint_auth_method ?? "none";
    if (tokenAuthMethod !== "none") {
      oauthError(res, 400, "invalid_client_metadata", "Only public clients with token_endpoint_auth_method=none are supported");
      return;
    }

    const client: RegisteredClient = {
      client_id: crypto.randomUUID(),
      client_id_issued_at: nowSeconds(),
      client_name: typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 200) : undefined,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };

    this.clients.set(client.client_id, client);
    this.persist();
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(client);
  }

  private beginAuthorize(req: Request, res: Response): void {
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const responseType = String(req.query.response_type ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "");
    const resource = String(req.query.resource ?? "");
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const scopes = String(req.query.scope ?? "files:write").split(/\s+/).filter(Boolean);

    const client = this.clients.get(clientId);
    if (!client) {
      oauthError(res, 400, "invalid_request", "Unknown client_id");
      return;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      oauthError(res, 400, "invalid_request", "redirect_uri is not registered");
      return;
    }
    if (responseType !== "code") {
      this.redirectAuthorizeError(res, redirectUri, state, "unsupported_response_type", "Only response_type=code is supported");
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      this.redirectAuthorizeError(res, redirectUri, state, "invalid_request", "PKCE S256 is required");
      return;
    }
    if (resource !== this.config.resourceUrl.href) {
      this.redirectAuthorizeError(res, redirectUri, state, "invalid_target", "resource must exactly match the MCP resource URL");
      return;
    }
    if (scopes.length === 0 || scopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) {
      this.redirectAuthorizeError(res, redirectUri, state, "invalid_scope", "Unsupported scope requested");
      return;
    }

    const requestId = randomToken(24);
    this.pending.set(requestId, {
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      state,
      resource,
      expiresAt: nowSeconds() + 300,
    });

    const scopeText = htmlEscape(scopes.join(" "));
    const clientName = htmlEscape(client.client_name ?? "ChatGPT");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize web-gpt-file-save</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:8vh auto;padding:24px;color:#111}
.card{border:1px solid #ddd;border-radius:16px;padding:24px;box-shadow:0 8px 30px #0000000d}
input{width:100%;box-sizing:border-box;padding:12px;margin:8px 0 16px;border:1px solid #bbb;border-radius:8px}
button{padding:12px 18px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600}
small{color:#666}
</style>
</head>
<body><div class="card">
<h2>Authorize local file import</h2>
<p><strong>${clientName}</strong> requests <code>${scopeText}</code>.</p>
<p>The token can only target <code>${htmlEscape(this.config.resourceUrl.href)}</code>.</p>
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${requestId}">
<label>Local MCP password</label>
<input type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Authorize</button>
</form>
<p><small>This is the single-user demo login for web-gpt-file-save.</small></p>
</div></body></html>`);
  }

  private finishAuthorize(req: Request, res: Response): void {
    const requestId = String(req.body?.request_id ?? "");
    const password = String(req.body?.password ?? "");
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);

    if (!pending || pending.expiresAt <= nowSeconds()) {
      oauthError(res, 400, "invalid_request", "Authorization request expired");
      return;
    }
    if (!timingSafePasswordEqual(password, this.config.authPassword)) {
      this.redirectAuthorizeError(res, pending.redirectUri, pending.state, "access_denied", "Invalid password");
      return;
    }

    const code = randomToken(32);
    this.codes.set(code, { ...pending, code, expiresAt: nowSeconds() + 300 });

    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.state) target.searchParams.set("state", pending.state);
    target.searchParams.set("iss", this.config.publicBaseUrl.href.replace(/\/$/, ""));
    res.redirect(302, target.href);
  }

  private exchangeToken(req: Request, res: Response): void {
    const grantType = String(req.body?.grant_type ?? "");
    const code = String(req.body?.code ?? "");
    const verifier = String(req.body?.code_verifier ?? "");
    const clientId = String(req.body?.client_id ?? "");
    const redirectUri = String(req.body?.redirect_uri ?? "");
    const resource = String(req.body?.resource ?? "");

    if (grantType !== "authorization_code") {
      oauthError(res, 400, "unsupported_grant_type", "Only authorization_code is supported");
      return;
    }

    const record = this.codes.get(code);
    if (!record || record.expiresAt <= nowSeconds()) {
      if (record) this.codes.delete(code);
      oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
      return;
    }
    if (clientId !== record.clientId || !this.clients.has(clientId)) {
      oauthError(res, 400, "invalid_grant", "Authorization code was issued to another client");
      return;
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      oauthError(res, 400, "invalid_grant", "redirect_uri does not match");
      return;
    }
    if (resource !== record.resource || resource !== this.config.resourceUrl.href) {
      oauthError(res, 400, "invalid_target", "resource does not match");
      return;
    }
    if (!verifier || pkceS256(verifier) !== record.codeChallenge) {
      oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }

    this.codes.delete(code);

    const token = randomToken(32);
    const expiresAt = nowSeconds() + this.config.accessTokenTtlSeconds;
    this.tokens.set(token, {
      token,
      clientId,
      scopes: record.scopes,
      resource: record.resource,
      expiresAt,
    });
    this.persist();

    res.setHeader("Cache-Control", "no-store");
    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: record.scopes.join(" "),
    });
  }

  private redirectAuthorizeError(
    res: Response,
    redirectUri: string,
    state: string | undefined,
    error: string,
    description: string,
  ): void {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    target.searchParams.set("iss", this.config.publicBaseUrl.href.replace(/\/$/, ""));
    res.redirect(302, target.href);
  }
}
