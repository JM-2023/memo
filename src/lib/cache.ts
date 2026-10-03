// Authenticated, encrypted local snapshot of the notebook. The clear-text
// cursor and opaque tab epoch are authenticated as AES-GCM additional data;
// the cursor is duplicated inside the ciphertext, so it can seed a warm sync
// without becoming a tamperable source of truth.
//
// The snapshot is stored as a small manifest plus SHARD_COUNT memo shards
// (memos bucketed by a hash of their id), so a save re-seals only the shards
// whose memos changed instead of the whole notebook. Each shard is sealed
// under a fresh random id that is bound into its AES-GCM additional data and
// listed inside the manifest's ciphertext: a shard from any other write can
// never be mixed into this manifest, so the pair still opens only as the
// exact state one write produced. The manifest also carries the (small) tag
// rows and purge tombstones, and is re-sealed on every save.

import type { Memo, TagMeta } from "./types";
import type { PurgedMemo } from "./syncState";

const DB_NAME = "memo-cache";
const STORE = "kv";
const SNAPSHOT_KEY = "snapshot";
const EPOCH_KEY = "epoch";
/** Version 4 splits memos into id-bound shards under a sealed manifest. */
const SNAPSHOT_VERSION = 4;
/** Fixed, so a memo's shard never moves; 32 keeps a warm start to one read
 * transaction of 33 records while an edit re-seals ~1/32 of the memos. */
export const SHARD_COUNT = 32;

function shardKey(index: number): string {
  return `snapshot-shard:${index}`;
}

/** The sealed manifest record (stored under SNAPSHOT_KEY). */
export interface SealedSnapshot {
  v: number;
  epoch: string;
  cursor: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
  /** Clear-text copy of the shard ids the manifest seals; only ever used as a
   * cross-tab concurrency token, never trusted when opening. */
  shards: string[];
}

export interface SealedShard {
  id: string;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

/** A manifest plus the shard records read in the same transaction. */
export interface SealedSnapshotHandle extends SealedSnapshot {
  shardRecords: (SealedShard | null)[];
}

export interface Snapshot {
  cursor: number;
  syncEpoch: string;
  memos: Memo[];
  tags: TagMeta[];
  purged: PurgedMemo[];
}

/** A newer app schema wins; within one schema, cursor is the high-water. */
export function shouldReplaceSealedSnapshot(current: unknown, candidate: Pick<SealedSnapshot, "v" | "epoch" | "cursor">): boolean {
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

function shardAad(index: number, id: string, epoch: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`memo-cache:${SNAPSHOT_VERSION}:${epoch}:shard:${index}:${id}`);
}

/** FNV-1a over the id: stable across sessions and tabs, cheap per save. */
export function shardOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SHARD_COUNT;
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

/**
 * Seal a derived payload (e.g. the semantic index) with the same server-held
 * key as the snapshot. Data derived from memo content must share the
 * notebook's fate: without an authenticated session there is no key, sealing
 * returns null, and callers must store nothing rather than fall back to
 * plaintext. The purpose string is bound as additional data so one sealed
 * payload type can never be replayed as another.
 */
export async function sealDerivedBytes(
  purpose: string,
  payload: Uint8Array<ArrayBuffer>
): Promise<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | null> {
  const pendingKey = keyPromise;
  if (!pendingKey) return null;
  try {
    const key = await pendingKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
      key,
      payload
    );
    return { iv, data };
  } catch {
    return null;
  }
}

/**
 * Opaque identity of the key sealDerivedBytes would use now (null without
 * one). Incremental writers compare it to tell whether ciphertext they stored
 * earlier is still readable, so nothing sealed under a replaced key is reused.
 */
export function derivedKeyIdentity(): object | null {
  return keyPromise;
}

