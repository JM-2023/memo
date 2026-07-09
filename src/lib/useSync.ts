import { useCallback, useEffect, useRef } from "react";
import { AuthRequiredError, syncSince } from "./api";
import type { Memo, TagMeta } from "./types";

interface UseSyncOptions {
  enabled: boolean;
  /** Merge changed memos / purged ids / touched tag meta into local state. */
  applyChanges: (memos: Memo[], purged: string[], tags: TagMeta[]) => void;
  onAuthLost: () => void;
}

/**
 * Keeps this client seamlessly in step with the server. The server stamps
 * every write with a global `seq`; we hold the last cursor and pull
 * increments:
 *   - right after each local mutation (reconciles the cursor and catches
 *     anything another device wrote in between),
 *   - when a sibling tab broadcasts a change (BroadcastChannel),
 *   - when the tab regains focus/visibility,
 *   - on a 60s heartbeat while visible (covers other devices).
 * Mutations never advance the cursor directly — only a sync response may,
 * because its rows and cursor come from one server-side snapshot.
 */
export function useSync({ enabled, applyChanges, onAuthLost }: UseSyncOptions) {
  const cursorRef = useRef(0);
  const busyRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const applyRef = useRef(applyChanges);
  applyRef.current = applyChanges;
  const authLostRef = useRef(onAuthLost);
  authLostRef.current = onAuthLost;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const setCursor = useCallback((cursor: number) => {
    cursorRef.current = cursor;
  }, []);

  const runSync = useCallback(async () => {
    if (!enabledRef.current || busyRef.current) return;
    busyRef.current = true;
    try {
      const data = await syncSince(cursorRef.current);
      if (data.memos.length > 0 || data.purged.length > 0 || data.tags.length > 0) {
        applyRef.current(data.memos, data.purged, data.tags);
      }
      cursorRef.current = Math.max(cursorRef.current, data.cursor);
    } catch (cause) {
      if (cause instanceof AuthRequiredError) {
        authLostRef.current();
      }
      // Anything else (offline, server hiccup) — silently retry on the next tick.
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Tell sibling tabs of this browser to pull immediately. */
  const notifyPeers = useCallback(() => {
    try {
      channelRef.current?.postMessage("changed");
    } catch {
      // Channel closed mid-flight — the heartbeat still covers it.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("memo-sync");
      channel.onmessage = () => void runSync();
      channelRef.current = channel;
    } catch {
      channelRef.current = null;
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void runSync();
    };
    const onFocus = () => void runSync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void runSync();
    }, 60_000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
      channelRef.current = null;
      channel?.close();
    };
  }, [enabled, runSync]);

  return { setCursor, runSync, notifyPeers };
}
