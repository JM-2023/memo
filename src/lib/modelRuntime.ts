// The only module that touches @huggingface/transformers, and it does so
// through a dynamic import: the several-megabyte inference chunk loads the
// first time semantic features actually run, never on startup. The library
// is wired so it can only ever read the manifest-verified freeze:
//
// - `customCache` serves bytes from the model store and nothing else;
// - remote loading is disabled, so a cache miss cannot silently reach
//   huggingface.co;
// - local-path probing (which the library requires to stay enabled) points
//   into /assets/, the one zone of this deployment that answers a real 404
//   instead of the SPA fallback's index.html — a miss fails loudly instead
//   of feeding HTML to the ONNX runtime;
// - the ONNX WASM pair loads from this origin (see vite.config.ts), not the
//   library's default third-party CDN; a one-thread proxy worker keeps the UI
//   responsive without the COOP/COEP headers that break external memo images.
//
// A successful activation ends with a self-test inference, so "ready" means
// the model produced sane vectors on this device, not merely that files and
// code loaded.

import { readModelFileBytes } from "./modelLoader";
import { MODEL_MANIFEST, modelFileForCacheKey } from "./modelManifest";

/** Hidden size of Granite Embedding 97M Multilingual R2. */
export const EMBEDDING_DIM = 384;

/**
 * Granite's retrieval space is symmetric and its official examples use raw
 * query and document text, so it needs no query-only instruction. Keeping
 * the empty prefix explicit makes that model contract visible at the call
 * site and avoids silently carrying the old Chinese-only BGE instruction.
 */
export const RETRIEVAL_QUERY_PREFIX = "";

export type EmbedFn = (texts: readonly string[]) => Promise<Float32Array[]>;

export type ModelRuntimeStage =
  | "idle"
  | "loading-code"
  | "loading-files"
  | "starting-runtime"
  | "runtime-ready"
  | "self-testing"
  | "ready"
  | "error";

export interface ModelRuntimeProgress {
  stage: ModelRuntimeStage;
  /** Honest, operation-backed completion; no timer-based fake progress. */
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
}

interface TransformerProgressEvent {
  status: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

const IDLE_RUNTIME_PROGRESS: ModelRuntimeProgress = Object.freeze({ stage: "idle", percent: 0 });
let runtimeProgress: ModelRuntimeProgress = IDLE_RUNTIME_PROGRESS;
const runtimeProgressListeners = new Set<() => void>();

function publishRuntimeProgress(next: ModelRuntimeProgress): void {
  const percent = Math.max(0, Math.min(100, Math.round(next.percent)));
  if (
    runtimeProgress.stage === next.stage &&
    runtimeProgress.percent === percent &&
    runtimeProgress.loadedBytes === next.loadedBytes &&
    runtimeProgress.totalBytes === next.totalBytes
  ) {
    return;
  }
  runtimeProgress = Object.freeze({ ...next, percent });
  for (const listener of runtimeProgressListeners) listener();
}

export function getModelRuntimeProgress(): ModelRuntimeProgress {
  return runtimeProgress;
}

export function subscribeModelRuntimeProgress(listener: () => void): () => void {
  runtimeProgressListeners.add(listener);
  return () => runtimeProgressListeners.delete(listener);
}

/** Map Transformers.js byte progress into the model activation portion. */
export function modelRuntimeProgressFromTransformerEvent(event: TransformerProgressEvent): ModelRuntimeProgress | null {
  if (event.status === "progress_total" && Number.isFinite(event.progress)) {
    return {
      stage: "loading-files",
      percent: 8 + (Math.max(0, Math.min(100, event.progress ?? 0)) / 100) * 74,
      loadedBytes: event.loaded,
      totalBytes: event.total
    };
  }
  if (event.status === "ready") return { stage: "starting-runtime", percent: 88 };
  return null;
}

let embedderPromise: Promise<EmbedFn> | null = null;
let selfTestPromise: Promise<void> | null = null;
let runtimeGeneration = 0;
let activeDisposer: (() => Promise<void>) | null = null;

async function createEmbedder(generation: number): Promise<EmbedFn> {
  publishRuntimeProgress({ stage: "loading-code", percent: 2 });
  const { env, pipeline } = await import("@huggingface/transformers");
  if (generation !== runtimeGeneration) throw new Error("Model runtime was cleared while it was starting");
  publishRuntimeProgress({ stage: "loading-code", percent: 8 });

  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(key: string) {
      const file = modelFileForCacheKey(key);
      if (!file) return undefined;
      const bytes = await readModelFileBytes(file.requestPath);
      // Transformers.js reads this header before opening the bodies to build
      // its aggregate progress denominator. A synthetic Response does not add
      // Content-Length automatically, so provide the manifest's verified size.
      return bytes
        ? new Response(bytes, {
            headers: {
              "Content-Length": String(file.bytes),
              "Content-Type": file.asset.endsWith(".json") ? "application/json" : "application/octet-stream"
            }
          })
        : undefined;
    },
    // ensureModelFiles pre-populates the freeze; there is nothing to add.
    async put() {}
  };
  env.allowRemoteModels = false;
  // The library refuses to run with local AND remote loading disabled, so
  // local stays enabled but aimed at the real-404 zone (public/assets/404.html
  // gives /assets/* genuine 404s). Optional files the manifest doesn't cover
  // then resolve to null; a required miss throws instead of downloading.
  env.allowLocalModels = true;
  env.localModelPath = "/assets/model-cache-miss/";