/** Open a payload sealed by sealDerivedBytes; null without the key or on tampering. */
export async function openDerivedBytes(
  purpose: string,
  iv: Uint8Array<ArrayBuffer>,
  data: ArrayBuffer
): Promise<Uint8Array<ArrayBuffer> | null> {
  const pendingKey = keyPromise;
  if (!pendingKey) return null;
  try {
    const key = await pendingKey;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
      key,
      data
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
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

async function idbReadState(withShards = false): Promise<{ record: SealedSnapshotHandle | null; epoch: string }> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      // Initialize the shared marker in the same transaction as the read so
      // every tab starts from one epoch even when no snapshot exists yet.
      // Shards ride the same transaction as their manifest: IndexedDB's
      // transaction isolation is what makes the set one consistent write.
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const snapshotRequest = store.get(SNAPSHOT_KEY);
      const epochRequest = store.get(EPOCH_KEY);
      const shardRequests = withShards ? Array.from({ length: SHARD_COUNT }, (_, index) => store.get(shardKey(index))) : [];
      let record: SealedSnapshotHandle | null = null;
      let epoch = "";
      snapshotRequest.onsuccess = () => {
        const manifest = (snapshotRequest.result as SealedSnapshot | undefined) ?? null;
        record = manifest ? { ...manifest, shardRecords: [] } : null;
      };
      for (const request of shardRequests) request.onerror = () => transaction.abort();
      epochRequest.onsuccess = () => {
        epoch = typeof epochRequest.result === "string" && epochRequest.result ? epochRequest.result : crypto.randomUUID();
        if (epochRequest.result !== epoch) store.put(epoch, EPOCH_KEY);
      };
      snapshotRequest.onerror = () => transaction.abort();
      epochRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => {
        if (record) record.shardRecords = shardRequests.map((request) => (request.result as SealedShard | undefined) ?? null);
        resolve({ record, epoch });
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot transaction aborted"));
    });
  } finally {
    db.close();
  }
}

type WriteOutcome = "written" | "skipped" | "conflict";

/**
 * Write a manifest and the shards it re-sealed. `reused` names the shards the
 * manifest takes over unchanged from what this tab believes is stored; if the
 * stored manifest no longer lists exactly those ids (another tab wrote in
 * between), nothing is written and the caller falls back to a full write.
 */
