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

import { derivedKeyIdentity, openDerivedBytes, sealDerivedBytes, SHARD_COUNT, shardOf } from "./cache";
import { EMBEDDING_DIM } from "./modelRuntime";
import type { Memo } from "./types";

/**
 * Granite accepts much longer inputs, but 400-character overlapping windows
 * keep single-threaded browser WASM inference responsive and let the best
 * local passage represent a long memo. Six windows cover ~2.2k characters
 * back to back; a longer memo keeps the same six-window budget (a 40k-character
 * memo would otherwise be ~100 rows on its own) but spreads the last four
 * across the rest of its text, so its later sections still have a window that
 * can match instead of the tail going unindexed.
 */
export const SEMANTIC_CHUNK_CHARS = 400;
export const SEMANTIC_CHUNK_OVERLAP = 50;
export const SEMANTIC_MAX_CHUNKS = 6;
/** Windows kept contiguous from the start of a memo too long to cover whole. */
const SEMANTIC_LEAD_CHUNKS = 2;
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

const SEMANTIC_CHUNK_STEP = SEMANTIC_CHUNK_CHARS - SEMANTIC_CHUNK_OVERLAP;
/** The longest text the contiguous windows reach the end of (2,150 chars). */
const SEMANTIC_CONTIGUOUS_CHARS = SEMANTIC_CHUNK_STEP * (SEMANTIC_MAX_CHUNKS - 1) + SEMANTIC_CHUNK_CHARS;

