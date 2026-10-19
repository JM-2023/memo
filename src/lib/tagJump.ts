// Tag matching for the search box's "jump to tag" rows: substring matches
// first (a segment start before a mid-word hit), then subsequence matches,
// with the matched characters so the row can mark them.

import type { TagNode } from "./tags";

export interface TagEntry {
  path: string;
  count: number;
}

export interface TagHit extends TagEntry {
  /** Indices into `path` that the query matched. */
  marks: number[];
}

/** Every tag in the tree, parents before children. */
export function flattenTags(tree: readonly TagNode[]): TagEntry[] {
  const out: TagEntry[] = [];
  const walk = (nodes: readonly TagNode[]) => {
    for (const node of nodes) {
      out.push({ path: node.path, count: node.count });
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * The word the tag rows answer: the query's last word, without a leading #.
 * Empty after a trailing space or inside a quoted phrase — those are words
 * for the search, not a tag being typed.
 */
export function tagNeedle(query: string): string {
  if (/\s$/.test(query)) return "";
  const word = /(\S+)$/.exec(query)?.[1] ?? "";
  if (word.startsWith('"') || word.startsWith("“")) return "";
  return word.replace(/^#+/, "").toLowerCase();
}

function subsequence(haystack: string, needle: string): number[] | null {
  const marks: number[] = [];
  let from = 0;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return null;
    marks.push(at);
    from = at + char.length;
  }
  return marks;
}

/** Tags matching the query's last word, best first, at most `limit`. */
export function matchTags(query: string, tags: readonly TagEntry[], limit = 6): TagHit[] {
  const needle = tagNeedle(query);
  if (!needle) return [];
  const exact: Array<TagHit & { rank: number }> = [];
  const loose: Array<TagHit & { rank: number }> = [];
  for (const tag of tags) {
    const lower = tag.path.toLowerCase();
    // A lowercase that changes the length can't map marks back; still a match.
    const mappable = lower.length === tag.path.length;
    const at = lower.indexOf(needle);
    if (at >= 0) {
      const segmentStart = at === 0 || lower[at - 1] === "/";
      const marks = mappable ? Array.from({ length: needle.length }, (_, index) => at + index) : [];
      exact.push({ ...tag, marks, rank: (segmentStart ? 0 : 1000) + at });
      continue;
    }
    const spread = subsequence(lower, needle);
    if (spread) loose.push({ ...tag, marks: mappable ? spread : [], rank: spread[spread.length - 1] - spread[0] });
  }
  const order = (a: TagHit & { rank: number }, b: TagHit & { rank: number }) =>
    a.rank - b.rank || a.path.length - b.path.length || b.count - a.count || a.path.localeCompare(b.path);
  return [...exact.sort(order), ...loose.sort(order)].slice(0, limit).map(({ rank: _rank, ...hit }) => hit);
}

/** The query with its last word replaced by `#path` (Tab in the search box). */
export function completeTag(query: string, path: string): string {
  const word = /(\S*)$/.exec(query)?.[1] ?? "";
  return `${query.slice(0, query.length - word.length)}#${path}`;
}
