// IndexedDB freeze for the embedding model's verified bytes. A separate
// database from the snapshot cache, and deliberately outside the encrypted
// pipeline: model weights are public artifacts, not user data, so sealing
// them buys nothing. They are still removed on explicit logout (and from the
// Semantic Search settings) so "clear this device" has one predictable
// meaning across every local store.
//
// Bytes are hash-verified by the loader before they are written, so reads
// trust the store instead of re-hashing 123 MB on every startup. Keys are
// namespaced by manifest version; opening the store for one version purges
// every other, keeping worst-case storage at about one model.

const DB_NAME = "memo-model";
const STORE = "files";

interface StoredModelFile {
  bytes: ArrayBuffer;
  storedAt: number;
}

function storeKey(version: string, requestPath: string): string {
  return `${version}/${requestPath}`;
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

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result!: T;
      run(store).then(
        (value) => {
          result = value;
        },
        () => transaction.abort()
      );
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Model store transaction aborted"));
    });
  } finally {
    db.close();
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Verified bytes for one file, or null when absent or unreadable. */
export async function readStoredModelFile(version: string, requestPath: string): Promise<ArrayBuffer | null> {
  try {
    const record = await withStore("readonly", (store) =>
      requestValue(store.get(storeKey(version, requestPath)) as IDBRequest<StoredModelFile | undefined>)
    );
    return record instanceof Object && record.bytes instanceof ArrayBuffer ? record.bytes : null;
  } catch {
    return null;
  }
}

/**
 * Persist verified bytes. Rejects on failure (quota, restricted context) so
 * the loader can fall back to holding the bytes in memory for the session.
 */
export async function writeStoredModelFile(version: string, requestPath: string, bytes: ArrayBuffer): Promise<void> {
  const record: StoredModelFile = { bytes, storedAt: Date.now() };
  await withStore("readwrite", async (store) => {
    store.put(record, storeKey(version, requestPath));
  });
}

/** Request paths already frozen for this manifest version. */
export async function listStoredModelFiles(version: string): Promise<Set<string>> {
  const prefix = `${version}/`;
  try {
    const keys = await withStore("readonly", (store) => requestValue(store.getAllKeys()));
    const present = new Set<string>();
    for (const key of keys) {
      if (typeof key === "string" && key.startsWith(prefix)) present.add(key.slice(prefix.length));
    }
    return present;
  } catch {
    return new Set();
  }
}

/** Best-effort removal of entries from any other manifest version. */
export async function purgeOtherModelVersions(version: string): Promise<void> {
  const prefix = `${version}/`;
  try {
    await withStore("readwrite", async (store) => {
      const keys = await requestValue(store.getAllKeys());
      for (const key of keys) {
        if (typeof key === "string" && !key.startsWith(prefix)) store.delete(key);
      }
    });
  } catch {
    // A failed purge only costs disk space; the version-prefixed keys keep
    // reads correct either way.
  }
}

/** Best-effort removal of every locally frozen model file. */
export function deleteModelStoreDb(): Promise<void> {
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

/**
 * Ask the browser not to evict this origin's storage. Best-effort: browsers
 * may decline silently, and the loader treats eviction as an ordinary
 * cache miss on a later activation.
 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is an optimization, never a requirement.
  }
}
