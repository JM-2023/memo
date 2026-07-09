import { requireAuth } from "./_utils/auth";
import { openContentRows } from "./_utils/crypto";
import { MEMO_COLUMNS, type MemoRow, type TagMetaRow } from "./_utils/memos";
import { nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

interface ImageDataRow {
  id: string;
  memo_id: string;
  ord: number;
  mime: string;
  width: number;
  height: number;
  data_base64: string;
}

/**
 * The whole notebook as one self-contained JSON download: every memo
 * (Trash included), inline image data, and tag pin state. Content is opened
 * before it leaves — a backup must be readable without the deployment's
 * encryption key. Server-local bookkeeping (seq, sessions, passcode) stays
 * out; import assigns fresh seqs on the target.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const [memoResult, imageResult, tagResult] = await context.env.DB.batch([
    context.env.DB.prepare(`SELECT ${MEMO_COLUMNS} FROM memos ORDER BY created_at ASC`),
    context.env.DB.prepare("SELECT id, memo_id, ord, mime, width, height, data_base64 FROM memo_images ORDER BY memo_id, ord"),
    context.env.DB.prepare("SELECT path, pinned_at, seq FROM tag_meta WHERE pinned_at IS NOT NULL")
  ]);

  const memoRows = (memoResult.results ?? []) as unknown as MemoRow[];
  await openContentRows(context.env, memoRows);

  const imagesByMemo = new Map<string, ImageDataRow[]>();
  for (const row of (imageResult.results ?? []) as unknown as ImageDataRow[]) {
    const list = imagesByMemo.get(row.memo_id) ?? [];
    list.push(row);
    imagesByMemo.set(row.memo_id, list);
  }

  const payload = {
    format: "memo-backup",
    version: 1,
    exportedAt: nowIso(),
    memos: memoRows.map((memo) => ({
      id: memo.id,
      content: memo.content,
      createdAt: memo.created_at,
      updatedAt: memo.updated_at,
      pinnedAt: memo.pinned_at,
      deletedAt: memo.deleted_at,
      images: (imagesByMemo.get(memo.id) ?? []).map((image) => ({
        id: image.id,
        mime: image.mime,
        width: image.width,
        height: image.height,
        dataBase64: image.data_base64
      }))
    })),
    tags: ((tagResult.results ?? []) as unknown as TagMetaRow[]).map((tag) => ({ path: tag.path, pinnedAt: tag.pinned_at }))
  };

  const day = nowIso().slice(0, 10);
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="memo-backup-${day}.json"`,
      "Cache-Control": "no-store"
    }
  });
}
