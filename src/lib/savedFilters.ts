// Saved filter presets — named snapshots of the whole feed context (search
// text, tag, heatmap day, structured filters). They live in localStorage
// beside the sort key: presets are workspace furniture, not notebook data,
// so they stay out of the encrypted sync pipeline. Ordinary logout clears
// them together with every other MEMO-owned local record.

import type { FeedFilters } from "./search";
import { tagMatches } from "./tags";

export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  tag: string | null;
  day: string | null;
  filters: FeedFilters;
}

export const SAVED_FILTERS_LIMIT = 20;

const STORAGE_KEY = "memo-saved-filters";
const DAY_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function dayOrNull(value: unknown): string | null {
  return typeof value === "string" && DAY_KEY_PATTERN.test(value) ? value : null;
}

/** Parse a stored payload, dropping anything malformed. Pure, for tests. */
export function parseSavedFilters(json: string | null): SavedFilter[] {
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const items: SavedFilter[] = [];
  for (const entry of data) {
    if (items.length >= SAVED_FILTERS_LIMIT) break;
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    if (typeof raw.name !== "string" || !raw.name.trim()) continue;
    const filters = (typeof raw.filters === "object" && raw.filters !== null ? raw.filters : {}) as Record<string, unknown>;
    items.push({
      id: raw.id,
      name: raw.name,
      query: typeof raw.query === "string" ? raw.query : "",
      tag: typeof raw.tag === "string" && raw.tag ? raw.tag : null,
      day: dayOrNull(raw.day),
      filters: {
        noTags: filters.noTags === true,
        hasImage: filters.hasImage === true,
        hasLink: filters.hasLink === true,
        hasOpenTask: filters.hasOpenTask === true,
        dateFrom: dayOrNull(filters.dateFrom),
        dateTo: dayOrNull(filters.dateTo)
      }
    });
  }
  return items;
}

export function loadSavedFilters(): SavedFilter[] {
  try {
    return parseSavedFilters(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function persistSavedFilters(items: readonly SavedFilter[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage full or blocked — presets are a convenience, never critical.
  }
}

/** Keep saved tag lenses attached to the same subtree after a rename. */
export function renameSavedFilterTags(items: readonly SavedFilter[], from: string, to: string): SavedFilter[] {
  return items.map((item) => (item.tag && tagMatches(item.tag, from) ? { ...item, tag: to + item.tag.slice(from.length) } : item));
}

/**
 * A removed tag cannot be represented as a useful saved lens. Drop presets
 * aimed at that subtree so applying one later cannot silently widen to all
 * memos when App clears its now-missing active tag.
 */
export function removeSavedFiltersForTag(items: readonly SavedFilter[], path: string): SavedFilter[] {
  return items.filter((item) => !item.tag || !tagMatches(item.tag, path));
}
