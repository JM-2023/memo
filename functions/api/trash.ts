import { requireAuth } from "./_utils/auth";
import { nextSeq } from "./_utils/memos";
import { json, requireSameOrigin } from "./_utils/response";
import type { AppContext } from "./_utils/types";

/**
 * DELETE /api/trash — empty the recycle bin: hard-delete every trashed memo
 * and its attachments. One shared tombstone seq is enough; sync only needs
 * "purged after N".
 */
export async function onRequestDelete(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const result = await context.env.DB.prepare("SELECT id FROM memos WHERE deleted_at IS NOT NULL").all<{ id: string }>();
  const ids = (result.results ?? []).map((row) => row.id);
  if (ids.length === 0) {
    return json({ ok: true, purgedIds: [] });
  }

  const seq = await nextSeq(context.env.DB);
  const statements: D1PreparedStatement[] = [];
  for (const id of ids) {
    statements.push(context.env.DB.prepare("DELETE FROM memo_images WHERE memo_id = ?").bind(id));
    statements.push(context.env.DB.prepare("INSERT OR REPLACE INTO tombstones (id, seq) VALUES (?, ?)").bind(id, seq));
  }
  statements.push(context.env.DB.prepare("DELETE FROM memos WHERE deleted_at IS NOT NULL"));
  await context.env.DB.batch(statements);

  return json({ ok: true, purgedIds: ids });
}
