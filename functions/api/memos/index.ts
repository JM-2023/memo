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

export interface ImagePayload {
  id?: string;
  dataBase64?: string;
  mime?: string;
  width?: number;
  height?: number;
}

interface CreateBody {
  id?: string;
  content?: string;
  images?: ImagePayload[];
}

export const MAX_CONTENT_CHARS = 20_000;
export const MAX_IMAGES_PER_MEMO = 9;
// Client compresses to ≤900KB binary; base64 inflates 4/3. Anything past this
// means the client-side pipeline was bypassed, so reject rather than risk D1
// value limits.
export const MAX_IMAGE_BASE64_CHARS = 1_400_000;
const ALLOWED_MIMES = new Set(["image/webp", "image/jpeg", "image/png", "image/gif"]);
export const VALID_ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

type ImageValidationError =
  | { code: "IMAGE_LIMIT_EXCEEDED"; error: string; params: { max: number } }
  | { code: "IMAGE_TOO_LARGE" | "IMAGE_TYPE_UNSUPPORTED" | "INVALID_REQUEST_BODY"; error: string; params?: undefined };

export interface ValidatedImage {
  id: string;
  dataBase64: string;
  mime: string;
  width: number;
  height: number;
}

export function validateImages(images: ImagePayload[] | undefined): { error: ImageValidationError | null; images: ValidatedImage[] } {
  const list = Array.isArray(images) ? images : [];
  if (list.length > MAX_IMAGES_PER_MEMO) {
    return {
      error: {
        code: "IMAGE_LIMIT_EXCEEDED",
        error: `A memo can contain up to ${MAX_IMAGES_PER_MEMO} images.`,
        params: { max: MAX_IMAGES_PER_MEMO }
      },
      images: []
    };
  }
  const cleaned: ValidatedImage[] = [];
  const ids = new Set<string>();
  for (const image of list) {
    const id = image.id === undefined ? crypto.randomUUID() : String(image.id);
    const data = String(image.dataBase64 ?? "");
    const mime = String(image.mime ?? "");
    if (!VALID_ENTITY_ID.test(id) || ids.has(id)) {
      return { error: { code: "INVALID_REQUEST_BODY", error: "Image ids must be unique stable identifiers." }, images: [] };
    }
    ids.add(id);
    if (!data || data.length > MAX_IMAGE_BASE64_CHARS) {
      return { error: { code: "IMAGE_TOO_LARGE", error: "The image is too large." }, images: [] };
    }
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      return { error: { code: "INVALID_REQUEST_BODY", error: "The image payload is not valid base64." }, images: [] };
    }
    if (!ALLOWED_MIMES.has(mime)) {
      return { error: { code: "IMAGE_TYPE_UNSUPPORTED", error: "The image format is not supported." }, images: [] };
    }
    const width = Number(image.width ?? 0);
    const height = Number(image.height ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { error: { code: "INVALID_REQUEST_BODY", error: "Image dimensions are invalid." }, images: [] };
    }
    cleaned.push({
      id,
      dataBase64: data,
      mime,
      width: Math.max(0, Math.floor(width)),
      height: Math.max(0, Math.floor(height))
    });
  }
  return { error: null, images: cleaned };
}

export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

interface ExistingMemo {
  memo: MemoJson;
  creationToken: string;
  creationSeq: number;
}

async function loadExistingMemo(context: AppContext, id: string): Promise<ExistingMemo | null> {
  const [memoResult, imageResult] = await context.env.DB.batch([
    context.env.DB.prepare(`SELECT ${MEMO_COLUMNS}, creation_token, creation_seq FROM memos WHERE id = ?`).bind(id),
    context.env.DB.prepare("SELECT id, memo_id, ord, mime, width, height, bytes FROM memo_images WHERE memo_id = ? ORDER BY ord").bind(id)
  ]);
  const row = memoResult.results?.[0] as unknown as (MemoRow & { creation_token: string; creation_seq: number }) | undefined;
  if (!row) return null;
  row.content = await openContent(await contentKeyOf(context.env), row.content, row.content_format);
  return {
    memo: shapeMemo(row, (imageResult.results ?? []) as unknown as ImageMetaRow[]),
    creationToken: row.creation_token,
    creationSeq: row.creation_seq
  };
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<CreateBody>(context.request, 14_000_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }
  const memoId = body.id === undefined ? crypto.randomUUID() : String(body.id);
  if (!VALID_ENTITY_ID.test(memoId)) {
    return apiError(400, "INVALID_REQUEST_BODY", "Memo id is invalid.");
  }
  const content = String(body.content ?? "").slice(0, MAX_CONTENT_CHARS);
  const { error, images } = validateImages(body.images);
  if (error) {
    return apiError(400, error.code, error.error, error.params);
  }
  if (!content.trim() && images.length === 0) {
    return apiError(400, "MEMO_EMPTY", "A memo must contain text or at least one image.");
  }

  const now = nowIso();
  // Sealed at rest, plaintext in the response — the client never sees ciphertext.
  const contentKey = await contentKeyOf(context.env);
  const storedContent = contentKey ? await sealContent(contentKey, content) : content;
  const contentFormat = contentKey ? "enc1" : "plain";
  const mutationToken = crypto.randomUUID();
  const db = context.env.DB;
  const statements = [
    claimSeq(
      db,
      "NOT EXISTS (SELECT 1 FROM memos WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM tombstones WHERE id = ?)",
      [memoId, memoId]
    ),
    db
      .prepare(
        `INSERT INTO memos (id, content, content_format, mutation_token, creation_token, created_at, updated_at, seq, creation_seq)
         SELECT ?, ?, ?, ?, ?, ?, ?, ${CURRENT_SEQ_SQL}, ${CURRENT_SEQ_SQL}
         WHERE NOT EXISTS (SELECT 1 FROM memos WHERE id = ?)
           AND NOT EXISTS (SELECT 1 FROM tombstones WHERE id = ?)`
      )
      .bind(memoId, storedContent, contentFormat, mutationToken, memoId, now, now, memoId, memoId)
  ];
  const imageMeta: { id: string; mime: string; width: number; height: number; bytes: number }[] = [];
  images.forEach((image, index) => {
    const imageId = image.id;
    const bytes = base64Bytes(image.dataBase64);
    imageMeta.push({ id: imageId, mime: image.mime, width: image.width, height: image.height, bytes });
    statements.push(
      db
        .prepare(
          `INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM memos WHERE id = ? AND mutation_token = ?)`
        )
        .bind(imageId, memoId, index, image.mime, image.width, image.height, bytes, image.dataBase64, now, memoId, mutationToken)
    );
  });
  const results = await db.batch(statements);
  const seq = claimedSeq(results[0]);
  if (seq === null) {
    const existing = await loadExistingMemo(context, memoId);
    if (existing) {
      if (existing.creationToken !== memoId || existing.memo.seq !== existing.creationSeq) {
        return json(
          { code: "VERSION_CONFLICT", error: "The memo already exists and has changed since it was created.", current: existing.memo },
          { status: 409 }
        );
      }
      return json({ memo: existing.memo, idempotent: true });
    }
    const retired = await db.prepare("SELECT 1 AS retired FROM tombstones WHERE id = ?").bind(memoId).first<{ retired: number }>();
    if (retired) {
      return apiError(409, "MEMO_ID_RETIRED", "This memo id was permanently deleted. Retry with a new id.");
    }
    throw new Error("sync_counter row missing — run migrations");
  }

  return json({
    memo: { id: memoId, content, createdAt: now, updatedAt: now, pinnedAt: null, deletedAt: null, seq, images: imageMeta }
  });
}
