import { requireAuth } from "./_utils/auth";
import { getOrCreateCacheKey, openContentRows, scheduleEncryptionBackfill } from "./_utils/crypto";
import {
  groupImages,
  MEMO_COLUMNS,
  parsePageLimit,
  shapeMemo,
  shapeTagMeta,
  type ImageMetaRow,
  type MemoRow,
  type TagMetaRow
} from "./_utils/memos";
import { json, nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

/**
 * Bounded incremental sync. A page boundary is chosen from the combined memo,
 * tombstone, and tag sequence stream; every entity at the cutoff seq is then
 * returned, so advancing cursor can never split one logical mutation group.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const url = new URL(context.request.url);
  const rawSince = Number(url.searchParams.get("since") ?? "0");
  const since = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0;
  // Bootstrap/warm start needs the IndexedDB key once. Heartbeat syncs omit
  // this flag so they do not spend an extra D1 read on an unchanged secret.
  const includeCacheKey = url.searchParams.get("cacheKey") === "1";
  const limit = parsePageLimit(url.searchParams.get("limit"));
  const db = context.env.DB;

  const [counterResult, cutoffResult] = await db.batch([
    db.prepare("SELECT n, sync_epoch FROM sync_counter WHERE id = 1"),
    db
      .prepare(
        `WITH changed(seq) AS (
           SELECT seq FROM memos INDEXED BY idx_memos_seq_id
             WHERE seq > ?1 AND seq <= (SELECT n FROM sync_counter WHERE id = 1)
           UNION ALL
           SELECT seq FROM tombstones INDEXED BY idx_tombstones_seq_id
             WHERE seq > ?1 AND seq <= (SELECT n FROM sync_counter WHERE id = 1)
           UNION ALL
           SELECT seq FROM tag_meta INDEXED BY idx_tag_meta_seq_path
             WHERE seq > ?1 AND seq <= (SELECT n FROM sync_counter WHERE id = 1)
         )
         SELECT MAX(seq) AS cutoff FROM (SELECT seq FROM changed ORDER BY seq LIMIT ?2)`
      )
      .bind(since, limit)
  ]);

  const counterRow = counterResult.results?.[0] as { n?: unknown; sync_epoch?: unknown } | undefined;
  if (
    typeof counterRow?.n !== "number" ||
    !Number.isSafeInteger(counterRow.n) ||
    typeof counterRow.sync_epoch !== "string" ||
    !counterRow.sync_epoch
  ) {
    throw new Error("sync_counter row missing — run migrations");
  }
  const highWater = counterRow.n;
  const syncEpoch = counterRow.sync_epoch;
  const rawCutoff = (cutoffResult.results?.[0] as { cutoff?: unknown } | undefined)?.cutoff;
  if (typeof rawCutoff !== "number") {
    scheduleEncryptionBackfill(context);
    return json({
      memos: [],
      purged: [],
      tags: [],
      cursor: highWater,
      syncEpoch,
      hasMore: false,
      cacheKey: includeCacheKey ? await getOrCreateCacheKey(context.env) : undefined,
      serverTime: nowIso()
    });
  }
  const cutoff = rawCutoff;

  const [memoResult, imageResult, tombstoneResult, tagResult, moreResult] = await db.batch([
    db
      .prepare(`SELECT ${MEMO_COLUMNS} FROM memos INDEXED BY idx_memos_seq_id WHERE seq > ? AND seq <= ? ORDER BY seq, id`)
      .bind(since, cutoff),
    db
      .prepare(
        `SELECT i.id, i.memo_id, i.ord, i.mime, i.width, i.height, i.bytes
         FROM memos m INDEXED BY idx_memos_seq_id
         JOIN memo_images i INDEXED BY idx_memo_images_memo_ord ON i.memo_id = m.id
         WHERE m.seq > ? AND m.seq <= ?
         ORDER BY m.seq, m.id, i.ord`
      )
      .bind(since, cutoff),
    db
      .prepare("SELECT id, seq FROM tombstones INDEXED BY idx_tombstones_seq_id WHERE seq > ? AND seq <= ? ORDER BY seq, id")
      .bind(since, cutoff),
    db
      .prepare("SELECT path, pinned_at, seq FROM tag_meta INDEXED BY idx_tag_meta_seq_path WHERE seq > ? AND seq <= ? ORDER BY seq, path")
      .bind(since, cutoff),
    db
      .prepare(
        `SELECT (
           EXISTS(SELECT 1 FROM memos WHERE seq > ?1 AND seq <= ?2)
           OR EXISTS(SELECT 1 FROM tombstones WHERE seq > ?1 AND seq <= ?2)
           OR EXISTS(SELECT 1 FROM tag_meta WHERE seq > ?1 AND seq <= ?2)
         ) AS has_more`
      )
      .bind(cutoff, highWater)
  ]);

  const imagesByMemo = groupImages((imageResult.results ?? []) as unknown as ImageMetaRow[]);
  const memoRows = (memoResult.results ?? []) as unknown as MemoRow[];
  await openContentRows(context.env, memoRows);
  const memos = memoRows.map((memo) => shapeMemo(memo, imagesByMemo.get(memo.id) ?? []));
  const purged = (tombstoneResult.results ?? []) as unknown as { id: string; seq: number }[];
  const tags = ((tagResult.results ?? []) as unknown as TagMetaRow[]).map(shapeTagMeta);
  const hasMore = Boolean((moreResult.results?.[0] as { has_more?: unknown } | undefined)?.has_more);

  scheduleEncryptionBackfill(context);
  return json({
    memos,
    purged,
    tags,
    cursor: hasMore ? cutoff : highWater,
    syncEpoch,
    hasMore,
    cacheKey: includeCacheKey ? await getOrCreateCacheKey(context.env) : undefined,
    serverTime: nowIso()
  });
}
