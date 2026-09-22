import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { importOpenAIFile } from "./importer.js";
import type { SingleUserOAuth } from "./oauth.js";

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).strict();

function authChallengeResult(oauth: SingleUserOAuth, auth: AuthInfo | undefined) {
  const hasToken = Boolean(auth);
  const challenge = hasToken
    ? oauth.challenge("insufficient_scope", "The files:write scope is required")
    : oauth.challenge("invalid_token", "Authentication is required");

  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: hasToken
        ? "Authentication succeeded but the token is missing files:write."
        : "Authentication is required before importing files.",
    }],
    _meta: {
      "mcp/www_authenticate": [challenge],
    },
  };
}

export function createMcpServer(config: AppConfig, oauth: SingleUserOAuth): McpServer {
  const server = new McpServer({
    name: "web-gpt-file-save",
    version: "0.3.0",
  });

  const registerSaveTool = (name: "save_file" | "import_file", legacy: boolean) => {
    server.registerTool(
      name,
      {
        title: legacy ? "Import conversation file (legacy)" : "Save conversation file locally",
        description: legacy
          ? "Legacy compatibility alias for save_file. Prefer save_file for new calls."
          : "Use this when the user asks to save, export, download, copy, or persist a ChatGPT conversation file or generated file to the configured local project. The file parameter is supplied by ChatGPT. destination is optional and defaults to the original file name.",
        inputSchema: z.object({
          file: OpenAIFileSchema,
          destination: z.string().min(1).optional().describe("Optional relative path below FILE_SAVE_ROOT, e.g. assets/hero.png. Omit to use the original file name."),
          overwrite: z.boolean().optional().default(false),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        _meta: {
          "openai/fileParams": ["file"],
          "securitySchemes": [{ type: "oauth2", scopes: ["files:write"] }],
        },
      },
      async ({ file, destination, overwrite }, ctx) => {
        const auth = ctx.http?.authInfo;
        if (!oauth.hasScope(auth, "files:write")) {
          return authChallengeResult(oauth, auth);
        }

        try {
          const result = await importOpenAIFile(config.saveRoot, destination, file, {
            overwrite,
            maxBytes: config.maxFileBytes,
            downloadTimeoutMs: config.downloadTimeoutMs,
          });
          console.error(JSON.stringify({
            event: "file_saved",
            tool: name,
            fileId: result.fileId,
            destination: result.destination,
            bytes: result.bytes,
            sha256: result.sha256,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }],
            structuredContent: { ok: true, ...result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({
            event: "file_save_failed",
            tool: name,
            fileId: file.file_id,
            destination: destination ?? null,
            error: message,
          }));
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
          };
        }
      },
    );
  };

  registerSaveTool("save_file", false);
  registerSaveTool("import_file", true);

  server.registerTool(
    "get_project_context",
    {
      title: "Get configured local project context",
      description: "Use this before asking the user for a local project path. Takes no arguments and returns the already-configured local project/save root. The user should not need to repeat an absolute path in each conversation; save_file destinations stay relative to this root.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {
        "securitySchemes": [{ type: "oauth2", scopes: ["files:write"] }],
      },
    },
    async (_args, ctx) => {
      const auth = ctx.http?.authInfo;
      if (!oauth.hasScope(auth, "files:write")) {
        return authChallengeResult(oauth, auth);
      }

      const project = {
        projectRoot: config.saveRoot,
        saveRoot: config.saveRoot,
        destinationMode: "relative",
        destinationOptional: true,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(project, null, 2) }],
        structuredContent: project,
      };
    },
  );

  server.registerTool(
    "show_config",
    {
      title: "Show file-save configuration",
      description: "Authenticated compatibility diagnostic for the configured file-save service. Prefer get_project_context when the goal is to discover the local project path without asking the user.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {
        "securitySchemes": [{ type: "oauth2", scopes: ["files:write"] }],
      },
    },
    async (_args, ctx) => {
      const auth = ctx.http?.authInfo;
      if (!oauth.hasScope(auth, "files:write")) {
        return authChallengeResult(oauth, auth);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            root: config.saveRoot,
            resource: config.resourceUrl.href,
            auth: "oauth2",
            maxFileBytes: config.maxFileBytes,
            downloadTimeoutMs: config.downloadTimeoutMs,
          }, null, 2),
        }],
        structuredContent: {
          root: config.saveRoot,
          resource: config.resourceUrl.href,
          auth: "oauth2",
          maxFileBytes: config.maxFileBytes,
          downloadTimeoutMs: config.downloadTimeoutMs,
        },
      };
    },
  );

  return server;
}
