// Markdown editing aids for the plain-<textarea> composer: pure
// string → { value, caret } transforms, so every behavior is unit-testable.
// The prefix grammar mirrors parseBlock in lib/markdown.

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
 * item clears the prefix instead — the natural way out of a list. Returns
 * null when the default newline should happen.
 */
export function continueListOnEnter(value: string, caret: number): EditPatch | null {
  const { start, end } = lineRangeAt(value, caret);
  const line = value.slice(start, end);

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
