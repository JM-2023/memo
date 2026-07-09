import { requireAuth } from "./_utils/auth";
import { groupImages, MEMO_COLUMNS, shapeMemo, shapeTagMeta, type ImageMetaRow, type MemoRow, type TagMetaRow } from "./_utils/memos";
import { json, nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

// The whole notebook ships in one payload (content only — image binaries are
// fetched lazily per memo). Trashed memos ride along (deletedAt set) so the
// recycle bin is client-side too. Only pinned tag rows matter at bootstrap
// (dormant ones carry no state). `cursor` seeds incremental /api/sync pulls;
// the batch is one transaction, so rows and cursor are a consistent snapshot.
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const [counterResult, memoResult, imageResult, tagResult] = await context.env.DB.batch([
    context.env.DB.prepare("SELECT n FROM sync_counter WHERE id = 1"),
    context.env.DB.prepare(`SELECT ${MEMO_COLUMNS} FROM memos ORDER BY created_at DESC`),
    context.env.DB.prepare("SELECT id, memo_id, ord, mime, width, height, bytes FROM memo_images ORDER BY memo_id, ord"),
    context.env.DB.prepare("SELECT path, pinned_at, seq FROM tag_meta WHERE pinned_at IS NOT NULL")
  ]);

  const cursor = ((counterResult.results?.[0] as { n?: number } | undefined)?.n ?? 0) as number;
  const imagesByMemo = groupImages((imageResult.results ?? []) as unknown as ImageMetaRow[]);
  const memos = ((memoResult.results ?? []) as unknown as MemoRow[]).map((memo) => shapeMemo(memo, imagesByMemo.get(memo.id) ?? []));
  const tags = ((tagResult.results ?? []) as unknown as TagMetaRow[]).map(shapeTagMeta);

  return json({ memos, tags, cursor, serverTime: nowIso() });
}
