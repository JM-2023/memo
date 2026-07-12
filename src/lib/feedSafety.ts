/** Apply a feed predicate while keeping the open editor mounted. */
export function filterPreservingId<T extends { id: string }>(items: readonly T[], preservedId: string | null, predicate: (item: T) => boolean): T[] {
  return items.filter((item) => item.id === preservedId || predicate(item));
}
