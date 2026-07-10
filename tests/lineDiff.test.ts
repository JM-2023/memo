import { describe, expect, it } from "vitest";
import { diffLines, lineRenders, visualLinesOf, type DiffOp } from "../src/lib/lineDiff";

function script(ops: DiffOp[]): string {
  return ops.map((op) => (op.type === "keep" ? `=${op.raw}` : op.type === "del" ? `-${op.raw}` : `+${op.raw}`)).join("|");
}

/** Applying the ops to the old side must reproduce the new side exactly. */
function replay(ops: DiffOp[]): { old: string[]; next: string[] } {
  const old: string[] = [];
  const next: string[] = [];
  for (const op of ops) {
    if (op.type !== "add") old.push(op.raw);
    if (op.type !== "del") next.push(op.raw);
  }
  return { old, next };
}

describe("visualLinesOf", () => {
  it("keeps text, blank and mixed lines with their original indices", () => {
    const lines = visualLinesOf("a\n\nb #tag\nhttps://example.com/page");
    expect(lines).toEqual([
      { raw: "a", key: 0 },
      { raw: "", key: 1 },
      { raw: "b #tag", key: 2 },
      { raw: "https://example.com/page", key: 3 }
    ]);
  });

  it("drops image-only lines but keeps lines with text beside an image", () => {
    expect(lineRenders("![](https://x.test/a.png)")).toBe(false);
    expect(lineRenders("  ![](https://x.test/a.png)  ")).toBe(false);
    expect(lineRenders("see ![](https://x.test/a.png)")).toBe(true);
    expect(lineRenders("https://x.test/a.png")).toBe(false); // bare image URL
    expect(lineRenders("https://x.test/page")).toBe(true); // plain link renders
    const lines = visualLinesOf("top\n![](https://x.test/a.png)\nbottom");
    expect(lines.map((line) => line.key)).toEqual([0, 2]);
  });
});

describe("diffLines", () => {
  it("returns pure keeps for identical inputs", () => {
    const ops = diffLines(["a", "b"], ["a", "b"]);
    expect(script(ops)).toBe("=a|=b");
    expect(ops.every((op) => op.type === "keep")).toBe(true);
  });

  it("diffs a middle edit with correct indices", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "x", "c"]);
    expect(script(ops)).toBe("=a|-b|+x|=c");
    expect(ops[0]).toEqual({ type: "keep", raw: "a", oldIndex: 0, newIndex: 0 });
    expect(ops[1]).toEqual({ type: "del", raw: "b", oldIndex: 1 });
    expect(ops[2]).toEqual({ type: "add", raw: "x", newIndex: 1 });
    expect(ops[3]).toEqual({ type: "keep", raw: "c", oldIndex: 2, newIndex: 2 });
  });

  it("handles pure insertion and pure deletion", () => {
    expect(script(diffLines(["a", "c"], ["a", "b", "c"]))).toBe("=a|+b|=c");
    expect(script(diffLines(["a", "b", "c"], ["a", "c"]))).toBe("=a|-b|=c");
    expect(script(diffLines([], ["a"]))).toBe("+a");
    expect(script(diffLines(["a"], []))).toBe("-a");
    expect(diffLines([], [])).toEqual([]);
  });

  it("keeps the longest common subsequence through reordering", () => {
    const ops = diffLines(["a", "b", "c", "d"], ["c", "a", "b", "d"]);
    const kept = ops.filter((op) => op.type === "keep").map((op) => op.raw);
    expect(kept).toEqual(["a", "b", "d"]);
  });

  it("matches repeated lines (blanks) without inventing changes", () => {
    const ops = diffLines(["a", "", "b", "", "c"], ["a", "", "x", "", "c"]);
    expect(script(ops)).toBe("=a|=|-b|+x|=|=c");
  });

  it("round-trips arbitrary edits", () => {
    const oldLines = ["one", "two", "three", "", "four", "five"];
    const newLines = ["zero", "one", "three", "4", "", "five", "six"];
    const { old, next } = replay(diffLines(oldLines, newLines));
    expect(old).toEqual(oldLines);
    expect(next).toEqual(newLines);
  });

  it("keeps new-side indices strictly increasing per side", () => {
    const ops = diffLines(["a", "b", "c", "d", "e"], ["b", "c", "x", "e", "y"]);
    const newIdx = ops.filter((op) => op.type !== "del").map((op) => (op.type === "keep" ? op.newIndex : op.newIndex));
    expect(newIdx).toEqual(newIdx.map((_, i) => i));
    const oldIdx = ops.filter((op) => op.type !== "add").map((op) => (op.type === "keep" ? op.oldIndex : op.oldIndex));
    expect(oldIdx).toEqual(oldIdx.map((_, i) => i));
  });

  it("degrades to replace-all past the DP area limit but still round-trips", () => {
    const oldLines = Array.from({ length: 600 }, (_, i) => `old ${i}`);
    const newLines = Array.from({ length: 600 }, (_, i) => `new ${i}`);
    // Shared prefix/suffix should still peel off as keeps.
    oldLines[0] = newLines[0] = "same head";
    oldLines[599] = newLines[599] = "same tail";
    const ops = diffLines(oldLines, newLines);
    expect(ops[0].type).toBe("keep");
    expect(ops[ops.length - 1].type).toBe("keep");
    const { old, next } = replay(ops);
    expect(old).toEqual(oldLines);
    expect(next).toEqual(newLines);
  });
});
