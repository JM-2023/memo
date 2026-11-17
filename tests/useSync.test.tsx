// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSync } from "../src/lib/useSync";
import type { Memo } from "../src/lib/types";

class TestBroadcastChannel {
  static instances: TestBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    TestBroadcastChannel.instances.push(this);
  }

  postMessage(): void {}
  close(): void {}

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function memo(id: string, seq: number): Memo {
  return {
    id,
    content: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq,
    images: []
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  TestBroadcastChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSync cross-tab coordination", () => {
  it("applies only the unseen half of a peer delta", () => {
    const applyChanges = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSync({
        enabled: true,
        applyChanges,
        onAuthLost: vi.fn(),
        onPeerLogout: vi.fn(),
        onServerReset: vi.fn()
      })
    );

    act(() => {
      result.current.setCursor(5);
      result.current.setSyncEpoch("epoch-a");
      TestBroadcastChannel.instances[0].emit({
        type: "delta",
        since: 0,
        data: {
          memos: [memo("covered", 4), memo("new", 6)],
          purged: [{ id: "gone", seq: 7 }],
          tags: [
            { path: "old", pinnedAt: null, seq: 5 },
            { path: "new", pinnedAt: null, seq: 8 }
          ],
          cursor: 8,
          syncEpoch: "epoch-a",
          serverTime: "2026-01-01T00:00:00.000Z",
          hasMore: false
        }
      });
    });

    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(applyChanges.mock.calls[0][0].map((item: Memo) => item.id)).toEqual(["new"]);
    expect(applyChanges.mock.calls[0][1]).toEqual([{ id: "gone", seq: 7 }]);
    expect(applyChanges.mock.calls[0][2]).toEqual([{ path: "new", pinnedAt: null, seq: 8 }]);
    expect(applyChanges.mock.calls[0][3]).toBe(8);

    unmount();
  });

  it("clears the degraded notice and answers a Retry when a peer's pull lands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const applyChanges = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSync({ enabled: true, applyChanges, onAuthLost: vi.fn(), onPeerLogout: vi.fn(), onServerReset: vi.fn() })
    );
    act(() => {
      result.current.setCursor(5);
      result.current.setSyncEpoch("epoch-a");
    });

    // Two of this tab's own pulls fail: the feed is called stale.
    for (let attempt = 0; attempt < 3 && !result.current.status.degraded; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
      });
    }
    expect(result.current.status.degraded).toBe(true);

    let retried: boolean | undefined;
    act(() => {
      void result.current.retryNow().then((ok) => {
        retried = ok;
      });
    });

    // A sibling tab holding the network lock answers for this one.
    const peerPage = (cursor: number, memos: Memo[]) => ({
      type: "delta",
      since: 5,
      data: { memos, purged: [], tags: [], cursor, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:00:00.000Z", hasMore: false }
    });
    await act(async () => {
      TestBroadcastChannel.instances[0].emit(peerPage(6, [memo("fresh", 6)]));
      await Promise.resolve();
    });

    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(result.current.status.degraded).toBe(false);
    expect(retried).toBe(true);

    unmount();
  });

  it("treats a peer page this tab already holds as a good answer", async () => {
    const { result, unmount } = renderHook(() =>
      useSync({ enabled: true, applyChanges: vi.fn(), onAuthLost: vi.fn(), onPeerLogout: vi.fn(), onServerReset: vi.fn() })
    );
    act(() => {
      result.current.setCursor(9);
      result.current.setSyncEpoch("epoch-a");
    });
    let retried: boolean | undefined;
    act(() => {
      void result.current.retryNow().then((ok) => {
        retried = ok;
      });
    });
    await act(async () => {
      TestBroadcastChannel.instances[0].emit({
        type: "delta",
        since: 4,
        data: { memos: [], purged: [], tags: [], cursor: 9, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:00:00.000Z", hasMore: false }
      });
      await Promise.resolve();
    });
    expect(retried).toBe(true);
    unmount();
  });

  it("does not take a page from another database history as an answer", async () => {
    const { result, unmount } = renderHook(() =>
      useSync({ enabled: true, applyChanges: vi.fn(), onAuthLost: vi.fn(), onPeerLogout: vi.fn(), onServerReset: vi.fn() })
    );
    act(() => {
      result.current.setCursor(5);
      result.current.setSyncEpoch("epoch-a");
    });
    let retried: boolean | undefined;
    act(() => {
      void result.current.retryNow().then((ok) => {
        retried = ok;
      });
    });
    await act(async () => {
      TestBroadcastChannel.instances[0].emit({
        type: "delta",
        since: 5,
        data: { memos: [], purged: [], tags: [], cursor: 8, syncEpoch: "epoch-b", serverTime: "2026-01-01T00:00:00.000Z", hasMore: false }
      });
      await Promise.resolve();
    });
    expect(retried).toBeUndefined();
    unmount();
  });
});
