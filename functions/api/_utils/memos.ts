// Shared memo row plumbing for bootstrap / sync / mutation endpoints.

export interface MemoRow {
  id: string;
  content: string;
  content_format: string;
  /** Immutable initial send time. */
  created_at: string;
  /** Last content/attachment edit; pin/trash/restore leave it untouched. */
  updated_at: string;
  pinned_at: string | null;
  deleted_at: string | null;
  seq: number;
}

export interface ImageMetaRow {
  id: string;
  memo_id: string;
  ord: number;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export const MEMO_COLUMNS = "id, content, content_format, created_at, updated_at, pinned_at, deleted_at, seq";

export const CURRENT_SEQ_SQL = "(SELECT n FROM sync_counter WHERE id = 1)";
export const DEFAULT_SYNC_PAGE_SIZE = 100;
export const MAX_SYNC_PAGE_SIZE = 200;

/** Clamp a user-provided page size to a predictable per-request budget. */
export function parsePageLimit(value: string | null, fallback = DEFAULT_SYNC_PAGE_SIZE): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_SYNC_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

export interface MemoJson {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  deletedAt: string | null;
  seq: number;
  images: { id: string; mime: string; width: number; height: number; bytes: number }[];
}

export function shapeMemo(row: MemoRow, images: ImageMetaRow[]): MemoJson {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinnedAt: row.pinned_at,
    deletedAt: row.deleted_at,
    seq: row.seq,
    images: images.map((image) => ({ id: image.id, mime: image.mime, width: image.width, height: image.height, bytes: image.bytes }))
  };
}

export function groupImages(rows: ImageMetaRow[]): Map<string, ImageMetaRow[]> {
  const byMemo = new Map<string, ImageMetaRow[]>();
  for (const row of rows) {
    const list = byMemo.get(row.memo_id) ?? [];
    list.push(row);
    byMemo.set(row.memo_id, list);
  }
  return byMemo;
}

export interface TagMetaRow {
  path: string;
  pinned_at: string | null;
  seq: number;
}

export interface TagMetaJson {
  path: string;
  pinnedAt: string | null;
  seq: number;
}

export function shapeTagMeta(row: TagMetaRow): TagMetaJson {
  return { path: row.path, pinnedAt: row.pinned_at, seq: row.seq };
}

/**
 * Build (but do not execute) the counter claim for a mutation transaction.
 * The caller MUST put this statement and every business write in the same
 * D1Database.batch(). The predicate is repeated by the business statement so
 * an OCC conflict/idempotent no-op neither changes data nor consumes a seq.
 */
export function claimSeq(db: D1Database, predicateSql: string, bindings: unknown[] = []): D1PreparedStatement {
  return db
    .prepare(`UPDATE sync_counter SET n = n + 1 WHERE id = 1 AND (${predicateSql}) RETURNING n`)
    .bind(...bindings);
}

export function claimedSeq(result: D1Result<unknown> | undefined): number | null {
  const row = result?.results?.[0] as { n?: unknown } | undefined;
  return typeof row?.n === "number" && Number.isSafeInteger(row.n) ? row.n : null;
}
