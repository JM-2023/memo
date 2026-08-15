// Client-side vector index over the notebook. Every embedding is derived
// from memo content, so the index gets the snapshot's treatment, not the
// model's: it is sealed with the same server-held key before touching
// IndexedDB, it is never written in plaintext (no key → no persistence, the
// session just rebuilds in memory), and logout deletes the database outright.
// The whole corpus already lives client-side, which is what lets all of this
// — embedding, storage, and search — run without a byte leaving the device.
//
// Layout: one row per chunk (long memos are windowed), rows grouped per memo
// in insertion order, vectors packed into one Float32Array. A memo's rows are
// keyed by a fingerprint of the text that was actually embedded, so attachment
// edits do not repeat inference while text edits still invalidate exactly that
// memo. Vectors are unit-length (the runtime normalizes), which makes ranking
// a plain dot product.

import { openDerivedBytes, sealDerivedBytes } from "./cache";
import { EMBEDDING_DIM } from "./modelRuntime";
import type { Memo } from "./types";

/**
 * Granite accepts much longer inputs, but 400-character overlapping windows
 * keep single-threaded browser WASM inference responsive and let the best
 * local passage represent a long memo. Six windows cover ~2.2k characters;
 * a longer memo's tail goes unindexed rather than exploding index time and
 * size (a 40k-character memo would otherwise be ~100 rows on its own).
 */
export const SEMANTIC_CHUNK_CHARS = 400;
export const SEMANTIC_CHUNK_OVERLAP = 50;
export const SEMANTIC_MAX_CHUNKS = 6;
/**
 * Dot-product floor below which a match reads as noise. Calibrated against
 * Granite Embedding 97M Multilingual R2 q8 on representative Chinese,
 * English, Japanese, French, and German probes: correct cross-language
 * matches landed at 0.750–0.882 while the unrelated "量子物理" control
 * peaked at 0.701. 0.74 sits between them with margin for WASM/CPU numeric
 * drift; personal search still prefers a weak tail hit over silently missing
 * a true one.
 */
export const SEMANTIC_SCORE_FLOOR = 0.74;
export const SEMANTIC_MAX_RESULTS = 200;

export interface SemanticRow {
  id: string;
  /** Informational timestamp from the embedding pass. */
  updatedAt: string;
  /** Non-security fingerprint of the exact chunk sequence embedded. */
  contentKey: string;
  chunkIndex: number;
  chunkCount: number;
}

export interface SemanticIndex {
  modelVersion: string;
  rows: SemanticRow[];
  /** rows.length × EMBEDDING_DIM, packed row-major. */
  vectors: Float32Array;
}

export function emptySemanticIndex(modelVersion: string): SemanticIndex {
  return { modelVersion, rows: [], vectors: new Float32Array(0) };
}

