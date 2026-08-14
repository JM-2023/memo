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
// keyed by its `updatedAt`, so any edit invalidates exactly that memo's rows
// on the next reconcile. Vectors are unit-length (the runtime normalizes),
// which makes ranking a plain dot product.

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
  /** The memo's updatedAt when its rows were embedded; edits invalidate. */
  updatedAt: string;
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

export interface IndexPlan {
  /** Memos whose rows are missing or stale and need embedding. */
  stale: Memo[];
  /** Row indices still valid — their memo exists with the same updatedAt. */
  keptRowIndices: number[];
}

export function planSemanticIndex(index: SemanticIndex, memos: readonly Memo[]): IndexPlan {
  const liveUpdatedAt = new Map<string, string>();
  for (const memo of memos) liveUpdatedAt.set(memo.id, memo.updatedAt);

  const indexedUpdatedAt = new Map<string, string>();
  const keptRowIndices: number[] = [];
  for (let row = 0; row < index.rows.length; row += 1) {
    const entry = index.rows[row];
    indexedUpdatedAt.set(entry.id, entry.updatedAt);
    if (liveUpdatedAt.get(entry.id) === entry.updatedAt) keptRowIndices.push(row);
  }

  const stale = memos.filter((memo) => indexedUpdatedAt.get(memo.id) !== memo.updatedAt);
  return { stale, keptRowIndices };
}

export interface ReconcileCallbacks {
  /** Called after each embedded batch with memos done vs. memos to do. */
  onProgress?: (done: number, total: number) => void;
  /** Return false to stop early; the partial index is still returned. */
  shouldContinue?: () => boolean;
  /** Called periodically with a consistent snapshot worth persisting. */
  onFlush?: (index: SemanticIndex) => void | Promise<void>;
}

const EMBED_BATCH_TEXTS = 16;
const FLUSH_EVERY_ROWS = 256;

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
  const { stale, keptRowIndices } = planSemanticIndex(index, memos);
  if (stale.length === 0 && keptRowIndices.length === index.rows.length) return index;

  const rows: SemanticRow[] = [];
  const pieces: Float32Array[] = [];
  for (const rowIndex of keptRowIndices) {
    rows.push(index.rows[rowIndex]);
    pieces.push(index.vectors.slice(rowIndex * EMBEDDING_DIM, (rowIndex + 1) * EMBEDDING_DIM));
  }

  let done = 0;
  let rowsSinceFlush = 0;
  callbacks.onProgress?.(done, stale.length);

  let batch: { memo: Memo; chunk: string }[] = [];
  const flushBatch = async () => {
    if (batch.length === 0) return;
    const vectors = await embed(batch.map((item) => item.chunk));
    for (let i = 0; i < batch.length; i += 1) {
      rows.push({ id: batch[i].memo.id, updatedAt: batch[i].memo.updatedAt });
      pieces.push(vectors[i]);
    }
    rowsSinceFlush += batch.length;
    batch = [];
    if (callbacks.onFlush && rowsSinceFlush >= FLUSH_EVERY_ROWS) {
      rowsSinceFlush = 0;
      await callbacks.onFlush(packIndex(index.modelVersion, [...rows], [...pieces]));
    }
    await yieldToMainThread();
  };

  for (const memo of stale) {
    if (callbacks.shouldContinue && !callbacks.shouldContinue()) break;
    for (const chunk of chunkMemoContent(memo.content)) {
      batch.push({ memo, chunk });
      if (batch.length >= EMBED_BATCH_TEXTS) await flushBatch();
    }
    done += 1;
    callbacks.onProgress?.(done, stale.length);
  }
  await flushBatch();

  return packIndex(index.modelVersion, rows, pieces);
}

/**
 * Rank memos against a unit query vector: per-row dot product, best chunk
 * wins per memo, noise floored, insertion order of the returned map is the
 * ranking.
 */
export function searchSemanticIndex(index: SemanticIndex, queryVector: Float32Array): Map<string, number> {
  const best = new Map<string, number>();
  const { rows, vectors } = index;
  for (let row = 0; row < rows.length; row += 1) {
    const base = row * EMBEDDING_DIM;
    let dot = 0;
    for (let k = 0; k < EMBEDDING_DIM; k += 1) dot += vectors[base + k] * queryVector[k];
    const id = rows[row].id;
    const current = best.get(id);
    if (current === undefined || dot > current) best.set(id, dot);
  }
  const ranked = [...best].filter(([, score]) => score >= SEMANTIC_SCORE_FLOOR);
  ranked.sort((a, b) => b[1] - a[1]);
  return new Map(ranked.slice(0, SEMANTIC_MAX_RESULTS));
}

// ---- Serialization ---------------------------------------------------------

interface IndexHeader {
  v: number;
  dim: number;
  modelVersion: string;
  rows: SemanticRow[];
}

export function encodeSemanticIndex(index: SemanticIndex): Uint8Array<ArrayBuffer> {
  const header: IndexHeader = { v: 1, dim: EMBEDDING_DIM, modelVersion: index.modelVersion, rows: index.rows };
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
    if (header.v !== 1 || header.dim !== EMBEDDING_DIM || typeof header.modelVersion !== "string" || !Array.isArray(header.rows)) {
      return null;
    }
    for (const row of header.rows) {
      if (!row || typeof row.id !== "string" || typeof row.updatedAt !== "string") return null;
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

interface SealedIndexRecord {
  v: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
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
export async function saveSemanticIndex(index: SemanticIndex): Promise<void> {
  try {
    const sealed = await sealDerivedBytes(SEAL_PURPOSE, encodeSemanticIndex(index));
    if (!sealed) return;
    const record: SealedIndexRecord = { v: 1, iv: sealed.iv, data: sealed.data };
    const db = await openDb();
    try {
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
    if (!record || record.v !== 1 || !(record.iv instanceof Uint8Array) || !(record.data instanceof ArrayBuffer)) return null;
    const payload = await openDerivedBytes(SEAL_PURPOSE, record.iv, record.data);
    if (!payload) return null;
    const index = decodeSemanticIndex(payload);
    return index && index.modelVersion === modelVersion ? index : null;
  } catch {
    return null;
  }
}

/** Drop the sealed index database entirely (logout cleanup). */
export function deleteSemanticIndexDb(): Promise<void> {
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
