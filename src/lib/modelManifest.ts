// Pinned identity of the on-device embedding model. The bytes live outside
// this repository and outside the Cloudflare deployment — the pinned Hugging
// Face revision first, with our immutable GitHub release as a best-effort
// secondary and manual-import archive — so this manifest is
// the only source of truth for what they are: exact size and SHA-256 per
// file. A download that does not verify is discarded no matter which mirror
// served it; "the link is alive but the content changed" behaves like a dead
// link instead of silently poisoning devices. Any change to the model — even
// re-quantizing the same weights — is a new release tag, a new `version`,
// and new hashes here. See docs/embedding-model-hosting.md.

export interface ModelFileSpec {
  /** Flat asset name in the GitHub release (release assets cannot nest). */
  asset: string;
  /** Path the transformers.js pipeline requests; cache keys end with it. */
  requestPath: string;
  /** Exact byte length recorded at publish time. */
  bytes: number;
  /** Lowercase hex SHA-256 recorded at publish time. */
  sha256: string;
}

export interface ModelManifest {
  /** transformers.js model id, also the tail of the primary mirror URL. */
  id: string;
  /** Pinned Hugging Face revision (a commit SHA, never a branch name). */
  hfRevision: string;
  /** Bumped on any change; the store and the future index key off it. */
  version: string;
  /** Immutable tag of the GitHub release holding the assets. */
  releaseTag: string;
  files: readonly ModelFileSpec[];
}

/** Repository whose releases hold the immutable manual-import archive. */
export const MODEL_RELEASE_REPO = "JM-2023/memo";

export const MODEL_MANIFEST: ModelManifest = Object.freeze({
  id: "Xenova/bge-small-zh-v1.5",
  hfRevision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
  version: "bge-small-zh-q8-r1",
  releaseTag: "model-bge-small-zh-q8-r1",
  files: Object.freeze([
    {
      asset: "config.json",
      requestPath: "config.json",
      bytes: 716,
      sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f"
    },
    {
      asset: "tokenizer.json",
      requestPath: "tokenizer.json",
      bytes: 439125,
      sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26"
    },
    {
      asset: "tokenizer_config.json",
      requestPath: "tokenizer_config.json",
      bytes: 367,
      sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a"
    },
    {
      asset: "model_quantized.onnx",
      requestPath: "onnx/model_quantized.onnx",
      bytes: 24010842,
      sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc"
    }
  ])
});

/**
 * Ordered download sources for one file. The pinned Hugging Face revision is
 * first because it passes browser CORS. GitHub's immutable release is kept as
 * a best-effort secondary and manual-import archive; its current redirect
 * chain lacks CORS, as recorded in §4.1 of the hosting doc.
 */
export function modelMirrorUrls(file: ModelFileSpec, manifest: ModelManifest = MODEL_MANIFEST): string[] {
  return [
    `https://huggingface.co/${manifest.id}/resolve/${manifest.hfRevision}/${file.requestPath}`,
    `https://github.com/${MODEL_RELEASE_REPO}/releases/download/${manifest.releaseTag}/${file.asset}`
  ];
}

export function modelTotalBytes(manifest: ModelManifest = MODEL_MANIFEST): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Resolve a transformers.js cache key to its manifest file. Keys arrive in
 * two shapes — a local path (`<localModelPath>/<model id>/<file>`) and a
 * remote URL (`https://…/resolve/<revision>/<file>`) — so matching anchors
 * the request path at a `/` boundary instead of trusting either prefix.
 * The boundary matters: a bare `endsWith("config.json")` would also claim
 * `tokenizer_config.json`.
 */
export function modelFileForCacheKey(key: string, manifest: ModelManifest = MODEL_MANIFEST): ModelFileSpec | null {
  for (const file of manifest.files) {
    if (key === file.requestPath || key.endsWith(`/${file.requestPath}`)) return file;
  }
  return null;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) hex += bytes[index].toString(16).padStart(2, "0");
  return hex;
}

/** True when the bytes are exactly the pinned content — size and SHA-256. */
export async function verifyModelBytes(file: ModelFileSpec, data: ArrayBuffer): Promise<boolean> {
  if (data.byteLength !== file.bytes) return false;
  return (await sha256Hex(data)) === file.sha256;
}