/** Overlapping windows over trimmed content; empty for whitespace-only memos. */
export function chunkMemoContent(content: string): string[] {
  const text = content.trim();
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < SEMANTIC_MAX_CHUNKS) {
    const end = Math.min(text.length, start + SEMANTIC_CHUNK_CHARS);
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = end - SEMANTIC_CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Fast cache key for the exact text windows sent to the model. Two independent
 * 32-bit accumulators plus lengths make accidental collisions vanishingly
 * unlikely; this is cache invalidation metadata, never a security primitive.
 */
function contentKeyForChunks(chunks: readonly string[]): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let codeUnits = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    codeUnits += chunk.length;
    first = Math.imul(first ^ chunk.length ^ chunkIndex, 0x01000193);
    second = Math.imul(second ^ chunk.length ^ (chunkIndex + 0x7f4a7c15), 0x5bd1e995);
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x5bd1e995);
    }
  }
  return `${chunks.length}:${codeUnits}:${(first >>> 0).toString(16).padStart(8, "0")}:${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Null means the memo has no text that can contribute to semantic search. */
export function semanticContentKey(content: string): string | null {
  const chunks = chunkMemoContent(content);
  return chunks.length > 0 ? contentKeyForChunks(chunks) : null;
}

export interface IndexPlan {
  /** Memos whose rows are missing or stale and need embedding. */
  stale: Memo[];
  /** Row indices still valid — their memo has the same embedded text. */
  keptRowIndices: number[];
  /** Same text, newer memo metadata; update rows without running inference. */
  refreshedUpdatedAt: Array<{ id: string; updatedAt: string }>;
}

export function planSemanticIndex(index: SemanticIndex, memos: readonly Memo[]): IndexPlan {
  interface IndexedMemoRows {
    contentKey: string;
    updatedAt: string;
    chunkCount: number;
    chunkIndices: Set<number>;
    rowCount: number;
    valid: boolean;
  }

  const indexed = new Map<string, IndexedMemoRows>();
  for (let row = 0; row < index.rows.length; row += 1) {
    const entry = index.rows[row];
    let state = indexed.get(entry.id);
    if (!state) {
      state = {
        contentKey: entry.contentKey,
        updatedAt: entry.updatedAt,
        chunkCount: entry.chunkCount,
        chunkIndices: new Set(),
        rowCount: 0,
        valid: true
      };
      indexed.set(entry.id, state);
    }
    state.rowCount += 1;
    if (
      state.contentKey !== entry.contentKey ||
      state.updatedAt !== entry.updatedAt ||
      state.chunkCount !== entry.chunkCount ||
      entry.chunkIndex < 0 ||
      entry.chunkIndex >= entry.chunkCount ||
      state.chunkIndices.has(entry.chunkIndex)
    ) {
      state.valid = false;
    }
    state.chunkIndices.add(entry.chunkIndex);
  }

  const validMemoIds = new Set<string>();
  const stale: Memo[] = [];
  const refreshedUpdatedAt: Array<{ id: string; updatedAt: string }> = [];
  for (const memo of memos) {
    const state = indexed.get(memo.id);
    const structurallyComplete = Boolean(
      state?.valid &&
        state.rowCount === state.chunkCount &&
        state.chunkIndices.size === state.chunkCount
    );
    // Most plans take this O(1) route. Hash text only after updatedAt changes,
    // which is when an attachment-only edit must be distinguished from text.
    if (structurallyComplete && state?.updatedAt === memo.updatedAt) {
      validMemoIds.add(memo.id);
      continue;
    }

    const chunks = chunkMemoContent(memo.content);
    // Image-only memos deliberately have no vector rows and are already
    // settled. Existing text rows are omitted from keptRowIndices below.
    if (chunks.length === 0) continue;
    const contentKey = contentKeyForChunks(chunks);
    if (
      structurallyComplete &&
      state &&
      state.contentKey === contentKey &&
      state.chunkCount === chunks.length &&
      state.rowCount === chunks.length
    ) {
      validMemoIds.add(memo.id);
      refreshedUpdatedAt.push({ id: memo.id, updatedAt: memo.updatedAt });
    } else {
      stale.push(memo);
    }
  }

  const keptRowIndices: number[] = [];
  for (let row = 0; row < index.rows.length; row += 1) {
    if (validMemoIds.has(index.rows[row].id)) keptRowIndices.push(row);
  }
  return { stale, keptRowIndices, refreshedUpdatedAt };
}

export interface SemanticIndexProgress {
  done: number;
  total: number;
  doneChunks: number;
  totalChunks: number;
}

export interface ReconcileCallbacks {
  /** Called after each batch with both memo and actual text-chunk progress. */
  onProgress?: (progress: SemanticIndexProgress) => void;
  /** A searchable snapshot published early, periodically, and on completion. */
  onPartial?: (index: SemanticIndex) => void;
  /** Return false to stop early; the partial index is still returned. */
  shouldContinue?: () => boolean;
  /** Called periodically with a consistent snapshot worth persisting. */
  onFlush?: (index: SemanticIndex) => void | Promise<void>;
}

// Eight similarly sized inputs keep memory and per-batch latency modest. ONNX
// runs in a one-thread proxy worker, so smaller batches trade a little elapsed
// time for steadier progress and a responsive UI without changing embeddings.
// Exported so the settings panel can report "Batch N of M" truthfully.
export const EMBED_BATCH_TEXTS = 8;
const FLUSH_EVERY_ROWS = 256;
const PARTIAL_EVERY_ROWS = 256;
const SEARCH_ROWS_PER_YIELD = 256;

function packIndex(modelVersion: string, rows: SemanticRow[], pieces: Float32Array[]): SemanticIndex {
  const vectors = new Float32Array(rows.length * EMBEDDING_DIM);
  let offset = 0;
  for (const piece of pieces) {
    vectors.set(piece, offset);
    offset += piece.length;
  }
  return { modelVersion, rows, vectors };
}

async function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Bring the index in line with the live memos: keep rows whose memo is
 * unchanged, re-embed the rest in small batches with the main thread
 * yielded between them. Returns the previous object untouched when there is
 * nothing to do, so callers can use identity to skip persistence.
 */
export async function reconcileSemanticIndex(
  index: SemanticIndex,
  memos: readonly Memo[],
  embed: (texts: readonly string[]) => Promise<Float32Array[]>,
  callbacks: ReconcileCallbacks = {}
): Promise<SemanticIndex> {
  const { stale, keptRowIndices, refreshedUpdatedAt } = planSemanticIndex(index, memos);
  if (stale.length === 0 && keptRowIndices.length === index.rows.length && refreshedUpdatedAt.length === 0) return index;

  const refreshedById = new Map(refreshedUpdatedAt.map((entry) => [entry.id, entry.updatedAt]));
  const keptRows: SemanticRow[] = [];
  for (const rowIndex of keptRowIndices) {
    const row = index.rows[rowIndex];
    const updatedAt = refreshedById.get(row.id);
    keptRows.push(updatedAt ? { ...row, updatedAt } : row);
  }

  interface PendingMemo {
    memo: Memo;
    contentKey: string;
    chunks: string[];
    vectors: Array<Float32Array | undefined>;
    remaining: number;
    appended: boolean;
  }

  interface PendingChunk {
    owner: PendingMemo;
    chunkIndex: number;
    chunk: string;
    order: number;
  }

  const pendingMemos: PendingMemo[] = [];
  const pendingChunks: PendingChunk[] = [];
  let order = 0;
  for (const memo of stale) {
    const chunks = chunkMemoContent(memo.content);
    // planSemanticIndex excludes non-indexable memos, but keep this guard so a
    // future planner change cannot reintroduce an empty-content reconcile loop.
    if (chunks.length === 0) continue;
    const owner: PendingMemo = {
      memo,
      contentKey: contentKeyForChunks(chunks),
      chunks,
      vectors: new Array<Float32Array | undefined>(chunks.length),
      remaining: chunks.length,
      appended: false
    };
    pendingMemos.push(owner);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      pendingChunks.push({ owner, chunkIndex, chunk: chunks[chunkIndex], order: order++ });
    }
  }
  let done = 0;
  let doneChunks = 0;
  callbacks.onProgress?.({ done: 0, total: pendingMemos.length, doneChunks: 0, totalChunks: pendingChunks.length });

  // FeatureExtractionPipeline pads every batch to its longest text. Running
  // similarly sized chunks together removes that wasted attention work while
  // preserving the exact same chunks, model, pooling, and final row order.
  const executionOrder = [...pendingChunks].sort((a, b) => a.chunk.length - b.chunk.length || a.order - b.order);

  // Intermediate indexes share one append-only vector buffer. Publishing no
  // longer recopies every completed vector after every eight-text batch.
  const partialRows = [...keptRows];
  const partialVectors = new Float32Array((keptRows.length + pendingChunks.length) * EMBEDDING_DIM);
  for (let kept = 0; kept < keptRowIndices.length; kept += 1) {
    const sourceRow = keptRowIndices[kept];
    partialVectors.set(
      index.vectors.subarray(sourceRow * EMBEDDING_DIM, (sourceRow + 1) * EMBEDDING_DIM),
      kept * EMBEDDING_DIM
    );
  }
  const appendCompletedMemo = (owner: PendingMemo): number => {
    if (owner.appended || owner.remaining !== 0) return 0;
    owner.appended = true;
    const startRows = partialRows.length;
    for (let chunkIndex = 0; chunkIndex < owner.chunks.length; chunkIndex += 1) {
      const vector = owner.vectors[chunkIndex];
      if (!vector || vector.length !== EMBEDDING_DIM) throw new Error(`Embedder returned an invalid vector for ${owner.memo.id}`);
      partialRows.push({
        id: owner.memo.id,
        updatedAt: owner.memo.updatedAt,
        contentKey: owner.contentKey,
        chunkIndex,
        chunkCount: owner.chunks.length
      });
      partialVectors.set(vector, (partialRows.length - 1) * EMBEDDING_DIM);
    }
    return partialRows.length - startRows;
  };
  const partialSnapshot = (): SemanticIndex => ({
    modelVersion: index.modelVersion,
    rows: [...partialRows],
    vectors: partialVectors.subarray(0, partialRows.length * EMBEDDING_DIM)
  });

  // Remove deleted/stale rows from live search immediately, before inference.
  if (keptRowIndices.length !== index.rows.length) callbacks.onPartial?.(partialSnapshot());

  const finalSnapshot = (): SemanticIndex => {
    const rows = [...keptRows];
    const pieces: Float32Array[] = [];
    for (const rowIndex of keptRowIndices) {
      pieces.push(index.vectors.subarray(rowIndex * EMBEDDING_DIM, (rowIndex + 1) * EMBEDDING_DIM));
    }
    for (const owner of pendingMemos) {
      if (owner.remaining !== 0) continue;
      for (let chunkIndex = 0; chunkIndex < owner.chunks.length; chunkIndex += 1) {
        const vector = owner.vectors[chunkIndex];
        if (!vector || vector.length !== EMBEDDING_DIM) throw new Error(`Embedder returned an invalid vector for ${owner.memo.id}`);
        rows.push({
          id: owner.memo.id,
          updatedAt: owner.memo.updatedAt,
          contentKey: owner.contentKey,
          chunkIndex,
          chunkCount: owner.chunks.length
        });
        pieces.push(vector);
      }
    }
    return packIndex(index.modelVersion, rows, pieces);
  };

  let rowsSinceFlush = 0;
  let rowsSincePublish = 0;
  let publishedPendingRows = false;
  for (let start = 0; start < executionOrder.length; start += EMBED_BATCH_TEXTS) {
    if (callbacks.shouldContinue && !callbacks.shouldContinue()) break;
    const batch = executionOrder.slice(start, start + EMBED_BATCH_TEXTS);
    const vectors = await embed(batch.map((item) => item.chunk));
    if (vectors.length !== batch.length) throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} chunks`);
    let appendedRows = 0;
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      if (vectors[i].length !== EMBEDDING_DIM) throw new Error(`Embedder returned a ${vectors[i].length}-dimension vector`);
      item.owner.vectors[item.chunkIndex] = vectors[i];
      item.owner.remaining -= 1;
      if (item.owner.remaining === 0) {
        done += 1;
        appendedRows += appendCompletedMemo(item.owner);
      }
    }
    doneChunks += batch.length;
    callbacks.onProgress?.({ done, total: pendingMemos.length, doneChunks, totalChunks: pendingChunks.length });
    rowsSincePublish += appendedRows;
    rowsSinceFlush += appendedRows;
    let partial: SemanticIndex | null = null;
    if (
      callbacks.onPartial &&
      appendedRows > 0 &&
      done < pendingMemos.length &&
      (!publishedPendingRows || rowsSincePublish >= PARTIAL_EVERY_ROWS)
    ) {
      partial = partialSnapshot();
      callbacks.onPartial(partial);
      publishedPendingRows = true;
      rowsSincePublish = 0;
    }
    if (callbacks.onFlush && rowsSinceFlush >= FLUSH_EVERY_ROWS) {
      rowsSinceFlush = 0;
      await callbacks.onFlush(partial ?? partialSnapshot());
    }
    await yieldToMainThread();
  }

  const final = finalSnapshot();
  callbacks.onPartial?.(final);
  return final;
}