  const onnx = env.backends.onnx as {
    wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean };
  };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = __ORT_WASM_BASE__;
    onnx.wasm.numThreads = 1;
    // A single proxy worker keeps ONNX inference off React's main thread. One
    // WASM thread caps CPU use while the worker keeps controls and progress UI
    // responsive throughout a long first index build.
    onnx.wasm.proxy = true;
  }

  const extractor = await pipeline("feature-extraction", MODEL_MANIFEST.id, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (event: TransformerProgressEvent) => {
      if (generation !== runtimeGeneration) return;
      const next = modelRuntimeProgressFromTransformerEvent(event);
      if (next) publishRuntimeProgress(next);
    }
  });

  // A clear can land while the several-megabyte runtime is still starting.
  // Dispose that late result instead of resurrecting a model the user just
  // removed.
  if (generation !== runtimeGeneration) {
    await extractor.dispose();
    throw new Error("Model runtime was cleared while it was starting");
  }
  activeDisposer = () => extractor.dispose();
  publishRuntimeProgress({ stage: "runtime-ready", percent: 90 });

  // One ONNX session is shared by index and query work. Serialize calls so a
  // query arriving during the first index build can take the next slot
  // safely instead of racing a session.run already in progress.
  let inferenceTail: Promise<void> = Promise.resolve();
  return (texts: readonly string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return Promise.resolve([]);
    const run = inferenceTail.then(async () => {
      const output = await extractor([...texts], { pooling: "cls", normalize: true });
      const dims = output.dims;
      if (dims.length !== 2 || dims[0] !== texts.length) {
        throw new Error(`Unexpected embedding shape [${dims.join(", ")}] for ${texts.length} texts`);
      }
      const dim = dims[1];
      const data = output.data as Float32Array;
      const vectors: Float32Array[] = [];
      for (let index = 0; index < texts.length; index += 1) {
        vectors.push(data.slice(index * dim, (index + 1) * dim));
      }
      return vectors;
    });
    inferenceTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

/**
 * The process-wide embedder. Construction failures clear the promise so a
 * later attempt (after a retry or an import) starts fresh.
 */
export function getEmbedder(): Promise<EmbedFn> {
  if (!embedderPromise) {
    const generation = runtimeGeneration;
    const current = createEmbedder(generation).catch((cause: unknown) => {
      if (embedderPromise === current) embedderPromise = null;
      if (generation === runtimeGeneration) publishRuntimeProgress({ stage: "error", percent: runtimeProgress.percent });
      throw cause;
    });
    embedderPromise = current;
  }
  return embedderPromise;
}

/**
 * Drop the process-wide pipeline and release its ONNX session. In-flight
 * construction is invalidated by generation and disposes itself on arrival.
 */
export async function resetModelRuntime(): Promise<void> {
  runtimeGeneration += 1;
  embedderPromise = null;
  selfTestPromise = null;
  publishRuntimeProgress(IDLE_RUNTIME_PROGRESS);
  const dispose = activeDisposer;
  activeDisposer = null;
  if (dispose) await dispose().catch(() => {});
}

function assertSelfTest(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`Model self-test failed: ${detail}`);
}

/**
 * One real inference over related Chinese/English probes and an unrelated
 * English control. Throws with a specific reason when the runtime produces
 * the wrong shape, degenerate vectors, or no cross-language alignment; the
 * settings UI only reports "ready" after this passes.
 */
export function runModelSelfTest(): Promise<void> {
  if (!selfTestPromise) {
    const generation = runtimeGeneration;
    const current = (async () => {
      const embed = await getEmbedder();
      if (generation === runtimeGeneration) publishRuntimeProgress({ stage: "self-testing", percent: 92 });
      const vectors = await embed(["今天买了苹果和香蕉。", "fresh fruit from the market", "The cat is sleeping by the window."]);
      assertSelfTest(vectors.length === 3, `expected 3 vectors, got ${vectors.length}`);
      for (const vector of vectors) {
        assertSelfTest(vector.length === EMBEDDING_DIM, `expected ${EMBEDDING_DIM} dimensions, got ${vector.length}`);
        let normSquared = 0;
        for (let index = 0; index < vector.length; index += 1) {
          assertSelfTest(Number.isFinite(vector[index]), "vector contains a non-finite value");
          normSquared += vector[index] * vector[index];
        }
        const norm = Math.sqrt(normSquared);
        assertSelfTest(Math.abs(norm - 1) < 0.02, `expected a unit vector, got norm ${norm.toFixed(4)}`);
      }
      let related = 0;
      let unrelated = 0;
      for (let index = 0; index < EMBEDDING_DIM; index += 1) {
        related += vectors[0][index] * vectors[1][index];
        unrelated += vectors[0][index] * vectors[2][index];
      }
      assertSelfTest(Math.abs(related) < 0.999, "distinct probes collapsed to one direction");
      assertSelfTest(related > unrelated + 0.03, "cross-language probe did not outrank the unrelated control");
      if (generation === runtimeGeneration) publishRuntimeProgress({ stage: "ready", percent: 100 });
    })().catch((cause: unknown) => {
      if (selfTestPromise === current) selfTestPromise = null;
      if (generation === runtimeGeneration) publishRuntimeProgress({ stage: "error", percent: runtimeProgress.percent });
      throw cause;
    });
    selfTestPromise = current;
  }
  return selfTestPromise;
}
