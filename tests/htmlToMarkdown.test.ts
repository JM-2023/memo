// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/lib/htmlToMarkdown";

describe("htmlToMarkdown", () => {
  it("keeps links, emphasis, strike, highlight and inline code", () => {
    expect(
      htmlToMarkdown('<p>Read <a href="https://example.com/a(b)">the <b>docs</b></a>, <em>now</em> <s>later</s> <mark>key</mark> <code>npm i</code></p>')
    ).toBe("Read [the **docs**](https://example.com/a%28b%29), *now* ~~later~~ ==key== `npm i`");
  });

  it("turns headings, nested lists, tasks and quotes into their line syntax", () => {
    const html = `
      <h1>Plan</h1>
      <ul><li>one<ul><li>nested</li></ul></li><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>
      <ol start="3"><li>third</li><li>fourth</li></ol>
      <blockquote><p>quoted</p><p>twice</p></blockquote>`;
    expect(htmlToMarkdown(html)).toBe(
      ["# Plan", "- one", "  - nested", "- [x] done", "- [ ] todo", "3. third", "4. fourth", "> quoted", "> twice"].join("\n")
    );
  });

  it("converts data tables and fenced code, keeping code whitespace", () => {
    const html = "<table><tr><th>a</th><th>b|c</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code>if (x) {\n  y();\n}</code></pre>";
    expect(htmlToMarkdown(html)).toBe("| a | b\\|c |\n| --- | --- |\n| 1 | 2 |\n```\nif (x) {\n  y();\n}\n```");
  });

  it("reads Google Docs style spans and ignores its font-weight:normal wrapper", () => {
    const html =
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-size:11pt;font-weight:700;white-space:pre;white-space:pre-wrap;">Bold</span><span style="font-size:11pt;font-weight:400;white-space:pre;white-space:pre-wrap;"> and </span><span style="font-style:italic;white-space:pre;white-space:pre-wrap;">slanted</span> <a href="https://x.com/"><span style="white-space:pre;white-space:pre-wrap;">link</span></a></p><ul><li aria-level="1"><p>top</p></li><li aria-level="2"><p>child</p></li></ul></b>';
    expect(htmlToMarkdown(html)).toBe("**Bold** and *slanted* [link](https://x.com/)\n- top\n  - child");
  });

  it("keeps #tags from MEMO's own card markup", () => {
    expect(htmlToMarkdown('<p>Read <a href="https://x.com/">Docs</a> <button class="memo-tag">#work</button> today</p>')).toBe(
      "Read [Docs](https://x.com/) #work today"
    );
  });

  it("fences code that itself contains a backtick fence", () => {
    expect(htmlToMarkdown("<pre>a\n```\nb</pre>")).toBe("````\na\n```\nb\n````");
  });

  it("drops unsafe link targets and scripts, never rendering the HTML", () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">x</a> <strong>y</strong><script>alert(2)</script><img src="https://e.com/i.png" onerror="alert(3)"></p>')).toBe(
      "x **y**"
    );
  });

  it("returns null when plain-text paste should run untouched", () => {
    expect(htmlToMarkdown("")).toBeNull();
    // Paragraphs and line breaks only: nothing the plain text lacks.
    expect(htmlToMarkdown("<p>one</p><p>two<br>three</p>")).toBeNull();
    // A code editor's styled copy: its indentation lives in the plain text.
    expect(htmlToMarkdown('<div style="white-space: pre;"><div><span style="font-weight: bold;">const</span> a = 1;</div></div>')).toBeNull();
  });
});