/**
 * Add a range of row scores to a memo-level best-score map. Scope membership
 * is checked before the 384-float dot product, so a narrow Tag + Filter view
 * avoids almost all arithmetic for out-of-view memos.
 */
function scoreSemanticRows(
  index: SemanticIndex,
  queryVector: Float32Array,
  best: Map<string, number>,
  start: number,
  end: number,
  allowedMemoIds: ReadonlySet<string> | null
): void {
  const { rows, vectors } = index;
  for (let row = start; row < end; row += 1) {
    const id = rows[row].id;
    if (allowedMemoIds && !allowedMemoIds.has(id)) continue;
    const base = row * EMBEDDING_DIM;
    let dot = 0;
    for (let k = 0; k < EMBEDDING_DIM; k += 1) dot += vectors[base + k] * queryVector[k];
    const current = best.get(id);
    if (current === undefined || dot > current) best.set(id, dot);
  }
}

function finishSemanticRanking(best: Map<string, number>): Map<string, number> {
  const ranked = [...best].filter(([, score]) => score >= SEMANTIC_SCORE_FLOOR);
  ranked.sort((a, b) => b[1] - a[1]);
  return new Map(ranked.slice(0, SEMANTIC_MAX_RESULTS));
}

/**
 * Rank memos against a unit query vector: per-row dot product, best chunk
 * wins per memo, noise floored, insertion order of the returned map is the
 * ranking. The optional set is the already-intersected feed scope.
 */
