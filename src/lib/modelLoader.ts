// Mirror-chain downloader for the embedding model. The network is involved
// only while a device is missing files: every downloaded byte is checked
// against the manifest's pinned size and SHA-256, then frozen into the model
// store, and later activations read the freeze. A mirror that 404s, hangs,
// or serves the wrong content is just skipped; when every mirror fails the
// error names each attempt so the UI can show something actionable. There is
// deliberately no resume (25 MB retries are fine), no auto-update polling
// (model changes are deliberate releases), and no concurrent download (the
// ONNX dominates, and one stream keeps progress honest).

import {
  MODEL_MANIFEST,
  modelMirrorUrls,
  modelTotalBytes,
  sha256Hex,
  verifyModelBytes,
  type ModelFileSpec,
  type ModelManifest
} from "./modelManifest";
import {
  deleteModelStoreDb,
  listStoredModelFiles,
  purgeOtherModelVersions,
  readStoredModelFile,
  requestPersistentStorage,
  writeStoredModelFile
} from "./modelStore";

export interface ModelProgress {
  loadedBytes: number;
  totalBytes: number;
  /** Request path of the file currently downloading, null between files. */
  currentFile: string | null;
}

export interface MirrorFailure {
  url: string;
  reason: string;
}

export class ModelUnavailableError extends Error {
  readonly failures: readonly MirrorFailure[];

  constructor(message: string, failures: readonly MirrorFailure[]) {
    super(message);
    this.name = "ModelUnavailableError";
    this.failures = failures;
  }
}

export interface ModelLoaderOptions {
  manifest?: ModelManifest;
  fetchImpl?: typeof fetch;
  mirrorUrls?: (file: ModelFileSpec, manifest: ModelManifest) => string[];
  /** Maximum silence while opening or reading one mirror before failover. */
  stallTimeoutMs?: number;
}

const MODEL_FETCH_STALL_TIMEOUT_MS = 30_000;

/**
 * Session-only overlay for bytes that could not be persisted (quota, private
 * browsing). Keyed like the store, so distinct manifest versions never mix.
 */
const memoryFiles = new Map<string, ArrayBuffer>();
let storageGeneration = 0;

class ModelFilesClearedError extends Error {
  constructor() {
    super("Model files were cleared during this operation");
    this.name = "ModelFilesClearedError";
  }
}

function assertStorageGeneration(generation: number): void {
  if (generation !== storageGeneration) throw new ModelFilesClearedError();
}

/**
 * Forget every model byte, including the session-only quota fallback. This is
 * shared by explicit logout and the settings panel's standalone clear action.
 */
export async function clearModelFiles(): Promise<void> {
  storageGeneration += 1;
  memoryFiles.clear();
  await deleteModelStoreDb();
}

function memoryKey(manifest: ModelManifest, requestPath: string): string {
  return `${manifest.version}/${requestPath}`;
}

/** Verified bytes from the freeze (store or session overlay), else null. */
export async function readModelFileBytes(requestPath: string, manifest: ModelManifest = MODEL_MANIFEST): Promise<ArrayBuffer | null> {
  const overlay = memoryFiles.get(memoryKey(manifest, requestPath));
  if (overlay) return overlay;
  return readStoredModelFile(manifest.version, requestPath);
}

/** Per-file presence (store or session overlay) without reading any bytes. */
export async function presentModelFiles(manifest: ModelManifest = MODEL_MANIFEST): Promise<Set<string>> {
  const present = await listStoredModelFiles(manifest.version);
  for (const file of manifest.files) {
    if (memoryFiles.has(memoryKey(manifest, file.requestPath))) present.add(file.requestPath);
  }
  return present;
}

/** Coarse presence summary driving the settings UI's initial state. */
export async function storedModelState(manifest: ModelManifest = MODEL_MANIFEST): Promise<"complete" | "partial" | "none"> {
  const present = await presentModelFiles(manifest);
  const count = manifest.files.filter((file) => present.has(file.requestPath)).length;
  if (count === manifest.files.length) return "complete";
  return count > 0 ? "partial" : "none";
}

/**
 * Stream one URL into an exactly-sized buffer. The pinned size is a hard
 * ceiling — a body that keeps going is cancelled instead of growing memory —
 * and a short body fails here so hashing never runs on padding.
 */
async function fetchExactBytes(
  fetchImpl: typeof fetch,
  url: string,
  expectedBytes: number,
  onChunk: (bytes: number) => void,
  stallTimeoutMs: number
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const waitForNetwork = <T>(operation: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`stalled for ${stallTimeoutMs} ms`));
      }, stallTimeoutMs);
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (cause) => {
          clearTimeout(timer);
          reject(cause);
        }
      );
    });

  try {
    const response = await waitForNetwork(fetchImpl(url, { signal: controller.signal }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = response.body;
    if (!body) {
      const buffer = await waitForNetwork(response.arrayBuffer());
      if (buffer.byteLength !== expectedBytes) throw new Error(`received ${buffer.byteLength} bytes, expected ${expectedBytes}`);
      onChunk(expectedBytes);
      return buffer;
    }
    const bytes = new Uint8Array(expectedBytes);
    reader = body.getReader();
    let offset = 0;
    for (;;) {
      const { done, value } = await waitForNetwork(reader.read());
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (offset + value.byteLength > expectedBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`body exceeds the pinned ${expectedBytes} bytes`);
      }
      bytes.set(value, offset);
      offset += value.byteLength;
      onChunk(value.byteLength);
    }
    if (offset !== expectedBytes) throw new Error(`received ${offset} bytes, expected ${expectedBytes}`);
    return bytes.buffer;
  } catch (cause) {
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    throw cause;
  }
}

