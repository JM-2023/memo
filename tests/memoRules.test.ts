import { describe, expect, it } from "vitest";
import { MAX_CONTENT_CHARS, memoBodyIssue, rewriteIssue } from "../src/lib/memoRules";
import { refusalOf, tagRewriteBlockers } from "../src/lib/tagRewriteBlockers";
import type { Memo } from "../src/lib/types";

function memo(id: string, content: string, images = 0, createdAt = "2026-01-01T00:00:00.000Z"): Memo {
  return {
    id,
    content,
    createdAt,
    updatedAt: createdAt,
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: Array.from({ length: images }, (_, index) => ({ id: `${id}-img-${index}`, mime: "image/webp", width: 1, height: 1, bytes: 1 }))
  };
}

describe("memo body rules", () => {
  it("refuses blank text without an image and text past the limit", () => {
    expect(memoBodyIssue("  \n ", 0)).toBe("MEMO_EMPTY");
    expect(memoBodyIssue("", 1)).toBeNull();
    expect(memoBodyIssue("x".repeat(MAX_CONTENT_CHARS), 0)).toBeNull();
    expect(memoBodyIssue("x".repeat(MAX_CONTENT_CHARS + 1), 3)).toBe("MEMO_CONTENT_TOO_LONG");
  });

  it("blames a rewrite only for what it breaks", () => {
    expect(rewriteIssue("#todo", "", 0)).toBe("MEMO_EMPTY");
    expect(rewriteIssue("#todo", "", 1)).toBeNull();
    expect(rewriteIssue("same", "same", 0)).toBeNull();
    // Already past the limit before: shortening it further is not refused.
    expect(rewriteIssue("x".repeat(MAX_CONTENT_CHARS + 10), "x".repeat(MAX_CONTENT_CHARS + 5), 0)).toBeNull();
    expect(rewriteIssue("x".repeat(MAX_CONTENT_CHARS - 1), "x".repeat(MAX_CONTENT_CHARS + 1), 0)).toBe("MEMO_CONTENT_TOO_LONG");
  });

  it("never lets a rewrite grow an over-long memo or empty it", () => {
    // A 47,999-character memo stored before the limit existed.
    const legacy = `${" ".repeat(47_994)}#tag`;
    expect(rewriteIssue(legacy, " ".repeat(47_994), 0)).toBe("MEMO_EMPTY");
    expect(rewriteIssue(legacy, `${" ".repeat(47_994)}#tag-much-longer`, 0)).toBe("MEMO_CONTENT_TOO_LONG");
    expect(rewriteIssue(`${"x".repeat(47_994)}#tag`, "x".repeat(47_994), 0)).toBeNull();
  });
});

describe("tag rewrite blockers", () => {
  it("finds text-only memos a removal empties, oldest first, and leaves the rest", () => {
    const later = memo("later", "#todo", 0, "2026-02-01T00:00:00.000Z");
    const earlier = memo("earlier", " #todo/now ", 0, "2026-01-01T00:00:00.000Z");
    const blockers = tagRewriteBlockers(
      [later, earlier, memo("photo", "#todo", 1), memo("words", "milk #todo"), memo("other", "#todos")],
      "todo",
      null
    );
    expect(blockers.empty.map((item) => item.id)).toEqual(["earlier", "later"]);
    expect(blockers.tooLong).toEqual([]);
  });

  it("finds memos a longer name pushes past the limit", () => {
    const near = memo("near", `${"x".repeat(MAX_CONTENT_CHARS - 6)} #work`);
    expect(tagRewriteBlockers([near], "work", "job").tooLong).toEqual([]);
    expect(tagRewriteBlockers([near], "work", "workshops").tooLong.map((item) => item.id)).toEqual(["near"]);
  });

  it("reads a server refusal defensively", () => {
    expect(refusalOf({ empty: 2, tooLong: 0, ids: "a,b" })).toEqual({ empty: 2, tooLong: 0, ids: ["a", "b"], done: 0 });
    expect(refusalOf({ empty: "2", ids: "", done: -1 })).toEqual({ empty: 0, tooLong: 0, ids: [], done: 0 });
    expect(refusalOf({ tooLong: 1, done: 5 })).toEqual({ empty: 0, tooLong: 1, ids: [], done: 5 });
    expect(refusalOf(undefined)).toEqual({ empty: 0, tooLong: 0, ids: [], done: 0 });
  });
});
