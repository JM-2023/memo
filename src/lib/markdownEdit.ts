// Markdown editing aids for the plain-<textarea> composer: pure
// string → { value, caret } transforms, so every behavior is unit-testable.
// The prefix grammar mirrors parseBlock in lib/markdown; table rows reuse
// its cell splitter directly so the two grammars cannot drift.

import { isTableRule, parseTableCells } from "./markdown";

export interface EditPatch {
  value: string;
  start: number;
  end: number;
}

const TASK_PREFIX = /^(\s*)([-*+])\s+\[[ xX]\]\s+/;
const BULLET_PREFIX = /^(\s*)([-*+])\s+/;
const ORDERED_PREFIX = /^(\s*)(\d{1,3})([.)])\s+/;
const QUOTE_PREFIX = /^>\s/;

export function lineRangeAt(value: string, index: number): { start: number; end: number } {
  const start = value.lastIndexOf("\n", index - 1) + 1;
  const found = value.indexOf("\n", index);
  return { start, end: found === -1 ? value.length : found };
}

/**
 * Enter on a list/task/quote line: continue the prefix on the next line
 * (ordered items count up, tasks continue unchecked). Enter on an *empty*
 * item clears the prefix instead — the natural way out of a list. Table
 * rows get their own ladder: Enter at the end of a fresh first row inserts
 * the "| --- |" delimiter, at the end of any row inside a table inserts an
 * empty row, and on an all-empty row exits the table. Returns null when the
 * default newline should happen.
 */
export function continueListOnEnter(value: string, caret: number): EditPatch | null {
  const { start, end } = lineRangeAt(value, caret);
  const line = value.slice(start, end);

  const cells = parseTableCells(line);
  if (cells) {
    // Splitting a row mid-way would corrupt it — only the row's end reacts.
    if (caret !== end) return null;
    const isRule = isTableRule(cells);
    if (!isRule && cells.every((cell) => cell === "")) {
      // Empty row: exit the table by clearing the line.
      return { value: value.slice(0, start) + value.slice(end), start, end: start };
    }
    // On a delimiter, or below another table line, the next row is an empty
    // data row; on a fresh first row it is the delimiter that completes the
    // header (Enter again then starts the body).
    const prev = start > 0 ? lineRangeAt(value, start - 1) : null;
    const inTable = isRule || (prev !== null && parseTableCells(value.slice(prev.start, prev.end)) !== null);
    const inserted = inTable ? `\n|${"  |".repeat(cells.length)}` : `\n| ${Array(cells.length).fill("---").join(" | ")} |`;
    const position = inTable ? caret + 3 : caret + inserted.length;
    return { value: value.slice(0, end) + inserted + value.slice(end), start: position, end: position };
  }

  let prefix: string | null = null;
  let matchedLength = 0;
  const task = TASK_PREFIX.exec(line);
  const bullet = task ? null : BULLET_PREFIX.exec(line);
  const ordered = task || bullet ? null : ORDERED_PREFIX.exec(line);
  if (task) {
    prefix = `${task[1]}${task[2]} [ ] `;
    matchedLength = task[0].length;
  } else if (bullet) {
    prefix = `${bullet[1]}${bullet[2]} `;
    matchedLength = bullet[0].length;
  } else if (ordered) {
    prefix = `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} `;
    matchedLength = ordered[0].length;
  } else if (QUOTE_PREFIX.test(line)) {
    prefix = "> ";
    matchedLength = 2;
  } else {
    return null;
  }

  // Enter inside the prefix itself behaves natively.
  if (caret < start + matchedLength) return null;

  if (line.slice(matchedLength).trim() === "" && caret === end) {
    // Empty item: exit the list by clearing the line.
    return { value: value.slice(0, start) + value.slice(end), start, end: start };
  }

  const inserted = `\n${prefix}`;
  const position = caret + inserted.length;
  return { value: value.slice(0, caret) + inserted + value.slice(caret), start: position, end: position };
}

/**
 * Wrap/unwrap the selection with an inline marker (**, *, ~~, ==, `).
 * Edge whitespace is excluded first — "**text **" would not parse. A caret
 * with no selection gets an empty pair to type into (or removes one it is
 * already sitting in).
 */
export function toggleWrap(value: string, start: number, end: number, marker: string): EditPatch {
  const m = marker.length;
  let s = start;
  let e = end;
  while (s < e && /\s/.test(value[s])) s += 1;
  while (e > s && /\s/.test(value[e - 1])) e -= 1;

  if (s === e) {
    if (value.slice(s - m, s) === marker && value.slice(s, s + m) === marker) {
      return { value: value.slice(0, s - m) + value.slice(s + m), start: s - m, end: s - m };
    }
    return { value: value.slice(0, s) + marker + marker + value.slice(s), start: s + m, end: s + m };
  }

  const inner = value.slice(s, e);
  if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= 2 * m) {
    return { value: value.slice(0, s) + inner.slice(m, inner.length - m) + value.slice(e), start: s, end: e - 2 * m };
  }
  if (value.slice(s - m, s) === marker && value.slice(e, e + m) === marker) {
    return { value: value.slice(0, s - m) + inner + value.slice(e + m), start: s - m, end: e - m };
  }
  return { value: value.slice(0, s) + marker + inner + marker + value.slice(e), start: s + m, end: e + m };
}

