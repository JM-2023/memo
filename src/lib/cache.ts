// Encrypted local snapshot of the notebook.
//
// Why: without it every page load re-downloads the whole notebook through
// /api/bootstrap. With it, startup is one tiny /api/sync?since=<cursor> call —
// constant-size regardless of how many memos exist.
//
// Privacy: the snapshot is sealed with AES-256-GCM before it touches
// IndexedDB. The key is NOT stored on this device — only authenticated
// /api/bootstrap and /api/sync responses hand it out (it lives in the
// server's app_settings). A device whose session expired therefore holds
// nothing but ciphertext. Only the sync cursor rides in the clear: it is a
// bare counter, and the warm-start sync needs it before the key arrives.
//
// Everything here is best-effort: private-mode browsers may reject
// IndexedDB, another tab may race a write — any failure just means the next
// start takes the full-bootstrap path.

import type { Memo, TagMeta } from "./types";

const DB_NAME = "memo-cache";
const STORE = "kv";
const SNAPSHOT_KEY = "snapshot";
/** Bump when the snapshot payload shape changes; old blobs then re-bootstrap. */
const SNAPSHOT_VERSION = 1;

interface StoredSnapshot {
  v: number;
  cursor: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export interface Snapshot {
  cursor: number;
  memos: Memo[];
  tags: TagMeta[];
}

// ---- cache key (from the server, memory only) ----

let keyB64: string | null = null;
let keyPromise: Promise<CryptoKey> | null = null;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Remember the snapshot key delivered by an authenticated response. */
export function adoptCacheKey(b64: string | undefined | null): void {
  if (!b64 || b64 === keyB64) return;
  keyB64 = b64;
  keyPromise = crypto.subtle.importKey("raw", base64ToBytes(b64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// ---- IndexedDB plumbing ----

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbRead(): Promise<StoredSnapshot | null> {
  const db = await openDb();
  try {
    const record = await idbRequest(db.transaction(STORE, "readonly").objectStore(STORE).get(SNAPSHOT_KEY));
    return (record as StoredSnapshot | undefined) ?? null;
  } finally {
    db.close();
  }
}

async function idbWrite(record: StoredSnapshot | null): Promise<void> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    if (record) await idbRequest(store.put(record, SNAPSHOT_KEY));
    else await idbRequest(store.delete(SNAPSHOT_KEY));
  } finally {
    db.close();
  }
}

// ---- public surface ----

/** The cached cursor, if a usable snapshot exists — cheap, needs no key. */
export async function peekSnapshotCursor(): Promise<number | null> {
  try {
    const record = await idbRead();
    if (!record || record.v !== SNAPSHOT_VERSION || !Number.isFinite(record.cursor) || record.cursor <= 0) return null;
    return record.cursor;
  } catch {
    return null;
  }
}

/** Decrypt the stored snapshot. Null on any mismatch — caller re-bootstraps. */
export async function openSnapshot(): Promise<Snapshot | null> {
  if (!keyPromise) return null;
  try {
    const record = await idbRead();
    if (!record || record.v !== SNAPSHOT_VERSION) return null;
    const key = await keyPromise;
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, key, record.data);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { memos?: Memo[]; tags?: TagMeta[] };
    if (!Array.isArray(parsed.memos) || !Array.isArray(parsed.tags)) return null;
    return { cursor: record.cursor, memos: parsed.memos, tags: parsed.tags };
  } catch {
    return null;
  }
}

/** Seal and persist the current state. Silently skips without a key. */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  if (!keyPromise) return;
  try {
    const key = await keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = new TextEncoder().encode(JSON.stringify({ memos: snapshot.memos, tags: snapshot.tags }));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
    await idbWrite({ v: SNAPSHOT_VERSION, cursor: snapshot.cursor, iv, data });
  } catch {
    // Best-effort — a failed write only costs the next warm start.
  }
}

export async function clearSnapshot(): Promise<void> {
  try {
    await idbWrite(null);
  } catch {
    // Nothing sensitive remains readable without the key anyway.
  }
}

// ---- delta merging (shared by warm start and App state updates) ----

export function mergeMemoDelta(base: Memo[], changed: Memo[], purged: string[]): Memo[] {
  if (changed.length === 0 && purged.length === 0) return base;
  const byId = new Map(base.map((memo) => [memo.id, memo]));
  for (const memo of changed) byId.set(memo.id, memo);
  for (const id of purged) byId.delete(id);
  return [...byId.values()];
}

/** Apply touched tag_meta rows; a NULL pinnedAt row erases that pin. */
export function mergeTagDelta(base: TagMeta[], changed: TagMeta[]): TagMeta[] {
  if (changed.length === 0) return base;
  const byPath = new Map(base.map((tag) => [tag.path, tag]));
  for (const tag of changed) {
    if (tag.pinnedAt) byPath.set(tag.path, tag);
    else byPath.delete(tag.path);
  }
  return [...byPath.values()];
}
