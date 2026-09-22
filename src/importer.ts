import crypto from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { rename, rm, writeFile } from "node:fs/promises";
import type { ImportOptions, ImportResult, OpenAIFileParam } from "./types.js";
import { resolveSafeRemoteUrl, resolveSafeTarget, type ResolvedRemoteUrl } from "./security.js";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export function inferDestination(file: OpenAIFileParam): string {
  const originalName = file.file_name?.trim();
  if (originalName) {
    const normalized = originalName.replaceAll("\\", "/");
    const baseName = normalized.split("/").pop()?.trim();
    if (baseName && baseName !== "." && baseName !== "..") return baseName;
  }

  const safeId = file.file_id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return `${safeId || "chatgpt-file"}.bin`;
}

function originalHostname(url: URL): string {
  return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function requestPinned(target: ResolvedRemoteUrl, downloadTimeoutMs: number): Promise<IncomingMessage> {
  const signal = AbortSignal.timeout(downloadTimeoutMs);
  const common = {
    hostname: target.address,
    port: target.url.port ? Number(target.url.port) : undefined,
    method: "GET",
    path: `${target.url.pathname}${target.url.search}`,
    headers: {
      Host: target.url.host,
      "Accept-Encoding": "identity",
    },
    signal,
  };

  return new Promise<IncomingMessage>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(signal.aborted ? new Error(`Download timed out after ${downloadTimeoutMs} ms`) : error);
    };

    if (target.url.protocol === "https:") {
      const hostname = originalHostname(target.url);
      const request = https.request({
        ...common,
        servername: net.isIP(hostname) ? undefined : hostname,
      }, resolve);
      request.once("error", onError);
      request.end();
      return;
    }

    const request = http.request(common, resolve);
    request.once("error", onError);
    request.end();
  });
}

async function readPinnedBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers["content-length"] ?? "0");
  if (declaredLength > maxBytes) {
    response.destroy();
    throw new Error(`File exceeds ${maxBytes} byte limit`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new Error(`File exceeds ${maxBytes} byte limit`);
    }
    chunks.push(buffer);
  }

  return new Uint8Array(Buffer.concat(chunks, total));
}

async function readFetchBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit`);
  if (!response.body) throw new Error("Download response had no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`File exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function downloadBounded(
  initialUrl: string,
  maxBytes: number,
  downloadTimeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  allowHttpForTests: boolean,
): Promise<Uint8Array> {
  let current = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = await resolveSafeRemoteUrl(current, allowHttpForTests);

    if (fetchImpl) {
      const response = await fetchImpl(target.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect ${response.status} did not include Location`);
        current = new URL(location, target.url).toString();
        continue;
      }
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      return await readFetchBody(response, maxBytes);
    }

    const response = await requestPinned(target, downloadTimeoutMs);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error(`Redirect ${status} did not include Location`);
      current = new URL(location, target.url).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Download failed: HTTP ${status}`);
    }
    return await readPinnedBody(response, maxBytes);
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

async function writeDownloadedFile(target: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return;
  }

  const parent = path.dirname(target);
  const temp = path.join(parent, `.web-gpt-file-save-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function importOpenAIFile(
  root: string,
  destination: string | undefined,
  file: OpenAIFileParam,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (!Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs < 1) {
    throw new Error("downloadTimeoutMs must be a positive integer");
  }

  const resolvedDestination = destination?.trim() || inferDestination(file);
  const { target } = await resolveSafeTarget(root, resolvedDestination);
  const bytes = await downloadBounded(
    file.download_url,
    maxBytes,
    downloadTimeoutMs,
    fetchImpl,
    options.allowHttpForTests ?? false,
  );

  const refreshed = await resolveSafeTarget(root, resolvedDestination);
  if (refreshed.target !== target) throw new Error("destination changed while the file was downloading");
  await writeDownloadedFile(refreshed.target, bytes, options.overwrite ?? false);

  return {
    savedPath: refreshed.target,
    destination: resolvedDestination,
    bytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    fileId: file.file_id,
    fileName: file.file_name,
    mimeType: file.mime_type,
  };
}

export function defaultSaveRoot(): string {
  return path.resolve(process.env.FILE_SAVE_ROOT ?? path.join(process.cwd(), "imports"));
}
