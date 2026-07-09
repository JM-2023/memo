import { requireAuth } from "../_utils/auth";
import { nextSeq } from "../_utils/memos";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

export interface ImagePayload {
  dataBase64?: string;
  mime?: string;
  width?: number;
  height?: number;
}

interface CreateBody {
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

type ImageValidationError =
  | { code: "IMAGE_LIMIT_EXCEEDED"; error: string; params: { max: number } }
  | { code: "IMAGE_TOO_LARGE" | "IMAGE_TYPE_UNSUPPORTED"; error: string; params?: undefined };

export function validateImages(images: ImagePayload[] | undefined): { error: ImageValidationError | null; images: Required<ImagePayload>[] } {
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
  const cleaned: Required<ImagePayload>[] = [];
  for (const image of list) {
    const data = String(image.dataBase64 ?? "");
    const mime = String(image.mime ?? "");
    if (!data || data.length > MAX_IMAGE_BASE64_CHARS) {
      return { error: { code: "IMAGE_TOO_LARGE", error: "The image is too large." }, images: [] };
    }
    if (!ALLOWED_MIMES.has(mime)) {
      return { error: { code: "IMAGE_TYPE_UNSUPPORTED", error: "The image format is not supported." }, images: [] };
    }
    cleaned.push({
      dataBase64: data,
      mime,
      width: Math.max(0, Math.floor(Number(image.width ?? 0))),
      height: Math.max(0, Math.floor(Number(image.height ?? 0)))
    });
  }
  return { error: null, images: cleaned };
}

export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
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
  const content = String(body.content ?? "").slice(0, MAX_CONTENT_CHARS);
  const { error, images } = validateImages(body.images);
  if (error) {
    return apiError(400, error.code, error.error, error.params);
  }
  if (!content.trim() && images.length === 0) {
    return apiError(400, "MEMO_EMPTY", "A memo must contain text or at least one image.");
  }

  const now = nowIso();
  const memoId = crypto.randomUUID();
  const seq = await nextSeq(context.env.DB);
  const statements = [
    context.env.DB
      .prepare("INSERT INTO memos (id, content, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?)")
      .bind(memoId, content, now, now, seq)
  ];
  const imageMeta: { id: string; mime: string; width: number; height: number; bytes: number }[] = [];
  images.forEach((image, index) => {
    const imageId = crypto.randomUUID();
    const bytes = base64Bytes(image.dataBase64);
    imageMeta.push({ id: imageId, mime: image.mime, width: image.width, height: image.height, bytes });
    statements.push(
      context.env.DB
        .prepare("INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(imageId, memoId, index, image.mime, image.width, image.height, bytes, image.dataBase64, now)
    );
  });
  await context.env.DB.batch(statements);

  return json({
    memo: { id: memoId, content, createdAt: now, updatedAt: now, pinnedAt: null, deletedAt: null, seq, images: imageMeta }
  });
}
