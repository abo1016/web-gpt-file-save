import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const rawBase = process.env.P1_PUBLIC_BASE_URL;
const password = process.env.P1_AUTH_PASSWORD;
if (!rawBase) throw new Error("P1_PUBLIC_BASE_URL is required");
if (!password) throw new Error("P1_AUTH_PASSWORD is required");

const baseUrl = new URL(rawBase);
const resourceUrl = new URL("/mcp", baseUrl);
const redirectUri = "http://127.0.0.1:7777/oauth/callback";
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

const metadataResponse = await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl));
assert.equal(metadataResponse.status, 200);
const metadata = await metadataResponse.json() as any;
assert.equal(metadata.authorization_endpoint, new URL("/authorize", baseUrl).href);
assert.equal(metadata.token_endpoint, new URL("/token", baseUrl).href);
assert.equal(metadata.registration_endpoint, new URL("/register", baseUrl).href);

const registrationResponse = await fetch(new URL("/register", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Public OAuth Smoke Test",
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
  state: "public-oauth-smoke-state",
  resource: resourceUrl.href,
}).toString();

const authorizePage = await fetch(authorizeUrl, { redirect: "manual" });
assert.equal(authorizePage.status, 200);
const html = await authorizePage.text();
const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
assert.ok(requestId);

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
assert.equal(callback.searchParams.get("state"), "public-oauth-smoke-state");
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
    resource: resourceUrl.href,
  }),
});
assert.equal(tokenResponse.status, 200);
const token = await tokenResponse.json() as any;
assert.equal(token.token_type, "Bearer");
assert.ok(token.access_token);
assert.equal(token.scope, "files:write");

const transport = new StreamableHTTPClientTransport(resourceUrl, {
  requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
});
const client = new Client({ name: "public-oauth-authorized-smoke", version: "0.3.0" });

try {
  await client.connect(transport);
  const projectContext = await client.callTool({
    name: "get_project_context",
    arguments: {},
  });
  assert.notEqual(projectContext.isError, true);
  assert.equal((projectContext.structuredContent as any)?.destinationMode, "relative");

  const saveProbe = await client.callTool({
    name: "save_file",
    arguments: {
      file: { download_url: "https://127.0.0.1:9/file", file_id: "file_public_auth_probe" },
      destination: "p1/public-authenticated-probe.bin",
      overwrite: false,
    },
  });
  assert.equal(saveProbe.isError, true);
  const text = (saveProbe.content?.[0] as any)?.text ?? "";
  assert.match(text, /Private or reserved-network download URLs are not allowed/);
  assert.equal((saveProbe._meta as any)?.["mcp/www_authenticate"], undefined);

  console.log(JSON.stringify({
    ok: true,
    oauth: "authorization_code+PKCE-S256",
    dynamicClientRegistration: true,
    resource: resourceUrl.href,
    projectContextAuthorized: true,
    saveToolAuthorized: true,
  }, null, 2));
} finally {
  await client.close();
}
