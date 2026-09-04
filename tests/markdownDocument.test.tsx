import React from "react";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownRows } from "../src/lib/markdownDocument";
import { parseBlock, parseInline, type Inline } from "../src/lib/markdown";
import { visualLinesOf, diffLines } from "../src/lib/lineDiff";
import { externalImagesOf } from "../src/lib/content";
import { MemoLine } from "../src/components/memoLines";
import { MathFormula } from "../src/components/MathFormula";
vi.mock("../src/lib/i18n", () => ({ useI18n: () => ({ tr: (en: string) => en }) }));
function flatten(nodes: Inline[]): Inline[] {
  return nodes.flatMap(node => "kids" in node ? [node, ...flatten(node.kids)] : [node]);
}
const fixtures = [1, 2].map(i => readFileSync(new URL(`./fixtures/latent-reasoning-${i}.md`, import.meta.url), "utf8"));
function inspect(content: string) {
  const rows = visualLinesOf(content);
  const blocks = rows.map(row => parseBlock(row.raw));
  const formulas: string[] = [];
  const links: string[] = [];
  for (const block of blocks) {
    if (block.kind === "math") formulas.push(block.text);
    else if (block.kind !== "codeblock") {
      const texts = block.kind === "trow" ? block.cells : "text" in block ? [block.text] : [];
      for (const text of texts) for (const node of flatten(parseInline(text))) {
        if (node.t === "math") formulas.push(node.text);
        if (node.t === "link") links.push(node.url);
      }
    }
  }
  return { rows, blocks, formulas, links };
}

describe("pasted research Markdown", () => {
  it("renders both complete pastes with equivalent formulas, diagrams, tables and links", () => {
    const results = fixtures.map(inspect);
    expect(results[0].formulas).toEqual(results[1].formulas);
    expect(results[0].formulas.length).toBeGreaterThan(40);
    for (const result of results) {
      expect(result.blocks.filter(b => b.kind === "codeblock")).toHaveLength(5);
      expect(result.blocks.filter(b => b.kind === "trow")).toHaveLength(5);
      expect(result.blocks.filter(b => b.kind === "trule")).toHaveLength(1);
      expect(result.links).toHaveLength(9);
      const html = renderToStaticMarkup(<>{result.rows.map((row, i) => <MemoLine key={row.key} raw={row.raw} nextRaw={result.rows[i + 1]?.raw} tagMode="ghost" />)}</>);
      expect((html.match(/<math[ >]/g) ?? []).length).toBe(result.formulas.length);
      expect(html).toContain("┌─────────────┐");
      expect(html).not.toContain("[1]:");
      expect(html).not.toContain("[arXiv][1]");
    }
  });
  it("preserves code literally and keeps code images out of the gallery", () => {
    const source = '```text\n#tag **bold** $x$ [ref][1]\nhttps://x.test/a.png\n\n```\n[1]: https://x.test';
    const rows = visualLinesOf(source);
    expect(rows).toHaveLength(1);
    expect(parseBlock(rows[0].raw)).toEqual({ kind: "codeblock", text: '#tag **bold** $x$ [ref][1]\nhttps://x.test/a.png\n' });
    expect(externalImagesOf(source)).toEqual([]);
  });
  it("keeps source task indices and produces self-contained replay blocks", () => {
    const old = '$$\na_b\n$$\n- [ ] todo\n[ref][1]\n[1]: https://a.test';
    const next = old.replace('a_b', 'a_c').replace('https://a.test', 'https://b.test');
    expect(visualLinesOf(old).map(r => r.key)).toEqual([0, 3, 4]);
    const ops = diffLines(visualLinesOf(old).map(r => r.raw), visualLinesOf(next).map(r => r.raw));
    expect(ops.filter(op => op.type === "add").map(op => op.raw)).toEqual(['$$\na_c\n$$', '[ref](https://b.test)']);
  });
  it("protects inline code, escaped dollars, unclosed formulas and prose pipes", () => {
    expect(parseInline('`$x$`')).toEqual([{ t: "code", text: "$x$" }]);
    expect(parseInline(String.raw`\$5 and $10`)).toEqual([{ t: "text", text: "$5 and $10" }]);
    expect(parseInline('$unclosed')).toEqual([{ t: "text", text: "$unclosed" }]);
    expect(markdownRows('a | b')[0].raw).toBe('a | b');
    expect(parseBlock(markdownRows('\\[\nx^2\n\\]')[0].raw)).toEqual({ kind: "math", text: 'x^2' });
  });
  it("leaves unsafe reference URLs literal and falls back for invalid TeX", () => {
    expect(markdownRows('[x][a]\n[a]: javascript:alert(1)')[0].raw).toBe('[x][a]');
    expect(renderToStaticMarkup(<MathFormula text={String.raw`\badcommand{<img src=x onerror=alert(1)>}`} />)).not.toContain('<img');
    expect(renderToStaticMarkup(<MathFormula text={String.raw`\href{javascript:alert(1)}{x}`} />)).not.toContain('href="javascript:');
  });
});