export function searchSemanticIndex(
  index: SemanticIndex,
  queryVector: Float32Array,
  allowedMemoIds: ReadonlySet<string> | null = null
): Map<string, number> {
  const best = new Map<string, number>();
  scoreSemanticRows(index, queryVector, best, 0, index.rows.length, allowedMemoIds);
  return finishSemanticRanking(best);
}

export interface SemanticSearchCallbacks {
  onProgress?: (doneRows: number, totalRows: number) => void;
  shouldContinue?: () => boolean;
}

/**
 * UI-safe ranking for the live search path. Dot products are split into small
 * slices with a main-thread yield between them; progress therefore reflects
 * rows actually examined and controls remain interactive even for a very
 * large encrypted index.
 */
export async function searchSemanticIndexAsync(
  index: SemanticIndex,
  queryVector: Float32Array,
  allowedMemoIds: ReadonlySet<string> | null = null,
  callbacks: SemanticSearchCallbacks = {}
): Promise<Map<string, number>> {
  const best = new Map<string, number>();
  const total = index.rows.length;
  callbacks.onProgress?.(0, total);
  for (let start = 0; start < total; start += SEARCH_ROWS_PER_YIELD) {
    if (callbacks.shouldContinue && !callbacks.shouldContinue()) return new Map();
    const end = Math.min(start + SEARCH_ROWS_PER_YIELD, total);
    scoreSemanticRows(index, queryVector, best, start, end, allowedMemoIds);
    callbacks.onProgress?.(end, total);
    if (end < total) await yieldToMainThread();
  }
  return finishSemanticRanking(best);
}

