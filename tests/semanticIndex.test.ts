import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { adoptCacheKey, forgetCacheKey } from "../src/lib/cache";
import { EMBEDDING_DIM } from "../src/lib/modelRuntime";
import {
  SEMANTIC_CHUNK_CHARS,
  SEMANTIC_CHUNK_OVERLAP,
  SEMANTIC_MAX_CHUNKS,
  chunkMemoContent,
  decodeSemanticIndex,
  emptySemanticIndex,
  encodeSemanticIndex,
  loadSemanticIndex,
  planSemanticIndex,
  reconcileSemanticIndex,
  saveSemanticIndex,
  searchSemanticIndex,
  type SemanticIndex
} from "../src/lib/semanticIndex";
import type { Memo } from "../src/lib/types";

function memoOf(id: string, content: string, updatedAt = "2026-08-15T00:00:00.000Z"): Memo {
  return { id, content, createdAt: updatedAt, updatedAt, pinnedAt: null, deletedAt: null, seq: 1, images: [] };
}

/** Unit vector along one axis — dot products become directly readable. */
function axis(dimension: number, value = 1): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  vector[dimension] = value;
  return vector;
}

const countingEmbed = async (texts: readonly string[]): Promise<Float32Array[]> => texts.map(() => axis(0));

function indexWith(rows: { id: string; vector: Float32Array }[]): SemanticIndex {
  const vectors = new Float32Array(rows.length * EMBEDDING_DIM);
  rows.forEach((row, i) => vectors.set(row.vector, i * EMBEDDING_DIM));
  return {
    modelVersion: "test-r1",
    rows: rows.map((row) => ({ id: row.id, updatedAt: "2026-08-15T00:00:00.000Z" })),
    vectors
  };
}

describe("chunking", () => {
  it("windows long content with overlap and a chunk cap", () => {
    expect(chunkMemoContent("")).toEqual([]);
    expect(chunkMemoContent("   \n  ")).toEqual([]);
    expect(chunkMemoContent("short note")).toEqual(["short note"]);

    const long = "x".repeat(1000);
    const chunks = chunkMemoContent(long);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(SEMANTIC_CHUNK_CHARS);
    expect(chunks[1].length).toBe(SEMANTIC_CHUNK_CHARS);
    // Third window: from 700 to 1000.
    expect(chunks[2].length).toBe(1000 - 2 * (SEMANTIC_CHUNK_CHARS - SEMANTIC_CHUNK_OVERLAP));

    expect(chunkMemoContent("y".repeat(40000)).length).toBe(SEMANTIC_MAX_CHUNKS);
  });
});

describe("plan and reconcile", () => {
  it("treats every memo as stale against an empty index, then settles", async () => {
    const memos = [memoOf("a", "第一条笔记"), memoOf("b", "second note")];
    const empty = emptySemanticIndex("test-r1");
    expect(planSemanticIndex(empty, memos).stale.length).toBe(2);

    const built = await reconcileSemanticIndex(empty, memos, countingEmbed);
    expect(built.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(built.vectors.length).toBe(2 * EMBEDDING_DIM);

    const settled = planSemanticIndex(built, memos);
    expect(settled.stale).toEqual([]);
    expect(settled.keptRowIndices.length).toBe(2);
    // Identity fast-path: nothing to do returns the same object.
    expect(await reconcileSemanticIndex(built, memos, countingEmbed)).toBe(built);
  });

  it("re-embeds an edited memo and drops a deleted one", async () => {
    const memos = [memoOf("a", "旧内容"), memoOf("b", "kept")];
    const built = await reconcileSemanticIndex(emptySemanticIndex("test-r1"), memos, countingEmbed);

    const edited = [memoOf("a", "新内容", "2026-08-15T09:00:00.000Z"), memos[1]];
    const plan = planSemanticIndex(built, edited);
    expect(plan.stale.map((memo) => memo.id)).toEqual(["a"]);
    expect(plan.keptRowIndices.length).toBe(1);

    const rebuilt = await reconcileSemanticIndex(built, edited, countingEmbed);
    expect(rebuilt.rows.map((row) => row.id).sort()).toEqual(["a", "b"]);

    const afterDelete = await reconcileSemanticIndex(rebuilt, [edited[0]], countingEmbed);
    expect(afterDelete.rows.map((row) => row.id)).toEqual(["a"]);
  });

  it("stops early when shouldContinue says so, keeping valid rows", async () => {
    const memos = [memoOf("a", "one"), memoOf("b", "two")];
    const partial = await reconcileSemanticIndex(emptySemanticIndex("test-r1"), memos, countingEmbed, {
      shouldContinue: () => false
    });
    expect(partial.rows).toEqual([]);
  });

  it("reports progress in memos", async () => {
    const memos = [memoOf("a", "one"), memoOf("b", "two"), memoOf("c", "three")];
    const seen: [number, number][] = [];
    await reconcileSemanticIndex(emptySemanticIndex("test-r1"), memos, countingEmbed, {
      onProgress: (done, total) => seen.push([done, total])
    });
    expect(seen[0]).toEqual([0, 3]);
    expect(seen.at(-1)).toEqual([3, 3]);
  });
});

describe("search", () => {
  it("ranks by best chunk, floors noise, and orders the map", () => {
    const index = indexWith([
      { id: "a", vector: axis(0, 0.5) },
      { id: "a", vector: axis(0, 0.9) },
      { id: "b", vector: axis(0, 0.8) },
      { id: "c", vector: axis(0, 0.73) }
    ]);
    const results = searchSemanticIndex(index, axis(0));
    expect([...results.keys()]).toEqual(["a", "b"]);
    expect(results.get("a")).toBeCloseTo(0.9, 5);
    expect(results.get("b")).toBeCloseTo(0.8, 5);
  });
});

describe("serialization", () => {
  it("round-trips rows and vectors", () => {
    const index = indexWith([
      { id: "a", vector: axis(3, 0.25) },
      { id: "b", vector: axis(7, -1) }
    ]);
    const decoded = decodeSemanticIndex(encodeSemanticIndex(index));
    expect(decoded).not.toBeNull();
    expect(decoded!.modelVersion).toBe("test-r1");
    expect(decoded!.rows).toEqual(index.rows);
    expect([...decoded!.vectors]).toEqual([...index.vectors]);
  });

  it("rejects truncated or mismatched payloads", () => {
    const bytes = encodeSemanticIndex(indexWith([{ id: "a", vector: axis(0) }]));
    expect(decodeSemanticIndex(bytes.subarray(0, bytes.byteLength - 8))).toBeNull();
    expect(decodeSemanticIndex(bytes.subarray(0, 3))).toBeNull();
  });
});

describe("sealed persistence", () => {
  const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

  it("persists only under the session key and only for the same model version", async () => {
    forgetCacheKey();
    const index = indexWith([{ id: "a", vector: axis(0, 0.8) }]);

    // No key: save is a deliberate no-op.
    await saveSemanticIndex(index);
    adoptCacheKey(KEY_B64);
    expect(await loadSemanticIndex("test-r1")).toBeNull();

    // With the key: full round-trip.
    await saveSemanticIndex(index);
    const loaded = await loadSemanticIndex("test-r1");
    expect(loaded).not.toBeNull();
    expect(loaded!.rows).toEqual(index.rows);
    expect([...loaded!.vectors]).toEqual([...index.vectors]);

    // A different model version must not resurrect old vectors.
    expect(await loadSemanticIndex("test-r2")).toBeNull();

    // Losing the key makes the stored index unreadable.
    forgetCacheKey();
    expect(await loadSemanticIndex("test-r1")).toBeNull();
  });
});
