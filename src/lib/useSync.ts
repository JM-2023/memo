import { useCallback, useEffect, useRef, useState } from "react";
import { AuthRequiredError, syncSince, type SyncResponse } from "./api";
import { adoptCacheKey } from "./cache";
import type { Memo, TagMeta } from "./types";
import { changesAfterCursor, type PurgedMemo } from "./syncState";

interface UseSyncOptions {
  enabled: boolean;
  applyChanges: (memos: readonly Memo[], purged: readonly PurgedMemo[], tags: readonly TagMeta[], cursor: number) => void;
  onAuthLost: () => void;
  onPeerLogout: () => void;
  onServerReset: () => void;
}

type PeerSyncResponse = Omit<SyncResponse, "cacheKey">;
type SyncChannelMessage =
  | { type: "changed" }
  | { type: "logout" }
  | { type: "auth-lost" }
  | { type: "delta"; since: number; data: PeerSyncResponse };

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_MS = 60_000;
/** Consecutive failed pulls before the feed is called stale out loud. One
    miss is noise (a tab waking, a flaky hop); two in a row is a condition. */
const DEGRADED_AFTER_FAILURES = 2;

/** What the reader is told about the link to the server. */
export interface SyncStatus {
  /** navigator.onLine, tracked live. */
  online: boolean;
  /** Pulls keep failing while online: the feed shows the last good sync. */
  degraded: boolean;
}

function initialSyncStatus(): SyncStatus {
  return { online: typeof navigator === "undefined" || navigator.onLine !== false, degraded: false };
}

