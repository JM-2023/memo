// The one definition of a storable memo body, shared by the composer, the
// create / edit / bulk-tag / tag-rewrite endpoints and the backup import. A
// rule that differs between any two of them lets the app write a memo that
// another path refuses — a backup the app itself cannot restore.

/** Longest memo text, in UTF-16 units (String#length). */
export const MAX_CONTENT_CHARS = 40_000;

export type MemoBodyIssue = "MEMO_EMPTY" | "MEMO_CONTENT_TOO_LONG";

/** Why a memo with this text and this many images cannot be stored, or null. */
export function memoBodyIssue(content: string, imageCount: number): MemoBodyIssue | null {
  if (content.length > MAX_CONTENT_CHARS) return "MEMO_CONTENT_TOO_LONG";
  if (!content.trim() && imageCount === 0) return "MEMO_EMPTY";
  return null;
}

/**
 * What a rewrite of a memo's text (a global tag rename or removal) would
 * break. It may never leave a memo with no text and no image, and never
 * grow one past the limit. A memo already past it — stored before the limit
 * existed — may still shrink toward it, as long as it does not grow.
 */
export function rewriteIssue(before: string, after: string, imageCount: number): MemoBodyIssue | null {
  if (after === before) return null;
  if (!after.trim() && imageCount === 0) return "MEMO_EMPTY";
  if (after.length > MAX_CONTENT_CHARS && after.length > before.length) return "MEMO_CONTENT_TOO_LONG";
  return null;
}
