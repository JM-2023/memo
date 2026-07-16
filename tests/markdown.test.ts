import { describe, expect, it } from "vitest";
import { parseBlock, parseInline, splitTaskLine, type Inline } from "../src/lib/markdown";

/** Compact one-line print of an inline tree for readable assertions. */
function print(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
          return node.text;
        case "code":
          return `code(${node.text})`;
        case "strong":
        case "em":
        case "del":
        case "mark":
          return `${node.t}(${print(node.kids)})`;
        case "link":
          return `link[${print(node.kids)}](${node.url})`;
        case "url":
          return `url(${node.url})`;
        case "tag":
          return `tag(${node.path})`;
        case "image":
          return `img(${node.url})`;
      }
    })
    .join("");
}

describe("parseBlock", () => {
  it("parses headings only when # has a following space", () => {
    expect(parseBlock("# Title")).toEqual({ kind: "heading", level: 1, text: "Title" });
    expect(parseBlock("## Sub")).toEqual({ kind: "heading", level: 2, text: "Sub" });
    expect(parseBlock("### Deep")).toEqual({ kind: "heading", level: 3, text: "Deep" });
    expect(parseBlock("##### Deeper")).toEqual({ kind: "heading", level: 3, text: "Deeper" });
    // No space → a #tag line, not a heading.
    expect(parseBlock("#tag and text")).toEqual({ kind: "p", text: "#tag and text" });
    expect(parseBlock("#标签")).toEqual({ kind: "p", text: "#标签" });
  });

  it("parses bullet, ordered and task items with indent depth", () => {
    expect(parseBlock("- item")).toEqual({ kind: "bullet", depth: 0, text: "item" });
    expect(parseBlock("* item")).toEqual({ kind: "bullet", depth: 0, text: "item" });
    expect(parseBlock("    - nested")).toEqual({ kind: "bullet", depth: 2, text: "nested" });
    expect(parseBlock("3. third")).toEqual({ kind: "ordered", depth: 0, ordinal: "3", text: "third" });
    expect(parseBlock("2) alt")).toEqual({ kind: "ordered", depth: 0, ordinal: "2", text: "alt" });
    expect(parseBlock("- [ ] todo")).toEqual({ kind: "task", depth: 0, checked: false, text: "todo" });
    expect(parseBlock("- [x] done")).toEqual({ kind: "task", depth: 0, checked: true, text: "done" });
    expect(parseBlock("- [ ]")).toEqual({ kind: "task", depth: 0, checked: false, text: "" });
    // Depth caps at 3 so a deep paste cannot push content off the card.
    expect(parseBlock("            - deep")).toEqual({ kind: "bullet", depth: 3, text: "deep" });
  });

  it("requires the marker space — dashes and numbers in prose stay prose", () => {
    expect(parseBlock("-not a list")).toEqual({ kind: "p", text: "-not a list" });
    expect(parseBlock("1.5 是一个数字")).toEqual({ kind: "p", text: "1.5 是一个数字" });
  });

  it("parses quotes and horizontal rules", () => {
    expect(parseBlock("> quoted")).toEqual({ kind: "quote", text: "quoted" });
    expect(parseBlock(">")).toEqual({ kind: "quote", text: "" });
    expect(parseBlock(">_< emoticon")).toEqual({ kind: "p", text: ">_< emoticon" });
    expect(parseBlock("---")).toEqual({ kind: "hr" });
    expect(parseBlock("*****")).toEqual({ kind: "hr" });
    expect(parseBlock("--")).toEqual({ kind: "p", text: "--" });
  });

  it("parses pipe rows into table cells", () => {
    expect(parseBlock("| a | b |")).toEqual({ kind: "trow", cells: ["a", "b"] });
    expect(parseBlock("| 名称 | 数量 | 备注 |")).toEqual({ kind: "trow", cells: ["名称", "数量", "备注"] });
    // The trailing pipe is optional; empty cells survive.
    expect(parseBlock("| a | b")).toEqual({ kind: "trow", cells: ["a", "b"] });
    expect(parseBlock("| a |  | c |")).toEqual({ kind: "trow", cells: ["a", "", "c"] });
    // "\|" is a literal pipe inside a cell.
    expect(parseBlock("| a \\| b | c |")).toEqual({ kind: "trow", cells: ["a | b", "c"] });
  });

  it("recognizes the table delimiter row, alignment colons included", () => {
    expect(parseBlock("| --- | --- |")).toEqual({ kind: "trule", cols: 2 });
    expect(parseBlock("|:---|---:|:-:|")).toEqual({ kind: "trule", cols: 3 });
    expect(parseBlock("|---|")).toEqual({ kind: "trule", cols: 1 });
  });

  it("leaves non-row pipes as prose", () => {
    expect(parseBlock("| alone")).toEqual({ kind: "p", text: "| alone" });
    expect(parseBlock("a | b")).toEqual({ kind: "p", text: "a | b" });
    expect(parseBlock("x || y 表示逻辑或")).toEqual({ kind: "p", text: "x || y 表示逻辑或" });
  });
});

