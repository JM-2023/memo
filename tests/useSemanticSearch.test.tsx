// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_MANIFEST } from "../src/lib/modelManifest";
import type { SemanticIndex } from "../src/lib/semanticIndex";

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
});

afterEach(() => cleanup());

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
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    // The second pass starts from nothing rather than reconciling with itself.
    expect((mocks.reconcile.mock.calls[1][0] as SemanticIndex).rows).toEqual([]);
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
});
