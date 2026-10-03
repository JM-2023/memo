import { useEffect, useState } from "react";

const SNAPSHOT_WRITER_LOCK = "memo-snapshot-writer";

/**
 * One tab at a time persists the sealed snapshot. Every tab applies the same
 * deltas (its own pulls or a peer's broadcast), so if each also saved, their
 * shard ids would keep overwriting each other's baseline and every save would
 * fall back to a full re-seal. The tab holding this Web Lock is the writer;
 * the others stay read-only until it closes, logs out or reloads, and the
 * next waiting tab then takes over and saves its own state once.
 *
 * Without Web Locks every tab writes, as before; the shard writer already
 * stays correct under that race, only slower.
 */
export function useSnapshotWriterLease(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) {
      setHeld(true);
      return;
    }
    const controller = new AbortController();
    let release = () => {};
    let active = true;
    locks
      .request(SNAPSHOT_WRITER_LOCK, { signal: controller.signal }, () => {
        if (!active) return undefined;
        setHeld(true);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch((cause: unknown) => {
        // Aborted while waiting is the normal hand-back. Anything else means
        // locks are unusable here: write, as a lock-less browser would.
        if (active && !(cause instanceof DOMException && cause.name === "AbortError")) setHeld(true);
      });
    return () => {
      active = false;
      controller.abort();
      release();
      setHeld(false);
    };
  }, [enabled]);

  return held;
}
