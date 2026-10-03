import { authRequiredResponse, readSessionClaims, requireAuth } from "../_utils/auth";
import { apiError } from "../_utils/response";
import type { AppContext } from "../_utils/types";

function base64ToBytes(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

interface ImageRow {
  mime: string;
  data_base64: string;
  variant: "preview" | "original";
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const id = String(context.params.id ?? "");
  // `?size=thumb` serves the small preview the feed grid draws. Rows stored
  // before previews existed have none and fall back to the original bytes.
  const thumb = new URL(context.request.url).searchParams.get("size") === "thumb";

  let claims: { gen: number } | null;
  try {
    claims = await readSessionClaims(context.env, context.request);
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Authentication could not be verified.");
  }
  if (!claims) return authRequiredResponse();

  // The cookie is checked locally; its generation and the image row are read
  // in one D1 batch, so a feed tile costs one round trip instead of two.
  // Trash keeps attachments (restore brings them back intact), so trashed
  // memos' thumbnails must keep resolving; the join only screens out orphans.
  const db = context.env.DB.withSession("first-primary");
  let generation: { session_generation: number } | undefined;
  let row: ImageRow | undefined;
  try {
    const [authResult, imageResult] = await db.batch([
      db.prepare("SELECT session_generation FROM auth_state WHERE id = 1"),
      db
        .prepare(
          thumb
            ? `SELECT COALESCE(i.thumb_mime, i.mime) AS mime, COALESCE(i.thumb_base64, i.data_base64) AS data_base64,
                 CASE WHEN i.thumb_base64 IS NULL THEN 'original' ELSE 'preview' END AS variant
               FROM memo_images i JOIN memos m ON m.id = i.memo_id WHERE i.id = ?`
            : `SELECT i.mime, i.data_base64, 'original' AS variant FROM memo_images i JOIN memos m ON m.id = i.memo_id WHERE i.id = ?`
        )
        .bind(id)
    ]);
    generation = authResult.results?.[0] as { session_generation: number } | undefined;
    row = imageResult.results?.[0] as ImageRow | undefined;
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The image could not be read.");
  }

  if (!generation) {
    // A fresh deployment seeds auth_state lazily from APP_PASSWORD_HASH; let
    // the full gate do that once rather than duplicating the seed here.
    const denied = await requireAuth(context);
    if (denied) return denied;
  } else if (Number(generation.session_generation) !== claims.gen) {
    return authRequiredResponse();
  }

  if (!row) {
    return apiError(404, "IMAGE_NOT_FOUND", "Image not found");
  }

  return new Response(base64ToBytes(row.data_base64), {
    headers: {
      "Content-Type": row.mime,
      // Which bytes these are: a `?size=thumb` request for a row without a
      // preview gets the original, and the client derives one from it.
      "X-Image-Variant": row.variant,
      // Authentication and deletion must be rechecked on every request. A
      // private browser cache can otherwise outlive logout or session rotation.
      // The client keeps its own sealed copy of feed previews instead.
      "Cache-Control": "no-store"
    }
  });
}
