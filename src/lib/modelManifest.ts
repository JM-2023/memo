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
  id: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
  hfRevision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
  version: "granite-embedding-97m-multilingual-r2-q8-r1",
  releaseTag: "model-granite-embedding-97m-multilingual-r2-q8-r1",
  files: Object.freeze([
    {
      asset: "config.json",
      requestPath: "config.json",
      bytes: 1215,
      sha256: "ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee"
    },
    {
      asset: "tokenizer.json",
      requestPath: "tokenizer.json",
      bytes: 25301671,
      sha256: "51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a"
    },
    {
      asset: "tokenizer_config.json",
      requestPath: "tokenizer_config.json",
      bytes: 12860,
      sha256: "6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5"
    },
    {
      asset: "model_quantized.onnx",
      requestPath: "onnx/model_quantized.onnx",
      bytes: 97858099,
      sha256: "704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22"
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
