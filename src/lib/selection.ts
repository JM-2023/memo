/** Return selected ids that still belong to the feed rendered to the user. */
export function selectionWithinVisibleIds(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const id of visibleIds) {
    if (selected.has(id)) result.add(id);
  }
  return result;
}
