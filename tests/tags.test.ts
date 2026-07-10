import { describe, expect, it } from "vitest";
import { isValidTagPath, renameTagInContent, tagMatches, tagRenamePathsOverlap } from "../src/lib/tags";

describe("tag path protocol", () => {
  it.each(["work", "工作", "work_2026", "parent/child", "领域/项目·甲", "a-b/子_项"])("accepts %s", (path) => {
    expect(isValidTagPath(path)).toBe(true);
  });

  it.each(["", "/root", "root/", "root//child", "two words", "#hash", "dot.name", "question?"])("rejects %s", (path) => {
    expect(isValidTagPath(path)).toBe(false);
  });

  it("accepts an ASCII path at the UTF-8 byte boundary", () => {
    expect(isValidTagPath("a".repeat(128))).toBe(true);
  });

  it("rejects an ASCII path beyond the UTF-8 byte boundary", () => {
    expect(isValidTagPath("a".repeat(129))).toBe(false);
  });

  it("counts multibyte tag paths by UTF-8 bytes", () => {
    expect(isValidTagPath("中".repeat(42))).toBe(true); // 126 bytes
    expect(isValidTagPath("中".repeat(43))).toBe(false); // 129 bytes
  });

  it("matches a path and its descendants without matching sibling prefixes", () => {
    expect(tagMatches("work", "work")).toBe(true);
    expect(tagMatches("work/project", "work")).toBe(true);
    expect(tagMatches("workshop", "work")).toBe(false);
  });

  it("rejects rename targets inside either side of the same subtree", () => {
    expect(tagRenamePathsOverlap("a", "a/b")).toBe(true);
    expect(tagRenamePathsOverlap("a/b", "a")).toBe(true);
    expect(tagRenamePathsOverlap("a/b", "a/c")).toBe(false);
    expect(tagRenamePathsOverlap("a", "ab")).toBe(false);
  });
});

describe("tag content rewriting", () => {
  it("renames exact and descendant tags while leaving sibling prefixes alone", () => {
    expect(renameTagInContent("#work #work/project #workshop", "work", "life")).toBe("#life #life/project #workshop");
  });

  it("does not rewrite URL fragments or Markdown image URLs", () => {
    const content = "https://example.com/#work ![](https://cdn.example.com/a#work) #work";
    expect(renameTagInContent(content, "work", "life")).toBe(
      "https://example.com/#work ![](https://cdn.example.com/a#work) #life"
    );
  });

  it("removes a tag and one adjacent space", () => {
    expect(renameTagInContent("before #work after", "work", null)).toBe("before after");
  });
});
