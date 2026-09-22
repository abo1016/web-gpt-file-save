import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AppConfig } from "../src/config.js";
import { createHttpApp } from "../src/http-server.js";
import { SingleUserOAuth } from "../src/oauth.js";

const password = "oauth-smoke-password";
const saveRoot = await mkdtemp(path.join(os.tmpdir(), "web-gpt-file-save-oauth-"));
const config = {
  host: "127.0.0.1",
  port: 0,
  publicBaseUrl: new URL("http://127.0.0.1"),
  resourceUrl: new URL("http://127.0.0.1/mcp"),
  protectedResourceMetadataUrl: new URL("http://127.0.0.1/.well-known/oauth-protected-resource/mcp"),
  saveRoot,
  stateFile: path.join(saveRoot, "oauth-state.json"),
  authPassword: password,
  accessTokenTtlSeconds: 3600,
  maxFileBytes: 25 * 1024 * 1024,
  downloadTimeoutMs: 30_000,
} satisfies AppConfig;

const { app } = createHttpApp(config);
const httpServer = app.listen(0, "127.0.0.1");
await once(httpServer, "listening");
const address = httpServer.address();
if (!address || typeof address === "string") throw new Error("unexpected listener address");

const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
config.publicBaseUrl = baseUrl;
config.resourceUrl = new URL("/mcp", baseUrl);
config.protectedResourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", baseUrl);

const redirectUri = "http://127.0.0.1:7777/oauth/callback";
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

try {
  const asMetadataResponse = await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl));
  assert.equal(asMetadataResponse.status, 200);
  const asMetadata = await asMetadataResponse.json() as any;
  assert.equal(asMetadata.authorization_endpoint, new URL("/authorize", baseUrl).href);
  assert.equal(asMetadata.token_endpoint, new URL("/token", baseUrl).href);
  assert.equal(asMetadata.registration_endpoint, new URL("/register", baseUrl).href);
  assert.ok(asMetadata.code_challenge_methods_supported.includes("S256"));

  const resourceMetadataResponse = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", baseUrl));
  assert.equal(resourceMetadataResponse.status, 200);
  const resourceMetadata = await resourceMetadataResponse.json() as any;
  assert.equal(resourceMetadata.resource, config.resourceUrl.href);
  assert.deepEqual(resourceMetadata.authorization_servers, [baseUrl.href.replace(/\/$/, "")]);

  const registrationResponse = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "OAuth Smoke Test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registration = await registrationResponse.json() as any;
  assert.ok(registration.client_id);

  const authorizeUrl = new URL("/authorize", baseUrl);
  authorizeUrl.search = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "files:write",
    state: "oauth-smoke-state",
    resource: config.resourceUrl.href,
  }).toString();

  const authorizePage = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizePage.status, 200);
  const html = await authorizePage.text();
  const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId, "authorization page must carry a request_id");

  const approval = await fetch(new URL("/authorize", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, password }),
  });
  assert.equal(approval.status, 302);
  const callbackLocation = approval.headers.get("location");
  assert.ok(callbackLocation);
  const callback = new URL(callbackLocation);
  assert.equal(callback.searchParams.get("state"), "oauth-smoke-state");
  assert.equal(callback.searchParams.get("iss"), baseUrl.href.replace(/\/$/, ""));
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      resource: config.resourceUrl.href,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json() as any;
  assert.equal(token.token_type, "Bearer");
  assert.ok(token.access_token);
  assert.equal(token.scope, "files:write");

  const reloadedOauth = new SingleUserOAuth(config);
  const persistedAuth = await reloadedOauth.verifyAccessToken(token.access_token);
  assert.equal(persistedAuth.clientId, registration.client_id);
  assert.ok(persistedAuth.scopes.includes("files:write"));

  const transport = new StreamableHTTPClientTransport(config.resourceUrl, {
    requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
  });
  const client = new Client({ name: "oauth-authorized-smoke", version: "0.2.0" });
  try {
    await client.connect(transport);
    const projectContext = await client.callTool({
      name: "get_project_context",
      arguments: {},
    });
    assert.notEqual(projectContext.isError, true);
    assert.equal((projectContext.structuredContent as any)?.projectRoot, saveRoot);
    assert.equal((projectContext.structuredContent as any)?.destinationMode, "relative");
    const shownConfig = await client.callTool({
      name: "show_config",
      arguments: {},
    });
    assert.notEqual(shownConfig.isError, true);
    assert.equal((shownConfig.structuredContent as any)?.root, saveRoot);
    const result = await client.callTool({
      name: "save_file",
      arguments: {
        file: { download_url: "https://127.0.0.1:9/file", file_id: "file_auth_probe" },
        destination: "p1/authenticated-probe.bin",
        overwrite: false,
      },
    });

    assert.equal(result.isError, true);
    const text = (result.content?.[0] as any)?.text ?? "";
    assert.match(text, /Private or reserved-network download URLs are not allowed/);
    assert.equal((result._meta as any)?.["mcp/www_authenticate"], undefined);
  } finally {
    await client.close();
  }

  console.log(JSON.stringify({
    ok: true,
    oauth: "authorization_code+PKCE-S256",
    dynamicClientRegistration: true,
    resource: config.resourceUrl.href,
    scope: token.scope,
  }, null, 2));
} finally {
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  await rm(saveRoot, { recursive: true, force: true });
}
