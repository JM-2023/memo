import { setTaskMark } from "./markdownEdit";
import type { Memo } from "./types";

export interface TaskFlip {
  lineKey: number;
  checked: boolean;
}

export interface TaskFlipQueue {
  running: boolean;
  flips: TaskFlip[];
  /**
   * Freshest server snapshot observed by this queue. Keeping it outside
   * React state lets a follow-up batch use the response that just arrived,
   * even before that response has committed a render.
   */
  base: Memo;
}

/** Apply a batch in click order, dropping task lines invalidated by an edit. */
export function applyTaskFlips(content: string, flips: readonly TaskFlip[]): string {
  let next = content;
  for (const flip of flips) next = setTaskMark(next, flip.lineKey, flip.checked) ?? next;
  return next;
}

/**
 * Pick the newest immutable memo snapshot without letting a render-stale
 * value replace the queue's just-returned server value.
 */
export function freshestTaskMemo(known: Memo, candidate: Memo | undefined): Memo {
  return candidate && candidate.seq > known.seq ? candidate : known;
}
