// Authenticated, encrypted local snapshot of the notebook. The clear-text
// cursor and opaque tab epoch are authenticated as AES-GCM additional data;
// the cursor is duplicated inside the ciphertext, so it can seed a warm sync
// without becoming a tamperable source of truth.

import type { Memo, TagMeta } from "./types";
import type { PurgedMemo } from "./syncState";

const DB_NAME = "memo-cache";
const STORE = "kv";
const SNAPSHOT_KEY = "snapshot";
const EPOCH_KEY = "epoch";
/** Version 3 binds cursor, tombstone watermarks, and a shared cache epoch. */
const SNAPSHOT_VERSION = 3;

export interface SealedSnapshot {
  v: number;
  epoch: string;
  cursor: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export interface Snapshot {
  cursor: number;
  syncEpoch: string;
  memos: Memo[];
  tags: TagMeta[];
  purged: PurgedMemo[];
}

/** A newer app schema wins; within one schema, cursor is the high-water. */
export function shouldReplaceSealedSnapshot(current: unknown, candidate: SealedSnapshot): boolean {
  if (!current || typeof current !== "object") return true;
  const record = current as Partial<SealedSnapshot>;
  // Reset epochs outrank schema/cursor ordering: an old D1 history must not
  // block the replacement snapshot merely because its cursor was higher.
  if (record.epoch !== candidate.epoch) return true;
  if (!Number.isFinite(record.v)) return true;
  if ((record.v as number) > candidate.v) return false;
  if (record.v !== candidate.v) return true;
  return !Number.isFinite(record.cursor) || Number(record.cursor) <= candidate.cursor;
}

/** Missing marker is initialized by the writer; an existing marker is final. */
export function cacheEpochAllowsWrite(storedEpoch: unknown, candidateEpoch: string): boolean {
  return typeof storedEpoch !== "string" || !storedEpoch || storedEpoch === candidateEpoch;
}

let keyB64: string | null = null;
let keyPromise: Promise<CryptoKey> | null = null;
let cacheEpoch: string | null = null;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function cursorAad(cursor: number, epoch: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`memo-cache:${SNAPSHOT_VERSION}:${epoch}:${cursor}`);
}

