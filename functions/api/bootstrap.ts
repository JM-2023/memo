import { requireAuth, sessionCacheKey } from "./_utils/auth";
import { openContentRows, scheduleEncryptionBackfill } from "./_utils/crypto";
import {
  CURRENT_SEQ_SQL,
  groupImages,
  MEMO_COLUMNS,
  shapeMemo,
  shapeTagMeta,
  type ImageMetaRow,
  type MemoRow,
  type TagMetaRow
} from "./_utils/memos";
import { apiError, json, nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Row cap per page. Short notes fill it; long ones hit the size budget first. */
export const BOOTSTRAP_MAX_ROWS = 400;
/** Stored content characters per page (ciphertext is ~4/3 of the text), so
 * a page of long memos stays a bounded decrypt + JSON job on the Free plan. */
export const BOOTSTRAP_PAGE_CHARS = 512_000;
/** Pinned memos ride the first page so the top of the feed never jumps. */
const BOOTSTRAP_PINNED_MAX = 100;
/** Separates created_at from the id in the opaque cursor; ids never contain it. */
const CURSOR_SEPARATOR = "~";

function parseSnapshot(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseAfter(value: string): [createdAt: string, id: string] | null {
  const split = value.lastIndexOf(CURSOR_SEPARATOR);
  if (value.length > 256 || split <= 0) return null;
  const id = value.slice(split + 1);
  return ENTITY_ID_PATTERN.test(id) ? [value.slice(0, split), id] : null;
}

function parseRowLimit(value: string | null): number {
  const parsed = Number(value);
  if (value === null || !Number.isFinite(parsed) || parsed <= 0) return BOOTSTRAP_MAX_ROWS;
  return Math.min(BOOTSTRAP_MAX_ROWS, Math.max(1, Math.floor(parsed)));
}

/**
 * Cold-start snapshot, one bounded keyset page at a time, newest memo first
 * by (created_at DESC, id DESC) so the client can render the first page as
 * the top of its feed while the rest streams in. The first response freezes
 * the sync high-water in `cursor`; later pages reuse it via `snapshot` and
 * only ever return rows with seq <= that cursor. created_at is immutable, so
 * an unchanged row keeps its place between pages. A row edited or purged
 * while paging drops out of the remaining pages, and the mandatory sync from
 * the frozen cursor supplies its newer version or tombstone, so bootstrap
 * can neither overwrite nor miss a concurrent change.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const url = new URL(context.request.url);
  const afterParam = url.searchParams.get("after");
  const snapshotParam = url.searchParams.get("snapshot");
  const isContinuation = afterParam !== null || snapshotParam !== null;
  const after = afterParam === null ? null : parseAfter(afterParam);
  if ((afterParam === null) !== (snapshotParam === null) || (afterParam !== null && after === null)) {
    return apiError(400, "INVALID_REQUEST_BODY", "The bootstrap continuation is invalid.");
  }

  const requestedSnapshot = parseSnapshot(snapshotParam);
  if (isContinuation && requestedSnapshot === null) {
    return apiError(400, "INVALID_REQUEST_BODY", "The bootstrap snapshot is invalid.");
  }

  const limit = parseRowLimit(url.searchParams.get("limit"));
  const snapshotSql = requestedSnapshot === null ? CURRENT_SEQ_SQL : "?";
  const snapshotBindings = requestedSnapshot === null ? [] : [requestedSnapshot];
  const db = context.env.DB;

  // One extra candidate row tells whether anything follows the page.
  const candidatesSql = `SELECT ${MEMO_COLUMNS} FROM memos
    WHERE seq <= ${snapshotSql}${after ? " AND (created_at, id) < (?, ?)" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`;
  const candidateBindings = [...snapshotBindings, ...(after ?? []), limit + 1];

  const statements: D1PreparedStatement[] = [
    db.prepare("SELECT n, sync_epoch FROM sync_counter WHERE id = 1"),
    // Keep candidates while the content before them fits the budget: the
    // first row always fits, so a page always advances.
    db
      .prepare(
        `SELECT ${MEMO_COLUMNS}, candidates FROM (
           SELECT ${MEMO_COLUMNS},
             SUM(length(content)) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) - length(content) AS before_chars,
             COUNT(*) OVER () AS candidates
           FROM (${candidatesSql})
         )
         WHERE before_chars < ?
         ORDER BY created_at DESC, id DESC`
      )
      .bind(...candidateBindings, BOOTSTRAP_PAGE_CHARS),
    db
      .prepare(
        `SELECT i.id, i.memo_id, i.ord, i.mime, i.width, i.height, i.bytes
         FROM memo_images i
         JOIN (${candidatesSql}) page ON page.id = i.memo_id
         ORDER BY i.memo_id COLLATE BINARY, i.ord`
      )
      .bind(...candidateBindings)
  ];
  if (!isContinuation) {
    // Same transaction as the counter read, so CURRENT_SEQ_SQL is the cursor.
    statements.push(
      db.prepare(`SELECT path, pinned_at, seq FROM tag_meta WHERE pinned_at IS NOT NULL AND seq <= ${CURRENT_SEQ_SQL}`),
      db.prepare("SELECT COUNT(*) AS total FROM memos"),
      db.prepare(
        `SELECT ${MEMO_COLUMNS} FROM memos WHERE pinned_at IS NOT NULL AND deleted_at IS NULL
         ORDER BY pinned_at DESC, id DESC LIMIT ${BOOTSTRAP_PINNED_MAX}`
      ),
      db.prepare(
        `SELECT i.id, i.memo_id, i.ord, i.mime, i.width, i.height, i.bytes
         FROM memo_images i
         JOIN (
           SELECT id FROM memos WHERE pinned_at IS NOT NULL AND deleted_at IS NULL
           ORDER BY pinned_at DESC, id DESC LIMIT ${BOOTSTRAP_PINNED_MAX}
         ) pinned ON pinned.id = i.memo_id
         ORDER BY i.memo_id COLLATE BINARY, i.ord`
      )
    );
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

  const pageRows = (results[1]?.results ?? []) as unknown as (MemoRow & { candidates: number })[];
  const candidates = pageRows[0]?.candidates ?? 0;
  const hasMore = pageRows.length < candidates || pageRows.length > limit;
  const memoRows: MemoRow[] = pageRows.slice(0, limit).map(({ candidates: _candidates, ...row }) => row);
  const pageIds = new Set(memoRows.map((row) => row.id));
  // Pinned rows the page already carries are not sent (or opened) twice.
  const pinnedRows = isContinuation
    ? []
    : ((results[5]?.results ?? []) as unknown as MemoRow[]).filter((row) => !pageIds.has(row.id));
  await openContentRows(context.env, [...memoRows, ...pinnedRows]);

  // The page's image query joins every candidate row, including the
  // look-ahead row and rows the size budget cut, so keep only the images of
  // memos this page returns. A pinned memo among those cut candidates then
  // takes its images from the pinned query alone, never from both.
  const imagesByMemo = groupImages([
    ...((results[2]?.results ?? []) as unknown as ImageMetaRow[]).filter((image) => pageIds.has(image.memo_id)),
    ...(isContinuation ? [] : ((results[6]?.results ?? []) as unknown as ImageMetaRow[]).filter((image) => !pageIds.has(image.memo_id)))
  ]);
  const memos = [...memoRows, ...pinnedRows].map((memo) => shapeMemo(memo, imagesByMemo.get(memo.id) ?? []));
  const tags = isContinuation
    ? []
    : (((results[3]?.results ?? []) as unknown as TagMetaRow[]).map(shapeTagMeta));
  const total = isContinuation ? undefined : Number((results[4]?.results?.[0] as { total?: unknown } | undefined)?.total ?? 0);
  const last = memoRows[memoRows.length - 1];
  const nextAfter = hasMore && last ? `${last.created_at}${CURSOR_SEPARATOR}${last.id}` : null;

  scheduleEncryptionBackfill(context);

  return json({
    memos,
    tags,
    cursor,
    syncEpoch,
    cacheKey: isContinuation ? undefined : await sessionCacheKey(context),
    serverTime: nowIso(),
    hasMore,
    nextAfter,
    total
  });
}
