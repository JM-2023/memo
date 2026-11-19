import { describe, expect, it } from "vitest";
import { memoLabelLead, selectionRange, selectionWithinVisibleIds, withSelectionRange } from "../src/lib/selection";

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

describe("range picks (Shift-click, or a long press on touch)", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("runs from the anchor to the target, outward from the anchor", () => {
    expect(selectionRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectionRange(ids, "d", "a")).toEqual(["d", "c", "b", "a"]);
  });

  it("has no range without an anchor, on the anchor itself, or with an end gone from the feed", () => {
    expect(selectionRange(ids, null, "c")).toBeNull();
    expect(selectionRange(ids, "c", "c")).toBeNull();
    expect(selectionRange(ids, "gone", "c")).toBeNull();
    expect(selectionRange(ids, "c", "gone")).toBeNull();
  });

  it("gives the whole range the state the target toggles to", () => {
    const picked = withSelectionRange(new Set(["a"]), ["b", "c", "d"], "d");
    expect(picked.on).toBe(true);
    expect([...picked.next].sort()).toEqual(["a", "b", "c", "d"]);

    const unpicked = withSelectionRange(new Set(["a", "b", "c", "d"]), ["d", "c"], "c");
    expect(unpicked.on).toBe(false);
    expect([...unpicked.next].sort()).toEqual(["a", "b"]);
  });
});

describe("memoLabelLead", () => {
  it("takes the first line with words, its markdown marks dropped", () => {
    expect(memoLabelLead("\n\n## Groceries for **Sunday**\n- milk")).toBe("Groceries for Sunday");
    expect(memoLabelLead("- [x] call [the bank](https://bank.example) `today`")).toBe("call the bank today");
    expect(memoLabelLead("> quoted #idea")).toBe("quoted #idea");
    expect(memoLabelLead("```js\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(memoLabelLead("---\n| a | b |\n| --- | --- |")).toBe("a b");
    expect(memoLabelLead("![](https://example.com/cat.png)\nA cat")).toBe("A cat");
  });

  it("cuts a long line to a short phrase, whole characters only", () => {
    const lead = memoLabelLead("这是一条非常非常长的笔记，用来测试读屏名字会不会被截断成合适的长度而不会把整段都念出来", 12);
    expect(Array.from(lead)).toHaveLength(12);
    expect(lead.endsWith("…")).toBe(true);
    expect(memoLabelLead("😀".repeat(50), 5)).toBe("😀😀😀😀…");
  });

  it("is empty for a memo with no words", () => {
    expect(memoLabelLead("")).toBe("");
    expect(memoLabelLead("\n  \n![](https://example.com/a.png)")).toBe("");
  });
});
