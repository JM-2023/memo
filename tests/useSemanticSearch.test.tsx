// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_MANIFEST } from "../src/lib/modelManifest";
import type { SemanticIndex } from "../src/lib/semanticIndex";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => {}),
  deleteDb: vi.fn(async () => {}),
  reconcile: vi.fn(),
  storedModelState: vi.fn(async () => "complete" as const),
  getEmbedder: vi.fn(async () => async (texts: readonly string[]) => texts.map(() => new Float32Array(384))),
  runModelSelfTest: vi.fn(async () => {})
}));

vi.mock("../src/lib/modelLoader", () => ({
  storedModelState: mocks.storedModelState
}));

vi.mock("../src/lib/modelRuntime", () => ({
  EMBEDDING_DIM: 384,
  RETRIEVAL_QUERY_PREFIX: "",
  getEmbedder: mocks.getEmbedder,
  runModelSelfTest: mocks.runModelSelfTest
}));

vi.mock("../src/lib/semanticIndex", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/semanticIndex")>();
  return {
    ...original,
    deleteSemanticIndexDb: mocks.deleteDb,
    loadSemanticIndex: mocks.load,
    reconcileSemanticIndex: mocks.reconcile,
    saveSemanticIndex: mocks.save
  };
});

import { useSemanticSearch } from "../src/hooks/useSemanticSearch";

function memoOf(id: string, content: string): Memo {
  const at = "2026-08-15T00:00:00Z";
  return { id, content, createdAt: at, updatedAt: at, pinnedAt: null, deletedAt: null, seq: 1, images: [] };
}

/** In-process BroadcastChannel: what one instance posts, the others receive. */
class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const other of FakeChannel.open) {
      if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data }));
    }
  }
  close() {
    FakeChannel.open.delete(this);
  }
}

