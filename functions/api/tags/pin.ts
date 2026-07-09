import { isValidTagPath } from "../../../src/lib/tags";
import { requireAuth } from "../_utils/auth";
import { nextSeq, shapeTagMeta } from "../_utils/memos";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface PinBody {
  path?: string;
  pinned?: boolean;
}

/** Pin / unpin a tag path. Meta rows are upserted, never deleted. */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<PinBody>(context.request, 10_000).catch(() => null);
  const path = String(body?.path ?? "");
  if (!body || !isValidTagPath(path) || typeof body.pinned !== "boolean") {
    return apiError(400, "TAG_INVALID", "The tag is invalid.");
  }

  const now = nowIso();
  const pinnedAt = body.pinned ? now : null;
  const seq = await nextSeq(context.env.DB);
  await context.env.DB
    .prepare(
      `INSERT INTO tag_meta (path, pinned_at, updated_at, seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET pinned_at = excluded.pinned_at, updated_at = excluded.updated_at, seq = excluded.seq`
    )
    .bind(path, pinnedAt, now, seq)
    .run();

  return json({ tag: shapeTagMeta({ path, pinned_at: pinnedAt, seq }) });
}