/** Remember the snapshot key delivered by an authenticated response. */
export function adoptCacheKey(b64: string | undefined | null): void {
  if (!b64 || b64 === keyB64) return;
  keyB64 = b64;
  keyPromise = crypto.subtle.importKey("raw", base64ToBytes(b64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Make ciphertext unreadable immediately on logout/auth loss. */
export function forgetCacheKey(): void {
  keyB64 = null;
  keyPromise = null;
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

async function idbReadState(): Promise<{ record: SealedSnapshot | null; epoch: string }> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      // Initialize the shared marker in the same transaction as the read so
      // every tab starts from one epoch even when no snapshot exists yet.
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const snapshotRequest = store.get(SNAPSHOT_KEY);
      const epochRequest = store.get(EPOCH_KEY);
      let record: SealedSnapshot | null = null;
      let epoch = "";
      snapshotRequest.onsuccess = () => {
        record = (snapshotRequest.result as SealedSnapshot | undefined) ?? null;
      };
      epochRequest.onsuccess = () => {
        epoch = typeof epochRequest.result === "string" && epochRequest.result ? epochRequest.result : crypto.randomUUID();
        if (epochRequest.result !== epoch) store.put(epoch, EPOCH_KEY);
      };
      snapshotRequest.onerror = () => transaction.abort();
      epochRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve({ record, epoch });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function idbWrite(record: SealedSnapshot): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      // Both guards share this write transaction. Cursor ordering handles
      // ordinary tab races; the epoch rejects a late write from an invalidated
      // D1 history even when that stale cursor is numerically larger.
      const snapshotRequest = store.get(SNAPSHOT_KEY);
      const epochRequest = store.get(EPOCH_KEY);
      let snapshotReady = false;
      let epochReady = false;
      const maybeWrite = () => {
        if (!snapshotReady || !epochReady) return;
        const storedEpoch = epochRequest.result;
        if (!cacheEpochAllowsWrite(storedEpoch, record.epoch)) return;
        if (storedEpoch !== record.epoch) store.put(record.epoch, EPOCH_KEY);
        if (shouldReplaceSealedSnapshot(snapshotRequest.result, record)) store.put(record, SNAPSHOT_KEY);
      };
      snapshotRequest.onsuccess = () => {
        snapshotReady = true;
        maybeWrite();
      };
      epochRequest.onsuccess = () => {
        epochReady = true;
        maybeWrite();
      };
      snapshotRequest.onerror = () => transaction.abort();
      epochRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function idbResetEpoch(): Promise<void> {
  const db = await openDb();
  const nextEpoch = crypto.randomUUID();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      store.put(nextEpoch, EPOCH_KEY);
      store.delete(SNAPSHOT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot transaction aborted"));
    });
    cacheEpoch = nextEpoch;
  } finally {
    db.close();
  }
}

async function ensureCacheEpoch(): Promise<string> {
  if (cacheEpoch) return cacheEpoch;
  const state = await idbReadState();
  cacheEpoch = state.epoch;
  return state.epoch;
}

/**
 * Serializes full-snapshot writes and makes invalidation a barrier. A queued
 * older cursor is discarded; equal cursors remain allowed because a mutation
 * response can legitimately improve state before its reconciliation pull.
 */
export class MonotonicWriteQueue<T extends { cursor: number }> {
  private generation = 0;
  private latestCursor = -1;
  private running = false;
  private pending: { value: T; generation: number; waiters: QueueWaiter[] } | null = null;
  private clearPending = false;
  private clearWaiters: QueueWaiter[] = [];

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly clear: () => Promise<void>
  ) {}

  get currentGeneration(): number {
    return this.generation;
  }

  get queuedCursor(): number {
    return this.latestCursor;
  }

  enqueue(value: T): Promise<void> {
    if (!Number.isFinite(value.cursor) || value.cursor < this.latestCursor) return Promise.resolve();
    this.latestCursor = Math.max(this.latestCursor, value.cursor);
    const generation = this.generation;
    const task = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (this.pending?.generation === generation) {
        // One write may already be running. Keep only the richest/latest
        // pending snapshot and let every replaced caller await that result.
        this.pending.value = value;
        this.pending.waiters.push(waiter);
      } else {
        this.pending = { value, generation, waiters: [waiter] };
      }
    });
    this.kick();
    return task;
  }

  invalidate(): Promise<void> {
    this.generation += 1;
    this.latestCursor = -1;
    if (this.pending && this.pending.generation !== this.generation) {
      for (const waiter of this.pending.waiters) waiter.resolve();
      this.pending = null;
    }
    const task = new Promise<void>((resolve, reject) => {
      this.clearWaiters.push({ resolve, reject });
    });
    this.clearPending = true;
    this.kick();
    return task;
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.clearPending) {
        this.clearPending = false;
        const waiters = this.clearWaiters;
        this.clearWaiters = [];
        try {
          await this.clear();
          for (const waiter of waiters) waiter.resolve();
        } catch (cause) {
          for (const waiter of waiters) waiter.reject(cause);
        }
        continue;
      }

      const item = this.pending;
      if (!item) break;
      this.pending = null;
      if (item.generation !== this.generation) {
        for (const waiter of item.waiters) waiter.resolve();
        continue;
      }
      try {
        await this.write(item.value);
        for (const waiter of item.waiters) waiter.resolve();
      } catch (cause) {
        for (const waiter of item.waiters) waiter.reject(cause);
      }
    }
    this.running = false;
    if (this.clearPending || this.pending) this.kick();
  }
}

interface QueueWaiter {
  resolve: () => void;
  reject: (cause?: unknown) => void;
}

const ENCODE_CHUNK_CHARS = 128 * 1024;
const YIELD_AFTER_BYTES = 256 * 1024;