async function keepBytes(manifest: ModelManifest, file: ModelFileSpec, buffer: ArrayBuffer, generation: number): Promise<void> {
  assertStorageGeneration(generation);
  try {
    await writeStoredModelFile(manifest.version, file.requestPath, buffer);
  } catch (cause) {
    assertStorageGeneration(generation);
    console.warn(`Model file ${file.requestPath} could not be persisted; keeping it in memory for this session.`, cause);
    memoryFiles.set(memoryKey(manifest, file.requestPath), buffer);
    return;
  }
  assertStorageGeneration(generation);
  memoryFiles.delete(memoryKey(manifest, file.requestPath));
}

/**
 * Make every manifest file present and verified locally, downloading only
 * what is missing (which is also what makes an interrupted download resume
 * for free). Progress covers already-present files, so the bar starts where
 * the device really is. Rejects with ModelUnavailableError when some file
 * cannot be obtained from any mirror.
 */
export async function ensureModelFiles(
  onProgress?: (progress: ModelProgress) => void,
  options: ModelLoaderOptions = {}
): Promise<void> {
  const manifest = options.manifest ?? MODEL_MANIFEST;
  const fetchImpl = options.fetchImpl ?? fetch;
  const urlsFor = options.mirrorUrls ?? modelMirrorUrls;
  const stallTimeoutMs = options.stallTimeoutMs ?? MODEL_FETCH_STALL_TIMEOUT_MS;
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) throw new RangeError("stallTimeoutMs must be a positive number");
  const generation = storageGeneration;

  await purgeOtherModelVersions(manifest.version);
  assertStorageGeneration(generation);

  const totalBytes = modelTotalBytes(manifest);
  let loadedBytes = 0;
  const emit = (currentFile: string | null) => onProgress?.({ loadedBytes, totalBytes, currentFile });

  let downloadedAny = false;
  emit(null);
  for (const file of manifest.files) {
    assertStorageGeneration(generation);
    if (await readModelFileBytes(file.requestPath, manifest)) {
      loadedBytes += file.bytes;
      emit(null);
      continue;
    }

    const fileStart = loadedBytes;
    const failures: MirrorFailure[] = [];
    let buffer: ArrayBuffer | null = null;
    for (const url of urlsFor(file, manifest)) {
      emit(file.requestPath);
      try {
        const candidate = await fetchExactBytes(
          fetchImpl,
          url,
          file.bytes,
          (chunkBytes) => {
            loadedBytes += chunkBytes;
            emit(file.requestPath);
          },
          stallTimeoutMs
        );
        assertStorageGeneration(generation);
        if (!(await verifyModelBytes(file, candidate))) throw new Error("SHA-256 mismatch");
        assertStorageGeneration(generation);
        buffer = candidate;
        break;
      } catch (cause) {
        if (cause instanceof ModelFilesClearedError) throw cause;
        // Roll progress back to the file boundary so a retry on the next
        // mirror never shows the bar moving backwards mid-chunk.
        loadedBytes = fileStart;
        emit(null);
        const reason = cause instanceof Error ? cause.message : String(cause);
        console.warn(`Model mirror failed for ${file.requestPath}: ${url} (${reason})`);
        failures.push({ url, reason });
      }
    }
    if (!buffer) {
      throw new ModelUnavailableError(`Model file ${file.requestPath} is unavailable from every mirror.`, failures);
    }

    await keepBytes(manifest, file, buffer, generation);
    downloadedAny = true;
    loadedBytes = fileStart + file.bytes;
    emit(null);
  }

  if (downloadedAny) {
    assertStorageGeneration(generation);
    await requestPersistentStorage();
  }
}

export interface ModelImportResult {
  /** Request paths newly satisfied by the provided files. */
  imported: string[];
  /** Request paths that were already present and were left untouched. */
  alreadyPresent: string[];
  /** Names of provided files that match nothing in the manifest. */
  unmatched: string[];
}

interface ImportableFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The escape hatch: accept model files from disk — a copy saved from another
 * device, or the release assets themselves. Matching is by content hash, not
 * filename, so any name is fine and a wrong or corrupted file can never be
 * imported by accident.
 */
export async function importModelFiles(files: readonly ImportableFile[], options: ModelLoaderOptions = {}): Promise<ModelImportResult> {
  const manifest = options.manifest ?? MODEL_MANIFEST;
  const generation = storageGeneration;
  await purgeOtherModelVersions(manifest.version);
  assertStorageGeneration(generation);

  const result: ModelImportResult = { imported: [], alreadyPresent: [], unmatched: [] };
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    assertStorageGeneration(generation);
    const digest = await sha256Hex(buffer);
    assertStorageGeneration(generation);
    const spec = manifest.files.find((candidate) => candidate.sha256 === digest && candidate.bytes === buffer.byteLength);
    if (!spec) {
      result.unmatched.push(file.name);
      continue;
    }
    if (await readModelFileBytes(spec.requestPath, manifest)) {
      assertStorageGeneration(generation);
      result.alreadyPresent.push(spec.requestPath);
      continue;
    }
    await keepBytes(manifest, spec, buffer, generation);
    result.imported.push(spec.requestPath);
  }

  if (result.imported.length > 0) {
    assertStorageGeneration(generation);
    await requestPersistentStorage();
  }
  return result;
}
