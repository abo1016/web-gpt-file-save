#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startHttpServer(config);
  console.error(
    `web-gpt-file-save listening on http://${config.host}:${config.port} (public: ${config.resourceUrl.href})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
