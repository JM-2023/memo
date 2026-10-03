// Search-hit highlighting for rendered memo cards. The keyword tier matches
// lowercased raw content (search.ts); this module finds the same needles in
// the card's rendered text and paints them through the CSS Custom Highlight
// API, which styles Ranges without touching the DOM — markdown, tag pills,
// links and FeedItem memoization stay exactly as they are.

import type { ParsedQuery } from "./search";

/** The registry key the stylesheet's ::highlight(search-hit) rule reads. */
export const SEARCH_HIT_HIGHLIGHT = "search-hit";

/** Every needle the query requires, longest first, duplicates dropped. */
export function searchNeedles(query: ParsedQuery): string[] {
  return [...new Set([...query.phrases, ...query.terms])].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * [start, end) offsets of each needle inside `text`, compared the way the
 * search compares: case-insensitive via toLowerCase. Lowercasing may change a
 * string's length (İ → i̇), so the folded text keeps a map back to source
 * offsets instead of assuming the two line up.
 */
export function findHitOffsets(text: string, needles: readonly string[]): Array<[number, number]> {
  if (needles.length === 0 || text.length === 0) return [];
  let folded = text.toLowerCase();
  // The common case folds unit for unit; only a length change needs the map.
  let source: number[] | null = null;
  if (folded.length !== text.length) {
    folded = "";
    source = [];
    for (let index = 0; index < text.length; ) {
      const width = (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      const lower = text.slice(index, index + width).toLowerCase();
      for (let k = 0; k < lower.length; k += 1) source.push(index);
      folded += lower;
      index += width;
    }
    source.push(text.length);
  }
  const hits: Array<[number, number]> = [];
  for (const needle of needles) {
    let from = 0;
    for (let at = folded.indexOf(needle, from); at >= 0; at = folded.indexOf(needle, from)) {
      const end = at + needle.length;
      if (!source) hits.push([at, end]);
      else {
        // A match ending inside one char's expansion covers that whole char.
        let stop = end;
        while (stop < source.length - 1 && source[stop] === source[stop - 1]) stop += 1;
        hits.push([source[at], source[stop]]);
      }
      from = end;
    }
  }
  return hits;
}

// Rendered text the reader never sees as prose: typeset formulas (KaTeX keeps
// its TeX source in a hidden annotation) and the task box's control.
const SKIP_SELECTOR = ".md-math, .md-task-box";

/**
 * Ranges covering every needle inside one card's .memo-content. Each visual
 * line (and each table cell) is matched on its own, the way raw content
 * separates them with newlines and pipes, so a hit never spans two lines.
 */
export function hitRangesIn(content: Element, needles: readonly string[]): Range[] {
  const ranges: Range[] = [];
  const doc = content.ownerDocument;
  const segments: Element[] = [];
  for (const line of Array.from(content.children)) {
    const cells = line.querySelectorAll(":scope > .md-td");
    if (cells.length > 0) segments.push(...Array.from(cells));
    else segments.push(line);
  }
  for (const segment of segments) {
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = "";
    const walker = doc.createTreeWalker(segment, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = (node as Text).data;
      if (!value) continue;
      nodes.push(node as Text);
      starts.push(text.length);
      text += value;
    }
    if (nodes.length === 0) continue;
    for (const [start, end] of findHitOffsets(text, needles)) {
      const range = doc.createRange();
      const [startNode, startOffset] = locate(nodes, starts, start, false);
      const [endNode, endOffset] = locate(nodes, starts, end, true);
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Text node + offset for a segment offset. An end offset sitting on a node
    boundary stays in the earlier node, so the range doesn't open a later one. */
function locate(nodes: Text[], starts: number[], offset: number, isEnd: boolean): [Text, number] {
  let index = nodes.length - 1;
  for (let i = 0; i < nodes.length; i += 1) {
    const nodeEnd = starts[i] + nodes[i].data.length;
    if (isEnd ? offset <= nodeEnd : offset < nodeEnd) {
      index = i;
      break;
    }
  }
  return [nodes[index], Math.min(nodes[index].data.length, offset - starts[index])];
}

interface HighlightRegistryLike {
  set: (name: string, value: unknown) => unknown;
  delete: (name: string) => unknown;
}

/** The page's highlight registry and constructor, when the browser has them. */
export function highlightApi(): { registry: HighlightRegistryLike; create: (ranges: Range[]) => unknown } | null {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights;
  const Ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || typeof Ctor !== "function") return null;
  return { registry, create: (ranges) => new Ctor(...ranges) };
}
