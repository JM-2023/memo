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
//   library's default third-party CDN, single-threaded because multithreading
//   would demand COOP/COEP headers that break external memo images.
//
// A successful activation ends with a self-test inference, so "ready" means
// the model produced sane vectors on this device, not merely that files and
// code loaded.

import { readModelFileBytes } from "./modelLoader";
import { MODEL_MANIFEST, modelFileForCacheKey } from "./modelManifest";

/** Hidden size of bge-small-zh-v1.5. */
export const EMBEDDING_DIM = 512;

/**
 * BGE models want short retrieval queries prefixed with this instruction;
 * memo-to-memo similarity uses no prefix. Recorded here for the index
 * feature that builds on this runtime.
 */
export const RETRIEVAL_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

export type EmbedFn = (texts: readonly string[]) => Promise<Float32Array[]>;

let embedderPromise: Promise<EmbedFn> | null = null;

async function createEmbedder(): Promise<EmbedFn> {
  const { env, pipeline } = await import("@huggingface/transformers");

  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(key: string) {
      const file = modelFileForCacheKey(key);
      if (!file) return undefined;
      const bytes = await readModelFileBytes(file.requestPath);
      return bytes ? new Response(bytes) : undefined;
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
    onnx.wasm.proxy = false;
  }

  const extractor = await pipeline("feature-extraction", MODEL_MANIFEST.id, { device: "wasm", dtype: "q8" });

  return async (texts: readonly string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];
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
  };
}

/**
 * The process-wide embedder. Construction failures clear the promise so a
 * later attempt (after a retry or an import) starts fresh.
 */
export function getEmbedder(): Promise<EmbedFn> {
  if (!embedderPromise) {
    embedderPromise = createEmbedder().catch((cause: unknown) => {
      embedderPromise = null;
      throw cause;
    });
  }
  return embedderPromise;
}

function assertSelfTest(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`Model self-test failed: ${detail}`);
}

/**
 * One real inference over one Chinese and one English probe. Throws with a
 * specific reason when the runtime produces the wrong shape or degenerate
 * vectors; the settings UI only reports "ready" after this passes.
 */
export async function runModelSelfTest(): Promise<void> {
  const embed = await getEmbedder();
  const vectors = await embed(["你好，世界", "hello world"]);
  assertSelfTest(vectors.length === 2, `expected 2 vectors, got ${vectors.length}`);
  let dot = 0;
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
  for (let index = 0; index < EMBEDDING_DIM; index += 1) dot += vectors[0][index] * vectors[1][index];
  assertSelfTest(Math.abs(dot) < 0.999, "distinct probes collapsed to one direction");
}