/** Web Locks where the test decides when the lock is granted. */
function installLocks() {
  const waiting: Array<() => void> = [];
  const request = vi.fn((_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => {
    return new Promise<void>((resolve, reject) => {
      const grant = () => void callback().then(resolve, reject);
      waiting.push(grant);
      options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return { request, grantNext: () => waiting.shift()?.() };
}

/**
 * One Web Lock shared by the hook and the test, which plays the other tab:
 * granted in request order, freed when the holder's callback settles, and
 * visible to query() as held or pending.
 */
function installLockManager() {
  let holder: object | null = null;
  const queue: Array<{ grant: () => void }> = [];
  const pump = () => {
    if (holder || queue.length === 0) return;
    queue.shift()!.grant();
  };
  const request = vi.fn((_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void> | void) => {
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          holder = entry;
          Promise.resolve()
            .then(callback)
            .then(() => resolve(), reject)
            .finally(() => {
              holder = null;
              pump();
            });
        }
      };
      queue.push(entry);
      options.signal?.addEventListener("abort", () => {
        const position = queue.indexOf(entry);
        if (position < 0) return;
        queue.splice(position, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
      queueMicrotask(pump);
    });
  });
  const query = vi.fn(async () => ({
    held: holder ? [{ name: "memo-semantic-indexer" }] : [],
    pending: queue.map(() => ({ name: "memo-semantic-indexer" }))
  }));
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request, query } });
  return {
    held: () => holder !== null,
    /** Another tab queues for the lock; `granted` settles once it holds it. */
    otherTab() {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const granted = new Promise<void>((resolve) => {
        void request("memo-semantic-indexer", {}, () => {
          resolve();
          return held;
        });
      });
      return { granted, release };
    }
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

function emptyIndex(): SemanticIndex {
  return { modelVersion: MODEL_MANIFEST.version, rows: [], vectors: new Float32Array(0) };
}

function indexOf(...memoIds: string[]): SemanticIndex {
  return {
    modelVersion: MODEL_MANIFEST.version,
    rows: memoIds.map((id) => ({ id, updatedAt: "2026-08-15T00:00:00Z", contentKey: `${id}:1`, chunkIndex: 0, chunkCount: 1 })),
    vectors: new Float32Array(memoIds.length * 384)
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteDb.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(emptyIndex());
  mocks.reconcile.mockImplementation(async (index: SemanticIndex) => index);
  mocks.storedModelState.mockResolvedValue("complete");
  mocks.getEmbedder.mockResolvedValue(async (texts: readonly string[]) => texts.map(() => new Float32Array(384)));
  mocks.runModelSelfTest.mockResolvedValue(undefined);
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeChannel.open.clear();
  delete (navigator as { locks?: unknown }).locks;
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("useSemanticSearch", () => {
  it("drops the in-memory index when disabled and reloads it on re-enable", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useSemanticSearch(enabled, [], ""),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocks.load).toHaveBeenCalledOnce();

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.status).toBe("off"));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("keeps an actionable error and retries activation directly", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("index exploded"));
    const { result } = renderHook(() => useSemanticSearch(true, [], ""));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("index exploded");

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.error).toBeNull();
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  });

  it("counts the memos it has vectors for", async () => {
    // Two rows per memo: the count is memos, not chunks.
    mocks.load.mockResolvedValue(indexOf("a", "a", "b"));
    const { result } = renderHook(() => useSemanticSearch(true, [], ""));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.indexedMemos).toBe(2);
  });

  it("rebuilds by discarding the sealed index and embedding from empty", async () => {
    mocks.load.mockResolvedValueOnce(indexOf("a", "b", "c"));
    const { result } = renderHook(() => useSemanticSearch(true, [], ""));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.indexedMemos).toBe(3);
    expect(result.current.rebuilding).toBe(false);

    // The purge empties the store, so the pass that follows loads nothing.
    mocks.load.mockResolvedValue(null);
    act(() => result.current.rebuild());
    expect(result.current.rebuilding).toBe(true);

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocks.deleteDb).toHaveBeenCalledOnce();
    // The rebuild pass starts from nothing rather than reconciling with itself.
    expect(mocks.reconcile).toHaveBeenCalled();
    expect((mocks.reconcile.mock.calls.at(-1)![0] as SemanticIndex).rows).toEqual([]);
    expect(result.current.indexedMemos).toBe(0);
    expect(result.current.rebuilding).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("hands a landed ranking to the caller instead of committing it itself", async () => {
    // The landing reorders every visible row at once, so the feed gets to
    // commit it inside a view transition. Swallowing the commit here proves
    // the results really do travel that way and not around it.
    mocks.load.mockResolvedValue(indexOf("a"));
    const swallowed = vi.fn();
    const { result } = renderHook(() => useSemanticSearch(true, [], "meaning", null, swallowed));

    await waitFor(() => expect(swallowed).toHaveBeenCalledOnce());
    expect(result.current.results).toBeNull();
  });

  it("publishes the ranking once the caller commits it", async () => {
    mocks.load.mockResolvedValue(indexOf("a"));
    const publish = vi.fn((commit: () => void) => commit());
    const { result } = renderHook(() => useSemanticSearch(true, [], "meaning", null, publish));

    await waitFor(() => expect(result.current.results).not.toBeNull());
    expect(publish).toHaveBeenCalledOnce();
  });

  it("rebuilds straight out of a failure and stops calling the pass a rebuild", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("embedder died"));
    const { result } = renderHook(() => useSemanticSearch(true, [], ""));

    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.rebuild());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.rebuilding).toBe(false);
  });

  it("opens the index without starting the model, and starts it for the first query", async () => {
    mocks.load.mockResolvedValue(indexOf("a"));
    const { result, rerender } = renderHook(({ query }) => useSemanticSearch(true, [memoOf("a", "a:1")], query), {
      initialProps: { query: "" }
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.indexedMemos).toBe(1);
    expect(mocks.getEmbedder).not.toHaveBeenCalled();
    expect(mocks.runModelSelfTest).not.toHaveBeenCalled();

    rerender({ query: "meaning" });
    await waitFor(() => expect(result.current.results).not.toBeNull());
    expect(mocks.getEmbedder).toHaveBeenCalledOnce();
    expect(mocks.runModelSelfTest).toHaveBeenCalledOnce();
  });

  it("starts the model for a first build only once a memo needs embedding", async () => {
    mocks.reconcile.mockImplementation(
      async (index: SemanticIndex, _memos: readonly Memo[], embed: (texts: string[]) => Promise<Float32Array[]>) => {
        await embed(["hello"]);
        return index;
      }
    );
    const { result } = renderHook(() => useSemanticSearch(true, [memoOf("a", "hello")], ""));

    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocks.getEmbedder).toHaveBeenCalledOnce();
  });

  it("keeps per-slice ranking progress out of the hook's render path", async () => {
    mocks.load.mockResolvedValue(indexOf(...Array.from({ length: 3000 }, (_, row) => `memo-${row}`)));
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ query }) => {
        renders += 1;
        return useSemanticSearch(true, [], query);
      },
      { initialProps: { query: "" } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const updates: number[] = [];
    const unsubscribe = result.current.live.subscribe(() => {
      const progress = result.current.live.getSnapshot().queryProgress;
      if (progress?.stage === "ranking") updates.push(progress.done);
    });
    // A slow device: every clock read is 10 ms on, so every check yields.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    const before = renders;

    rerender({ query: "meaning" });
    expect(result.current.queryBusy).toBe(true);
    await waitFor(() => expect(result.current.results).not.toBeNull());
    await waitFor(() => expect(result.current.queryBusy).toBe(false));
    unsubscribe();

    expect(updates.length).toBeGreaterThan(10);
    // The rerender itself, busy on, results landing, busy off — not a render per slice.
    expect(renders - before).toBeLessThanOrEqual(5);
  });

  it("re-ranks an earlier query from its cached vector instead of embedding it again", async () => {
    mocks.load.mockResolvedValue(indexOf("a"));
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Float32Array(384)));
    mocks.getEmbedder.mockResolvedValue(embed);
    const { result, rerender } = renderHook(({ query }) => useSemanticSearch(true, [], query), {
      initialProps: { query: "apples" }
    });
    await waitFor(() => expect(result.current.results).not.toBeNull());
    rerender({ query: "pears" });
    await waitFor(() => expect(embed).toHaveBeenCalledWith(["pears"]));
    await waitFor(() => expect(result.current.results).not.toBeNull());

    rerender({ query: "apples" });
    await waitFor(() => expect(result.current.results).not.toBeNull());
    expect(embed.mock.calls.filter(([texts]) => texts[0] === "apples")).toHaveLength(1);
  });

  it("leaves indexing to the tab holding the lock and follows what it writes", async () => {
    installLocks();
    const peer = new FakeChannel("memo-semantic-index");
    const asked: unknown[] = [];
    peer.onmessage = (event) => asked.push(event.data);
    mocks.load.mockResolvedValue(emptyIndex());
    const { result } = renderHook(() => useSemanticSearch(true, [memoOf("a", "hello")], ""));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not the indexer: no first build here, no model, no writes.
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.getEmbedder).not.toHaveBeenCalled();

    act(() => peer.postMessage({ type: "indexing", rebuilding: false }));
    await waitFor(() => expect(result.current.status).toBe("indexing"));
    const progress = { done: 1, total: 2, doneChunks: 1, totalChunks: 2 };
    act(() => peer.postMessage({ type: "progress", progress }));
    await waitFor(() => expect(result.current.live.getSnapshot().progress).toEqual(progress));

    mocks.load.mockResolvedValue(indexOf("a"));
    act(() => peer.postMessage({ type: "settled", wrote: true }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.indexedMemos).toBe(1);
    expect(mocks.save).not.toHaveBeenCalled();

    // A rebuild asked for here is the indexer's to run.
    act(() => result.current.rebuild());
    await waitFor(() => expect(asked).toContainEqual({ type: "rebuild" }));
    expect(mocks.deleteDb).not.toHaveBeenCalled();
  });

  it("takes the indexing over once the lock comes free", async () => {
    const locks = installLocks();
    mocks.load.mockResolvedValue(emptyIndex());
    const memos = [memoOf("a", "hello")];
    const { result } = renderHook(() => useSemanticSearch(true, memos, ""));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocks.reconcile).not.toHaveBeenCalled();

    act(() => locks.grantNext());
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
  });

  it("lets the lock go while its tab is hidden, so the visible tab indexes", async () => {
    const locks = installLockManager();
    mocks.load.mockResolvedValue(indexOf("a"));
    const { result, rerender } = renderHook(({ memos }) => useSemanticSearch(true, memos, ""), {
      initialProps: { memos: [memoOf("a", "a:1")] }
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(locks.held()).toBe(true));

    // The user switches to the other tab: this one is hidden (and may be
    // suspended), so the other tab must not be left waiting on it.
    const other = locks.otherTab();
    act(() => setHidden(true));
    await other.granted;
    rerender({ memos: [memoOf("a", "a:1"), memoOf("b", "new memo")] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.reconcile).not.toHaveBeenCalled();

    // Back here, it queues again and takes over once the other tab lets go.
    act(() => setHidden(false));
    other.release();
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect((mocks.reconcile.mock.calls[0][1] as Memo[]).map((memo) => memo.id)).toEqual(["a", "b"]);
  });

  it("lets the lock go when a failed query leaves the tab in error", async () => {
    const locks = installLockManager();
    mocks.load.mockResolvedValue(indexOf("a"));
    mocks.getEmbedder.mockRejectedValue(new Error("runtime died"));
    const { result, rerender } = renderHook(({ query }) => useSemanticSearch(true, [memoOf("a", "a:1")], query), {
      initialProps: { query: "" }
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(locks.held()).toBe(true));
    const other = locks.otherTab();

    rerender({ query: "meaning" });
    await waitFor(() => expect(result.current.status).toBe("error"));
    await other.granted;
  });

  it("finishes a pass while hidden, but hands over at the next batch when another tab is waiting", async () => {
    const locks = installLockManager();
    mocks.load.mockResolvedValue(emptyIndex());
    let batches = 0;
    mocks.reconcile.mockImplementation(
      async (
        _index: SemanticIndex,
        _memos: readonly Memo[],
        _embed: unknown,
        callbacks: {
          onProgress?: (progress: { done: number; total: number; doneChunks: number; totalChunks: number }) => void;
          shouldContinue?: () => boolean;
        }
      ) => {
        while (batches < 200 && callbacks.shouldContinue?.() !== false) {
          batches += 1;
          callbacks.onProgress?.({ done: batches, total: 200, doneChunks: batches, totalChunks: 200 });
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return indexOf("a");
      }
    );
    const { result } = renderHook(() => useSemanticSearch(true, [memoOf("a", "hello")], ""));
    await waitFor(() => expect(result.current.status).toBe("indexing"));

    // Hidden with nobody waiting: a desktop background tab keeps building.
    act(() => setHidden(true));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(locks.held()).toBe(true);

    const other = locks.otherTab();
    await other.granted;
    // Cut short, and what it had was saved for the next indexer to build on.
    expect(batches).toBeLessThan(200);
    expect(mocks.save).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("does not start a second pass while one is still saving", async () => {
    mocks.load.mockResolvedValue(indexOf("a", "b"));
    mocks.reconcile.mockImplementation(async (index: SemanticIndex, memos: readonly Memo[]) => {
      const live = new Set(memos.map((memo) => memo.id));
      return { ...index, rows: index.rows.filter((row) => live.has(row.id)) };
    });
    let finishSave = () => {};
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    const a = memoOf("a", "a:1");
    const b = memoOf("b", "b:1");
    const { result, rerender } = renderHook(({ memos }) => useSemanticSearch(true, memos, ""), {
      initialProps: { memos: [a, b] }
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Deleting b needs no model: the pass stays "ready" while its save hangs.
    rerender({ memos: [a] });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce(), { timeout: 3000 });
    rerender({ memos: [] });
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(mocks.reconcile).toHaveBeenCalledOnce();

    // Once it lands, the deferred pass runs from its result, not from before it.
    await act(async () => finishSave());
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect((mocks.reconcile.mock.calls[1][0] as SemanticIndex).rows.map((row) => row.id)).toEqual(["a"]);
  }, 10000);
});
