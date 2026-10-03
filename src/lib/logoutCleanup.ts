import { invalidateSnapshot } from "./cache";
import { deleteImageCacheDb } from "./imageCache";
import { resetModelRuntime } from "./modelRuntime";
import { deleteSemanticIndexDb } from "./semanticIndex";

const APP_STORAGE_PREFIXES = ["memo:", "memo-"] as const;

/**
 * Device preferences that say nothing about the notebook: how the app looks
 * and behaves on this device. They survive logout so the gate and the next
 * session keep the owner's language and theme. Everything else under the app
 * prefixes (saved filters and Daily Review settings name tags and searches;
 * the review day lists memo ids) is notebook-derived and is cleared.
 */
const DEVICE_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  "memo:theme",
  "memo:language",
  "memo-sort",
  "memo:semantic-search",
  "memo:share-layout",
  "memo:share-tone",
  "memo:share-seal",
  "memo:share-hand",
  "memo:share-date",
  "memo:share-privacy"
]);

function isAppStorageKey(key: string): boolean {
  return APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)) && !DEVICE_PREFERENCE_KEYS.has(key);
}

/**
 * Remove every MEMO-owned Web Storage entry except the device preferences,
 * leaving unrelated same-origin data alone. Current preferences use `memo:`;
 * the older sort, saved-filter, and review keys use `memo-`.
 */
function clearAppStorage(storage: Storage): void {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && isAppStorageKey(key)) keys.push(key);
    }
  } catch {
    return;
  }

  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Continue clearing the remaining entries when one key is inaccessible.
    }
  }
}

async function clearCacheStorage(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const names = await caches.keys();
    await Promise.allSettled(names.map((name) => caches.delete(name)));
  } catch {
    // Cache Storage is optional and may be unavailable in private contexts.
  }
}

/**
 * Clear the notebook's data from this device after an explicit logout (here
 * or in a sibling tab) or a revoked session. Plain session expiry does not
 * come here: it only forgets the snapshot key, like a cold start.
 *
 * Snapshot invalidation forgets the in-memory AES key synchronously, then
 * serializes deletion behind any in-flight snapshot write. Web Storage is
 * best-effort because browsers may deny access in private/restricted contexts.
 * The server's logout response remains responsible for the HTTP cache through
 * Clear-Site-Data; this also clears Cache Storage for present or future app
 * shell caches.
 *
 * `memo-index` holds sealed vectors derived from memo content and is deleted.
 * `memo-model` holds only the public, SHA-verified model weights, so it stays:
 * deleting them protected nothing and cost a 123 MB download on next use
 * (Semantic Search settings still offer an explicit removal). The runtime
 * pipeline is disposed so no notebook-derived state lingers in memory.
 * Sealed feed previews (`memo-image-cache`) and the in-memory image blobs
 * are deleted too.
 */
export async function clearLocalDeviceData(): Promise<void> {
  const snapshotInvalidation = invalidateSnapshot();

  try {
    if (typeof localStorage !== "undefined") clearAppStorage(localStorage);
  } catch {
    // Accessing the storage object itself can throw in restricted contexts.
  }
  try {
    if (typeof sessionStorage !== "undefined") clearAppStorage(sessionStorage);
  } catch {
    // Accessing the storage object itself can throw in restricted contexts.
  }

  // Forgetting the snapshot key already happened synchronously. A damaged or
  // unavailable IndexedDB must not turn a completed server logout into an
  // unhandled client-side rejection.
  await Promise.allSettled([
    snapshotInvalidation,
    clearCacheStorage(),
    deleteImageCacheDb(),
    deleteSemanticIndexDb(),
    resetModelRuntime()
  ]);
}
