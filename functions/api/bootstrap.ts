import { requireAuth } from "./_utils/auth";
import { getOrCreateCacheKey, openContentRows, scheduleEncryptionBackfill } from "./_utils/crypto";
import {
  CURRENT_SEQ_SQL,
  groupImages,
  MEMO_COLUMNS,
  parsePageLimit,
  shapeMemo,
  shapeTagMeta,
  type ImageMetaRow,
  type MemoRow,
  type TagMetaRow
} from "./_utils/memos";
import { apiError, json, nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function parseSnapshot(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Cold-start snapshot, one bounded keyset page at a time. The first response
 * freezes the sync high-water in `cursor`; later pages reuse it via
 * `snapshot`. A row edited while paging may disappear from the base page, but
 * the mandatory sync from that frozen cursor immediately supplies its newer
 * version, so bootstrap cannot overwrite or miss a concurrent edit.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const url = new URL(context.request.url);
  const afterParam = url.searchParams.get("after");
  const snapshotParam = url.searchParams.get("snapshot");
  const isContinuation = afterParam !== null || snapshotParam !== null;
  if (
    (afterParam === null) !== (snapshotParam === null) ||
    (afterParam !== null && !ENTITY_ID_PATTERN.test(afterParam))
  ) {
    return apiError(400, "INVALID_REQUEST_BODY", "The bootstrap continuation is invalid.");
  }

  const requestedSnapshot = parseSnapshot(snapshotParam);
  if (isContinuation && requestedSnapshot === null) {
    return apiError(400, "INVALID_REQUEST_BODY", "The bootstrap snapshot is invalid.");
  }

  const after = afterParam ?? "";
  const limit = parsePageLimit(url.searchParams.get("limit"));
  const snapshotSql = requestedSnapshot === null ? CURRENT_SEQ_SQL : "?";
  const snapshotBindings = requestedSnapshot === null ? [] : [requestedSnapshot];
  const db = context.env.DB;

  const statements: D1PreparedStatement[] = [
    db.prepare("SELECT n, sync_epoch FROM sync_counter WHERE id = 1"),
    db
      .prepare(`SELECT ${MEMO_COLUMNS} FROM memos WHERE id > ? AND seq <= ${snapshotSql} ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(after, ...snapshotBindings, limit + 1),
    db
      .prepare(
        `SELECT i.id, i.memo_id, i.ord, i.mime, i.width, i.height, i.bytes
         FROM memo_images i
         JOIN (
           SELECT id FROM memos WHERE id > ? AND seq <= ${snapshotSql}
           ORDER BY id COLLATE BINARY LIMIT ?
         ) page ON page.id = i.memo_id
         ORDER BY i.memo_id COLLATE BINARY, i.ord`
      )
      .bind(after, ...snapshotBindings, limit)
  ];
  if (!isContinuation) {
    statements.push(db.prepare(`SELECT path, pinned_at, seq FROM tag_meta WHERE pinned_at IS NOT NULL AND seq <= ${CURRENT_SEQ_SQL}`));
  }

  const results = await db.batch(statements);
  const counterRow = results[0]?.results?.[0] as { n?: unknown; sync_epoch?: unknown } | undefined;
  if (
    typeof counterRow?.n !== "number" ||
    !Number.isSafeInteger(counterRow.n) ||
    typeof counterRow.sync_epoch !== "string" ||
    !counterRow.sync_epoch
  ) {
    throw new Error("sync_counter row missing — run migrations");
  }
  const currentCursor = counterRow.n;
  const syncEpoch = counterRow.sync_epoch;
  const cursor = requestedSnapshot ?? currentCursor;
  if (requestedSnapshot !== null && requestedSnapshot > currentCursor) {
    return apiError(400, "INVALID_REQUEST_BODY", "The bootstrap snapshot is newer than the database.");
  }

  const pageRows = (results[1]?.results ?? []) as unknown as MemoRow[];
  const hasMore = pageRows.length > limit;
  const memoRows = hasMore ? pageRows.slice(0, limit) : pageRows;
  await openContentRows(context.env, memoRows);

  const imagesByMemo = groupImages((results[2]?.results ?? []) as unknown as ImageMetaRow[]);
  const memos = memoRows.map((memo) => shapeMemo(memo, imagesByMemo.get(memo.id) ?? []));
  const tags = isContinuation
    ? []
    : (((results[3]?.results ?? []) as unknown as TagMetaRow[]).map(shapeTagMeta));
  const nextAfter = hasMore && memoRows.length > 0 ? memoRows[memoRows.length - 1].id : null;

  scheduleEncryptionBackfill(context);

  return json({
    memos,
    tags,
    cursor,
    syncEpoch,
    cacheKey: isContinuation ? undefined : await getOrCreateCacheKey(context.env),
    serverTime: nowIso(),
    hasMore,
    nextAfter
  });
}
