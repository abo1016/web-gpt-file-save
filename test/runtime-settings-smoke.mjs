import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";

const root = await mkdtemp(path.join(os.tmpdir(), "web-gpt-file-save-settings-"));
const env = {
  ...process.env,
  MCP_SETTINGS_DIR: path.join(root, "private-settings"),
};

try {
  const mod = await import("../scripts/runtime-settings.mjs");
  const initial = await mod.loadRuntimeSettings({ cwd: root, env });
  assert.equal(initial.saveRoot, root);
  assert.ok(initial.authPassword.length >= 12);
  assert.equal(initial.stableTunnelName, "web-gpt-file-save");
  assert.equal(initial.quickPort, 8765);
  assert.equal(initial.stablePort, 8878);

  const target = path.join(root, "target-project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(target));
  await mod.updateRuntimeSettings({
    saveRoot: target,
    stablePublicBaseUrl: "https://files.example.com",
    stableTunnelName: "my-file-save",
    quickPort: 8766,
    stablePort: 8879,
  }, { cwd: root, env });

  const reloaded = await mod.loadRuntimeSettings({ cwd: root, env });
  assert.equal(reloaded.saveRoot, target);
  assert.equal(reloaded.stablePublicBaseUrl, "https://files.example.com");
  assert.equal(reloaded.stableTunnelName, "my-file-save");
  assert.equal(reloaded.quickPort, 8766);
  assert.equal(reloaded.stablePort, 8879);
  assert.equal(reloaded.authPassword, initial.authPassword);

  await assert.rejects(
    () => mod.updateRuntimeSettings({ stablePublicBaseUrl: "https://temp.trycloudflare.com" }, { cwd: root, env }),
    /must not be a Quick Tunnel/,
  );

  const mode = (await stat(reloaded.settingsFile)).mode & 0o777;
  assert.equal(mode, 0o600);
  const stored = JSON.parse(await readFile(reloaded.settingsFile, "utf8"));
  assert.equal(stored.saveRoot, target);

  console.log(JSON.stringify({
    ok: true,
    persistedSettings: true,
    fileMode: mode.toString(8),
    quickAndStableSeparated: true,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
