import { describe, expect, it } from "vitest";
import { selectionWithinVisibleIds } from "../src/lib/selection";

describe("selectionWithinVisibleIds", () => {
  it("excludes selected memos hidden by a changed filter", () => {
    const selected = new Set(["visible", "hidden", "deleted"]);

    expect([...selectionWithinVisibleIds(selected, ["visible", "other"])]).toEqual(["visible"]);
  });

  it("preserves visible feed order and removes duplicates", () => {
    const selected = new Set(["b", "a"]);

    expect([...selectionWithinVisibleIds(selected, ["a", "b", "a"])]).toEqual(["a", "b"]);
  });
});
