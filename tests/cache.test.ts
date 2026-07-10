import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  MonotonicWriteQueue,
  adoptCacheKey,
  cacheEpochAllowsWrite,
  encodeSnapshotCooperatively,
  invalidateSnapshot,
  openSnapshot,
  readSealedSnapshot,
  saveSnapshot,
  shouldReplaceSealedSnapshot,
  type Snapshot
} from "../src/lib/cache";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MonotonicWriteQueue", () => {
  it("drops a cursor older than the greatest cursor already queued", async () => {
    const writes: number[] = [];
    const queue = new MonotonicWriteQueue<{ cursor: number }>(
      async ({ cursor }) => {
        writes.push(cursor);
      },
      async () => undefined
    );

    await queue.enqueue({ cursor: 100 });
    await queue.enqueue({ cursor: 80 });

    expect(writes).toEqual([100]);
    expect(queue.queuedCursor).toBe(100);
  });

  it("allows equal cursors because the later snapshot may contain richer state", async () => {
    const writes: string[] = [];
    const queue = new MonotonicWriteQueue<{ cursor: number; body: string }>(
      async ({ body }) => {
        writes.push(body);
      },
      async () => undefined
    );

    await queue.enqueue({ cursor: 100, body: "mutation response" });
    await queue.enqueue({ cursor: 100, body: "same cursor after local state settled" });

    expect(writes).toEqual(["mutation response", "same cursor after local state settled"]);
  });

  it("executes writes serially within one generation", async () => {
    const firstGate = deferred();
    const events: string[] = [];
    const queue = new MonotonicWriteQueue<{ cursor: number }>(
      async ({ cursor }) => {
        events.push(`start:${cursor}`);
        if (cursor === 1) await firstGate.promise;
        events.push(`end:${cursor}`);
      },
      async () => undefined
    );

    const first = queue.enqueue({ cursor: 1 });
    const second = queue.enqueue({ cursor: 2 });
    await nextMicrotask();
    expect(events).toEqual(["start:1"]);

    firstGate.resolve();
    await first;
    await second;
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("coalesces queued snapshots to the latest value while one write is running", async () => {
    const firstGate = deferred();
    const writes: number[] = [];
    const queue = new MonotonicWriteQueue<{ cursor: number }>(
      async ({ cursor }) => {
        writes.push(cursor);
        if (cursor === 1) await firstGate.promise;
      },
      async () => undefined
    );

    const first = queue.enqueue({ cursor: 1 });
    const replaced = queue.enqueue({ cursor: 2 });
    const latest = queue.enqueue({ cursor: 3 });
    await nextMicrotask();
    expect(writes).toEqual([1]);

    firstGate.resolve();
    await Promise.all([first, replaced, latest]);
    expect(writes).toEqual([1, 3]);
  });

  it("makes invalidate a clear barrier, skips queued old-generation writes, and accepts the new generation", async () => {
    const firstGate = deferred();
    const events: string[] = [];
    const queue = new MonotonicWriteQueue<{ cursor: number }>(
      async ({ cursor }) => {
        events.push(`start:${cursor}`);
        if (cursor === 10) await firstGate.promise;
        events.push(`end:${cursor}`);
      },
      async () => {
        events.push("clear");
      }
    );

    const inFlight = queue.enqueue({ cursor: 10 });
    const staleQueued = queue.enqueue({ cursor: 11 });
    await nextMicrotask();
    expect(events).toEqual(["start:10"]);

    const cleared = queue.invalidate();
    const newGeneration = queue.enqueue({ cursor: 1 });
    expect(queue.currentGeneration).toBe(1);
    expect(queue.queuedCursor).toBe(1);

    firstGate.resolve();
    await Promise.all([inFlight, staleQueued, cleared, newGeneration]);

    expect(events).toEqual(["start:10", "end:10", "clear", "start:1", "end:1"]);
  });

  it("continues processing after a rejected write", async () => {
    const writes: number[] = [];
    const queue = new MonotonicWriteQueue<{ cursor: number }>(
      async ({ cursor }) => {
        writes.push(cursor);
        if (cursor === 1) throw new Error("storage unavailable");
      },
      async () => undefined
    );

    await expect(queue.enqueue({ cursor: 1 })).rejects.toThrow("storage unavailable");
    await expect(queue.enqueue({ cursor: 2 })).resolves.toBeUndefined();
    expect(writes).toEqual([1, 2]);
  });
});