// ---- Serialization ---------------------------------------------------------

interface IndexHeader {
  v: number;
  dim: number;
  modelVersion: string;
  rows: SemanticRow[];
}

export function encodeSemanticIndex(index: SemanticIndex): Uint8Array<ArrayBuffer> {
  const header: IndexHeader = { v: 2, dim: EMBEDDING_DIM, modelVersion: index.modelVersion, rows: index.rows };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const vectorBytes = new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength);
  const payload = new Uint8Array(4 + headerBytes.byteLength + vectorBytes.byteLength);
  new DataView(payload.buffer).setUint32(0, headerBytes.byteLength, true);
  payload.set(headerBytes, 4);
  payload.set(vectorBytes, 4 + headerBytes.byteLength);
  return payload;
}

export function decodeSemanticIndex(payload: Uint8Array): SemanticIndex | null {
  try {
    if (payload.byteLength < 4) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const headerLength = view.getUint32(0, true);
    if (4 + headerLength > payload.byteLength) return null;
    const header = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + headerLength))) as Partial<IndexHeader>;
    if (header.v !== 2 || header.dim !== EMBEDDING_DIM || typeof header.modelVersion !== "string" || !Array.isArray(header.rows)) {
      return null;
    }
    for (const row of header.rows) {
      if (
        !row ||
        typeof row.id !== "string" ||
        typeof row.updatedAt !== "string" ||
        typeof row.contentKey !== "string" ||
        !Number.isInteger(row.chunkIndex) ||
        !Number.isInteger(row.chunkCount) ||
        row.chunkCount < 1 ||
        row.chunkIndex < 0 ||
        row.chunkIndex >= row.chunkCount
      ) {
        return null;
      }
    }
    const vectorBytes = payload.subarray(4 + headerLength);
    if (vectorBytes.byteLength !== header.rows.length * EMBEDDING_DIM * 4) return null;
    // Copy through a fresh buffer: the sealed payload's offset carries no
    // alignment guarantee for a Float32Array view.
    const vectors = new Float32Array(vectorBytes.byteLength / 4);
    new Uint8Array(vectors.buffer).set(vectorBytes);
    return { modelVersion: header.modelVersion, rows: header.rows as SemanticRow[], vectors };
  } catch {
    return null;
  }
}

