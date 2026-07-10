import type { Memo, TagMeta } from "./types";

/** A versioned hard-delete marker returned by incremental sync. */
export interface PurgedMemo {
  id: string;
  seq: number;
}

/**
 * Normalized, version-aware client state. Unpinned tag rows and memo
 * tombstones intentionally remain here as watermarks: a delayed response must
 * never be able to resurrect an older value after the sync cursor has moved on.
 */
export interface SyncState {
  memos: Map<string, Memo>;
  tags: Map<string, TagMeta>;
  tombstones: Map<string, number>;
}

export interface SyncDelta {
  memos?: readonly Memo[];
  purged?: readonly PurgedMemo[];
  tags?: readonly TagMeta[];
}

/**
 * Keep only entities newer than a client high-water mark. This is required
 * for cross-tab pages that can overlap a freshly bootstrapped tab: bootstrap
 * contains current rows but intentionally omits historical tombstones and
 * unpin markers, so replaying the older half could resurrect stale state.
 */
export function changesAfterCursor(delta: SyncDelta, cursor: number): Required<SyncDelta> {
  return {
    memos: (delta.memos ?? []).filter((memo) => memo.seq > cursor),
    purged: (delta.purged ?? []).filter((purge) => purge.seq > cursor),
    tags: (delta.tags ?? []).filter((tag) => tag.seq > cursor)
  };
}

export function createSyncState(
  memos: readonly Memo[] = [],
  tags: readonly TagMeta[] = [],
  purged: readonly PurgedMemo[] = []
): SyncState {
  return applySyncDelta(
    { memos: new Map(), tags: new Map(), tombstones: new Map() },
    { memos, tags, purged }
  );
}

/**
 * Merge one server delta without allowing an older response to roll state
 * backwards. The function is intentionally pure and preserves the original
 * state and Map references when every incoming version is already known.
 */
export function applySyncDelta(state: SyncState, delta: SyncDelta): SyncState {
  let memos = state.memos;
  let tags = state.tags;
  let tombstones = state.tombstones;

  const mutableMemos = () => {
    if (memos === state.memos) memos = new Map(memos);
    return memos;
  };
  const mutableTags = () => {
    if (tags === state.tags) tags = new Map(tags);
    return tags;
  };
  const mutableTombstones = () => {
    if (tombstones === state.tombstones) tombstones = new Map(tombstones);
    return tombstones;
  };

  // Purge wins an equal-seq tie. A later re-import still crosses the older
  // tombstone because its memo receives a strictly newer global seq.
  for (const purge of delta.purged ?? []) {
    if (!purge.id || !Number.isFinite(purge.seq)) continue;
    const knownTombstone = tombstones.get(purge.id) ?? -1;
    if (purge.seq > knownTombstone) mutableTombstones().set(purge.id, purge.seq);

    const current = memos.get(purge.id);
    if (current && purge.seq >= current.seq) mutableMemos().delete(purge.id);
  }

  for (const memo of delta.memos ?? []) {
    if (!memo.id || !Number.isFinite(memo.seq)) continue;
    const current = memos.get(memo.id);
    const tombstoneSeq = tombstones.get(memo.id) ?? -1;
    if (memo.seq <= tombstoneSeq || (current && memo.seq <= current.seq)) continue;
    mutableMemos().set(memo.id, memo);
  }

  // Keep pinnedAt:null rows. They are the only durable proof that an older pin
  // response is stale, even though the derived sidebar view hides them.
  for (const tag of delta.tags ?? []) {
    if (!tag.path || !Number.isFinite(tag.seq)) continue;
    const current = tags.get(tag.path);
    if (current && tag.seq <= current.seq) continue;
    mutableTags().set(tag.path, tag);
  }

  if (memos === state.memos && tags === state.tags && tombstones === state.tombstones) return state;
  return { memos, tags, tombstones };
}

export function memosOf(state: SyncState): Memo[] {
  return [...state.memos.values()];
}

export function tagsOfState(state: SyncState): TagMeta[] {
  return [...state.tags.values()];
}

export function purgedOf(state: SyncState): PurgedMemo[] {
  return [...state.tombstones].map(([id, seq]) => ({ id, seq }));
}
