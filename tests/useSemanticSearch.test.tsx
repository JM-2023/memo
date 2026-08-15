// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_MANIFEST } from "../src/lib/modelManifest";
import type { SemanticIndex } from "../src/lib/semanticIndex";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => {}),
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
    loadSemanticIndex: mocks.load,
    reconcileSemanticIndex: mocks.reconcile,
    saveSemanticIndex: mocks.save
  };
});

import { useSemanticSearch } from "../src/hooks/useSemanticSearch";

function emptyIndex(): SemanticIndex {
  return { modelVersion: MODEL_MANIFEST.version, rows: [], vectors: new Float32Array(0) };
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
