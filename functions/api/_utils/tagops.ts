// Shared machinery for tag rename / remove: both rewrite the #tag tokens
// inside memo contents (tags have no table of their own — the content IS the
// source of truth) and migrate any pin state in tag_meta along with them.

import { renameTagInContent } from "../../../src/lib/tags";
import { contentKeyOf, sealContent, openContent } from "./crypto";
import { groupImages, MEMO_COLUMNS, nextSeq, shapeMemo, shapeTagMeta, type ImageMetaRow, type MemoJson, type MemoRow, type TagMetaJson } from "./memos";
import { nowIso } from "./response";
import type { AppContext } from "./types";

interface RewriteResult {
  memos: MemoJson[];
  tags: TagMetaJson[];
  updated: number;
}

/**
 * Rewrite `#from` (and descendants) to `#to` in every memo — trashed ones
 * included, so a restore comes back consistent. `to === null` removes the
 * tag. All touched rows share one fresh seq; the response carries the full
 * updated memos + tag_meta rows so the caller can apply them like a sync
 * payload.
 */
export async function rewriteTag(context: AppContext, from: string, to: string | null): Promise<RewriteResult | null> {
  const db = context.env.DB;
  const [memoResult, metaResult] = await db.batch([
    db.prepare(`SELECT ${MEMO_COLUMNS} FROM memos`),
    db.prepare("SELECT path, pinned_at FROM tag_meta WHERE path = ?1 OR path LIKE ?1 || '/%'").bind(from)
  ]);

  const rows = (memoResult.results ?? []) as unknown as MemoRow[];
  const metaRows = (metaResult.results ?? []) as unknown as { path: string; pinned_at: string | null }[];

  const now = nowIso();
  const contentKey = await contentKeyOf(context.env);
  const changed: MemoRow[] = [];
  for (const row of rows) {
    // Rewrites happen on plaintext; `changed` keeps plaintext for the response
    // and gets re-sealed only in the UPDATE binding below.
    const plain = await openContent(contentKey, row.content);
    const next = renameTagInContent(plain, from, to);
    if (next !== plain) changed.push({ ...row, content: next, updated_at: now });
  }
  if (changed.length === 0 && metaRows.every((row) => row.pinned_at === null)) {
    return null;
  }

  // Final pin states computed in JS so the response mirrors the DB exactly:
  // source rows go dormant (pin cleared), their pin lands on the mapped path
  // — unless the target already holds a pin of its own (merge keeps it).
  const finalStates = new Map<string, string | null>();
  if (to !== null && metaRows.some((row) => row.pinned_at !== null)) {
    const targetPaths = metaRows.map((row) => `${to}${row.path.slice(from.length)}`);
    const placeholders = targetPaths.map((_, index) => `?${index + 1}`).join(", ");
    const existing = await db
      .prepare(`SELECT path, pinned_at FROM tag_meta WHERE path IN (${placeholders})`)
      .bind(...targetPaths)
      .all<{ path: string; pinned_at: string | null }>();
    for (const row of existing.results ?? []) finalStates.set(row.path, row.pinned_at);
  }
  // Two passes: clear every source first, then land the pins — otherwise a
  // rename into its own subtree (欢迎 → 欢迎/子) could clobber a migrated pin.
  for (const row of metaRows) finalStates.set(row.path, null);
  if (to !== null) {
    for (const row of metaRows) {
      const target = `${to}${row.path.slice(from.length)}`;
      finalStates.set(target, finalStates.get(target) ?? row.pinned_at);
    }
  }

  const seq = await nextSeq(db);
  const statements: D1PreparedStatement[] = [];
  for (const row of changed) {
    const stored = contentKey ? await sealContent(contentKey, row.content) : row.content;
    statements.push(db.prepare("UPDATE memos SET content = ?, updated_at = ?, seq = ? WHERE id = ?").bind(stored, row.updated_at, seq, row.id));
  }
  const tags: TagMetaJson[] = [];
  for (const [path, pinnedAt] of finalStates) {
    tags.push(shapeTagMeta({ path, pinned_at: pinnedAt, seq }));
    statements.push(
      db
        .prepare(
          `INSERT INTO tag_meta (path, pinned_at, updated_at, seq) VALUES (?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET pinned_at = excluded.pinned_at, updated_at = excluded.updated_at, seq = excluded.seq`
        )
        .bind(path, pinnedAt, now, seq)
    );
  }
  if (statements.length > 0) {
    changed.forEach((row) => {
      row.seq = seq;
    });
    await db.batch(statements);
  }

  // Attachment meta for the response (image binaries never leave their rows).
  let imagesByMemo = new Map<string, ImageMetaRow[]>();
  if (changed.length > 0) {
    const imageResult = await db.prepare("SELECT id, memo_id, ord, mime, width, height, bytes FROM memo_images ORDER BY memo_id, ord").all<ImageMetaRow>();
    imagesByMemo = groupImages(imageResult.results ?? []);
  }

  return {
    memos: changed.map((row) => shapeMemo(row, imagesByMemo.get(row.id) ?? [])),
    tags,
    updated: changed.length
  };
}
