// Per-line markdown for memo cards. The whole grammar is deliberately
// line-stateless: cards render, diff and replay their content as independent
// visual lines (lineDiff.ts), so every construct here derives from one raw
// line alone — block syntax from the line's prefix, inline syntax within the
// remainder. No cross-line constructs (fenced code blocks, setext headings,
// real <ul>/<ol> grouping): those would need context the replay's per-line
// clones cannot carry. Tables fit the rule because every "|" row is its own
// equal-column grid — no shared <table> box, so a lone row renders the same
// as a row among siblings. Block parsing changes HOW a line renders, never
// WHETHER it renders — the collapse decision stays with tokenizeLine /
// lineRenders.

import { isImageUrl, splitTrailingPunct } from "./content";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; depth: number; text: string }
  | { kind: "ordered"; depth: number; ordinal: string; text: string }
  | { kind: "task"; depth: number; checked: boolean; text: string }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  /** One "| a | b |" table row. Each row is rendered as its own equal-column
   *  grid, so rows align across the card without any shared table box. */
  | { kind: "trow"; cells: string[] }
  /** The "| --- | --- |" delimiter row — rendered as the header rule. */
  | { kind: "trule"; cols: number };

const HR_PATTERN = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
// "# Heading" needs the space — "#tag" (no space) stays a tag.
const HEADING_PATTERN = /^(#{1,6})\s+(\S.*)$/;
const TASK_PATTERN = /^(\s*)[-*+]\s+\[([ xX])\](?:\s+(.*))?$/;
// TASK_PATTERN's splitting twin: same grammar, but capturing the text around
// the mark so the checkbox can be flipped in place. Tests hold the two to
// agreement — a line the card renders as a task must always be splittable.
const TASK_SPLIT_PATTERN = /^(\s*[-*+]\s+\[)([ xX])(\](?:\s+.*)?)$/;
const BULLET_PATTERN = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_PATTERN = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
// Bare ">" or "> text" — a space is required so ">_<" style openers stay prose.
const QUOTE_PATTERN = /^>(?:\s+(.*))?$/;

/** Two spaces (or one tab) per nesting level, capped so deep pastes stay sane. */
function depthOf(indent: string): number {
  return Math.min(Math.floor(indent.replace(/\t/g, "  ").length / 2), 3);
}

// A delimiter cell: dashes with optional GFM alignment colons. Alignment
// itself is not honored — data rows cannot see the delimiter statelessly.
const TRULE_CELL = /^:?-+:?$/;

/**
 * Split "| a | b |" into trimmed cell texts, or null when the line is not a
 * table row. A row must start with "|" and contain at least one more
 * *unescaped* "|"; "\|" is a literal pipe inside a cell. The trailing "|"
 * is optional — "| a | b" still yields two cells.
 */
export function parseTableCells(raw: string): string[] | null {
  const line = raw.trim();
  if (line[0] !== "|") return null;
  const cells: string[] = [];
  let cell = "";
  let closed = false;
  for (let i = 1; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
      closed = true;
    } else {
      cell += ch;
    }
  }
  if (!closed) return null;
  if (cell.trim() !== "") cells.push(cell.trim());
  return cells;
}

/** True when every cell is a "---" / ":--:" delimiter — the header rule row. */
export function isTableRule(cells: string[]): boolean {
  return cells.every((cell) => TRULE_CELL.test(cell));
}

export interface TaskLineParts {
  /** Everything before the mark, "- [" included. */
  head: string;
  checked: boolean;
  /** Everything from the closing "]" on. */
  tail: string;
}

/** Split a task line around its checkbox mark; null off task lines. */
export function splitTaskLine(raw: string): TaskLineParts | null {
  const match = TASK_SPLIT_PATTERN.exec(raw);
  return match ? { head: match[1], checked: match[2] !== " ", tail: match[3] } : null;
}

export function parseBlock(raw: string): Block {
  if (raw.includes("|")) {
    const cells = parseTableCells(raw);
    if (cells) return isTableRule(cells) ? { kind: "trule", cols: cells.length } : { kind: "trow", cells };
  }
  if (HR_PATTERN.test(raw)) return { kind: "hr" };
  const heading = HEADING_PATTERN.exec(raw);
  if (heading) return { kind: "heading", level: Math.min(heading[1].length, 3) as 1 | 2 | 3, text: heading[2] };
  const task = TASK_PATTERN.exec(raw);
  if (task) return { kind: "task", depth: depthOf(task[1]), checked: task[2] !== " ", text: task[3] ?? "" };
  const bullet = BULLET_PATTERN.exec(raw);
  if (bullet) return { kind: "bullet", depth: depthOf(bullet[1]), text: bullet[2] };
  const ordered = ORDERED_PATTERN.exec(raw);
  if (ordered) return { kind: "ordered", depth: depthOf(ordered[1]), ordinal: ordered[2], text: ordered[3] };
  const quote = QUOTE_PATTERN.exec(raw);
  if (quote) return { kind: "quote", text: quote[1] ?? "" };
  return { kind: "p", text: raw };
}

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; kids: Inline[] }
  | { t: "em"; kids: Inline[] }
  | { t: "del"; kids: Inline[] }
  | { t: "mark"; kids: Inline[] }
  | { t: "link"; url: string; kids: Inline[] }
  | { t: "url"; url: string }
  | { t: "tag"; raw: string; path: string }
  /** Leaves the text flow — the card hoists it into the media grid. */
  | { t: "image"; url: string };