async function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Encode in bounded pieces so a large notebook does not create one long task. */
export async function encodeSnapshotCooperatively(snapshot: Snapshot): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let buffer = "";
  let totalBytes = 0;
  let bytesSinceYield = 0;

  const flush = async () => {
    if (!buffer) return;
    const encoded = encoder.encode(buffer);
    buffer = "";
    chunks.push(encoded);
    totalBytes += encoded.byteLength;
    bytesSinceYield += encoded.byteLength;
    if (bytesSinceYield >= YIELD_AFTER_BYTES) {
      bytesSinceYield = 0;
      await yieldToMainThread();
    }
  };
  const append = (text: string) => {
    buffer += text;
    return buffer.length >= ENCODE_CHUNK_CHARS;
  };
  const appendArray = async (items: readonly unknown[]) => {
    for (let index = 0; index < items.length; index += 1) {
      if (append(`${index === 0 ? "" : ","}${JSON.stringify(items[index])}`)) await flush();
    }
  };

  append(`{"cursor":${JSON.stringify(snapshot.cursor)},"syncEpoch":${JSON.stringify(snapshot.syncEpoch)},"memos":[`);
  await appendArray(snapshot.memos);
  append(`],"tags":[`);
  await appendArray(snapshot.tags);
  append(`],"purged":[`);
  await appendArray(snapshot.purged);
  append(`]}`);
  await flush();

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  let copiedSinceYield = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
    copiedSinceYield += chunk.byteLength;
    if (copiedSinceYield >= YIELD_AFTER_BYTES) {
      copiedSinceYield = 0;
      await yieldToMainThread();
    }
  }
  return payload;
}

async function sealAndWrite(snapshot: Snapshot): Promise<void> {
  const pendingKey = keyPromise;
  if (!pendingKey) return;
  const epoch = await ensureCacheEpoch();
  const key = await pendingKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = await encodeSnapshotCooperatively(snapshot);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: cursorAad(snapshot.cursor, epoch) },
    key,
    payload
  );
  await idbWrite({ v: SNAPSHOT_VERSION, epoch, cursor: snapshot.cursor, iv, data });
}

const writeQueue = new MonotonicWriteQueue<Snapshot>(sealAndWrite, idbResetEpoch);

/** Read one exact sealed record; callers retain it across the warm-sync RTT. */
export async function readSealedSnapshot(): Promise<SealedSnapshot | null> {
  try {
    const { record, epoch } = await idbReadState();
    cacheEpoch = epoch;
    if (
      !record ||
      record.v !== SNAPSHOT_VERSION ||
      record.epoch !== epoch ||
      !Number.isFinite(record.cursor) ||
      record.cursor < 0
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/** Decrypt the exact record previously read by readSealedSnapshot. */
export async function openSnapshot(record: SealedSnapshot): Promise<Snapshot | null> {
  const pendingKey = keyPromise;
  if (!pendingKey || record.v !== SNAPSHOT_VERSION || !record.epoch) return null;
  try {
    // The retained record is exact, but another tab may have rotated the
    // shared epoch while this tab was awaiting its warm-sync response.
    const state = await idbReadState();
    cacheEpoch = state.epoch;
    if (state.epoch !== record.epoch) return null;
    const key = await pendingKey;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: cursorAad(record.cursor, record.epoch) },
      key,
      record.data
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<Snapshot>;
    if (
      parsed.cursor !== record.cursor ||
      typeof parsed.syncEpoch !== "string" ||
      !parsed.syncEpoch ||
      !Array.isArray(parsed.memos) ||
      !Array.isArray(parsed.tags) ||
      !Array.isArray(parsed.purged)
    ) {
      return null;
    }
    return { cursor: record.cursor, syncEpoch: parsed.syncEpoch, memos: parsed.memos, tags: parsed.tags, purged: parsed.purged };
  } catch {
    return null;
  }
}

/** Seal and persist current state in monotonic, serialized order. */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  if (!keyPromise) return;
  try {
    await writeQueue.enqueue(snapshot);
  } catch {
    // Best-effort — a failed write only costs the next warm start.
  }
}

/** Invalidate queued saves, forget the key, and rotate the shared tab epoch. */
export async function invalidateSnapshot(): Promise<void> {
  forgetCacheKey();
  try {
    await writeQueue.invalidate();
  } catch {
    // The key is already gone; a storage failure leaves only ciphertext.
  }
}
