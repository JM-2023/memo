import { describe, expect, it } from "vitest";
import { memoMatchesSubmittedDraft } from "../src/lib/memoRecovery";
import { applySyncDelta, changesAfterCursor, createSyncState } from "../src/lib/syncState";
import type { Memo, TagMeta } from "../src/lib/types";

function memo(id: string, seq: number, content = `${id}@${seq}`): Memo {
  return {
    id,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq,
    images: []
  };
}

function tag(path: string, seq: number, pinnedAt: string | null): TagMeta {
  return { path, seq, pinnedAt };
}

describe("version-aware memo merging", () => {
  it("keeps the highest memo seq when one delta arrives out of order", () => {
    const state = createSyncState([memo("a", 10)]);
    const newest = memo("a", 13, "newest");

    const next = applySyncDelta(state, { memos: [newest, memo("a", 12, "late older response")] });

    expect(next.memos.get("a")).toBe(newest);
    expect(next.memos.get("a")?.seq).toBe(13);
  });

  it("treats an equal-seq memo as a full identity-preserving no-op", () => {
    const original = memo("a", 10, "authoritative");
    const state = createSyncState([original]);

    const next = applySyncDelta(state, { memos: [memo("a", 10, "same version, different object")] });

    expect(next).toBe(state);
    expect(next.memos).toBe(state.memos);
    expect(next.tags).toBe(state.tags);
    expect(next.tombstones).toBe(state.tombstones);
    expect(next.memos.get("a")).toBe(original);
  });

  it("does not let an older memo roll a newer local mutation backwards", () => {
    const current = memo("a", 20, "local mutation response");
    const state = createSyncState([current]);

    const next = applySyncDelta(state, { memos: [memo("a", 19, "delayed sync response")] });

    expect(next).toBe(state);
    expect(next.memos.get("a")).toBe(current);
  });

  it("clones only the map whose contents actually changed", () => {
    const state = createSyncState([memo("a", 1)], [tag("work", 1, "2026-01-01T00:00:00.000Z")]);

    const next = applySyncDelta(state, { memos: [memo("b", 2)] });

    expect(next).not.toBe(state);
    expect(next.memos).not.toBe(state.memos);
    expect(next.tags).toBe(state.tags);
    expect(next.tombstones).toBe(state.tombstones);
  });
});

describe("purge watermarks", () => {
  it("removes a memo and blocks stale or equal-seq resurrection", () => {
    const state = createSyncState([memo("a", 5)]);
    const purged = applySyncDelta(state, { purged: [{ id: "a", seq: 6 }] });

    expect(purged.memos.has("a")).toBe(false);
    expect(purged.tombstones.get("a")).toBe(6);

    const resurrected = applySyncDelta(purged, { memos: [memo("a", 5), memo("a", 6)] });
    expect(resurrected).toBe(purged);
    expect(resurrected.memos.has("a")).toBe(false);
  });

  it("allows a strictly newer re-import to cross an older tombstone", () => {
    const state = createSyncState([], [], [{ id: "a", seq: 6 }]);
    const imported = memo("a", 7, "re-imported");

    const next = applySyncDelta(state, { memos: [imported] });

    expect(next.memos.get("a")).toBe(imported);
    expect(next.tombstones.get("a")).toBe(6);
  });

  it("gives purge precedence when a malformed delta contains an equal-seq memo", () => {
    const state = createSyncState();

    const next = applySyncDelta(state, {
      memos: [memo("a", 9)],
      purged: [{ id: "a", seq: 9 }]
    });

    expect(next.memos.has("a")).toBe(false);
    expect(next.tombstones.get("a")).toBe(9);
  });

  it("ignores an older purge after a newer memo has crossed the watermark", () => {
    const state = createSyncState([memo("a", 7)], [], [{ id: "a", seq: 6 }]);

    const next = applySyncDelta(state, { purged: [{ id: "a", seq: 6 }] });

    expect(next).toBe(state);
    expect(next.memos.get("a")?.seq).toBe(7);
  });

  it("keeps the greatest tombstone when purge records arrive out of order", () => {
    const state = createSyncState([], [], [
      { id: "a", seq: 12 },
      { id: "a", seq: 10 }
    ]);

    expect(state.tombstones.get("a")).toBe(12);
  });
});

