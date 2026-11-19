/** Return selected ids that still belong to the feed rendered to the user. */
export function selectionWithinVisibleIds(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const id of visibleIds) {
    if (selected.has(id)) result.add(id);
  }
  return result;
}

/**
 * The cards a range pick covers — a Shift-click, or a long press in select
 * mode, its touch twin — from the anchor (the last card picked or unpicked)
 * to the target, both included, ordered outward from the anchor so the
 * ripple starts where the reader's eye already is. Null when there is no
 * range to take: no anchor, the anchor itself, or either end gone from the
 * feed; the pick is then a plain toggle.
 */
export function selectionRange(ids: readonly string[], anchor: string | null, target: string): string[] | null {
  if (anchor === null || anchor === target) return null;
  const from = ids.indexOf(anchor);
  const to = from === -1 ? -1 : ids.indexOf(target);
  if (from === -1 || to === -1) return null;
  return from < to ? ids.slice(from, to + 1) : ids.slice(to, from + 1).reverse();
}

/**
 * Every card in the range takes the state the target is toggled to: picking
 * an unpicked card picks the whole range, unpicking a picked one unpicks it.
 */
export function withSelectionRange(current: ReadonlySet<string>, range: readonly string[], target: string): { next: Set<string>; on: boolean } {
  const on = !current.has(target);
  const next = new Set(current);
  for (const id of range) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return { next, on };
}

const LABEL_LEAD_MAX = 40;

/**
 * What tells one memo's select control from the next for a screen reader:
 * the memo's first line of text, markdown marks dropped and cut to a short
 * phrase. Empty for a memo with no text (images only); the caller falls
 * back to the time alone.
 */
export function memoLabelLead(content: string, max = LABEL_LEAD_MAX): string {
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    // Fences, rules and table rules carry no words.
    if (/^(```|~~~)/.test(trimmed) || /^[\s|:*_-]+$/.test(trimmed)) continue;
    const line = trimmed
      // Block marks: heading, quote, list bullet or number, task box.
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(>\s?)+/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      // Inline marks: images go, links keep their words, emphasis and code ticks drop.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`|]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    const chars = Array.from(line);
    return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : line;
  }
  return "";
}
