import type { Memo } from "./types";

/**
 * The fields a one-tap memo action (pin / unpin, trash, restore) changes —
 * shown at the click, ahead of the server's answer.
 */
export type OptimisticPatch = Partial<Pick<Memo, "pinnedAt" | "deletedAt">>;

/** memo id → the guess riding over it while its request is in flight. */
export type OptimisticLayer = ReadonlyMap<string, OptimisticPatch>;

/**
 * The memo as the reader should see it right now. The layer only skins the
 * rendered state: sync state (and every snapshot made from it) stays the
 * server truth, so a guess is never persisted and a failure only has to
 * peel the patch off. Untouched memos keep their identity, which keeps the
 * memoized feed rows still.
 */
export function withOptimistic(memo: Memo, layer: OptimisticLayer): Memo {
  const patch = layer.get(memo.id);
  return patch ? { ...memo, ...patch } : memo;
}

export function applyOptimisticLayer(memos: readonly Memo[], layer: OptimisticLayer): readonly Memo[] {
  if (layer.size === 0) return memos;
  return memos.map((memo) => withOptimistic(memo, layer));
}

export function withPatch(layer: OptimisticLayer, id: string, patch: OptimisticPatch): OptimisticLayer {
  const next = new Map(layer);
  next.set(id, patch);
  return next;
}

export function withoutPatch(layer: OptimisticLayer, id: string): OptimisticLayer {
  if (!layer.has(id)) return layer;
  const next = new Map(layer);
  next.delete(id);
  return next;
}
