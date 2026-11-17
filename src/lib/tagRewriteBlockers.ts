// A global tag rename or removal rewrites every memo carrying the tag. One
// that would leave a memo empty (a text-only memo that is nothing but the
// tag) or push it past the length limit is refused — the server checks the
// whole notebook before its first write; this is the same check run over the
// memos this device holds, so the reader hears which memos are in the way
// before anything is sent.

import { rewriteIssue } from "./memoRules";
import { renameTagInContent } from "./tags";
import type { Memo } from "./types";

export interface TagRewriteBlockers {
  /** Memos the rewrite would leave with no text and no image. */
  empty: Memo[];
  /** Memos the rewrite would push past MAX_CONTENT_CHARS. */
  tooLong: Memo[];
}

/** The memos (Trash included) a rewrite of `from` to `to` (null: removal) would make unstorable, oldest first. */
export function tagRewriteBlockers(memos: Iterable<Memo>, from: string, to: string | null): TagRewriteBlockers {
  const blockers: TagRewriteBlockers = { empty: [], tooLong: [] };
  for (const memo of memos) {
    const issue = rewriteIssue(memo.content, renameTagInContent(memo.content, from, to), memo.images.length);
    if (issue === "MEMO_EMPTY") blockers.empty.push(memo);
    else if (issue === "MEMO_CONTENT_TOO_LONG") blockers.tooLong.push(memo);
  }
  const oldestFirst = (left: Memo, right: Memo) => left.createdAt.localeCompare(right.createdAt);
  blockers.empty.sort(oldestFirst);
  blockers.tooLong.sort(oldestFirst);
  return blockers;
}

/**
 * A server refusal (TAG_REWRITE_BLOCKED, or TAG_INVALID part-way): its counts,
 * the ids it names (which may be a prefix of all of them), and `done`, the
 * memos already rewritten — non-zero only for a job an older release began.
 */
export function refusalOf(params: Record<string, unknown> | undefined): { empty: number; tooLong: number; ids: string[]; done: number } {
  const countOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
  const ids = typeof params?.ids === "string" && params.ids ? params.ids.split(",").filter(Boolean) : [];
  return { empty: countOf(params?.empty), tooLong: countOf(params?.tooLong), ids, done: countOf(params?.done) };
}
