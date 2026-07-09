import { requireAuth } from "../_utils/auth";
import { contentKeyOf, openContent, sealContent } from "../_utils/crypto";
import { MEMO_COLUMNS, nextSeq, shapeMemo, type ImageMetaRow, type MemoRow } from "../_utils/memos";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";
import { base64Bytes, MAX_CONTENT_CHARS, MAX_IMAGES_PER_MEMO, validateImages, type ImagePayload } from "./index";

interface UpdateBody {
  content?: string;
  /** New attachments appended after the surviving existing ones. */
  addImages?: ImagePayload[];
  /** Existing attachment ids to remove. */
  removeImageIds?: string[];
  /** Present = set pin state; absent = leave alone. Pinning is not an edit. */
  pinned?: boolean;
  /** true = pull the memo back out of the trash; other fields are ignored. */
  restore?: boolean;
}

/** Loads the row with content already opened — every consumer wants plaintext. */
async function loadMemo(context: AppContext, id: string): Promise<MemoRow | null> {
  const row = await context.env.DB.prepare(`SELECT ${MEMO_COLUMNS} FROM memos WHERE id = ?`).bind(id).first<MemoRow>();
  if (row) {
    row.content = await openContent(await contentKeyOf(context.env), row.content);
  }
  return row;
}

async function loadImageMeta(context: AppContext, id: string): Promise<ImageMetaRow[]> {
  const result = await context.env.DB
    .prepare("SELECT id, memo_id, ord, mime, width, height, bytes FROM memo_images WHERE memo_id = ? ORDER BY ord")
    .bind(id)
    .all<ImageMetaRow>();
  return result.results ?? [];
}

export async function onRequestPut(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const id = String(context.params.id ?? "");
  const memo = await loadMemo(context, id);
  if (!memo) {
    return apiError(404, "MEMO_NOT_FOUND", "Memo not found");
  }

  const body = await readJson<UpdateBody>(context.request, 14_000_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }

  if (body.restore === true) {
    if (memo.deleted_at !== null) {
      const seq = await nextSeq(context.env.DB);
      await context.env.DB.prepare("UPDATE memos SET deleted_at = NULL, seq = ? WHERE id = ?").bind(seq, id).run();
      memo.deleted_at = null;
      memo.seq = seq;
    }
    return json({ memo: shapeMemo(memo, await loadImageMeta(context, id)) });
  }
  if (memo.deleted_at !== null) {
    return apiError(409, "MEMO_TRASHED", "Restore the memo from the recycle bin before editing it.");
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  const removeIds = Array.isArray(body.removeImageIds) ? body.removeImageIds.map(String) : [];
  const { error, images: addImages } = validateImages(body.addImages);
  if (error) {
    return apiError(400, error.code, error.error, error.params);
  }

  const existing = await loadImageMeta(context, id);
  const surviving = existing.filter((row) => !removeIds.includes(row.id));
  if (surviving.length + addImages.length > MAX_IMAGES_PER_MEMO) {
    return apiError(400, "IMAGE_LIMIT_EXCEEDED", `A memo can contain up to ${MAX_IMAGES_PER_MEMO} images.`, {
      max: MAX_IMAGES_PER_MEMO
    });
  }

  const nextContent = body.content === undefined ? memo.content : String(body.content).slice(0, MAX_CONTENT_CHARS);
  if (!nextContent.trim() && surviving.length + addImages.length === 0) {
    return apiError(400, "MEMO_EMPTY", "A memo must contain text or at least one image.");
  }

  for (const removeId of removeIds) {
    statements.push(context.env.DB.prepare("DELETE FROM memo_images WHERE memo_id = ? AND id = ?").bind(id, removeId));
  }
  // Reorder survivors, then append new attachments after them.
  surviving.forEach((row, index) => {
    statements.push(context.env.DB.prepare("UPDATE memo_images SET ord = ? WHERE id = ?").bind(index, row.id));
  });
  const imageMeta: ImageMetaRow[] = surviving.map((row) => ({ ...row }));
  addImages.forEach((image, index) => {
    const imageId = crypto.randomUUID();
    const bytes = base64Bytes(image.dataBase64);
    imageMeta.push({ id: imageId, memo_id: id, ord: surviving.length + index, mime: image.mime, width: image.width, height: image.height, bytes });
    statements.push(
      context.env.DB
        .prepare("INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(imageId, id, surviving.length + index, image.mime, image.width, image.height, bytes, image.dataBase64, now)
    );
  });

  // "编辑时间" only moves for real content/attachment changes — pin toggles
  // must not reshuffle an updated-time sort.
  const contentChanged = nextContent !== memo.content;
  const imagesChanged = removeIds.length > 0 || addImages.length > 0;
  const updatedAt = contentChanged || imagesChanged ? now : memo.updated_at;
  const pinnedAt = body.pinned === undefined ? memo.pinned_at : body.pinned ? now : null;
  const contentKey = await contentKeyOf(context.env);
  const storedContent = contentKey ? await sealContent(contentKey, nextContent) : nextContent;
  const seq = await nextSeq(context.env.DB);
  statements.push(
    context.env.DB
      .prepare("UPDATE memos SET content = ?, updated_at = ?, pinned_at = ?, seq = ? WHERE id = ?")
      .bind(storedContent, updatedAt, pinnedAt, seq, id)
  );
  await context.env.DB.batch(statements);

  return json({
    memo: shapeMemo(
      { id, content: nextContent, created_at: memo.created_at, updated_at: updatedAt, pinned_at: pinnedAt, deleted_at: null, seq },
      imageMeta
    )
  });
}

export async function onRequestDelete(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const id = String(context.params.id ?? "");
  const memo = await loadMemo(context, id);
  if (!memo) {
    return apiError(404, "MEMO_NOT_FOUND", "Memo not found");
  }

  const permanent = new URL(context.request.url).searchParams.get("permanent") === "1";
  if (permanent) {
    // Hard delete: row + attachments gone for good; only an id-sized
    // tombstone remains so other devices learn to drop it on next sync.
    const seq = await nextSeq(context.env.DB);
    await context.env.DB.batch([
      context.env.DB.prepare("DELETE FROM memo_images WHERE memo_id = ?").bind(id),
      context.env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(id),
      context.env.DB.prepare("INSERT OR REPLACE INTO tombstones (id, seq) VALUES (?, ?)").bind(id, seq)
    ]);
    return json({ ok: true, purgedIds: [id] });
  }

  // Move to trash. Attachments stay so a restore brings the memo back whole.
  if (memo.deleted_at === null) {
    const seq = await nextSeq(context.env.DB);
    const deletedAt = nowIso();
    await context.env.DB.prepare("UPDATE memos SET deleted_at = ?, seq = ? WHERE id = ?").bind(deletedAt, seq, id).run();
    memo.deleted_at = deletedAt;
    memo.seq = seq;
  }
  return json({ ok: true, memo: shapeMemo(memo, await loadImageMeta(context, id)) });
}