describe("splitTaskLine", () => {
  it("agrees with parseBlock on what a task line is", () => {
    const corpus = [
      "- [ ] todo",
      "- [x] done",
      "* [X] caps",
      "+ [ ]",
      "- [ ] ",
      "  - [x] nested",
      "-\t[ ] tabbed",
      "- [] not a task",
      "- [y] not a task",
      "-[ ] no marker space",
      "- [ ]x glued text",
      "1. [ ] ordered is a list, not a task",
      "plain",
      "# heading",
      ""
    ];
    for (const raw of corpus) {
      expect(splitTaskLine(raw) !== null, raw).toBe(parseBlock(raw).kind === "task");
    }
  });

  it("splits into head + one mark char + tail, with parseBlock's checked state", () => {
    for (const raw of ["- [ ] todo", "  * [X] caps", "+ [x]"]) {
      const parts = splitTaskLine(raw)!;
      const block = parseBlock(raw);
      if (block.kind === "task") expect(parts.checked).toBe(block.checked);
      else expect.fail(`${raw} should parse as a task`);
      expect(raw.startsWith(parts.head)).toBe(true);
      expect(raw.endsWith(parts.tail)).toBe(true);
      expect(parts.head.length + 1 + parts.tail.length).toBe(raw.length);
    }
  });
});

describe("parseInline", () => {
  it("parses emphasis pairs and nesting", () => {
    expect(print(parseInline("a **bold** b"))).toBe("a strong(bold) b");
    expect(print(parseInline("*em* and ~~del~~ and ==mark=="))).toBe("em(em) and del(del) and mark(mark)");
    expect(print(parseInline("**bold *inner* bold**"))).toBe("strong(bold em(inner) bold)");
    expect(print(parseInline("***both***"))).toBe("strong(em(both))");
    expect(print(parseInline("这是**重点**内容"))).toBe("这是strong(重点)内容");
  });

  it("leaves unpaired or space-flanked markers literal", () => {
    expect(print(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(print(parseInline("a == b"))).toBe("a == b");
    expect(print(parseInline("**dangling"))).toBe("**dangling");
    expect(print(parseInline("** spaced **"))).toBe("** spaced **");
  });

  it("keeps underscores inside words literal", () => {
    expect(print(parseInline("snake_case_name"))).toBe("snake_case_name");
    expect(print(parseInline("_lead_ rest"))).toBe("em(lead) rest");
  });

  it("protects code spans from every other rule", () => {
    expect(print(parseInline("run `npm **install**` now"))).toBe("run code(npm **install**) now");
    expect(print(parseInline("`#not-a-tag`"))).toBe("code(#not-a-tag)");
    expect(print(parseInline("un`closed"))).toBe("un`closed");
  });

  it("parses tags, bare urls and labelled links", () => {
    expect(print(parseInline("see #工作/项目 now"))).toBe("see tag(工作/项目) now");
    expect(print(parseInline("**#tag in bold**"))).toBe("strong(tag(tag) in bold)");
    expect(print(parseInline("go https://example.com/a."))).toBe("go url(https://example.com/a).");
    expect(print(parseInline("[文档](https://example.com/docs)"))).toBe("link[文档](https://example.com/docs)");
    expect(print(parseInline("[**bold** #x https://a.com](https://b.com)"))).toBe("link[strong(bold) #x https://a.com](https://b.com)");
  });

  it("hoists image syntax and image-extension urls out of the flow", () => {
    expect(print(parseInline("shot ![alt](https://x.com/a.png) end"))).toBe("shot img(https://x.com/a.png) end");
    expect(print(parseInline("https://x.com/photo.jpg"))).toBe("img(https://x.com/photo.jpg)");
  });
});
