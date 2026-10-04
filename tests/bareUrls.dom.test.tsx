// @vitest-environment jsdom

// Bare URLs in memo prose: where one ends (CJK text, punctuation and
// full-width forms close it, in every pattern that finds links — card, tags,
// word counts, search), how it reads on the card (decoded, without the
// scheme, middle-ellipsized when long) while its href stays exact, and how a
// long numbered list keeps one marker column.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoLine } from "../src/components/memoLines";
import { displayUrl, stripLinks, tokenizeLine, URL_PATTERN } from "../src/lib/content";
import { LanguageProvider } from "../src/lib/i18n";
import { parseInline } from "../src/lib/markdown";
import { extractTags, renameTagInContent } from "../src/lib/tags";

afterEach(cleanup);

const MIXED = "参考https://a.com/x，然后再看#读书";

describe("where a bare URL ends", () => {
  it("stops at CJK punctuation, so the text after it is text and its tag is a tag", () => {
    expect(tokenizeLine(MIXED)).toEqual([
      { kind: "text", text: "参考" },
      { kind: "link", url: "https://a.com/x" },
      { kind: "text", text: "，然后再看" },
      { kind: "tag", raw: "#读书", path: "读书" }
    ]);
    expect(parseInline(MIXED)).toEqual([
      { t: "text", text: "参考" },
      { t: "url", url: "https://a.com/x" },
      { t: "text", text: "，然后再看" },
      { t: "tag", raw: "#读书", path: "读书" }
    ]);
    expect(extractTags(MIXED)).toEqual(["读书"]);
    expect(renameTagInContent(MIXED, "读书", "阅读")).toBe("参考https://a.com/x，然后再看#阅读");
  });

  it("stops at Han, kana and Hangul directly after the address", () => {
    expect([..."见https://a.com/x中文 https://b.com/yひらがな https://c.com/z한글".matchAll(URL_PATTERN)].map((match) => match[0])).toEqual([
      "https://a.com/x",
      "https://b.com/y",
      "https://c.com/z"
    ]);
  });

  it("leaves a full-width closing paren outside the link", () => {
    expect(parseInline("（见https://a.com/x）")).toEqual([
      { t: "text", text: "（见" },
      { t: "url", url: "https://a.com/x" },
      { t: "text", text: "）" }
    ]);
  });

  it("still ends an ASCII URL at a space, with sentence punctuation trimmed", () => {
    expect(parseInline("see https://a.com/x, then #read")).toEqual([
      { t: "text", text: "see " },
      { t: "url", url: "https://a.com/x" },
      { t: "text", text: ", then " },
      { t: "tag", raw: "#read", path: "read" }
    ]);
    expect(extractTags("see https://a.com/x#frag and #read")).toEqual(["read"]);
  });

  it("counts the CJK prose after a link as words", () => {
    expect(stripLinks(MIXED)).toBe("参考 ，然后再看#读书");
  });

  it("leaves a scheme with nothing addressable after it as text instead of throwing", () => {
    expect(parseInline("see https:// later")).toEqual([{ t: "text", text: "see https:// later" }]);
    expect(parseInline("https://中文")).toEqual([{ t: "text", text: "https://中文" }]);
  });
});

describe("how a bare URL reads", () => {
  it("decodes, drops the scheme, a leading www. and a trailing slash", () => {
    expect(displayUrl("https://www.example.com/")).toBe("example.com");
    expect(displayUrl("http://example.com/a/b")).toBe("example.com/a/b");
    expect(displayUrl("https://zh.wikipedia.org/wiki/%E7%AC%94%E8%AE%B0")).toBe("zh.wikipedia.org/wiki/笔记");
  });

  it("keeps escapes that would hide or reorder the address, and malformed ones", () => {
    expect(displayUrl("https://a.com/%E2%80%AEevil")).toBe("a.com/%E2%80%AEevil");
    expect(displayUrl("https://a.com/a%20b")).toBe("a.com/a%20b");
    expect(displayUrl("https://a.com/%E7%AC")).toBe("a.com/%E7%AC");
  });

  it("gives way in the middle past 48 characters, keeping the host and the end", () => {
    const text = displayUrl("https://github.com/JM-2023/memo/blob/main/src/components/MemoCard.tsx");
    expect(Array.from(text)).toHaveLength(48);
    expect(text).toBe("github.com/JM-2023/memo/blob/…nents/MemoCard.tsx");
  });

  it("renders the readable text with the exact href", () => {
    const url = "https://zh.wikipedia.org/wiki/%E7%AC%94%E8%AE%B0%E6%9C%AC%E7%94%B5%E8%84%91%E7%9A%84%E5%8E%86%E5%8F%B2%E4%B8%8E%E5%8F%91%E5%B1%95%E6%A6%82%E8%BF%B0%E5%92%8C%E5%BD%B1%E5%93%8D%E5%88%86%E6%9E%90";
    render(
      <LanguageProvider>
        <MemoLine raw={`读到 ${url}，`} tagMode="button" />
      </LanguageProvider>
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    // CJK counts double toward the 48: the decoded title still gives way.
    expect(link.textContent).toBe("zh.wikipedia.org/wiki/笔记本…发展概述和影响分析");
    // Shortened, it names itself in full on hover.
    expect(link.getAttribute("title")).toBe(url);
    expect(link.parentElement?.textContent?.endsWith("，")).toBe(true);
  });
});

describe("numbered list markers", () => {
  it("marks the rows whose number runs past one digit, so it hangs left", () => {
    const { container } = render(
      <LanguageProvider>
        <MemoLine raw="9. nine" tagMode="button" />
        <MemoLine raw="10. ten" tagMode="button" />
        <MemoLine raw="100. hundred" tagMode="ghost" />
      </LanguageProvider>
    );
    const rows = [...container.querySelectorAll(".md-ordered")];
    expect(rows.map((row) => row.getAttribute("data-wide"))).toEqual([null, "2", "3"]);
  });
});
