import { requireAuth } from "../_utils/auth";
import { contentKeyOf, openContent, sealContent } from "../_utils/crypto";
import {
  claimSeq,
  claimedSeq,
  CURRENT_SEQ_SQL,
  MEMO_COLUMNS,
  shapeMemo,
  type ImageMetaRow,
  type MemoJson,
  type MemoRow
} from "../_utils/memos";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";
import { base64Bytes, MAX_CONTENT_CHARS, MAX_IMAGES_PER_MEMO, validateImages, type ImagePayload } from "./index";

interface UpdateBody {
  expectedSeq?: unknown;
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

interface MemoHeaderRow {
  id: string;
  created_at: string;
  updated_at: string;
  pinned_at: string | null;
  deleted_at: string | null;
  seq: number;
}

function parseExpectedSeq(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Loads the row with content already opened — mutations fail closed on key errors. */
async function loadMemo(context: AppContext, id: string): Promise<MemoRow | null> {
  const row = await context.env.DB.prepare(`SELECT ${MEMO_COLUMNS} FROM memos WHERE id = ?`).bind(id).first<MemoRow>();
  if (row) row.content = await openContent(await contentKeyOf(context.env), row.content, row.content_format);
  return row;
}

async function loadImageMeta(context: AppContext, id: string): Promise<ImageMetaRow[]> {
  const result = await context.env.DB
    .prepare("SELECT id, memo_id, ord, mime, width, height, bytes FROM memo_images WHERE memo_id = ? ORDER BY ord")
    .bind(id)
    .all<ImageMetaRow>();
  return result.results ?? [];
}

async function currentMemoJson(context: AppContext, id: string, known?: MemoRow | null): Promise<MemoJson | null> {
  const memo = known === undefined ? await loadMemo(context, id) : known;
  return memo ? shapeMemo(memo, await loadImageMeta(context, id)) : null;
}

function versionConflict(current: MemoJson | null): Response {
  return json({ code: "VERSION_CONFLICT", error: "The memo changed on another client.", current }, { status: 409 });
}

export async function onRequestPut(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<UpdateBody>(context.request, 14_000_000).catch(() => null);
  if (!body) return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  const expectedSeq = parseExpectedSeq(body.expectedSeq);
  if (expectedSeq === null) return apiError(400, "INVALID_REQUEST_BODY", "expectedSeq is required.");
  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    return apiError(400, "INVALID_REQUEST_BODY", "pinned must be boolean.");
  }

  const id = String(context.params.id ?? "");
  const requestedPinOnly =
    typeof body.pinned === "boolean" &&
    body.restore !== true &&
    body.content === undefined &&
    (!Array.isArray(body.removeImageIds) || body.removeImageIds.length === 0) &&
    (!Array.isArray(body.addImages) || body.addImages.length === 0);

  if (requestedPinOnly) {
    const header = await context.env.DB
      .prepare("SELECT id, created_at, updated_at, pinned_at, deleted_at, seq FROM memos WHERE id = ?")
      .bind(id)
      .first<MemoHeaderRow>();
    if (!header) return apiError(404, "MEMO_NOT_FOUND", "Memo not found");
    if (header.seq !== expectedSeq) return versionConflict(await currentMemoJson(context, id));
    if (header.deleted_at !== null) return apiError(409, "MEMO_TRASHED", "Restore the memo from the recycle bin before editing it.");

    const wantsPinned = body.pinned === true;
    if (Boolean(header.pinned_at) === wantsPinned) {
      return json({ memoPatch: { id, pinnedAt: header.pinned_at, seq: header.seq } });
    }
    const pinnedAt = wantsPinned ? nowIso() : null;
    const db = context.env.DB;
    const results = await db.batch([
      claimSeq(db, "EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NULL)", [id, expectedSeq]),
      db
        .prepare(`UPDATE memos SET pinned_at = ?, seq = ${CURRENT_SEQ_SQL} WHERE id = ? AND seq = ? AND deleted_at IS NULL`)
        .bind(pinnedAt, id, expectedSeq)
    ]);
    const seq = claimedSeq(results[0]);
    if (seq === null) return versionConflict(await currentMemoJson(context, id));
    return json({ memoPatch: { id, pinnedAt, seq } });
  }

  const memo = await loadMemo(context, id);
  if (!memo) return apiError(404, "MEMO_NOT_FOUND", "Memo not found");
  if (memo.seq !== expectedSeq) return versionConflict(await currentMemoJson(context, id, memo));

  const db = context.env.DB;
  if (body.restore === true) {
    if (memo.deleted_at === null) return json({ memo: shapeMemo(memo, await loadImageMeta(context, id)) });
    const results = await db.batch([
      claimSeq(db, "EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NOT NULL)", [id, expectedSeq]),
      db
        .prepare(`UPDATE memos SET deleted_at = NULL, seq = ${CURRENT_SEQ_SQL} WHERE id = ? AND seq = ? AND deleted_at IS NOT NULL`)
        .bind(id, expectedSeq)
    ]);
    const seq = claimedSeq(results[0]);
    if (seq === null) return versionConflict(await currentMemoJson(context, id));
    memo.deleted_at = null;
    memo.seq = seq;
    return json({ memo: shapeMemo(memo, await loadImageMeta(context, id)) });
  }
  if (memo.deleted_at !== null) return apiError(409, "MEMO_TRASHED", "Restore the memo from the recycle bin before editing it.");

  const removeIds = [...new Set(Array.isArray(body.removeImageIds) ? body.removeImageIds.map(String) : [])];
  const { error, images: addImages } = validateImages(body.addImages);
  if (error) return apiError(400, error.code, error.error, error.params);

  const existing = await loadImageMeta(context, id);
  const existingById = new Map(existing.map((image) => [image.id, image]));
  const actuallyRemoved = removeIds.filter((imageId) => existingById.has(imageId));
  const removed = new Set(actuallyRemoved);
  const surviving = existing.filter((row) => !removed.has(row.id));
  if (addImages.some((image) => existingById.has(image.id) && !removed.has(image.id))) {
    return apiError(400, "INVALID_REQUEST_BODY", "A new image id already exists on this memo.");
  }
  if (surviving.length + addImages.length > MAX_IMAGES_PER_MEMO) {
    return apiError(400, "IMAGE_LIMIT_EXCEEDED", `A memo can contain up to ${MAX_IMAGES_PER_MEMO} images.`, { max: MAX_IMAGES_PER_MEMO });
  }

  const nextContent = body.content === undefined ? memo.content : String(body.content);
  if (nextContent.length > MAX_CONTENT_CHARS) {
    return apiError(400, "MEMO_CONTENT_TOO_LONG", `A memo can contain up to ${MAX_CONTENT_CHARS} characters.`, {
      max: MAX_CONTENT_CHARS
    });
  }
  if (!nextContent.trim() && surviving.length + addImages.length === 0) {
    return apiError(400, "MEMO_EMPTY", "A memo must contain text or at least one image.");
  }

  const contentChanged = nextContent !== memo.content;
  const imagesChanged = actuallyRemoved.length > 0 || addImages.length > 0;
  const wantsPinned = body.pinned === undefined ? Boolean(memo.pinned_at) : body.pinned;
  const pinChanged = body.pinned !== undefined && Boolean(memo.pinned_at) !== wantsPinned;
  if (!contentChanged && !imagesChanged && !pinChanged) return json({ memo: shapeMemo(memo, existing) });

  const now = nowIso();
  const mutationToken = crypto.randomUUID();
  const updatedAt = contentChanged || imagesChanged ? now : memo.updated_at;
  const pinnedAt = pinChanged ? (wantsPinned ? now : null) : memo.pinned_at;
  const setClauses: string[] = [];
  const updateBindings: unknown[] = [];
  let contentFormat = memo.content_format;
  if (contentChanged) {
    const key = await contentKeyOf(context.env);
    const stored = key ? await sealContent(key, nextContent) : nextContent;
    contentFormat = key ? "enc1" : "plain";
    setClauses.push("content = ?", "content_format = ?");
    updateBindings.push(stored, contentFormat);
  }
  if (contentChanged || imagesChanged) {
    setClauses.push("updated_at = ?");
    updateBindings.push(updatedAt);
  }
  if (pinChanged) {
    setClauses.push("pinned_at = ?");
    updateBindings.push(pinnedAt);
  }
  setClauses.push(`seq = ${CURRENT_SEQ_SQL}`, "mutation_token = ?");
  updateBindings.push(mutationToken);

  const statements: D1PreparedStatement[] = [
    claimSeq(db, "EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NULL)", [id, expectedSeq]),
    db
      .prepare(`UPDATE memos SET ${setClauses.join(", ")} WHERE id = ? AND seq = ? AND deleted_at IS NULL`)
      .bind(...updateBindings, id, expectedSeq)
  ];
  for (const removeId of actuallyRemoved) {
    statements.push(
      db
        .prepare("DELETE FROM memo_images WHERE memo_id = ? AND id = ? AND EXISTS (SELECT 1 FROM memos WHERE id = ? AND mutation_token = ?)")
        .bind(id, removeId, id, mutationToken)
    );
  }
  if (actuallyRemoved.length > 0) {
    surviving.forEach((row, index) =>
      statements.push(
        db
          .prepare("UPDATE memo_images SET ord = ? WHERE memo_id = ? AND id = ? AND EXISTS (SELECT 1 FROM memos WHERE id = ? AND mutation_token = ?)")
          .bind(index, id, row.id, id, mutationToken)
      )
    );
  }

  const imageMeta: ImageMetaRow[] = surviving.map((row, index) => ({ ...row, ord: actuallyRemoved.length > 0 ? index : row.ord }));
  addImages.forEach((image, index) => {
    const ord = surviving.length + index;
    const bytes = base64Bytes(image.dataBase64);
    imageMeta.push({ id: image.id, memo_id: id, ord, mime: image.mime, width: image.width, height: image.height, bytes });
    statements.push(
      db
        .prepare(
          `INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM memos WHERE id = ? AND mutation_token = ?)`
        )
        .bind(image.id, id, ord, image.mime, image.width, image.height, bytes, image.dataBase64, now, id, mutationToken)
    );
  });

  const results = await db.batch(statements);
  const seq = claimedSeq(results[0]);
  if (seq === null) return versionConflict(await currentMemoJson(context, id));
  return json({
    memo: shapeMemo(
      {
        id,
        content: nextContent,
        content_format: contentFormat,
        created_at: memo.created_at,
        updated_at: updatedAt,
        pinned_at: pinnedAt,
        deleted_at: null,
        seq
      },
      imageMeta
    )
  });
}

export async function onRequestDelete(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const url = new URL(context.request.url);
  const expectedSeq = parseExpectedSeq(url.searchParams.get("expectedSeq"));
  if (expectedSeq === null) return apiError(400, "INVALID_REQUEST_BODY", "expectedSeq is required.");
  const permanent = url.searchParams.get("permanent") === "1";
  const id = String(context.params.id ?? "");
  const memo = await loadMemo(context, id);
  if (!memo) {
    if (permanent) {
      const tombstone = await context.env.DB.prepare("SELECT id, seq FROM tombstones WHERE id = ?").bind(id).first<{ id: string; seq: number }>();
      if (tombstone) return json({ ok: true, purged: [tombstone], purgedIds: [id], idempotent: true });
    }
    return apiError(404, "MEMO_NOT_FOUND", "Memo not found");
  }
  if (memo.seq !== expectedSeq) return versionConflict(await currentMemoJson(context, id, memo));

  const db = context.env.DB;
  if (permanent) {
    if (memo.deleted_at === null) {
      return apiError(409, "MEMO_NOT_TRASHED", "Move the memo to Trash before permanently deleting it.");
    }
    const predicate = "EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NOT NULL)";
    const results = await db.batch([
      claimSeq(db, predicate, [id, expectedSeq]),
      db
        .prepare(
          `INSERT OR REPLACE INTO tombstones (id, seq)
           SELECT ?, ${CURRENT_SEQ_SQL} WHERE EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NOT NULL)
           RETURNING id, seq`
        )
        .bind(id, id, expectedSeq),
      db
        .prepare("DELETE FROM memo_images WHERE memo_id = ? AND EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NOT NULL)")
        .bind(id, id, expectedSeq),
      db.prepare("DELETE FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NOT NULL").bind(id, expectedSeq)
    ]);
    const seq = claimedSeq(results[0]);
    if (seq === null) return versionConflict(await currentMemoJson(context, id));
    return json({ ok: true, purged: [{ id, seq }], purgedIds: [id] });
  }

  if (memo.deleted_at !== null) return json({ ok: true, memo: shapeMemo(memo, await loadImageMeta(context, id)) });
  const deletedAt = nowIso();
  const results = await db.batch([
    claimSeq(db, "EXISTS (SELECT 1 FROM memos WHERE id = ? AND seq = ? AND deleted_at IS NULL)", [id, expectedSeq]),
    db
      .prepare(`UPDATE memos SET deleted_at = ?, seq = ${CURRENT_SEQ_SQL} WHERE id = ? AND seq = ? AND deleted_at IS NULL`)
      .bind(deletedAt, id, expectedSeq)
  ]);
  const seq = claimedSeq(results[0]);
  if (seq === null) return versionConflict(await currentMemoJson(context, id));
  memo.deleted_at = deletedAt;
  memo.seq = seq;
  return json({ ok: true, memo: shapeMemo(memo, await loadImageMeta(context, id)) });
}
