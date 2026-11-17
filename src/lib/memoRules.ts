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
 * What a server-side rewrite (a global tag rename or removal) would break:
 * a memo storable before that the new text makes unstorable. A memo already
 * out of bounds before the rewrite is not the rewrite's doing.
 */
export function rewriteIssue(before: string, after: string, imageCount: number): MemoBodyIssue | null {
  if (after === before) return null;
  const issue = memoBodyIssue(after, imageCount);
  return issue && memoBodyIssue(before, imageCount) === null ? issue : null;
}
