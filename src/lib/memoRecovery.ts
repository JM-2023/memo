import type { Memo } from "./types";

/** True when a conflict response already contains the exact submitted draft. */
export function memoMatchesSubmittedDraft(memo: Memo, content: string, imageIds: readonly string[]): boolean {
  if (memo.deletedAt !== null || memo.content !== content) return false;
  const submitted = new Set(imageIds);
  if (memo.images.length !== submitted.size) return false;
  return memo.images.every((image) => submitted.has(image.id));
}
