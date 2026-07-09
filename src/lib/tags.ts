import { MD_IMAGE_PATTERN, stripLinks, URL_PATTERN } from "./content";
import type { Memo } from "./types";

// flomo-style tags: #标签 or hierarchical #领域/子类. A tag runs until
// whitespace/#/punctuation; interior "/" nests levels. URLs are blanked
// first so a fragment like https://x.com/a#section never becomes a tag.
const TAG_PATTERN = /#([\p{L}\p{N}_\-/·]+)/gu;

/** A well-formed tag path: charset segments joined by single slashes. */
export function isValidTagPath(path: string): boolean {
  return /^[\p{L}\p{N}_\-·]+(\/[\p{L}\p{N}_\-·]+)*$/u.test(path);
}

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  for (const match of stripLinks(content).matchAll(TAG_PATTERN)) {
    // Trim separators that only make sense mid-path.
    const tag = match[1].replace(/^[/·]+|[/·]+$/g, "");
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/**
 * Rewrite every `#from` (and descendant `#from/…`) tag token in `content` to
 * `to`; `to === null` removes the token instead (eating one adjacent space so
 * "a #tag b" tidies to "a b"). URL spans are protected — a fragment like
 * https://x.com/a#section is never touched. Shared by the server-side
 * rename/remove endpoints, so client and server agree on tag boundaries.
 */
export function renameTagInContent(content: string, from: string, to: string | null): string {
  const shielded: [number, number][] = [];
  for (const match of content.matchAll(MD_IMAGE_PATTERN)) {
    shielded.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  for (const match of content.matchAll(URL_PATTERN)) {
    shielded.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  const isShielded = (index: number) => shielded.some(([start, end]) => index >= start && index < end);

  let result = "";
  let last = 0;
  for (const match of content.matchAll(TAG_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (isShielded(start)) continue;
    const inner = match[1];
    // Mirror extractTags' trimming: separators only make sense mid-path.
    const lead = inner.match(/^[/·]+/)?.[0] ?? "";
    const tail = inner.match(/[/·]+$/)?.[0] ?? "";
    const path = inner.slice(lead.length, inner.length - tail.length);
    if (!path || !tagMatches(path, from)) continue;

    if (to === null) {
      let cutStart = start;
      let cutEnd = end;
      if (content[cutEnd] === " ") cutEnd += 1;
      else if (content[cutStart - 1] === " ") cutStart -= 1;
      result += content.slice(last, cutStart);
      last = cutEnd;
    } else {
      result += `${content.slice(last, start)}#${lead}${to}${path.slice(from.length)}${tail}`;
      last = end;
    }
  }
  result += content.slice(last);
  return result;
}

export interface TagNode {
  name: string;
  path: string;
  count: number;
  children: TagNode[];
}

/** True when a memo tagged `tag` belongs under filter `path` (self or descendant). */
export function tagMatches(tag: string, path: string): boolean {
  return tag === path || tag.startsWith(`${path}/`);
}

export function buildTagTree(memos: Memo[], pinnedAtOf?: Map<string, string>, locale = "en-US"): { tree: TagNode[]; uniqueTagCount: number } {
  const unique = new Set<string>();
  const roots: TagNode[] = [];
  const byPath = new Map<string, TagNode>();

  const ensureNode = (path: string, name: string, parent: TagNode | null): TagNode => {
    let node = byPath.get(path);
    if (!node) {
      node = { name, path, count: 0, children: [] };
      byPath.set(path, node);
      (parent ? parent.children : roots).push(node);
    }
    return node;
  };

  for (const memo of memos) {
    const tags = extractTags(memo.content);
    for (const tag of tags) unique.add(tag);
    // Count each memo once per node it touches (self or ancestor).
    const touched = new Set<string>();
    for (const tag of tags) {
      const parts = tag.split("/");
      let path = "";
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        touched.add(path);
      }
    }
    for (const path of touched) {
      const parts = path.split("/");
      let parent: TagNode | null = null;
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        parent = ensureNode(current, part, parent);
      }
      if (parent) parent.count += 1;
    }
  }

  // Pinned nodes rise above their siblings (newest pin first) at every level.
  const sortNodes = (nodes: TagNode[]) => {
    nodes.sort((a, b) => {
      const pinA = pinnedAtOf?.get(a.path) ?? "";
      const pinB = pinnedAtOf?.get(b.path) ?? "";
      if (Boolean(pinA) !== Boolean(pinB)) return pinA ? -1 : 1;
      if (pinA && pinB && pinA !== pinB) return pinB.localeCompare(pinA);
      return a.name.localeCompare(b.name, locale);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);

  return { tree: roots, uniqueTagCount: unique.size };
}
