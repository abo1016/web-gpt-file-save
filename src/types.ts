export interface OpenAIFileParam {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface ImportOptions {
  overwrite?: boolean;
  maxBytes?: number;
  downloadTimeoutMs?: number;
  allowHttpForTests?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ImportResult {
  savedPath: string;
  destination: string;
  bytes: number;
  sha256: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
}