describe("tag watermarks", () => {
  it("retains an unpin row and rejects an older delayed pin", () => {
    const state = createSyncState([], [tag("work", 4, "2026-01-01T00:00:00.000Z")]);
    const unpinned = tag("work", 5, null);
    const afterUnpin = applySyncDelta(state, { tags: [unpinned] });

    expect(afterUnpin.tags.get("work")).toBe(unpinned);
    expect(afterUnpin.tags.get("work")?.pinnedAt).toBeNull();

    const stalePin = applySyncDelta(afterUnpin, { tags: [tag("work", 4, "2026-01-02T00:00:00.000Z")] });
    expect(stalePin).toBe(afterUnpin);
    expect(stalePin.tags.get("work")).toBe(unpinned);
  });

  it("allows a strictly newer pin after an unpin watermark", () => {
    const state = createSyncState([], [tag("work", 5, null)]);
    const repinned = tag("work", 6, "2026-01-03T00:00:00.000Z");

    const next = applySyncDelta(state, { tags: [repinned] });

    expect(next.tags.get("work")).toBe(repinned);
  });

  it("keeps the first authoritative object on an equal tag seq", () => {
    const current = tag("work", 6, "2026-01-03T00:00:00.000Z");
    const state = createSyncState([], [current]);

    const next = applySyncDelta(state, { tags: [tag("work", 6, null)] });

    expect(next).toBe(state);
    expect(next.tags.get("work")).toBe(current);
  });
});

describe("cross-tab high-water filtering", () => {
  it("drops a historical page already covered by a fresh bootstrap", () => {
    const delta = changesAfterCursor(
      {
        memos: [memo("purged-later", 40)],
        purged: [{ id: "older-purge", seq: 80 }],
        tags: [tag("old-pin", 70, "2026-01-01T00:00:00.000Z")]
      },
      100
    );

    expect(delta).toEqual({ memos: [], purged: [], tags: [] });
  });

  it("keeps only the new half of a page that straddles the local cursor", () => {
    const delta = changesAfterCursor(
      {
        memos: [memo("old", 99), memo("new", 101)],
        purged: [{ id: "gone", seq: 102 }],
        tags: [tag("old-tag", 100, null), tag("new-tag", 103, null)]
      },
      100
    );

    expect(delta.memos.map(({ id }) => id)).toEqual(["new"]);
    expect(delta.purged).toEqual([{ id: "gone", seq: 102 }]);
    expect(delta.tags.map(({ path }) => path)).toEqual(["new-tag"]);
  });
});

describe("lost create-recovery responses", () => {
  it("recognizes the exact submitted value as an already successful save", () => {
    const current = {
      ...memo("draft-id", 12, "final draft"),
      images: [
        { id: "image-a", mime: "image/webp", width: 100, height: 80, bytes: 42 },
        { id: "image-b", mime: "image/webp", width: 120, height: 90, bytes: 64 }
      ]
    };

    expect(memoMatchesSubmittedDraft(current, "final draft", ["image-b", "image-a"])).toBe(true);
  });

  it("does not accept different content, attachments, or a trashed memo", () => {
    const current = {
      ...memo("draft-id", 12, "server value"),
      images: [{ id: "image-a", mime: "image/webp", width: 100, height: 80, bytes: 42 }]
    };

    expect(memoMatchesSubmittedDraft(current, "draft value", ["image-a"])).toBe(false);
    expect(memoMatchesSubmittedDraft(current, "server value", ["image-b"])).toBe(false);
    expect(memoMatchesSubmittedDraft({ ...current, deletedAt: "2026-01-02T00:00:00.000Z" }, "server value", ["image-a"])).toBe(false);
  });
});
