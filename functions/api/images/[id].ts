import { requireAuth } from "../_utils/auth";
import { apiError } from "../_utils/response";
import type { AppContext } from "../_utils/types";

function base64ToBytes(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const id = String(context.params.id ?? "");
  // Trash keeps attachments (restore brings them back intact), so trashed
  // memos' thumbnails must keep resolving; the join only screens out orphans.
  const row = await context.env.DB
    .prepare(
      `SELECT i.mime, i.data_base64 FROM memo_images i
       JOIN memos m ON m.id = i.memo_id
       WHERE i.id = ?`
    )
    .bind(id)
    .first<{ mime: string; data_base64: string }>();
  if (!row) {
    return apiError(404, "IMAGE_NOT_FOUND", "Image not found");
  }

  return new Response(base64ToBytes(row.data_base64), {
    headers: {
      "Content-Type": row.mime,
      // Authentication and deletion must be rechecked on every request. A
      // private browser cache can otherwise outlive logout or session rotation.
      "Cache-Control": "no-store"
    }
  });
}
