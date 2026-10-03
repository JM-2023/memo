import { inlineCodeSpanEnd, MD_IMAGE_PATTERN, URL_PATTERN } from "./content";
import { mathAt, parseBlock } from "./markdown";
import { crossLineBlock } from "./markdownDocument";
import type { Memo } from "./types";

// Tags can be flat (#标签) or hierarchical (#领域/子类). A tag runs until
// whitespace/#/punctuation; interior "/" nests levels. URLs are blanked
// first so a fragment like https://x.com/a#section never becomes a tag.
const TAG_PATTERN = /#([\p{L}\p{N}_\-/·]+)/gu;

type TextRange = [start: number, end: number];

/**
 * Spans whose `#...` text is literal rather than a memo tag — everything the
 * card renders as code or TeX. Fenced code and display TeX blocks are found
 * with the renderer's own grouping (an unclosed fence runs to the end, as on
 * the card); inline code spans and inline TeX stay line-local, so an
 * unmatched backtick never shields another line.
 */
function protectedTagRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of content.matchAll(MD_IMAGE_PATTERN)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  for (const match of content.matchAll(URL_PATTERN)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  const lines = content.split("\n");
  const starts: number[] = [];
  for (let key = 0, offset = 0; key < lines.length; offset += lines[key].length + 1, key += 1) starts.push(offset);
  for (let key = 0; key < lines.length; key += 1) {
    const lineStart = starts[key];
    const line = lines[key];
    const block = crossLineBlock(lines, key);
    if (block) {
      const last = Math.min(block.end, lines.length - 1);
      ranges.push([lineStart, starts[last] + lines[last].length]);
      key = last;
      continue;
    }
    const trimmed = line.trim();
    if ((trimmed.startsWith("$$") || trimmed.startsWith("\\[")) && parseBlock(line).kind === "math") {
      ranges.push([lineStart, lineStart + line.length]);
      continue;
    }
    for (let cursor = 0; cursor < line.length; ) {
      const char = line[cursor];
      if (char !== "`" && char !== "$" && char !== "\\") {
        cursor += 1;
        continue;
      }
      const codeEnd = inlineCodeSpanEnd(line, cursor);
      const end = codeEnd !== -1 ? codeEnd : cursor + (mathAt(line, cursor)?.raw.length ?? 0);
      if (end === cursor) {
        cursor += 1;
        continue;
      }
      ranges.push([lineStart + cursor, lineStart + end]);
      cursor = end;
    }
  }

  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return ranges;
}

function rangeContains(ranges: TextRange[], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** A well-formed tag path: charset segments joined by single slashes. */
export function isValidTagPath(path: string): boolean {
  return new TextEncoder().encode(path).byteLength <= 128 && /^[\p{L}\p{N}_\-·]+(\/[\p{L}\p{N}_\-·]+)*$/u.test(path);
}

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const protectedRanges = protectedTagRanges(content);
  for (const match of content.matchAll(TAG_PATTERN)) {
    if (rangeContains(protectedRanges, match.index ?? 0)) continue;
    // Trim separators that only make sense mid-path.
    const tag = match[1].replace(/^[/·]+|[/·]+$/g, "");
    if (tag) tags.add(tag);
  }
  return [...tags];
}

// Memo objects are immutable snapshots — every edit or sync delivers a fresh
// object — so a WeakMap keyed on the object is a leak-free extraction cache.
// This keeps filtering/tree-building O(memos) instead of O(memos × content)
// on every keystroke or feed change.
const memoTagsCache = new WeakMap<Memo, string[]>();

export function tagsOf(memo: Memo): string[] {
  let tags = memoTagsCache.get(memo);
  if (!tags) {
    tags = extractTags(memo.content);
    memoTagsCache.set(memo, tags);
  }
  return tags;
}

/**
 * Append one exact tag on its own final line without disturbing the user's
 * existing whitespace. Replaying the operation is idempotent.
 */
export function appendTagToContent(content: string, path: string): string {
  if (extractTags(content).includes(path)) return content;
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  // A fence left open runs to the end of the memo, so a tag line appended
  // inside it would render as code. Close it first; the card looks the same.
  const closer = openFenceAtEnd(content);
  return `${content}${separator}${closer ? `${closer}\n` : ""}#${path}`;
}

/** The marker that would close a code fence still open at the end, or null. */
function openFenceAtEnd(content: string): string | null {
  const lines = content.split("\n");
  for (let key = 0; key < lines.length; key += 1) {
    const block = crossLineBlock(lines, key);
    if (!block) continue;
    if (block.kind === "codeblock" && block.end >= lines.length) return /^ {0,3}(`{3,}|~{3,})/.exec(lines[key])?.[1] ?? null;
    key = block.end;
  }
  return null;
}

/**
 * Keep a memo created inside a hierarchical tag view inside that view. A
 * descendant already satisfies its parent context (`#work/project` remains in
 * the `#work` feed), so avoid adding a redundant parent token.
 */
export function inheritTagContext(content: string, path: string): string {
  if (extractTags(content).some((tag) => tagMatches(tag, path))) return content;
  return appendTagToContent(content, path);
}

/**
 * Rewrite every `#from` (and descendant `#from/…`) tag token in `content` to
 * `to`; `to === null` removes the token instead (eating one adjacent space so
 * "a #tag b" tidies to "a b"). URL spans are protected — a fragment like
 * https://x.com/a#section is never touched. Code (fenced blocks and inline
 * spans) and TeX are protected with the same rules as the renderer, so a
 * `#include` in pasted code is never rewritten. Shared by the server-side rename/remove
 * endpoints, so client and server agree on tag boundaries.
 */
export function renameTagInContent(content: string, from: string, to: string | null): string {
  const protectedRanges = protectedTagRanges(content);

  let result = "";
  let last = 0;
  for (const match of content.matchAll(TAG_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (rangeContains(protectedRanges, start)) continue;
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

/** Overlapping subtrees cannot be replayed idempotently after an interruption. */
export function tagRenamePathsOverlap(from: string, to: string): boolean {
  return to.startsWith(`${from}/`) || from.startsWith(`${to}/`);
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
    const tags = tagsOf(memo);
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
