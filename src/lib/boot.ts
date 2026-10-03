import { bootstrap, syncSince, type BootstrapResponse, type SyncResponse } from "./api";
import { readSealedSnapshot, type SealedSnapshotHandle } from "./cache";

/** The first network request of an app entry, already in flight. */
export type BootStart =
  | { kind: "warm"; sealed: SealedSnapshotHandle; firstSync: Promise<SyncResponse> }
  | { kind: "cold"; firstPage: Promise<BootstrapResponse> };

/** Mark a speculative request as observed; whoever needs it still awaits it. */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/**
 * Read the sealed snapshot and fire the request it calls for at once: a warm
 * sync from its cursor (which also delivers the key that opens it), or the
 * first cold bootstrap page. The snapshot cannot be decrypted before that
 * authenticated response, by design, so this is the earliest it can render.
 */
export async function startBoot(): Promise<BootStart> {
  const sealed = await readSealedSnapshot();
  if (sealed) return { kind: "warm", sealed, firstSync: observed(syncSince(sealed.cursor, { includeCacheKey: true })) };
  return { kind: "cold", firstPage: observed(bootstrap()) };
}
