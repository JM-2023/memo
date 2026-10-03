// Stored attachments are served with `Cache-Control: no-store`, so the HTTP
// cache never holds plaintext image bytes past logout. This module is the
// client's own cache in its place:
//
// - Memory: one blob: URL per (image, variant), reference-counted by the
//   components drawing it and kept under a byte budget while unreferenced,
//   so remounting a card (switching lenses, the edit morph's ghost layers)
//   never downloads the same bytes twice in a session.
// - Disk, feed previews only: AES-GCM sealed in IndexedDB with the
//   notebook's server-held cache key (see sealDerivedBytes), so a cold start
//   draws the feed without the network while a device with no session can
//   read nothing. clearLocalDeviceData deletes the database on logout and the
//   snapshot save prunes previews whose memos are gone. An attachment stored
//   before previews existed has none on the server; the first time this
//   device fetches it, a preview is derived from the original and sealed.
//
// Image ids are immutable, so an entry never goes stale; it can only become
// unwanted.

import { openDerivedBytes, sealDerivedBytes } from "./cache";
import { derivePreview } from "./imageEncode";
import type { Memo } from "./types";

export type ImageVariant = "thumb" | "full";

export function imageUrl(id: string, variant: ImageVariant = "full"): string {
  const path = `/api/images/${encodeURIComponent(id)}`;
  return variant === "thumb" ? `${path}?size=thumb` : path;
}

export class ImageLoadError extends Error {
  constructor(readonly status: number) {
    super(`Image request failed (${status})`);
    this.name = "ImageLoadError";
  }
}

// ---- Memory ---------------------------------------------------------------

/** Encoded bytes kept for blobs no component is drawing right now. */
const MEMORY_BUDGET = 48 * 1024 * 1024;
/**
 * A peeked URL is painted by a render whose effect has not retained it yet;
 * cards unmounting in the same commit must not revoke it in between.
 */
const PEEK_SHIELD_MS = 2000;

interface Entry {
  url: string;
  bytes: number;
  refs: number;
  /** Eviction skips the entry until then (see PEEK_SHIELD_MS). */
  shieldUntil: number;
}

/** Insertion order doubles as recency: a hit re-inserts its entry. */
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();
let heldBytes = 0;
/** Images whose tile last ended in the failed state, for inert ghost copies. */
const failed = new Set<string>();
/** Bumped by clearImageCache so a request already in flight stores nothing. */
let epoch = 0;

function keyOf(id: string, variant: ImageVariant): string {
  return `${variant}:${id}`;
}

function evict(): void {
  if (heldBytes <= MEMORY_BUDGET) return;
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (heldBytes <= MEMORY_BUDGET) break;
    if (entry.refs > 0 || entry.shieldUntil > now) continue;
    entries.delete(key);
    heldBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

function store(key: string, blob: Blob): void {
  if (entries.has(key)) return;
  entries.set(key, { url: URL.createObjectURL(blob), bytes: blob.size, refs: 0, shieldUntil: 0 });
  heldBytes += blob.size;
  evict();
}

function retain(key: string): string | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.refs += 1;
  entries.delete(key);
  entries.set(key, entry);
  return entry.url;
}

/**
 * A cached URL for synchronous first paint; the caller must still retain or
 * acquire it (in an effect). Until then it is briefly shielded from eviction.
 */
export function peekImage(id: string, variant: ImageVariant): string | null {
  const entry = entries.get(keyOf(id, variant));
  if (!entry) return null;
  entry.shieldUntil = Date.now() + PEEK_SHIELD_MS;
  return entry.url;
}

/** Hold a cached URL without loading; null when it is not in memory. */
export function retainImage(id: string, variant: ImageVariant): string | null {
  return retain(keyOf(id, variant));
}

/** Give back one reference taken by acquireImage or retainImage. */
export function releaseImage(id: string, variant: ImageVariant, url: string): void {
  const entry = entries.get(keyOf(id, variant));
  if (!entry || entry.url !== url) return;
  entry.refs = Math.max(0, entry.refs - 1);
  evict();
}