/** Overlapping windows over trimmed content; empty for whitespace-only memos. */
export function chunkMemoContent(content: string): string[] {
  const text = content.trim();
  if (!text) return [];
  const starts: number[] = [];
  if (text.length <= SEMANTIC_CONTIGUOUS_CHARS) {
    // Back to back, exactly as every existing index row was embedded: these
    // windows (and so their content keys) must not move.
    for (let start = 0; ; start += SEMANTIC_CHUNK_STEP) {
      starts.push(start);
      if (start + SEMANTIC_CHUNK_CHARS >= text.length) break;
    }
  } else {
    // The opening stays contiguous; the remaining windows are spaced evenly
    // from where it ends to the last character. At exactly the contiguous
    // length the spacing equals the ordinary step, so the two layouts meet.
    for (let index = 0; index < SEMANTIC_LEAD_CHUNKS; index += 1) starts.push(index * SEMANTIC_CHUNK_STEP);
    const first = SEMANTIC_LEAD_CHUNKS * SEMANTIC_CHUNK_STEP;
    const last = text.length - SEMANTIC_CHUNK_CHARS;
    const spread = SEMANTIC_MAX_CHUNKS - SEMANTIC_LEAD_CHUNKS - 1;
    for (let index = 0; index <= spread; index += 1) starts.push(Math.round(first + ((last - first) * index) / spread));
  }
  const chunks: string[] = [];
  for (const start of starts) {
    const piece = text.slice(start, Math.min(text.length, start + SEMANTIC_CHUNK_CHARS)).trim();
    if (piece) chunks.push(piece);
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
    const sameUpdatedAt = state?.updatedAt === memo.updatedAt;
    // Most plans take this O(1) route. Hash text only after updatedAt changes,
    // which is when an attachment-only edit must be distinguished from text —
    // or when the memo is too long for the contiguous windows: rows embedded
    // before long memos spread their windows still carry head-only keys under
    // an unchanged updatedAt, and only hashing (six short slices) finds them.
    if (
      structurallyComplete &&
      sameUpdatedAt &&
      !(state?.chunkCount === SEMANTIC_MAX_CHUNKS && memo.content.length > SEMANTIC_CONTIGUOUS_CHARS)
    ) {
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
      if (!sameUpdatedAt) refreshedUpdatedAt.push({ id: memo.id, updatedAt: memo.updatedAt });
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
/** First checkpoint; later ones wait until the pass has appended half as many
    rows again as it already had, so a first build seals O(n) bytes in total
    instead of O(n²) — at the cost of redoing at most a third of the pass if
    the tab closes mid-build. Rows the pass kept do not count towards the
    growth, so catching up on an existing index still checkpoints every 256
    appended rows to begin with. */
const FLUSH_EVERY_ROWS = 256;
const PARTIAL_EVERY_ROWS = 256;
/** Rows scored between clock checks, and the main-thread budget per slice:
    a typical index ranks in one or two slices, a huge one still yields. */
const SEARCH_ROWS_PER_CHECK = 256;
const SEARCH_SLICE_MS = 8;

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
    /** Its rows once appended; the final index reuses these exact objects so
        persistence can tell by identity which shards a pass changed. */
    rows: SemanticRow[] | null;
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
      rows: null
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
  const completedOrder: PendingMemo[] = [];
  const appendCompletedMemo = (owner: PendingMemo): number => {
    if (owner.rows || owner.remaining !== 0) return 0;
    const rows: SemanticRow[] = [];
    for (let chunkIndex = 0; chunkIndex < owner.chunks.length; chunkIndex += 1) {
      const vector = owner.vectors[chunkIndex];
      if (!vector || vector.length !== EMBEDDING_DIM) throw new Error(`Embedder returned an invalid vector for ${owner.memo.id}`);
      const row: SemanticRow = {
        id: owner.memo.id,
        updatedAt: owner.memo.updatedAt,
        contentKey: owner.contentKey,
        chunkIndex,
        chunkCount: owner.chunks.length
      };
      rows.push(row);
      partialRows.push(row);
      partialVectors.set(vector, (partialRows.length - 1) * EMBEDDING_DIM);
    }
    owner.rows = rows;
    completedOrder.push(owner);
    return rows.length;
  };
  const partialSnapshot = (): SemanticIndex => ({
    modelVersion: index.modelVersion,
    rows: [...partialRows],
    vectors: partialVectors.subarray(0, partialRows.length * EMBEDDING_DIM)
  });

  // Remove deleted/stale rows from live search immediately, before inference.
  if (keptRowIndices.length !== index.rows.length) callbacks.onPartial?.(partialSnapshot());

  const finalSnapshot = (): SemanticIndex => {
    const completed = pendingMemos.filter((owner) => owner.rows !== null);
    // Memos finished in their final order (one edit, or same-length texts):
    // the append-only buffer already is the final layout, so skip the copy.
    if (completed.every((owner, position) => completedOrder[position] === owner)) return partialSnapshot();
    const rows = [...keptRows];
    const pieces: Float32Array[] = [];
    for (const rowIndex of keptRowIndices) {
      pieces.push(index.vectors.subarray(rowIndex * EMBEDDING_DIM, (rowIndex + 1) * EMBEDDING_DIM));
    }
    for (const owner of completed) {
      rows.push(...owner.rows!);
      for (const vector of owner.vectors) pieces.push(vector!);
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
    const appendedBeforeFlush = partialRows.length - keptRows.length - rowsSinceFlush;
    if (callbacks.onFlush && rowsSinceFlush >= Math.max(FLUSH_EVERY_ROWS, appendedBeforeFlush / 2)) {
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
 * UI-safe ranking for the live search path. Dot products run in time-boxed
 * slices with a main-thread yield between them, so controls stay interactive
 * even for a very large encrypted index while an ordinary one finishes in a
 * slice or two. Progress is reported at each yield and reflects rows actually
 * examined.
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
  let sliceStart = performance.now();
  for (let start = 0; start < total; start += SEARCH_ROWS_PER_CHECK) {
    if (callbacks.shouldContinue && !callbacks.shouldContinue()) return new Map();
    const end = Math.min(start + SEARCH_ROWS_PER_CHECK, total);
    scoreSemanticRows(index, queryVector, best, start, end, allowedMemoIds);
    if (end < total && performance.now() - sliceStart >= SEARCH_SLICE_MS) {
      callbacks.onProgress?.(end, total);
      await yieldToMainThread();
      sliceStart = performance.now();
    }
  }
  if (callbacks.shouldContinue && !callbacks.shouldContinue()) return new Map();
  callbacks.onProgress?.(total, total);
  return finishSemanticRanking(best);
}


// ---- Serialization ---------------------------------------------------------

interface IndexHeader {
  v: number;
  dim: number;
  modelVersion: string;
  rows: SemanticRow[];
}

const ROW_BYTES = EMBEDDING_DIM * 4;

/** Header plus packed vectors for the given rows, or for every row. */
function encodeRows(index: SemanticIndex, rowIndices: readonly number[] | null): Uint8Array<ArrayBuffer> {
  const rows = rowIndices ? rowIndices.map((row) => index.rows[row]) : index.rows;
  const header: IndexHeader = { v: 2, dim: EMBEDDING_DIM, modelVersion: index.modelVersion, rows };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const vectorBytes = new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength);
  const base = 4 + headerBytes.byteLength;
  const payload = new Uint8Array(base + rows.length * ROW_BYTES);
  new DataView(payload.buffer).setUint32(0, headerBytes.byteLength, true);
  payload.set(headerBytes, 4);
  if (!rowIndices) {
    payload.set(vectorBytes.subarray(0, rows.length * ROW_BYTES), base);
  } else {
    for (let position = 0; position < rowIndices.length; position += 1) {
      const row = rowIndices[position];
      payload.set(vectorBytes.subarray(row * ROW_BYTES, (row + 1) * ROW_BYTES), base + position * ROW_BYTES);
    }
  }
  return payload;
}

export function encodeSemanticIndex(index: SemanticIndex): Uint8Array<ArrayBuffer> {
  return encodeRows(index, null);
}

interface ParsedIndexPayload {
  modelVersion: string;
  rows: SemanticRow[];
  /** A view into the payload; callers copy it into an aligned buffer. */
  vectorBytes: Uint8Array;
}

function parseIndexPayload(payload: Uint8Array): ParsedIndexPayload | null {
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
    if (vectorBytes.byteLength !== header.rows.length * ROW_BYTES) return null;
    return { modelVersion: header.modelVersion, rows: header.rows as SemanticRow[], vectorBytes };
  } catch {
    return null;
  }
}

export function decodeSemanticIndex(payload: Uint8Array): SemanticIndex | null {
  const parsed = parseIndexPayload(payload);
  if (!parsed) return null;
  // Copy through a fresh buffer: the sealed payload's offset carries no
  // alignment guarantee for a Float32Array view.
  const vectors = new Float32Array(parsed.vectorBytes.byteLength / 4);
  new Uint8Array(vectors.buffer).set(parsed.vectorBytes);
  return { modelVersion: parsed.modelVersion, rows: parsed.rows, vectors };
}

// ---- Sealed persistence ----------------------------------------------------
//
// Stored the way the snapshot cache is: a small sealed manifest plus
// SHARD_COUNT shards of rows bucketed by memo id (cache.ts shardOf). Each
// shard is sealed under a fresh id bound into its additional data and listed
// inside the manifest's ciphertext, so the set only ever opens as the exact
// state one write produced. A save re-seals just the shards whose rows
// changed, decided by row identity — reconcile hands unchanged memos' row
// objects through untouched — never by re-serializing. A version-1 record
// (the whole index as one sealed blob) still opens, and the next save writes
// it out in shards: an upgrade costs one write, not a re-embed.

const DB_NAME = "memo-index";
const STORE = "kv";
const RECORD_KEY = "index";
const LEGACY_SEAL_PURPOSE = "memo-index:1";
const MANIFEST_SEAL_PURPOSE = "memo-index:2:manifest";
const RECORD_VERSION = 2;
let storeGeneration = 0;

function shardKey(shard: number): string {
  return `index-shard:${shard}`;
}

function shardSealPurpose(shard: number, id: string): string {
  return `memo-index:2:shard:${shard}:${id}`;
}

interface SealedBox {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

/** Stored under RECORD_KEY. `shards` is a clear-text copy of the ids the
    ciphertext lists, used only as a concurrency token, never when opening. */
interface IndexManifestRecord extends SealedBox {
  v: number;
  shards: string[];
}

interface IndexShardRecord extends SealedBox {
  id: string;
}

interface IndexManifestPayload {
  modelVersion: string;
  dim: number;
  shards: string[];
}

export interface SemanticIndexWriteToken {
  readonly generation: number;
}

/**
 * What this tab last wrote or opened: per shard, the stored id and the exact
 * row objects sealed in it. Tied to the key and model it was sealed under.
 */
let baseline: { key: object; modelVersion: string; shardIds: string[]; shardRows: (readonly SemanticRow[])[] } | null = null;
/** Saves run one at a time, so each compares against the last one's baseline. */
let saveTail: Promise<void> = Promise.resolve();

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

function isSealedBox(value: unknown): value is SealedBox {
  const box = value as Partial<SealedBox> | null | undefined;
  return Boolean(box && box.iv instanceof Uint8Array && box.data instanceof ArrayBuffer);
}

function sameRows(a: readonly SemanticRow[], b: readonly SemanticRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

type WriteOutcome = "written" | "skipped" | "conflict";

/**
 * Write a manifest and the shards it re-sealed. If the stored manifest no
 * longer lists the ids of the shards this write keeps (the store was cleared
 * or rewritten elsewhere), nothing is written and the caller writes in full.
 */
async function idbWrite(
  record: IndexManifestRecord,
  sealed: ReadonlyMap<number, IndexShardRecord>,
  reused: readonly number[],
  generation: number
): Promise<WriteOutcome> {
  const db = await openDb();
  try {
    return await new Promise<WriteOutcome>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const current = store.get(RECORD_KEY);
      let outcome: WriteOutcome = "skipped";
      current.onsuccess = () => {
        if (generation !== storeGeneration) return;
        if (reused.length > 0) {
          const stored = current.result as Partial<IndexManifestRecord> | undefined;
          const storedShards = stored?.v === RECORD_VERSION && Array.isArray(stored.shards) ? stored.shards : null;
          if (!storedShards || reused.some((shard) => storedShards[shard] !== record.shards[shard])) {
            outcome = "conflict";
            return;
          }
        }
        for (const [shard, shardRecord] of sealed) store.put(shardRecord, shardKey(shard));
        store.put(record, RECORD_KEY);
        outcome = "written";
      };
      current.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Index transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function writeShards(index: SemanticIndex, generation: number, forceFull: boolean): Promise<void> {
  const key = derivedKeyIdentity();
  if (!key) return;
  const buckets: number[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (let row = 0; row < index.rows.length; row += 1) buckets[shardOf(index.rows[row].id)].push(row);
  const base = !forceFull && baseline && baseline.key === key && baseline.modelVersion === index.modelVersion ? baseline : null;

  const shardIds: string[] = [];
  const shardRows: SemanticRow[][] = [];
  const sealed = new Map<number, IndexShardRecord>();
  const reused: number[] = [];
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    const rows = buckets[shard].map((row) => index.rows[row]);
    shardRows.push(rows);
    if (base && sameRows(base.shardRows[shard], rows)) {
      shardIds.push(base.shardIds[shard]);
      reused.push(shard);
      continue;
    }
    const id = crypto.randomUUID();
    const box = await sealDerivedBytes(shardSealPurpose(shard, id), encodeRows(index, buckets[shard]));
    if (!box || generation !== storeGeneration) return;
    shardIds.push(id);
    sealed.set(shard, { id, iv: box.iv, data: box.data });
  }

  const manifest: IndexManifestPayload = { modelVersion: index.modelVersion, dim: EMBEDDING_DIM, shards: shardIds };
  const box = await sealDerivedBytes(MANIFEST_SEAL_PURPOSE, new TextEncoder().encode(JSON.stringify(manifest)));
  // A key swapped mid-write would leave shards sealed under two keys.
  if (!box || generation !== storeGeneration || derivedKeyIdentity() !== key) return;
  const outcome = await idbWrite({ v: RECORD_VERSION, iv: box.iv, data: box.data, shards: shardIds }, sealed, reused, generation);
  if (outcome === "written") {
    if (generation === storeGeneration) baseline = { key, modelVersion: index.modelVersion, shardIds, shardRows };
    return;
  }
  baseline = null;
  // Shards this write meant to keep are gone; a full write depends on
  // nothing already stored.
  if (outcome === "conflict" && !forceFull) await writeShards(index, generation, true);
}

/**
 * Persist the sealed index. Without the session key this is a deliberate
 * no-op — an unauthenticated device stores nothing, and the next authorized
 * session re-embeds instead.
 */
export function saveSemanticIndex(
  index: SemanticIndex,
  token: SemanticIndexWriteToken = captureSemanticIndexWriteToken()
): Promise<void> {
  const run = saveTail.then(async () => {
    if (token.generation !== storeGeneration) return;
    try {
      await writeShards(index, token.generation, false);
    } catch {
      // Best-effort — a failed write only costs a re-embed next session.
      baseline = null;
    }
  });
  saveTail = run;
  return run;
}

async function openLegacyIndex(record: SealedBox, modelVersion: string, generation: number): Promise<SemanticIndex | null> {
  const payload = await openDerivedBytes(LEGACY_SEAL_PURPOSE, record.iv, record.data);
  if (!payload || generation !== storeGeneration) return null;
  const index = decodeSemanticIndex(payload);
  return index && index.modelVersion === modelVersion ? index : null;
}

async function openShardedIndex(
  record: SealedBox,
  shardRecords: readonly unknown[],
  modelVersion: string,
  generation: number
): Promise<SemanticIndex | null> {
  const key = derivedKeyIdentity();
  if (!key) return null;
  const plain = await openDerivedBytes(MANIFEST_SEAL_PURPOSE, record.iv, record.data);
  if (!plain) return null;
  const manifest = JSON.parse(new TextDecoder().decode(plain)) as Partial<IndexManifestPayload>;
  if (
    manifest.modelVersion !== modelVersion ||
    manifest.dim !== EMBEDDING_DIM ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length !== SHARD_COUNT
  ) {
    return null;
  }
  // The authenticated id list, not the clear-text copy, decides which shard
  // ciphertexts belong to this manifest.
  const parts: ParsedIndexPayload[] = [];
  let rowCount = 0;
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    const id = manifest.shards[shard];
    const shardRecord = shardRecords[shard] as Partial<IndexShardRecord> | undefined;
    if (typeof id !== "string" || !shardRecord || shardRecord.id !== id || !isSealedBox(shardRecord)) return null;
    const payload = await openDerivedBytes(shardSealPurpose(shard, id), shardRecord.iv, shardRecord.data);
    const parsed = payload ? parseIndexPayload(payload) : null;
    if (!parsed || parsed.modelVersion !== modelVersion || parsed.rows.some((row) => shardOf(row.id) !== shard)) return null;
    parts.push(parsed);
    rowCount += parsed.rows.length;
  }
  if (generation !== storeGeneration) return null;
  const rows: SemanticRow[] = [];
  const vectors = new Float32Array(rowCount * EMBEDDING_DIM);
  const vectorBytes = new Uint8Array(vectors.buffer);
  for (const part of parts) {
    vectorBytes.set(part.vectorBytes, rows.length * ROW_BYTES);
    for (const row of part.rows) rows.push(row);
  }
  // The very row objects returned here are what the next save compares to.
  baseline = { key, modelVersion, shardIds: manifest.shards, shardRows: parts.map((part) => part.rows) };
  return { modelVersion, rows, vectors };
}

/** The sealed index for this model version, or null (absent, unreadable, stale). */
export async function loadSemanticIndex(modelVersion: string): Promise<SemanticIndex | null> {
  const generation = storeGeneration;
  try {
    const db = await openDb();
    let record: unknown;
    let shardRecords: unknown[] = [];
    try {
      [record, shardRecords] = await new Promise<[unknown, unknown[]]>((resolve, reject) => {
        // One read transaction: the manifest and its shards as one write left them.
        const transaction = db.transaction(STORE, "readonly");
        const store = transaction.objectStore(STORE);
        const head = store.get(RECORD_KEY);
        const shards = Array.from({ length: SHARD_COUNT }, (_, shard) => store.get(shardKey(shard)));
        transaction.oncomplete = () => resolve([head.result, shards.map((request) => request.result)]);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("Index transaction aborted"));
      });
    } finally {
      db.close();
    }
    if (generation !== storeGeneration || !isSealedBox(record)) return null;
    const version = (record as { v?: unknown }).v;
    if (version === 1) return await openLegacyIndex(record, modelVersion, generation);
    if (version === RECORD_VERSION) return await openShardedIndex(record, shardRecords, modelVersion, generation);
    return null;
  } catch {
    return null;
  }
}

/** Drop the sealed index database entirely (logout cleanup). */
export function deleteSemanticIndexDb(): Promise<void> {
  storeGeneration += 1;
  baseline = null;
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