describe("sealed IndexedDB snapshot", () => {
  it("rejects an older cross-tab record and preserves a future schema", () => {
    const record = (v: number, cursor: number, epoch = "epoch-a") => ({
      v,
      epoch,
      cursor,
      iv: new Uint8Array(12),
      data: new ArrayBuffer(0)
    });

    expect(shouldReplaceSealedSnapshot(record(3, 20), record(3, 19))).toBe(false);
    expect(shouldReplaceSealedSnapshot(record(3, 20), record(3, 20))).toBe(true);
    expect(shouldReplaceSealedSnapshot(record(3, 20), record(3, 21))).toBe(true);
    expect(shouldReplaceSealedSnapshot(record(4, 1), record(3, 99))).toBe(false);
    expect(shouldReplaceSealedSnapshot(record(4, 500, "old-epoch"), record(3, 5, "new-epoch"))).toBe(true);
    expect(cacheEpochAllowsWrite("new-epoch", "old-epoch")).toBe(false);
    expect(cacheEpochAllowsWrite("new-epoch", "new-epoch")).toBe(true);
  });

  it("cooperatively encodes the same logical snapshot", async () => {
    const snapshot: Snapshot = {
      cursor: 7,
      syncEpoch: "server-a",
      memos: [
        {
          id: "memo-1",
          content: "中英文 #tag",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          pinnedAt: null,
          deletedAt: null,
          seq: 6,
          images: []
        }
      ],
      tags: [{ path: "tag", pinnedAt: null, seq: 5 }],
      purged: [{ id: "gone", seq: 4 }]
    };

    const encoded = await encodeSnapshotCooperatively(snapshot);
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(snapshot);
  });

  it("opens the exact record retained before a newer IndexedDB write", async () => {
    await invalidateSnapshot();
    const key = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    adoptCacheKey(toBase64(key));
    const older: Snapshot = { cursor: 10, syncEpoch: "server-a", memos: [], tags: [], purged: [] };
    const newer: Snapshot = { cursor: 20, syncEpoch: "server-a", memos: [], tags: [], purged: [{ id: "gone", seq: 19 }] };

    await saveSnapshot(older);
    const retainedHandle = await readSealedSnapshot();
    expect(retainedHandle?.cursor).toBe(10);

    await saveSnapshot(newer);
    const currentHandle = await readSealedSnapshot();
    expect(currentHandle?.cursor).toBe(20);

    await expect(openSnapshot(retainedHandle!)).resolves.toEqual(older);
    await expect(openSnapshot(currentHandle!)).resolves.toEqual(newer);
    await invalidateSnapshot();
  });

  it("authenticates the clear-text cursor as AES-GCM additional data", async () => {
    await invalidateSnapshot();
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    adoptCacheKey(toBase64(key));
    const snapshot: Snapshot = {
      cursor: 42,
      syncEpoch: "server-a",
      memos: [],
      tags: [],
      purged: [{ id: "gone", seq: 41 }]
    };

    await saveSnapshot(snapshot);
    const sealed = await readSealedSnapshot();
    expect(sealed).not.toBeNull();
    await expect(openSnapshot(sealed!)).resolves.toEqual(snapshot);

    await expect(openSnapshot({ ...sealed!, cursor: 43 })).resolves.toBeNull();
    await invalidateSnapshot();
    await expect(readSealedSnapshot()).resolves.toBeNull();
  });

  it("accepts a lower cursor after an explicit database-reset invalidation", async () => {
    await invalidateSnapshot();
    const key = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 3));
    adoptCacheKey(key);
    await saveSnapshot({ cursor: 500, syncEpoch: "server-old", memos: [], tags: [], purged: [] });
    expect((await readSealedSnapshot())?.cursor).toBe(500);

    await invalidateSnapshot();
    adoptCacheKey(key);
    await saveSnapshot({ cursor: 5, syncEpoch: "server-new", memos: [], tags: [], purged: [] });
    expect((await readSealedSnapshot())?.cursor).toBe(5);
    await invalidateSnapshot();
  });

  it("rejects a late high-cursor write from another tab's old epoch", async () => {
    await invalidateSnapshot();
    const key = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 7));
    adoptCacheKey(key);
    await saveSnapshot({ cursor: 500, syncEpoch: "server-old", memos: [], tags: [], purged: [] });

    vi.resetModules();
    const staleTab = await import("../src/lib/cache");
    staleTab.adoptCacheKey(key);
    expect((await staleTab.readSealedSnapshot())?.cursor).toBe(500);

    await invalidateSnapshot();
    await staleTab.saveSnapshot({ cursor: 600, syncEpoch: "server-old", memos: [], tags: [], purged: [] });
    adoptCacheKey(key);
    await saveSnapshot({ cursor: 5, syncEpoch: "server-new", memos: [], tags: [], purged: [] });

    expect((await readSealedSnapshot())?.cursor).toBe(5);
    await invalidateSnapshot();
  });
});
