import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.P1_PUBLIC_BASE_URL;
if (!base) throw new Error("P1_PUBLIC_BASE_URL is required");

const mcpUrl = new URL("/mcp", base);
const transport = new StreamableHTTPClientTransport(mcpUrl);
const client = new Client({ name: "public-smoke", version: "0.2.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const saveTool = tools.tools.find((tool) => tool.name === "save_file");
  const importTool = tools.tools.find((tool) => tool.name === "import_file");
  assert.ok(saveTool, "public MCP must advertise save_file");
  assert.ok(importTool, "public MCP must advertise import_file");
  assert.deepEqual(saveTool._meta?.["openai/fileParams"], ["file"]);

  const unauth = await client.callTool({
    name: "save_file",
    arguments: {
      file: { download_url: "https://example.com/demo.txt", file_id: "file_public_probe" },
      destination: "p1/public-probe.txt",
      overwrite: false,
    },
  });
  assert.equal(unauth.isError, true);
  assert.ok(Array.isArray((unauth._meta as any)?.["mcp/www_authenticate"]));

  console.log(JSON.stringify({
    ok: true,
    mcpUrl: mcpUrl.href,
    tools: tools.tools.map((tool) => tool.name),
    fileParams: saveTool._meta?.["openai/fileParams"],
    authChallenge: (unauth._meta as any)?.["mcp/www_authenticate"],
  }, null, 2));
} finally {
  await client.close();
}