/** Tab / Shift+Tab on a list line: two spaces of indent per level. */
export function shiftListIndent(value: string, caret: number, delta: 1 | -1): EditPatch | null {
  const { start, end } = lineRangeAt(value, caret);
  const line = value.slice(start, end);
  if (!TASK_PREFIX.test(line) && !BULLET_PREFIX.test(line) && !ORDERED_PREFIX.test(line)) return null;

  if (delta > 0) {
    return { value: value.slice(0, start) + "  " + value.slice(start), start: caret + 2, end: caret + 2 };
  }
  const removable = Math.min(2, /^\s*/.exec(line)![0].length);
  if (removable === 0) return null;
  const position = Math.max(start, caret - removable);
  return { value: value.slice(0, start) + value.slice(start + removable), start: position, end: position };
}

/** Toolbar list toggle: plain line → "- " bullet, any list form → plain. */
export function toggleBulletLine(value: string, caret: number): EditPatch {
  const { start, end } = lineRangeAt(value, caret);
  const line = value.slice(start, end);
  const match = TASK_PREFIX.exec(line) ?? BULLET_PREFIX.exec(line) ?? ORDERED_PREFIX.exec(line);
  if (match) {
    // Drop the marker, keep the indent.
    const keep = start + match[1].length;
    const removed = match[0].length - match[1].length;
    const position = caret <= keep ? Math.min(caret, keep) : Math.max(keep, caret - removed);
    return { value: value.slice(0, keep) + line.slice(match[0].length) + value.slice(end), start: position, end: position };
  }
  const at = start + /^\s*/.exec(line)![0].length;
  const position = caret >= at ? caret + 2 : caret;
  return { value: value.slice(0, at) + "- " + value.slice(at), start: position, end: position };
}

/**
 * Trimmed content range of each cell on a table-row line, in absolute value
 * coordinates. An empty cell collapses to a caret point just inside it.
 */
function cellRangesOf(value: string, start: number, end: number): Array<{ s: number; e: number }> | null {
  const line = value.slice(start, end);
  if (parseTableCells(line) === null) return null;
  const ranges: Array<{ s: number; e: number }> = [];
  const push = (from: number, to: number) => {
    let s = from;
    let e = to;
    while (s < e && /\s/.test(line[s])) s += 1;
    while (e > s && /\s/.test(line[e - 1])) e -= 1;
    if (s === e) s = e = Math.min(from + 1, to);
    ranges.push({ s: start + s, e: start + e });
  };
  let cellStart = line.indexOf("|") + 1;
  let i = cellStart;
  while (i < line.length) {
    if (line[i] === "\\" && line[i + 1] === "|") i += 2;
    else if (line[i] === "|") {
      push(cellStart, i);
      cellStart = i + 1;
      i += 1;
    } else i += 1;
  }
  if (line.slice(cellStart).trim() !== "") push(cellStart, line.length);
  return ranges;
}

/**
 * Tab / Shift+Tab inside a table row: select the next / previous cell's
 * content (spreadsheet-style, so typing replaces it), hopping to the
 * adjacent row's first / last cell at the line edges. Null off tables and
 * past the table's ends.
 */
export function tableTabStop(value: string, caret: number, dir: 1 | -1): EditPatch | null {
  const { start, end } = lineRangeAt(value, caret);
  const ranges = cellRangesOf(value, start, end);
  if (!ranges) return null;

  let at = ranges.findIndex((range) => caret <= range.e);
  if (at === -1) at = ranges.length; // past the last cell (after the closing "|")
  const target = at + dir;

  if (target >= ranges.length) {
    if (end >= value.length) return null;
    const next = lineRangeAt(value, end + 1);
    const nextRanges = cellRangesOf(value, next.start, next.end);
    if (!nextRanges) return null;
    return { value, start: nextRanges[0].s, end: nextRanges[0].e };
  }
  if (target < 0) {
    if (start === 0) return null;
    const prev = lineRangeAt(value, start - 1);
    const prevRanges = cellRangesOf(value, prev.start, prev.end);
    if (!prevRanges) return null;
    const last = prevRanges[prevRanges.length - 1];
    return { value, start: last.s, end: last.e };
  }
  const cell = ranges[target];
  return { value, start: cell.s, end: cell.e };
}

/**
 * Toolbar table insert: a two-column skeleton (header, delimiter, one empty
 * row) on its own lines, with the first header label selected so typing
 * replaces it. A non-empty caret line keeps its content — the table starts
 * on the next line.
 */
export function insertTableTemplate(value: string, caret: number, headerA: string, headerB: string): EditPatch {
  const { start, end } = lineRangeAt(value, caret);
  const table = `| ${headerA} | ${headerB} |\n| --- | --- |\n|  |  |`;
  if (value.slice(start, end).trim() === "") {
    return { value: value.slice(0, start) + table + value.slice(end), start: start + 2, end: start + 2 + headerA.length };
  }
  const position = end + 1 + 2;
  return { value: value.slice(0, end) + `\n${table}` + value.slice(end), start: position, end: position + headerA.length };
}
