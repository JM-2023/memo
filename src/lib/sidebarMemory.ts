// The sidebar's layout state across reloads: which period the heatmap shows
// and which tag subtrees are unfolded. Plain localStorage under the memo:
// prefix — the open paths are tag names, so like saved filters they are
// workspace furniture that an ordinary logout clears (logoutCleanup.ts).
// Every access is best-effort: a blocked or full storage just forgets.

import type { PeriodKind } from "./stats";

export const PERIOD_KEY = "memo:heatmap-period";
export const OPEN_TAGS_KEY = "memo:tag-tree-open";
/** Enough for any tree a person unfolds by hand; a corrupt entry can't grow without bound. */
export const OPEN_TAGS_LIMIT = 200;

const PERIODS: readonly PeriodKind[] = ["week", "month", "year"];

export function loadPeriod(): PeriodKind {
  try {
    const stored = localStorage.getItem(PERIOD_KEY);
    return PERIODS.includes(stored as PeriodKind) ? (stored as PeriodKind) : "week";
  } catch {
    return "week";
  }
}

export function persistPeriod(period: PeriodKind): void {
  try {
    // Week is the default: nothing to remember.
    if (period === "week") localStorage.removeItem(PERIOD_KEY);
    else localStorage.setItem(PERIOD_KEY, period);
  } catch {
    // Layout memory is a convenience.
  }
}

/** Parse a stored list of open tag paths, dropping anything malformed. Pure, for tests. */
export function parseOpenTagPaths(json: string | null): string[] {
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const paths: string[] = [];
  for (const entry of data) {
    if (paths.length >= OPEN_TAGS_LIMIT) break;
    if (typeof entry === "string" && entry && !paths.includes(entry)) paths.push(entry);
  }
  return paths;
}

export function loadOpenTagPaths(): string[] {
  try {
    return parseOpenTagPaths(localStorage.getItem(OPEN_TAGS_KEY));
  } catch {
    return [];
  }
}

export function persistOpenTagPaths(paths: Iterable<string>): void {
  try {
    const list = [...paths].slice(0, OPEN_TAGS_LIMIT);
    if (list.length === 0) localStorage.removeItem(OPEN_TAGS_KEY);
    else localStorage.setItem(OPEN_TAGS_KEY, JSON.stringify(list));
  } catch {
    // Layout memory is a convenience.
  }
}