/** Incremental sync with serialized pulls, peer signals and bounded retries. */
export function useSync({ enabled, applyChanges, onAuthLost, onPeerLogout, onServerReset }: UseSyncOptions) {
  const [status, setStatus] = useState<SyncStatus>(initialSyncStatus);
  const cursorRef = useRef(0);
  const syncEpochRef = useRef("");
  const busyRef = useRef(false);
  const againRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef(0);
  const triggerTimerRef = useRef(0);
  const coordinationFallbackRef = useRef(0);
  const failureCountRef = useRef(0);

  const applyRef = useRef(applyChanges);
  applyRef.current = applyChanges;
  const authLostRef = useRef(onAuthLost);
  authLostRef.current = onAuthLost;
  const peerLogoutRef = useRef(onPeerLogout);
  peerLogoutRef.current = onPeerLogout;
  const serverResetRef = useRef(onServerReset);
  serverResetRef.current = onServerReset;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const setCursor = useCallback((cursor: number) => {
    cursorRef.current = Math.max(0, Number.isFinite(cursor) ? cursor : 0);
  }, []);

  const setSyncEpoch = useCallback((epoch: string) => {
    syncEpochRef.current = epoch;
  }, []);

  const cancelRetry = useCallback(() => {
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = 0;
  }, []);

  const runSyncRef = useRef<() => Promise<void>>(async () => undefined);

  const scheduleRetry = useCallback(() => {
    if (!enabledRef.current || retryTimerRef.current || navigator.onLine === false) return;
    const attempt = Math.min(failureCountRef.current, 6);
    const base = Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    failureCountRef.current += 1;
    if (failureCountRef.current >= DEGRADED_AFTER_FAILURES) {
      setStatus((current) => (current.degraded ? current : { ...current, degraded: true }));
    }
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = 0;
      void runSyncRef.current();
    }, delay);
  }, []);

  const runSyncUncoordinated = useCallback(async () => {
    if (!enabledRef.current) return;
    if (busyRef.current) {
      againRef.current = true;
      return;
    }
    busyRef.current = true;
    try {
      do {
        againRef.current = false;
        const requestedCursor = cursorRef.current;
        const controller = new AbortController();
        abortRef.current = controller;
        const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const data = await syncSince(requestedCursor, { signal: controller.signal });
          if (!enabledRef.current) return;
          if (syncEpochRef.current && data.syncEpoch !== syncEpochRef.current) {
            serverResetRef.current();
            return;
          }
          if (!syncEpochRef.current) syncEpochRef.current = data.syncEpoch;
          if (data.cursor < requestedCursor) {
            // The bound D1 database was reset/replaced. Keeping the old cursor
            // would skip every change in the new sequence space forever.
            serverResetRef.current();
            return;
          }
          adoptCacheKey(data.cacheKey);
          const nextCursor = Math.max(cursorRef.current, data.cursor);
          if (data.memos.length > 0 || data.purged.length > 0 || data.tags.length > 0) {
            applyRef.current(data.memos, data.purged, data.tags, nextCursor);
          }
          cursorRef.current = nextCursor;
          try {
            const { cacheKey: _cacheKey, ...peerData } = data;
            channelRef.current?.postMessage({ type: "delta", since: requestedCursor, data: peerData } satisfies SyncChannelMessage);
          } catch {
            // Sibling tabs retain their own focus/heartbeat fallback.
          }
          failureCountRef.current = 0;
          cancelRetry();
          setStatus((current) => (current.degraded ? { ...current, degraded: false } : current));
          if (data.hasMore) {
            // A paginated endpoint must make progress or it would hot-loop.
            if (nextCursor <= requestedCursor) throw new Error("Sync page did not advance its cursor");
            againRef.current = true;
          }
        } catch (cause) {
          if (!enabledRef.current) return;
          if (cause instanceof AuthRequiredError) {
            cancelRetry();
            try {
              channelRef.current?.postMessage({ type: "auth-lost" } satisfies SyncChannelMessage);
            } catch {
              // The current tab still locks immediately below.
            }
            authLostRef.current();
            return;
          }
          scheduleRetry();
          return;
        } finally {
          window.clearTimeout(timeout);
          if (abortRef.current === controller) abortRef.current = null;
        }
      } while (againRef.current && enabledRef.current);
    } finally {
      busyRef.current = false;
    }
  }, [cancelRetry, scheduleRetry]);

  const runSync = useCallback(async () => {
    if (!enabledRef.current) return;
    if (busyRef.current) {
      againRef.current = true;
      return;
    }
    const locks = navigator.locks;
    if (!locks) {
      await runSyncUncoordinated();
      return;
    }
    let acquired = false;
    await locks.request("memo-sync-network", { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return;
      acquired = true;
      window.clearTimeout(coordinationFallbackRef.current);
      coordinationFallbackRef.current = 0;
      await runSyncUncoordinated();
    });
    if (!acquired && enabledRef.current && !coordinationFallbackRef.current) {
      // The leader normally broadcasts even an empty response. If it dies
      // mid-request, retry the lock after a short jitter instead of waiting a
      // full heartbeat.
      coordinationFallbackRef.current = window.setTimeout(() => {
        coordinationFallbackRef.current = 0;
        void runSyncRef.current();
      }, 1_200 + Math.round(Math.random() * 400));
    }
  }, [runSyncUncoordinated]);
  runSyncRef.current = runSync;

  /** Coalesce focus + visibility pairs without delaying explicit mutations. */
  const scheduleSync = useCallback((delay = 80) => {
    if (!enabledRef.current) return;
    window.clearTimeout(triggerTimerRef.current);
    triggerTimerRef.current = window.setTimeout(() => {
      triggerTimerRef.current = 0;
      void runSyncRef.current();
    }, delay);
  }, []);

  const postMessage = useCallback((message: SyncChannelMessage) => {
    try {
      channelRef.current?.postMessage(message);
    } catch {
      // A focus/online/heartbeat pull remains as fallback.
    }
  }, []);

  const notifyPeers = useCallback(() => postMessage({ type: "changed" }), [postMessage]);
  const notifyLogout = useCallback(() => postMessage({ type: "logout" }), [postMessage]);

  useEffect(() => {
    if (!enabled) return;
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("memo-sync");
      channel.onmessage = (event: MessageEvent<SyncChannelMessage | "changed">) => {
        if (!enabledRef.current) return;
        const message = event.data;
        if (message === "changed" || message?.type === "changed") scheduleSync(0);
        else if (message?.type === "logout") peerLogoutRef.current();
        else if (message?.type === "auth-lost") authLostRef.current();
        else if (message?.type === "delta") {
          window.clearTimeout(coordinationFallbackRef.current);
          coordinationFallbackRef.current = 0;
          const localCursor = cursorRef.current;
          if (localCursor < message.since) {
            scheduleSync(0);
            return;
          }
          const { data } = message;
          if (syncEpochRef.current && data.syncEpoch !== syncEpochRef.current) {
            // Let our own authenticated request decide which history is live;
            // a peer may simply be broadcasting a response fetched pre-reset.
            scheduleSync(0);
            return;
          }
          // Ignore pages wholly covered by our own bootstrap/sync. For a page
          // that straddles the local high-water, apply only its newer half.
          if (data.cursor <= localCursor) return;
          const delta = changesAfterCursor(data, localCursor);
          if (delta.memos.length > 0 || delta.purged.length > 0 || delta.tags.length > 0) {
            applyRef.current(delta.memos, delta.purged, delta.tags, data.cursor);
          }
          cursorRef.current = data.cursor;
          if (data.hasMore) scheduleSync(0);
        }
      };
      channelRef.current = channel;
    } catch {
      channelRef.current = null;
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleSync();
    };
    const onFocus = () => scheduleSync();
    const onOnline = () => {
      failureCountRef.current = 0;
      cancelRetry();
      setStatus({ online: true, degraded: false });
      scheduleSync(0);
    };
    const onOffline = () => {
      // Nothing to retry against: the feed is the last good sync until the
      // link returns. The offline word replaces the degraded one.
      cancelRetry();
      setStatus({ online: false, degraded: false });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") scheduleSync(0);
    }, 60_000);

    // Close the bootstrap-to-listener gap and catch a peer message that landed
    // while this tab was entering the ready phase.
    scheduleSync(0);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(timer);
      window.clearTimeout(triggerTimerRef.current);
      window.clearTimeout(coordinationFallbackRef.current);
      cancelRetry();
      abortRef.current?.abort();
      abortRef.current = null;
      channelRef.current = null;
      channel?.close();
    };
  }, [enabled, scheduleSync, cancelRetry]);

  /** The reader's own "try again": restarts the backoff from zero. */
  const retryNow = useCallback(() => {
    failureCountRef.current = 0;
    cancelRetry();
    scheduleSync(0);
  }, [cancelRetry, scheduleSync]);

  return { setCursor, setSyncEpoch, runSync, notifyPeers, notifyLogout, status, retryNow };
}
