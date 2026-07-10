import { isValidTagPath } from "../../../src/lib/tags";
import { requireAuth } from "../_utils/auth";
import { claimSeq, claimedSeq, shapeTagMeta } from "../_utils/memos";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "../_utils/response";
import { getBlockingTagOperation, tagOperationBusyParams } from "../_utils/tagops";
import type { AppContext } from "../_utils/types";

interface PinBody {
  path?: string;
  pinned?: boolean;
}

export const MAX_TAG_PATH_BYTES = 128;
const utf8 = new TextEncoder();

export function validTagPath(path: string): boolean {
  return isValidTagPath(path) && utf8.encode(path).byteLength <= MAX_TAG_PATH_BYTES;
}

/** Pin / unpin a tag path. Meta rows are upserted, never deleted. */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<PinBody>(context.request, 10_000).catch(() => null);
  const path = String(body?.path ?? "");
  if (!body || !validTagPath(path) || typeof body.pinned !== "boolean") {
    return apiError(400, "TAG_INVALID", "The tag is invalid.");
  }
  const now = nowIso();
  const pinnedAt = body.pinned ? now : null;
  const db = context.env.DB;
  const statePredicate = body.pinned
    ? "NOT EXISTS (SELECT 1 FROM tag_meta WHERE path = ? AND pinned_at IS NOT NULL)"
    : "EXISTS (SELECT 1 FROM tag_meta WHERE path = ? AND pinned_at IS NOT NULL)";
  const predicate = `(${statePredicate}) AND NOT EXISTS (
    SELECT 1 FROM tag_operation_lock WHERE id = 1 AND completed = 0
  )`;
  const results = await db.batch([
    claimSeq(db, predicate, [path]),
    db
      .prepare(
        `INSERT OR REPLACE INTO tag_meta (path, pinned_at, updated_at, seq)
         SELECT ?, ?, ?, n FROM sync_counter WHERE id = 1 AND (${predicate})`
      )
      .bind(path, pinnedAt, now, path),
    db.prepare("SELECT EXISTS(SELECT 1 FROM tag_operation_lock WHERE id = 1 AND completed = 0) AS active")
  ]);
  const seq = claimedSeq(results[0]);
  if (seq === null) {
    const current = await db.prepare("SELECT path, pinned_at, seq FROM tag_meta WHERE path = ?").bind(path).first<{
      path: string;
      pinned_at: string | null;
      seq: number;
    }>();
    const alreadyDesired = body.pinned ? Boolean(current?.pinned_at) : !current?.pinned_at;
    const lockWasActive = Boolean((results[2]?.results?.[0] as { active?: unknown } | undefined)?.active);
    if (!alreadyDesired && lockWasActive) {
      return apiError(
        409,
        "TAG_OPERATION_BUSY",
        "A global tag rename or removal is still running.",
        tagOperationBusyParams(await getBlockingTagOperation(context))
      );
    }
    if (!alreadyDesired) {
      throw new Error("sync_counter row missing — run migrations");
    }
    return json({ tag: current ? shapeTagMeta(current) : shapeTagMeta({ path, pinned_at: null, seq: 0 }), idempotent: true });
  }

  return json({ tag: shapeTagMeta({ path, pinned_at: pinnedAt, seq }) });
}
