import type { Server as HttpServer } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AppConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { SingleUserOAuth } from "./oauth.js";

function allowedHostMiddleware(config: AppConfig) {
  const publicHost = config.publicBaseUrl.hostname.toLowerCase();
  const allowed = new Set([publicHost, "127.0.0.1", "localhost", "[::1]"]);

  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.header("host") ?? "";
    const host = raw.startsWith("[")
      ? raw.slice(0, raw.indexOf("]") + 1).toLowerCase()
      : raw.split(":")[0]?.toLowerCase();

    if (!host || !allowed.has(host)) {
      res.status(403).json({ error: "forbidden", error_description: "Host header is not allowed" });
      return;
    }
    next();
  };
}

function originMiddleware(config: AppConfig) {
  const publicOrigin = config.publicBaseUrl.origin;

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (!origin) {
      next();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      res.status(403).json({ error: "forbidden", error_description: "Invalid Origin header" });
      return;
    }

    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.origin !== publicOrigin && !loopback) {
      res.status(403).json({ error: "forbidden", error_description: "Origin is not allowed" });
      return;
    }
    next();
  };
}

export function createHttpApp(config: AppConfig) {
  const app = express();
  const oauth = new SingleUserOAuth(config);

  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(allowedHostMiddleware(config));
  app.use(originMiddleware(config));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "web-gpt-file-save", resource: config.resourceUrl.href });
  });

  oauth.install(app);

  const mcpHandler = createMcpHandler(
    () => createMcpServer(config, oauth),
    { legacy: "stateless" },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error("[mcp-http]", error),
  });

  app.all(
    "/mcp",
    oauth.optionalBearerMiddleware(),
    (req, res) => {
      void nodeMcpHandler(req, res, req.body);
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return { app, oauth };
}

export async function startHttpServer(config: AppConfig): Promise<HttpServer> {
  const { app } = createHttpApp(config);
  return await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.once("error", reject);
  });
}