/** Forget bytes that turned out not to decode, so the next load refetches. */
export function discardImage(id: string, variant: ImageVariant): void {
  const key = keyOf(id, variant);
  const entry = entries.get(key);
  if (entry) {
    entries.delete(key);
    heldBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
  if (variant === "thumb") void deleteSealed(id);
}

/** Seed memory with bytes this device already holds (a just-compressed upload). */
export function primeImage(id: string, variant: ImageVariant, blob: Blob): void {
  store(keyOf(id, variant), blob);
}

async function fetchInto(id: string, variant: ImageVariant): Promise<void> {
  const key = keyOf(id, variant);
  let task = pending.get(key);
  if (!task) {
    const started = epoch;
    task = (async () => {
      let blob = variant === "thumb" ? await readSealed(id) : null;
      if (!blob) {
        const response = await fetch(imageUrl(id, variant), { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new ImageLoadError(response.status);
        blob = await response.blob();
        if (!blob.type.startsWith("image/")) throw new ImageLoadError(response.status);
        if (variant === "thumb" && response.headers.get("X-Image-Variant") === "original") {
          // No preview on the server: make one here, so the feed decodes a
          // small bitmap and the next cold start reads it from disk.
          const original = blob;
          const preview = await derivePreview(original, PERSIST_MAX_BYTES);
          if (preview) {
            blob = preview;
            // It is the original too; a lone tile upgrading to it needs no request.
            if (started === epoch) store(keyOf(id, "full"), original);
          }
        }
        if (variant === "thumb" && started === epoch) void persistSealed(id, blob);
      }
      if (started !== epoch) throw new ImageLoadError(0);
      store(key, blob);
    })();
    const current = task.finally(() => {
      if (pending.get(key) === current) pending.delete(key);
    });
    task = current;
    pending.set(key, current);
  }
  await task;
}

/** Resolve a blob: URL for the image and hold one reference to it. */
export async function acquireImage(id: string, variant: ImageVariant): Promise<string> {
  const key = keyOf(id, variant);
  // Two passes: a burst of other loads may evict an unreferenced entry
  // between its store and this continuation.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hit = retain(key);
    if (hit) return hit;
    await fetchInto(id, variant);
  }
  const hit = retain(key);
  if (hit) return hit;
  throw new ImageLoadError(0);
}

/** Remember (or forget) that an image's tile ended in the failed state. */
export function noteImageFailed(id: string, didFail: boolean): void {
  if (didFail) failed.add(id);
  else failed.delete(id);
}

/** Whether an image's tile last ended in the failed state this session. */
export function imageFailed(id: string): boolean {
  return failed.has(id);
}

/** Drop every in-memory image (logout, session loss). */
export function clearImageCache(): void {
  epoch += 1;
  failed.clear();
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url);
  entries.clear();
  pending.clear();
  heldBytes = 0;
}

// ---- Sealed previews in IndexedDB ----------------------------------------

const DB_NAME = "memo-image-cache";
const STORE = "thumbs";
/**
 * Previews only. An older original served in their place is kept as is when
 * it is this small, and replaced by a preview derived from it otherwise.
 */
const PERSIST_MAX_BYTES = 200_000;
const MAX_RECORDS = 800;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 5 * 60 * 1000;

interface SealedThumb {
  id: string;
  /** Last write or (coarsely) last read, for oldest-first trimming. */
  at: number;
  mime: string;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let writesSinceTrim = 0;
let lastPrune = 0;

function purposeOf(id: string): string {
  return `memo-image:thumb:${id}`;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("at", "at");
      };
      request.onsuccess = () => {
        const db = request.result;
        // Logout deletes the database; step aside instead of blocking it.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((cause) => {
      dbPromise = null;
      throw cause;
    });
  }
  return dbPromise;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Image cache transaction aborted"));
  });
}

async function readSealed(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const record = await new Promise<SealedThumb | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result as SealedThumb | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!record) return null;
    // Null without the key (no session) or for a record sealed under another.
    const plain = await openDerivedBytes(purposeOf(id), record.iv, record.data);
    if (!plain) return null;
    if (Date.now() - record.at > TOUCH_AFTER_MS) {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put({ ...record, at: Date.now() });
      void done(transaction).catch(() => undefined);
    }
    return new Blob([plain], { type: record.mime });
  } catch {
    return null;
  }
}

async function deleteSealed(id: string): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    await done(transaction);
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

async function persistSealed(id: string, blob: Blob): Promise<void> {
  if (blob.size > PERSIST_MAX_BYTES) return;
  try {
    const started = epoch;
    const sealed = await sealDerivedBytes(purposeOf(id), new Uint8Array(await blob.arrayBuffer()));
    if (!sealed || started !== epoch) return;
    const db = await openDb();
    const transaction = db.transaction(STORE, "readwrite");
    const record: SealedThumb = { id, at: Date.now(), mime: blob.type, iv: sealed.iv, data: sealed.data };
    transaction.objectStore(STORE).put(record);
    await done(transaction);
    writesSinceTrim += 1;
    if (writesSinceTrim >= 25) {
      writesSinceTrim = 0;
      await trimOldest(db);
    }
  } catch {
    // Best effort: a failed write only costs one download next time.
  }
}

async function trimOldest(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction(STORE, "readwrite");
  const store = transaction.objectStore(STORE);
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    let excess = countRequest.result - MAX_RECORDS;
    if (excess <= 0) return;
    const cursorRequest = store.index("at").openKeyCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || excess <= 0) return;
      store.delete(cursor.primaryKey);
      excess -= 1;
      cursor.continue();
    };
  };
  await done(transaction);
}

/**
 * Delete sealed previews whose attachment no longer belongs to any memo
 * (deleted forever here or on another device). Trash keeps its images, so
 * trashed memos count as live. Throttled: callers may run it on every save.
 */
export async function pruneImageCache(memos: readonly Memo[], now = Date.now()): Promise<void> {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  try {
    const live = new Set<string>();
    for (const memo of memos) for (const image of memo.images) live.add(image.id);
    const db = await openDb();
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      for (const key of keysRequest.result) if (!live.has(String(key))) store.delete(key);
    };
    await done(transaction);
  } catch {
    // The next save retries.
  }
}

/** Logout: forget memory and delete the sealed previews. */
export async function deleteImageCacheDb(): Promise<void> {
  clearImageCache();
  lastPrune = 0;
  const pendingDb = dbPromise;
  dbPromise = null;
  try {
    (await pendingDb)?.close();
  } catch {
    // An open that never succeeded has nothing to close.
  }
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