// ---- Sealed persistence ----------------------------------------------------

const DB_NAME = "memo-index";
const STORE = "kv";
const RECORD_KEY = "index";
const SEAL_PURPOSE = "memo-index:1";
let storeGeneration = 0;

interface SealedIndexRecord {
  v: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export interface SemanticIndexWriteToken {
  readonly generation: number;
}

/** Capture before long indexing work; a later clear invalidates this token. */
export function captureSemanticIndexWriteToken(): SemanticIndexWriteToken {
  return { generation: storeGeneration };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Persist the sealed index. Without the session key this is a deliberate
 * no-op — an unauthenticated device stores nothing, and the next authorized
 * session re-embeds instead.
 */
export async function saveSemanticIndex(
  index: SemanticIndex,
  token: SemanticIndexWriteToken = captureSemanticIndexWriteToken()
): Promise<void> {
  const generation = token.generation;
  if (generation !== storeGeneration) return;
  try {
    const sealed = await sealDerivedBytes(SEAL_PURPOSE, encodeSemanticIndex(index));
    if (!sealed || generation !== storeGeneration) return;
    const record: SealedIndexRecord = { v: 1, iv: sealed.iv, data: sealed.data };
    const db = await openDb();
    try {
      if (generation !== storeGeneration) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(record, RECORD_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("Index transaction aborted"));
      });
    } finally {
      db.close();
    }
  } catch {
    // Best-effort — a failed write only costs a re-embed next session.
  }
}

/** The sealed index for this model version, or null (absent, unreadable, stale). */
export async function loadSemanticIndex(modelVersion: string): Promise<SemanticIndex | null> {
  const generation = storeGeneration;
  try {
    const db = await openDb();
    let record: SealedIndexRecord | undefined;
    try {
      record = await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, "readonly");
        const request = transaction.objectStore(STORE).get(RECORD_KEY);
        request.onsuccess = () => resolve(request.result as SealedIndexRecord | undefined);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
    if (generation !== storeGeneration || !record || record.v !== 1 || !(record.iv instanceof Uint8Array) || !(record.data instanceof ArrayBuffer)) {
      return null;
    }
    const payload = await openDerivedBytes(SEAL_PURPOSE, record.iv, record.data);
    if (!payload || generation !== storeGeneration) return null;
    const index = decodeSemanticIndex(payload);
    return index && index.modelVersion === modelVersion ? index : null;
  } catch {
    return null;
  }
}

/** Drop the sealed index database entirely (logout cleanup). */
export function deleteSemanticIndexDb(): Promise<void> {
  storeGeneration += 1;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