// Sticky probes anchored at the scan position (lastIndex is set per use).
const IMAGE_AT = /!\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)/uy;
const LINK_AT = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/uy;
const URL_AT = /https?:\/\/[^\s]+/uy;
const TAG_AT = /#[\p{L}\p{N}_\-/·]+/uy;

const WORD_CHAR = /[\p{L}\p{N}]/u;

interface Delim {
  m: string;
  t: "strong" | "em" | "del" | "mark";
  /** Underscore emphasis only opens/closes at word boundaries (snake_case). */
  word?: boolean;
}

// Longest markers first — "**" must win over "*" at the same position.
const DELIMS: Delim[] = [
  { m: "**", t: "strong" },
  { m: "__", t: "strong", word: true },
  { m: "~~", t: "del" },
  { m: "==", t: "mark" },
  { m: "*", t: "em" },
  { m: "_", t: "em", word: true }
];

/** First usable closer at/after openerEnd: non-empty inner, non-space before. */
function findCloser(text: string, openerEnd: number, marker: string, word: boolean): number {
  let at = text.indexOf(marker, openerEnd);
  while (at !== -1) {
    if (at > openerEnd) {
      const before = text[at - 1];
      const after = text[at + marker.length];
      const beforeOk = before !== undefined && !/\s/.test(before);
      const afterOk = !word || after === undefined || !WORD_CHAR.test(after);
      if (beforeOk && afterOk) return at;
    }
    at = text.indexOf(marker, at + 1);
  }
  return -1;
}

/**
 * One line's inline markup as a tree. `plain` mode (inside link labels)
 * keeps emphasis and code but demotes links/URLs/tags/images to literal
 * text — nested interactive elements would be invalid markup.
 */
export function parseInline(text: string, depth = 0, plain = false): Inline[] {
  if (depth > 4) return text ? [{ t: "text", text }] : [];
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push({ t: "text", text: buffer });
      buffer = "";
    }
  };

  let i = 0;
  scan: while (i < text.length) {
    const ch = text[i];

    // Code span — protects everything inside, including markers and #tags.
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        out.push({ t: "code", text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === "!" && text[i + 1] === "[") {
      IMAGE_AT.lastIndex = i;
      const match = IMAGE_AT.exec(text);
      if (match) {
        flush();
        if (plain) buffer += match[0];
        else out.push({ t: "image", url: match[1] });
        i += match[0].length;
        continue;
      }
    }

    if (ch === "[" && !plain) {
      LINK_AT.lastIndex = i;
      const match = LINK_AT.exec(text);
      if (match) {
        flush();
        out.push({ t: "link", url: match[2], kids: parseInline(match[1], depth + 1, true) });
        i += match[0].length;
        continue;
      }
    }

    if (ch === "h" && (text.startsWith("https://", i) || text.startsWith("http://", i))) {
      URL_AT.lastIndex = i;
      const match = URL_AT.exec(text)!;
      const { url, trailing } = splitTrailingPunct(match[0]);
      flush();
      if (plain) buffer += url;
      else if (isImageUrl(url)) out.push({ t: "image", url });
      else out.push({ t: "url", url });
      buffer += trailing;
      i += match[0].length;
      continue;
    }

    if (ch === "#") {
      TAG_AT.lastIndex = i;
      const match = TAG_AT.exec(text);
      if (match) {
        const path = match[0].slice(1).replace(/^[/·]+|[/·]+$/g, "");
        if (path) {
          flush();
          if (plain) buffer += match[0];
          else out.push({ t: "tag", raw: match[0], path });
          i += match[0].length;
          continue;
        }
      }
    }

    // ***both*** — strong wrapping em, matched before the generic pairs.
    if (text.startsWith("***", i)) {
      const after = text[i + 3];
      if (after !== undefined && !/\s/.test(after)) {
        const close = findCloser(text, i + 3, "***", false);
        if (close !== -1) {
          flush();
          out.push({ t: "strong", kids: [{ t: "em", kids: parseInline(text.slice(i + 3, close), depth + 1, plain) }] });
          i = close + 3;
          continue;
        }
      }
    }

    for (const delim of DELIMS) {
      if (!text.startsWith(delim.m, i)) continue;
      const after = text[i + delim.m.length];
      const openerOk =
        after !== undefined && !/\s/.test(after) && (!delim.word || i === 0 || !WORD_CHAR.test(text[i - 1]));
      if (openerOk) {
        const close = findCloser(text, i + delim.m.length, delim.m, delim.word ?? false);
        if (close !== -1) {
          flush();
          out.push({ t: delim.t, kids: parseInline(text.slice(i + delim.m.length, close), depth + 1, plain) });
          i = close + delim.m.length;
          continue scan;
        }
      }
      // Marker with no usable closer: emit the whole run literally so its
      // inner characters aren't re-probed ("**" must not retry as "*").
      buffer += delim.m;
      i += delim.m.length;
      continue scan;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}
