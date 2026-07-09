import { requireAuth } from "./_utils/auth";
import { groupImages, MEMO_COLUMNS, shapeMemo, shapeTagMeta, type ImageMetaRow, type MemoRow, type TagMetaRow } from "./_utils/memos";
import { json, nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

/**
 * Incremental sync: everything that changed after `since` (creations, edits,
 * pins, trash moves, restores — all bump memos.seq) plus ids hard-deleted
 * since then (tombstones) plus tag_meta rows touched by pin/rename/remove
 * (a NULL pinned_at row is how an un-pin travels). The batch runs as one
 * transaction, so the returned cursor is exactly as fresh as the rows —
 * nothing can slip between them.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const rawSince = Number(new URL(context.request.url).searchParams.get("since") ?? "0");
  const since = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0;

  const [counterResult, memoResult, imageResult, tombstoneResult, tagResult] = await context.env.DB.batch([
    context.env.DB.prepare("SELECT n FROM sync_counter WHERE id = 1"),
    context.env.DB.prepare(`SELECT ${MEMO_COLUMNS} FROM memos WHERE seq > ? ORDER BY seq`).bind(since),
    context.env.DB.prepare(
      `SELECT i.id, i.memo_id, i.ord, i.mime, i.width, i.height, i.bytes
       FROM memo_images i JOIN memos m ON m.id = i.memo_id
       WHERE m.seq > ? ORDER BY i.memo_id, i.ord`
    ).bind(since),
    context.env.DB.prepare("SELECT id FROM tombstones WHERE seq > ?").bind(since),
    context.env.DB.prepare("SELECT path, pinned_at, seq FROM tag_meta WHERE seq > ?").bind(since)
  ]);

  const cursor = ((counterResult.results?.[0] as { n?: number } | undefined)?.n ?? 0) as number;
  const imagesByMemo = groupImages((imageResult.results ?? []) as unknown as ImageMetaRow[]);
  const memos = ((memoResult.results ?? []) as unknown as MemoRow[]).map((memo) => shapeMemo(memo, imagesByMemo.get(memo.id) ?? []));
  const purged = ((tombstoneResult.results ?? []) as unknown as { id: string }[]).map((row) => row.id);
  const tags = ((tagResult.results ?? []) as unknown as TagMetaRow[]).map(shapeTagMeta);

  return json({ memos, purged, tags, cursor, serverTime: nowIso() });
}
