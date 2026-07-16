/** Apply a feed predicate while keeping the open editor mounted. */
export function filterPreservingId<T extends { id: string }>(items: readonly T[], preservedId: string | null, predicate: (item: T) => boolean): T[] {
  return items.filter((item) => item.id === preservedId || predicate(item));
}

export interface FeedWindow<Key = string> {
  key: Key;
  cap: number;
}

/** Resolve the cap during render so a new filter never renders the old, expanded window. */
export function feedWindowCap<Key>(window: FeedWindow<Key>, key: Key, pageSize: number): number {
  return window.key === key ? window.cap : pageSize;
}

/** Advance the currently rendered filter generation, starting stale generations at one page. */
export function advanceFeedWindow<Key>(window: FeedWindow<Key>, key: Key, pageSize: number): FeedWindow<Key> {
  return { key, cap: feedWindowCap(window, key, pageSize) + pageSize };
}
