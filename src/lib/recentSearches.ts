// The search box's last few searches, offered when it opens empty. Kept the
// way saved filters are (lib/savedFilters.ts): plain localStorage under the
// app's prefix — search words are notebook-derived, so an ordinary logout
// clears them with the rest of the workspace furniture (logoutCleanup.ts),
// and App forgets its in-memory copy at the same time.

export const RECENT_SEARCHES_KEY = "memo:recent-searches";
export const RECENT_SEARCHES_LIMIT = 6;
/** Longer than any search worth repeating; keeps a pasted page out of storage. */
const MAX_LENGTH = 200;

function normalized(query: string): string | null {
  const text = query.trim().replace(/\s+/g, " ");
  return text && text.length <= MAX_LENGTH ? text : null;
}

/** Parse a stored list (newest first), dropping anything malformed. Pure, for tests. */
export function parseRecentSearches(json: string | null): string[] {
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const items: string[] = [];
  for (const entry of data) {
    if (items.length >= RECENT_SEARCHES_LIMIT) break;
    const text = typeof entry === "string" ? normalized(entry) : null;
    if (!text) continue;
    const key = text.toLowerCase();
    if (!items.some((item) => item.toLowerCase() === key)) items.push(text);
  }
  return items;
}

/** `query` at the front of `items`, once: case and spacing don't make a second entry. */
export function rememberSearch(items: readonly string[], query: string): string[] {
  const text = normalized(query);
  if (!text) return [...items];
  const key = text.toLowerCase();
  return [text, ...items.filter((item) => item.toLowerCase() !== key)].slice(0, RECENT_SEARCHES_LIMIT);
}

export function loadRecentSearches(): string[] {
  try {
    return parseRecentSearches(localStorage.getItem(RECENT_SEARCHES_KEY));
  } catch {
    return [];
  }
}

export function persistRecentSearches(items: readonly string[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(RECENT_SEARCHES_KEY);
    else localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(items));
  } catch {
    // A convenience, never critical.
  }
}
