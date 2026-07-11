import { describe, expect, it } from "vitest";
import {
  continueListOnEnter,
  insertTableTemplate,
  shiftListIndent,
  tableTabStop,
  toggleBulletLine,
  toggleWrap
} from "../src/lib/markdownEdit";

describe("continueListOnEnter", () => {
  it("continues bullet, task and quote prefixes", () => {
    expect(continueListOnEnter("- one", 5)).toEqual({ value: "- one\n- ", start: 8, end: 8 });
    expect(continueListOnEnter("  * a", 5)).toEqual({ value: "  * a\n  * ", start: 10, end: 10 });
    expect(continueListOnEnter("- [x] done", 10)).toEqual({ value: "- [x] done\n- [ ] ", start: 17, end: 17 });
    expect(continueListOnEnter("> 引用", 4)).toEqual({ value: "> 引用\n> ", start: 7, end: 7 });
  });

  it("increments ordered items and keeps their delimiter", () => {
    expect(continueListOnEnter("1. a", 4)).toEqual({ value: "1. a\n2. ", start: 8, end: 8 });
    expect(continueListOnEnter("9) a", 4)).toEqual({ value: "9) a\n10) ", start: 9, end: 9 });
  });

  it("splits mid-line while continuing the prefix", () => {
    expect(continueListOnEnter("- one two", 4)).toEqual({ value: "- on\n- e two", start: 7, end: 7 });
  });

  it("clears an empty item instead of stacking another", () => {
    expect(continueListOnEnter("- a\n- ", 6)).toEqual({ value: "- a\n", start: 4, end: 4 });
    expect(continueListOnEnter("1. a\n2. ", 8)).toEqual({ value: "1. a\n", start: 5, end: 5 });
  });

  it("returns null for plain lines and for Enter inside the prefix", () => {
    expect(continueListOnEnter("plain text", 5)).toBeNull();
    expect(continueListOnEnter("- one", 1)).toBeNull();
  });
});

describe("continueListOnEnter tables", () => {
  it("completes a fresh header row with the delimiter", () => {
    expect(continueListOnEnter("| a | b |", 9)).toEqual({ value: "| a | b |\n| --- | --- |", start: 23, end: 23 });
  });

  it("adds an empty row after the delimiter or inside a table", () => {
    expect(continueListOnEnter("| a |\n| --- |", 13)).toEqual({ value: "| a |\n| --- |\n|  |", start: 16, end: 16 });
    expect(continueListOnEnter("| a | b |\n| c | d |", 19)).toEqual({
      value: "| a | b |\n| c | d |\n|  |  |",
      start: 22,
      end: 22
    });
  });

  it("exits on an empty row and stays native mid-row", () => {
    expect(continueListOnEnter("| a | b |\n|  |  |", 17)).toEqual({ value: "| a | b |\n", start: 10, end: 10 });
    expect(continueListOnEnter("| a | b |", 4)).toBeNull();
  });
});

describe("tableTabStop", () => {
  it("selects the next / previous cell's content", () => {
    expect(tableTabStop("| aa | bb |", 3, 1)).toEqual({ value: "| aa | bb |", start: 7, end: 9 });
    expect(tableTabStop("| aa | bb |", 8, -1)).toEqual({ value: "| aa | bb |", start: 2, end: 4 });
    expect(tableTabStop("|  |  |", 2, 1)).toEqual({ value: "|  |  |", start: 5, end: 5 });
  });

  it("hops across rows at the line edges", () => {
    expect(tableTabStop("| a |\n| b |", 3, 1)).toEqual({ value: "| a |\n| b |", start: 8, end: 9 });
    expect(tableTabStop("| a |\n| b |", 9, -1)).toEqual({ value: "| a |\n| b |", start: 2, end: 3 });
  });

  it("returns null off tables and past the table's ends", () => {
    expect(tableTabStop("plain", 2, 1)).toBeNull();
    expect(tableTabStop("| a |", 3, 1)).toBeNull();
    expect(tableTabStop("| a |", 3, -1)).toBeNull();
  });
});

describe("insertTableTemplate", () => {
  it("replaces an empty line and selects the first header label", () => {
    expect(insertTableTemplate("", 0, "A", "B")).toEqual({
      value: "| A | B |\n| --- | --- |\n|  |  |",
      start: 2,
      end: 3
    });
  });

  it("starts below a non-empty line", () => {
    expect(insertTableTemplate("note", 2, "A", "B")).toEqual({
      value: "note\n| A | B |\n| --- | --- |\n|  |  |",
      start: 7,
      end: 8
    });
  });
});

describe("toggleWrap", () => {
  it("wraps and unwraps a selection", () => {
    expect(toggleWrap("hello world", 0, 5, "**")).toEqual({ value: "**hello** world", start: 2, end: 7 });
    expect(toggleWrap("**hello** world", 0, 9, "**")).toEqual({ value: "hello world", start: 0, end: 5 });
    expect(toggleWrap("**hello** world", 2, 7, "**")).toEqual({ value: "hello world", start: 0, end: 5 });
  });

  it("shrinks past edge whitespace so the result parses", () => {
    expect(toggleWrap("say hello now", 3, 10, "~~")).toEqual({ value: "say ~~hello~~ now", start: 6, end: 11 });
  });

  it("gives a caret an empty pair and removes one it sits in", () => {
    expect(toggleWrap("ab", 1, 1, "*")).toEqual({ value: "a**b", start: 2, end: 2 });
    expect(toggleWrap("a**b", 2, 2, "*")).toEqual({ value: "ab", start: 1, end: 1 });
  });
});

describe("shiftListIndent", () => {
  it("indents and outdents list lines only", () => {
    expect(shiftListIndent("- a", 3, 1)).toEqual({ value: "  - a", start: 5, end: 5 });
    expect(shiftListIndent("  - a", 5, -1)).toEqual({ value: "- a", start: 3, end: 3 });
    expect(shiftListIndent("plain", 3, 1)).toBeNull();
    expect(shiftListIndent("- a", 3, -1)).toBeNull();
  });
});

describe("toggleBulletLine", () => {
  it("adds a bullet to a plain line and strips any list form back", () => {
    expect(toggleBulletLine("note", 4)).toEqual({ value: "- note", start: 6, end: 6 });
    expect(toggleBulletLine("- note", 6)).toEqual({ value: "note", start: 4, end: 4 });
    expect(toggleBulletLine("3. note", 7)).toEqual({ value: "note", start: 4, end: 4 });
    expect(toggleBulletLine("- [x] note", 10)).toEqual({ value: "note", start: 4, end: 4 });
  });

  it("works on the caret's line inside multi-line drafts", () => {
    expect(toggleBulletLine("a\nb", 3)).toEqual({ value: "a\n- b", start: 5, end: 5 });
  });
});
