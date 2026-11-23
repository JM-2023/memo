import { requireAuth } from "./_utils/auth";
import { json, nowIso } from "./_utils/response";
import type { AppContext, AppEnv } from "./_utils/types";

/**
 * Cloudflare's Free plan caps one D1 database at 500 MB. Paid plans allow
 * more, and Cloudflare can change either figure, so a deployment can name
 * its own ceiling with D1_DATABASE_LIMIT_MB. Counted in decimal megabytes,
 * as the dashboard does; if the platform means MiB the meter errs early.
 */
export const DEFAULT_DATABASE_LIMIT_MB = 500;

export function databaseLimitBytes(env: Pick<AppEnv, "D1_DATABASE_LIMIT_MB">): number {
  const configured = Number(env.D1_DATABASE_LIMIT_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DATABASE_LIMIT_MB;
  return Math.round(megabytes * 1_000_000);
}

interface TotalsRow {
  memo_count: number;
  text_bytes: number;
  trash_count: number;
  trash_text_bytes: number;
}

interface ImageSizeRow {
  id: string;
  memo_id: string;
  bytes: number;
  trashed: number;
}

interface TrashSizeRow {
  id: string;
  bytes: number;
}

export interface StorageShare {
  memos: number;
  textBytes: number;
  images: number;
  imageBytes: number;
}

export interface StorageReportJson {
  measuredAt: string;
  database: {
    /** What D1 reports for the whole file — tables, indexes, free pages. Null when the runtime does not say. */
    bytes: number | null;
    limitBytes: number;
  };
  /** Memos outside Trash. */
  notes: StorageShare;
  trash: StorageShare;
  /** Every stored attachment as stored: base64 original plus base64 preview. */
  images: { id: string; memoId: string; bytes: number }[];
  /** Each trashed memo's text plus attachments, as stored. */
  trashMemos: { id: string; bytes: number }[];
}

function whole(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * What the notebook costs in D1, read in one batch. `octet_length` takes a
 * value's size from the record header, so neither memo text nor the base64
 * image columns are loaded; the scan costs one row read per memo and per
 * attachment and nothing per byte. Content is measured as stored — sealed
 * (enc1:) rows count their ciphertext — because that is what fills the file.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const db = context.env.DB;
  const imageBytesSql = "octet_length(i.data_base64) + COALESCE(octet_length(i.thumb_base64), 0)";
  const [totalsResult, imagesResult, trashResult] = await db.batch([
    db.prepare(
      `SELECT
         COALESCE(SUM(deleted_at IS NULL), 0) AS memo_count,
         COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN octet_length(content) END), 0) AS text_bytes,
         COALESCE(SUM(deleted_at IS NOT NULL), 0) AS trash_count,
         COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN octet_length(content) END), 0) AS trash_text_bytes
       FROM memos`
    ),
    // The join screens out attachments whose memo row is gone, as the image
    // endpoint does; they cannot be shown or opened, only counted as "other".
    db.prepare(
      `SELECT i.id, i.memo_id, ${imageBytesSql} AS bytes, m.deleted_at IS NOT NULL AS trashed
       FROM memo_images AS i JOIN memos AS m ON m.id = i.memo_id
       ORDER BY i.id`
    ),
    db.prepare(
      `SELECT m.id,
              octet_length(m.content) + COALESCE((SELECT SUM(${imageBytesSql}) FROM memo_images AS i WHERE i.memo_id = m.id), 0) AS bytes
       FROM memos AS m
       WHERE m.deleted_at IS NOT NULL
       ORDER BY m.id`
    )
  ]);

  const totals = (totalsResult.results?.[0] ?? {}) as Partial<TotalsRow>;
  const imageRows = (imagesResult.results ?? []) as unknown as ImageSizeRow[];
  const notes: StorageShare = { memos: whole(totals.memo_count), textBytes: whole(totals.text_bytes), images: 0, imageBytes: 0 };
  const trash: StorageShare = { memos: whole(totals.trash_count), textBytes: whole(totals.trash_text_bytes), images: 0, imageBytes: 0 };
  const images = imageRows.map((row) => {
    const bytes = whole(row.bytes);
    const share = Number(row.trashed) ? trash : notes;
    share.images += 1;
    share.imageBytes += bytes;
    return { id: row.id, memoId: row.memo_id, bytes };
  });
  const trashMemos = ((trashResult.results ?? []) as unknown as TrashSizeRow[]).map((row) => ({ id: row.id, bytes: whole(row.bytes) }));

  // Every D1 result carries the database's size after the statement; a
  // read-only batch leaves it as it found it.
  const sizeAfter = Number((totalsResult.meta as Partial<D1Meta> | undefined)?.size_after);
  const report: StorageReportJson = {
    measuredAt: nowIso(),
    database: { bytes: Number.isFinite(sizeAfter) && sizeAfter > 0 ? Math.round(sizeAfter) : null, limitBytes: databaseLimitBytes(context.env) },
    notes,
    trash,
    images,
    trashMemos
  };
  return json(report);
}
