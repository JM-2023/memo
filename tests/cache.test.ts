import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  MonotonicWriteQueue,
  adoptCacheKey,
  SHARD_COUNT,
  cacheEpochAllowsWrite,
  invalidateSnapshot,
  openSnapshot,
  readSealedSnapshot,
  saveSnapshot,
  shardOf,
  shouldReplaceSealedSnapshot,
  type Snapshot
} from "../src/lib/cache";
import type { Memo } from "../src/lib/types";

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

function memo(id: string, content: string): Memo {
  return {
    id,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: []
  };
}

function byId(memos: readonly Memo[]): Memo[] {
  return [...memos].sort((a, b) => a.id.localeCompare(b.id));
}

/** The stored shard records' ids, straight from IndexedDB. */
async function readShardIds(): Promise<(string | null)[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("memo-cache", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const store = db.transaction("kv").objectStore("kv");
    return await Promise.all(
      Array.from(
        { length: SHARD_COUNT },
        (_, index) =>
          new Promise<string | null>((resolve) => {
            const request = store.get(`snapshot-shard:${index}`);
            request.onsuccess = () => resolve((request.result as { id?: string } | undefined)?.id ?? null);
          })
      )
    );
  } finally {
    db.close();
  }
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

  it("round-trips a sharded notebook with tags and tombstones", async () => {
    await invalidateSnapshot();
    adoptCacheKey(toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 11)));
    const snapshot: Snapshot = {
      cursor: 7,
      syncEpoch: "server-a",
      memos: Array.from({ length: 200 }, (_, index) => memo(`memo-${index}`, `中英文 ${index} #tag`)),
      tags: [{ path: "tag", pinnedAt: null, seq: 5 }],
      purged: [{ id: "gone", seq: 4 }]
    };

    await saveSnapshot(snapshot);
    const opened = await openSnapshot((await readSealedSnapshot())!);
    expect(opened?.cursor).toBe(7);
    expect(opened?.tags).toEqual(snapshot.tags);
    expect(opened?.purged).toEqual(snapshot.purged);
    expect(byId(opened!.memos)).toEqual(byId(snapshot.memos));
    await invalidateSnapshot();
  });

  it("re-seals only the shard an edit touched", async () => {
    await invalidateSnapshot();
    adoptCacheKey(toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 13)));
    const memos = Array.from({ length: 200 }, (_, index) => memo(`memo-${index}`, `note ${index}`));
    await saveSnapshot({ cursor: 1, syncEpoch: "server-a", memos, tags: [], purged: [] });
    const before = await readShardIds();

    // Sync state swaps only the edited memo's object; the rest keep identity.
    const edited = memos.map((item, index) => (index === 42 ? { ...item, content: "edited", seq: 2 } : item));
    await saveSnapshot({ cursor: 2, syncEpoch: "server-a", memos: edited, tags: [], purged: [] });
    const after = await readShardIds();

    const changed = after.map((id, index) => (id !== before[index] ? index : -1)).filter((index) => index >= 0);
    expect(changed).toEqual([shardOf("memo-42")]);
    const opened = await openSnapshot((await readSealedSnapshot())!);
    expect(opened?.memos.find((item) => item.id === "memo-42")?.content).toBe("edited");
    expect(opened?.memos).toHaveLength(200);
    await invalidateSnapshot();
  });

  it("refuses a shard from another write mixed into the manifest", async () => {
    await invalidateSnapshot();
    adoptCacheKey(toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 17)));
    const memos = [memo("memo-a", "first")];
    await saveSnapshot({ cursor: 1, syncEpoch: "server-a", memos, tags: [], purged: [] });
    const older = (await readSealedSnapshot())!;
    await saveSnapshot({ cursor: 2, syncEpoch: "server-a", memos: [{ ...memos[0], content: "second", seq: 2 }], tags: [], purged: [] });
    const newer = (await readSealedSnapshot())!;

    const index = shardOf("memo-a");
    const shardRecords = [...newer.shardRecords];
    shardRecords[index] = older.shardRecords[index];
    await expect(openSnapshot({ ...newer, shardRecords })).resolves.toBeNull();
    // Relabelling the old ciphertext with the new id fails authentication.
    shardRecords[index] = { ...older.shardRecords[index]!, id: newer.shardRecords[index]!.id };
    await expect(openSnapshot({ ...newer, shardRecords })).resolves.toBeNull();
    await expect(openSnapshot(newer)).resolves.not.toBeNull();
    await invalidateSnapshot();
  });

  it("falls back to a full write when another tab rewrote shards in between", async () => {
    await invalidateSnapshot();
    const key = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 19));
    adoptCacheKey(key);
    const memos = Array.from({ length: 64 }, (_, index) => memo(`memo-${index}`, `note ${index}`));
    await saveSnapshot({ cursor: 1, syncEpoch: "server-a", memos, tags: [], purged: [] });

    // A second tab (own module state) rewrites everything at a newer cursor.
    vi.resetModules();
    const otherTab = await import("../src/lib/cache");
    otherTab.adoptCacheKey(key);
    const otherMemos = memos.map((item) => ({ ...item, content: `${item.content} (other tab)`, seq: 2 }));
    await otherTab.saveSnapshot({ cursor: 2, syncEpoch: "server-a", memos: otherMemos, tags: [], purged: [] });

    // This tab's baseline is now stale; its incremental write must not reuse
    // shard ids the other tab replaced.
    // Every other memo keeps its object, so without the conflict check this
    // write would reuse ids whose shards the other tab has since replaced.
    const mine = memos.map((item, index) => (index === 0 ? { ...item, content: "mine", seq: 3 } : item));
    await saveSnapshot({ cursor: 3, syncEpoch: "server-a", memos: mine, tags: [], purged: [] });
    const opened = await openSnapshot((await readSealedSnapshot())!);
    expect(opened?.cursor).toBe(3);
    expect(opened?.memos).toHaveLength(64);
    expect(opened?.memos.find((item) => item.id === "memo-0")?.content).toBe("mine");
    expect(opened?.memos.find((item) => item.id === "memo-5")?.content).toBe("note 5");
    await invalidateSnapshot();
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
