import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { importOpenAIFile, inferDestination } from "../src/importer.js";

const payload = Buffer.from("chatgpt-file-import-smoke-test\n", "utf8");
const replacementPayload = Buffer.from("chatgpt-file-import-replacement\n", "utf8");
const expectedSha = crypto.createHash("sha256").update(payload).digest("hex");

const server = http.createServer((req, res) => {
  if (req.url === "/file") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": payload.length });
    res.end(payload);
    return;
  }
  if (req.url === "/replacement") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": replacementPayload.length });
    res.end(replacementPayload);
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("unexpected test server address");

const root = await mkdtemp(path.join(os.tmpdir(), "web-gpt-file-save-"));
try {
  assert.equal(inferDestination({
    download_url: "https://example.com/file",
    file_id: "file_123",
    file_name: "nested/generated hero.png",
  }), "generated hero.png");
  assert.equal(inferDestination({
    download_url: "https://example.com/file",
    file_id: "file/unsafe id",
  }), "file_unsafe_id.bin");
  const result = await importOpenAIFile(
    root,
    "assets/demo.txt",
    {
      download_url: `http://127.0.0.1:${address.port}/file`,
      file_id: "file_mock_123",
      mime_type: "text/plain",
      file_name: "demo.txt",
    },
    { allowHttpForTests: true },
  );

  assert.equal(result.sha256, expectedSha);
  assert.deepEqual(await readFile(path.join(root, "assets/demo.txt")), payload);
  assert.equal(result.destination, "assets/demo.txt");

  const inferred = await importOpenAIFile(
    root,
    undefined,
    {
      download_url: `http://127.0.0.1:${address.port}/file`,
      file_id: "file_inferred",
      file_name: "generated-image.txt",
    },
    { allowHttpForTests: true },
  );
  assert.equal(inferred.destination, "generated-image.txt");
  assert.deepEqual(await readFile(path.join(root, "generated-image.txt")), payload);

  const overwritten = await importOpenAIFile(
    root,
    "assets/demo.txt",
    {
      download_url: `http://127.0.0.1:${address.port}/replacement`,
      file_id: "file_overwrite",
      file_name: "replacement.txt",
    },
    { allowHttpForTests: true, overwrite: true },
  );
  assert.equal(overwritten.destination, "assets/demo.txt");
  assert.deepEqual(await readFile(path.join(root, "assets/demo.txt")), replacementPayload);

  await assert.rejects(
    () => importOpenAIFile(root, "../escape.txt", {
      download_url: `http://127.0.0.1:${address.port}/file`,
      file_id: "file_mock_escape",
    }, { allowHttpForTests: true }),
    /escapes FILE_SAVE_ROOT/,
  );

  await assert.rejects(
    () => importOpenAIFile(root, "assets/demo.txt", {
      download_url: `http://127.0.0.1:${address.port}/file`,
      file_id: "file_mock_overwrite",
    }, { allowHttpForTests: true }),
    /EEXIST/,
  );

  console.log(JSON.stringify({ ok: true, savedPath: result.savedPath, sha256: result.sha256 }, null, 2));
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
