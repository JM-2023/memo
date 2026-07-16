// Line-level diffing for the memo edit replay animation. Operates on the
// card's *visual* lines (image-only lines collapse out of the text flow), so
// diff ops map 1:1 onto rendered <p> rows in .memo-content.

import { tokenizeLine } from "./content";
import { splitTaskLine } from "./markdown";

export interface VisualLine {
  raw: string;
  /** Index in the original content.split("\n") — the render key. */
  key: number;
}

/** Mirror of the card renderer: does this raw line produce a rendered row? */
export function lineRenders(line: string): boolean {
  if (!line) return true; // empty line → blank spacer row
  const tokens = tokenizeLine(line);
  const visible = tokens.filter((token) => token.kind !== "image");
  if (visible.every((token) => token.kind === "text" && token.text.trim() === "")) {
    // Whitespace-only remainder: renders as a blank row unless the line was
    // image-only, in which case it collapses entirely.
    return tokens.length === visible.length;
  }
  return true;
}

/** The lines that actually render, in order, with their original indices. */
export function visualLinesOf(content: string): VisualLine[] {
  const lines: VisualLine[] = [];
  content.split("\n").forEach((raw, key) => {
    if (lineRenders(raw)) lines.push({ raw, key });
  });
  return lines;
}

/**
 * True when an edit script only flips task checkbox marks: every change is a
 * del/add pair over the same line text with a different [ ]/[x] mark. Flips
 * never reorder lines, so pairing dels with adds in order is exact. The card
 * stage uses this to let checkbox toggles land silently — the box's own CSS
 * transition is the animation — instead of replaying a line morph.
 */
export function isTaskMarkFlipOnly(ops: readonly DiffOp[]): boolean {
  const dels: string[] = [];
  const adds: string[] = [];
  for (const op of ops) {
    if (op.type === "del") dels.push(op.raw);
    else if (op.type === "add") adds.push(op.raw);
  }
  if (dels.length === 0 || dels.length !== adds.length) return false;
  return dels.every((raw, index) => {
    const oldParts = splitTaskLine(raw);
    const newParts = splitTaskLine(adds[index]);
    return oldParts !== null && newParts !== null && oldParts.head === newParts.head && oldParts.tail === newParts.tail;
  });
}

export type DiffOp =
  | { type: "keep"; raw: string; oldIndex: number; newIndex: number }
  | { type: "del"; raw: string; oldIndex: number }
  | { type: "add"; raw: string; newIndex: number };

/** Beyond this DP area the middle section is treated as replace-all. */
const LCS_AREA_LIMIT = 250_000;

/**
 * Ordered edit script between two line lists (classic LCS). Common prefix
 * and suffix are peeled first, so the quadratic part only sees the edited
 * middle; a pathological middle degrades to delete-all + add-all rather
 * than an O(n·m) blowup.
 */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: "keep", raw: oldLines[i], oldIndex: i, newIndex: i });

  const midOld = oldEnd - start;
  const midNew = newEnd - start;
  if (midOld > 0 && midNew > 0 && midOld * midNew <= LCS_AREA_LIMIT) {
    // LCS length table over the middle window.
    const width = midNew + 1;
    const table = new Uint32Array((midOld + 1) * width);
    for (let i = midOld - 1; i >= 0; i -= 1) {
      for (let j = midNew - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          oldLines[start + i] === newLines[start + j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midOld && j < midNew) {
      if (oldLines[start + i] === newLines[start + j]) {
        ops.push({ type: "keep", raw: oldLines[start + i], oldIndex: start + i, newIndex: start + j });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push({ type: "del", raw: oldLines[start + i], oldIndex: start + i });
        i += 1;
      } else {
        ops.push({ type: "add", raw: newLines[start + j], newIndex: start + j });
        j += 1;
      }
    }
    while (i < midOld) {
      ops.push({ type: "del", raw: oldLines[start + i], oldIndex: start + i });
      i += 1;
    }
    while (j < midNew) {
      ops.push({ type: "add", raw: newLines[start + j], newIndex: start + j });
      j += 1;
    }
  } else {
    for (let i = start; i < oldEnd; i += 1) ops.push({ type: "del", raw: oldLines[i], oldIndex: i });
    for (let j = start; j < newEnd; j += 1) ops.push({ type: "add", raw: newLines[j], newIndex: j });
  }

  for (let k = 0; k < oldLines.length - oldEnd; k += 1) {
    ops.push({ type: "keep", raw: oldLines[oldEnd + k], oldIndex: oldEnd + k, newIndex: newEnd + k });
  }
  return ops;
}
