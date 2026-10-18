/**
 * Which long memos the reader has unfolded, by memo id — feed-wide, so a
 * card that remounts (a lens change, a search, a trip to Trash and back, the
 * render window rewinding) comes back as the reader left it. A card that
 * came back folded made the feed's saved reading place wrong: the offset
 * was measured inside the open body, and restoring it landed pages away.
 *
 * Memory only, like an open edit: nothing here reaches storage, the URL or
 * history. A purged memo's id is dropped with it, and logout forgets all.
 */
const unfolded = new Set<string>();

export function isUnfolded(id: string): boolean {
  return unfolded.has(id);
}

export function rememberFold(id: string, expanded: boolean): void {
  if (expanded) unfolded.add(id);
  else unfolded.delete(id);
}

/** Drop memos that no longer exist (purged here or elsewhere). */
export function forgetFolds(ids: Iterable<string>): void {
  for (const id of ids) unfolded.delete(id);
}

/** Logout: the next session starts with every memo folded. */
export function forgetAllFolds(): void {
  unfolded.clear();
}