async function idbWrite(record: SealedSnapshot, sealed: Map<number, SealedShard>, reused: readonly number[]): Promise<WriteOutcome> {
  const db = await openDb();
  try {
    return await new Promise<WriteOutcome>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      // All guards share this write transaction. Cursor ordering handles
      // ordinary tab races; the epoch rejects a late write from an invalidated
      // D1 history even when that stale cursor is numerically larger.
      const snapshotRequest = store.get(SNAPSHOT_KEY);
      const epochRequest = store.get(EPOCH_KEY);
      let snapshotReady = false;
      let epochReady = false;
      let outcome: WriteOutcome = "skipped";
      const maybeWrite = () => {
        if (!snapshotReady || !epochReady) return;
        const storedEpoch = epochRequest.result;
        if (!cacheEpochAllowsWrite(storedEpoch, record.epoch)) return;
        const stored = snapshotRequest.result as Partial<SealedSnapshot> | undefined;
        if (!shouldReplaceSealedSnapshot(stored, record)) return;
        if (reused.length > 0) {
          const storedShards = stored?.v === record.v && stored.epoch === record.epoch && Array.isArray(stored.shards) ? stored.shards : null;
          if (!storedShards || reused.some((index) => storedShards[index] !== record.shards[index])) {
            outcome = "conflict";
            return;
          }
        }
        if (storedEpoch !== record.epoch) store.put(record.epoch, EPOCH_KEY);
        for (const [index, shard] of sealed) store.put(shard, shardKey(index));
        store.put(record, SNAPSHOT_KEY);
        outcome = "written";
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
      transaction.oncomplete = () => resolve(outcome);
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
      for (let index = 0; index < SHARD_COUNT; index += 1) store.delete(shardKey(index));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot transaction aborted"));
    });
    cacheEpoch = nextEpoch;
    baseline = null;
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

const YIELD_AFTER_BYTES = 256 * 1024;

async function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface ManifestPayload {
  cursor: number;
  syncEpoch: string;
  tags: TagMeta[];
  purged: PurgedMemo[];
  shards: string[];
}

/**
 * What this tab last wrote (or opened): per shard, the stored id and the
 * exact memo objects sealed in it. Sync state replaces a memo object only
 * when that memo changes, so a shard whose members are the same objects in
 * the same order needs no re-seal — detection is reference comparison, not
 * serialization. Tied to the key it was sealed under: a rotated key makes
 * every stored shard unreadable, so nothing may be reused across it.
 */
let baseline: { key: Promise<CryptoKey>; epoch: string; shardIds: string[]; shardMemos: (readonly Memo[])[] } | null = null;

function bucketMemos(memos: readonly Memo[]): Memo[][] {
  const buckets: Memo[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (const memo of memos) buckets[shardOf(memo.id)].push(memo);
  return buckets;
}

function sameMembers(a: readonly Memo[], b: readonly Memo[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

async function sealAndWrite(snapshot: Snapshot, forceFull = false): Promise<void> {
  const pendingKey = keyPromise;
  if (!pendingKey) return;
  const epoch = await ensureCacheEpoch();
  const key = await pendingKey;
  const encoder = new TextEncoder();
  const buckets = bucketMemos(snapshot.memos);
  const base = !forceFull && baseline && baseline.key === pendingKey && baseline.epoch === epoch ? baseline : null;

  const shardIds: string[] = [];
  const sealed = new Map<number, SealedShard>();
  const reused: number[] = [];
  let bytesSinceYield = 0;
  for (let index = 0; index < SHARD_COUNT; index += 1) {
    if (base && sameMembers(base.shardMemos[index], buckets[index])) {
      shardIds.push(base.shardIds[index]);
      reused.push(index);
      continue;
    }
    const id = crypto.randomUUID();
    const payload = encoder.encode(JSON.stringify(buckets[index]));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: shardAad(index, id, epoch) }, key, payload);
    shardIds.push(id);
    sealed.set(index, { id, iv, data });
    // Bounded pieces: a cold first write of a large notebook still never
    // becomes one long task.
    bytesSinceYield += payload.byteLength;
    if (bytesSinceYield >= YIELD_AFTER_BYTES) {
      bytesSinceYield = 0;
      await yieldToMainThread();
    }
  }

  const manifest: ManifestPayload = {
    cursor: snapshot.cursor,
    syncEpoch: snapshot.syncEpoch,
    tags: snapshot.tags,
    purged: snapshot.purged,
    shards: shardIds
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: cursorAad(snapshot.cursor, epoch) },
    key,
    encoder.encode(JSON.stringify(manifest))
  );
  const outcome = await idbWrite({ v: SNAPSHOT_VERSION, epoch, cursor: snapshot.cursor, iv, data, shards: shardIds }, sealed, reused);
  if (outcome === "written") {
    baseline = { key: pendingKey, epoch, shardIds, shardMemos: buckets };
  } else if (outcome === "conflict") {
    // Another tab rewrote shards this write meant to keep. Re-seal them all;
    // a full write depends on nothing already stored.
    baseline = null;
    await sealAndWrite(snapshot, true);
  } else {
    // A newer cursor or epoch owns the store; what it holds is not ours.
    baseline = null;
  }
}

const writeQueue = new MonotonicWriteQueue<Snapshot>((snapshot) => sealAndWrite(snapshot), idbResetEpoch);

/** Read one exact sealed record set; callers retain it across the warm-sync RTT. */
export async function readSealedSnapshot(): Promise<SealedSnapshotHandle | null> {
  try {
    const { record, epoch } = await idbReadState(true);
    cacheEpoch = epoch;
    if (
      !record ||
      record.v !== SNAPSHOT_VERSION ||
      record.epoch !== epoch ||
      !Number.isFinite(record.cursor) ||
      record.cursor < 0 ||
      !Array.isArray(record.shards) ||
      record.shards.length !== SHARD_COUNT
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/** Decrypt the exact record set previously read by readSealedSnapshot. */
export async function openSnapshot(record: SealedSnapshotHandle): Promise<Snapshot | null> {
  const pendingKey = keyPromise;
  if (!pendingKey || record.v !== SNAPSHOT_VERSION || !record.epoch) return null;
  try {
    // The retained record is exact, but another tab may have rotated the
    // shared epoch while this tab was awaiting its warm-sync response.
    const state = await idbReadState();
    cacheEpoch = state.epoch;
    if (state.epoch !== record.epoch) return null;
    const key = await pendingKey;
    const decoder = new TextDecoder();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: cursorAad(record.cursor, record.epoch) },
      key,
      record.data
    );
    const parsed = JSON.parse(decoder.decode(plaintext)) as Partial<ManifestPayload>;
    if (
      parsed.cursor !== record.cursor ||
      typeof parsed.syncEpoch !== "string" ||
      !parsed.syncEpoch ||
      !Array.isArray(parsed.tags) ||
      !Array.isArray(parsed.purged) ||
      !Array.isArray(parsed.shards) ||
      parsed.shards.length !== SHARD_COUNT
    ) {
      return null;
    }
    // The authenticated id list, not the clear-text copy, decides which
    // shard ciphertexts belong to this manifest.
    const shardMemos: Memo[][] = [];
    for (let index = 0; index < SHARD_COUNT; index += 1) {
      const id = parsed.shards[index];
      const shard = record.shardRecords[index];
      if (typeof id !== "string" || !shard || shard.id !== id) return null;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: shard.iv, additionalData: shardAad(index, id, record.epoch) },
        key,
        shard.data
      );
      const memos = JSON.parse(decoder.decode(plain)) as unknown;
      if (!Array.isArray(memos)) return null;
      shardMemos.push(memos as Memo[]);
    }
    // These exact objects seed sync state, so the next save re-seals only
    // the shards a delta actually touched.
    baseline = { key: pendingKey, epoch: record.epoch, shardIds: parsed.shards, shardMemos };
    return { cursor: record.cursor, syncEpoch: parsed.syncEpoch, memos: shardMemos.flat(), tags: parsed.tags, purged: parsed.purged };
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
