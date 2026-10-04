import { describe, expect, it } from "vitest";
import { applyOptimisticLayer, withOptimistic, withoutPatch, withPatch, type OptimisticLayer } from "../src/lib/optimisticMemos";
import { formatTime } from "../src/lib/dates";
import type { Memo } from "../src/lib/types";

function memo(id: string): Memo {
  return {
    id,
    content: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: []
  };
}

describe("optimistic memo layer", () => {
  it("skins only the patched memo and keeps every other identity", () => {
    const a = memo("a");
    const b = memo("b");
    const layer = withPatch(new Map(), "a", { pinnedAt: "2026-02-01T00:00:00.000Z" });
    const shown = applyOptimisticLayer([a, b], layer);
    expect(shown[0]).toEqual({ ...a, pinnedAt: "2026-02-01T00:00:00.000Z" });
    expect(shown[0].seq).toBe(a.seq);
    expect(shown[1]).toBe(b);
    expect(a.pinnedAt).toBeNull();
  });

  it("returns the same list when nothing is in flight", () => {
    const list = [memo("a")];
    expect(applyOptimisticLayer(list, new Map())).toBe(list);
  });

  it("can patch a field back to null (restore, unpin)", () => {
    const trashed = { ...memo("a"), deletedAt: "2026-01-02T00:00:00.000Z" };
    expect(withOptimistic(trashed, new Map([["a", { deletedAt: null }]])).deletedAt).toBeNull();
  });

  it("removes a patch without disturbing an untouched layer", () => {
    const layer: OptimisticLayer = new Map([["a", { pinnedAt: null }]]);
    expect(withoutPatch(layer, "b")).toBe(layer);
    expect(withoutPatch(layer, "a").size).toBe(0);
    expect(layer.size).toBe(1);
  });
});

describe("formatTime", () => {
  it("formats consistently through the cached per-locale formatter", () => {
    const iso = "2026-03-04T05:06:00.000Z";
    const first = formatTime(iso, "en-US");
    expect(formatTime(iso, "en-US")).toBe(first);
    expect(formatTime(iso, "zh-CN")).not.toBe(first);
  });
});
