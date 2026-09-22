import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AppConfig } from "../src/config.js";
import { createHttpApp } from "../src/http-server.js";

const saveRoot = await mkdtemp(path.join(os.tmpdir(), "web-gpt-file-save-protocol-"));
const { app } = createHttpApp({
  host: "127.0.0.1",
  port: 0,
  publicBaseUrl: new URL("http://127.0.0.1"),
  resourceUrl: new URL("http://127.0.0.1/mcp"),
  protectedResourceMetadataUrl: new URL("http://127.0.0.1/.well-known/oauth-protected-resource/mcp"),
  saveRoot,
  stateFile: path.join(saveRoot, "oauth-state.json"),
  authPassword: "protocol-test-password",
  accessTokenTtlSeconds: 3600,
  maxFileBytes: 25 * 1024 * 1024,
  downloadTimeoutMs: 30_000,
} satisfies AppConfig);

const httpServer = app.listen(0, "127.0.0.1");
await once(httpServer, "listening");
const address = httpServer.address();
if (!address || typeof address === "string") throw new Error("unexpected listener address");
const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl));
const client = new Client({ name: "protocol-smoke", version: "0.2.0" });

try {
  await client.connect(transport);
  const result = await client.listTools();
  const saveTool = result.tools.find((tool) => tool.name === "save_file");
  const importTool = result.tools.find((tool) => tool.name === "import_file");
  const projectContextTool = result.tools.find((tool) => tool.name === "get_project_context");
  assert.ok(saveTool, "save_file tool must be advertised");
  assert.ok(importTool, "import_file tool must be advertised");
  assert.ok(projectContextTool, "get_project_context tool must be advertised");
  assert.deepEqual(projectContextTool.inputSchema.required ?? [], []);
  assert.deepEqual(projectContextTool._meta?.["securitySchemes"], [{ type: "oauth2", scopes: ["files:write"] }]);
  const showConfigTool = result.tools.find((tool) => tool.name === "show_config");
  assert.ok(showConfigTool, "show_config tool must be advertised");
  assert.deepEqual(showConfigTool._meta?.["securitySchemes"], [{ type: "oauth2", scopes: ["files:write"] }]);
  assert.deepEqual(saveTool._meta?.["openai/fileParams"], ["file"]);
  assert.deepEqual(importTool._meta?.["openai/fileParams"], ["file"]);
  assert.deepEqual(saveTool._meta?.["securitySchemes"], [{ type: "oauth2", scopes: ["files:write"] }]);

  const schema = saveTool.inputSchema as any;
  const fileSchema = schema.properties?.file;
  assert.ok(fileSchema, "file schema must exist");
  for (const key of ["download_url", "file_id", "mime_type", "file_name"]) {
    assert.ok(fileSchema.properties?.[key], `file schema must declare ${key}`);
  }
  assert.deepEqual(new Set(fileSchema.required ?? []), new Set(["download_url", "file_id"]));
  assert.ok(!(schema.required ?? []).includes("destination"), "destination must be optional");

  const unauth = await client.callTool({
    name: "save_file",
    arguments: {
      file: { download_url: "https://127.0.0.1:9/file", file_id: "file_auth_probe" },
      destination: "p1/auth-probe.bin",
      overwrite: false,
    },
  });
  assert.equal(unauth.isError, true);
  assert.ok(Array.isArray((unauth._meta as any)?.["mcp/www_authenticate"]));

  const unauthProjectContext = await client.callTool({
    name: "get_project_context",
    arguments: {},
  });
  assert.equal(unauthProjectContext.isError, true);
  assert.ok(Array.isArray((unauthProjectContext._meta as any)?.["mcp/www_authenticate"]));

  const unauthShowConfig = await client.callTool({
    name: "show_config",
    arguments: {},
  });
  assert.equal(unauthShowConfig.isError, true);
  assert.ok(Array.isArray((unauthShowConfig._meta as any)?.["mcp/www_authenticate"]));

  console.log(JSON.stringify({
    ok: true,
    transport: "streamable-http",
    tools: result.tools.map((tool) => tool.name),
    fileParams: saveTool._meta?.["openai/fileParams"],
    securitySchemes: saveTool._meta?.["securitySchemes"],
    unauthChallenge: (unauth._meta as any)?.["mcp/www_authenticate"],
  }, null, 2));
} finally {
  await client.close();
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  await rm(saveRoot, { recursive: true, force: true });
}
