import { isValidTagPath } from "../../../src/lib/tags";
import { requireAuth } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import { rewriteTag } from "../_utils/tagops";
import type { AppContext } from "../_utils/types";

interface RenameBody {
  from?: string;
  to?: string;
}

/**
 * Rename a tag everywhere: every memo containing #from (or a descendant
 * #from/…) is rewritten server-side, pin state moves with it, and the whole
 * change syncs to other devices as ordinary memo/tag updates. Renaming onto
 * an existing tag merges the two.
 */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<RenameBody>(context.request, 10_000).catch(() => null);
  const from = String(body?.from ?? "");
  const to = String(body?.to ?? "");
  if (!body || !isValidTagPath(from) || !isValidTagPath(to)) {
    return apiError(400, "TAG_INVALID", "The tag name is invalid.");
  }
  if (from === to) {
    return apiError(400, "TAG_NAME_UNCHANGED", "The new tag name is unchanged.");
  }

  const result = await rewriteTag(context, from, to);
  if (!result) {
    return apiError(404, "TAG_NOT_FOUND", "Tag not found");
  }
  return json(result);
}
