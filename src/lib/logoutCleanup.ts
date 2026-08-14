import { invalidateSnapshot } from "./cache";
import { deleteSemanticIndexDb } from "./semanticIndex";

const APP_STORAGE_PREFIXES = ["memo:", "memo-"] as const;

function isAppStorageKey(key: string): boolean {
  return APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Remove every MEMO-owned Web Storage entry while leaving unrelated
 * same-origin data alone. Current preferences use `memo:`; the older sort,
 * saved-filter, and review keys use `memo-`.
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
 * Clear persistent data owned by this device after an ordinary logout.
 *
 * Snapshot invalidation forgets the in-memory AES key synchronously, then
 * serializes deletion behind any in-flight snapshot write. Web Storage is
 * best-effort because browsers may deny access in private/restricted contexts.
 * The server's logout response remains responsible for the HTTP cache through
 * Clear-Site-Data; this also clears Cache Storage for present or future app
 * shell caches.
 *
 * The `memo-model` IndexedDB database (src/lib/modelStore.ts) is deliberately
 * left alone: it holds the semantic model's hash-verified weights — public
 * artifacts, not user data — and wiping it would only force a ~24 MB
 * re-download after every logout. The `memo-index` database is the opposite
 * case — vectors derived from memo content — so it is deleted here even
 * though forgetting the snapshot key already made it unreadable.
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
  await Promise.allSettled([snapshotInvalidation, clearCacheStorage(), deleteSemanticIndexDb()]);
}
