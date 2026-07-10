import { requireAuth } from "./_utils/auth";
import { contentKeyOf } from "./_utils/crypto";
import { json, requireSameOrigin } from "./_utils/response";
import type { AppContext } from "./_utils/types";

/**
 * Empty Trash as one set-based transaction. The selected set cannot change
 * between tombstone creation, attachment deletion, and memo deletion. Each
 * tombstone receives its own seq so sync pages remain strictly bounded.
 */
export async function onRequestDelete(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  // Empty Trash never needs plaintext, but it is irreversible. Validate the
  // deployment key first so a stale page cannot destroy encrypted rows while
  // the server is running with a missing or rotated MEMO_ENC_KEY.
  await contentKeyOf(context.env);

  const db = context.env.DB;
  const results = await db.batch([
    db.prepare(
      `UPDATE sync_counter
       SET n = n + (SELECT COUNT(*) FROM memos WHERE deleted_at IS NOT NULL)
       WHERE id = 1 AND EXISTS (SELECT 1 FROM memos WHERE deleted_at IS NOT NULL)
       RETURNING n`
    ),
    db.prepare(
      `INSERT OR REPLACE INTO tombstones (id, seq)
       SELECT id,
              (SELECT n FROM sync_counter WHERE id = 1)
                - (SELECT COUNT(*) FROM memos WHERE deleted_at IS NOT NULL)
                + ROW_NUMBER() OVER (ORDER BY id)
       FROM memos
       WHERE deleted_at IS NOT NULL
       RETURNING id, seq`
    ),
    db.prepare("DELETE FROM memo_images WHERE memo_id IN (SELECT id FROM memos WHERE deleted_at IS NOT NULL)"),
    db.prepare("DELETE FROM memos WHERE deleted_at IS NOT NULL")
  ]);

  const purged = ((results[1]?.results ?? []) as unknown as { id: string; seq: number }[]).sort((left, right) => left.seq - right.seq);
  return json({ ok: true, purged, purgedIds: purged.map((row) => row.id) });
}
