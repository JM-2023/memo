// Shared memo row plumbing for bootstrap / sync / mutation endpoints.

export interface MemoRow {
  id: string;
  content: string;
  created_at: string;
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

export const MEMO_COLUMNS = "id, content, created_at, updated_at, pinned_at, deleted_at, seq";

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
 * Atomically claim the next global sequence number. D1 serialises writes per
 * database, so RETURNING hands every caller a distinct value; gaps from failed
 * follow-up writes are harmless.
 */
export async function nextSeq(db: D1Database): Promise<number> {
  const row = await db.prepare("UPDATE sync_counter SET n = n + 1 WHERE id = 1 RETURNING n").first<{ n: number }>();
  if (!row) {
    throw new Error("sync_counter row missing — run migrations");
  }
  return row.n;
}
