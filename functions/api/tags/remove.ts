import { isValidTagPath } from "../../../src/lib/tags";
import { requireAuth } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import { rewriteTag } from "../_utils/tagops";
import type { AppContext } from "../_utils/types";

interface RemoveBody {
  path?: string;
}

/**
 * Strip a tag (and its descendants) out of every memo's text. The memos
 * themselves stay — only the #token disappears, with one adjacent space
 * tidied away.
 */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<RemoveBody>(context.request, 10_000).catch(() => null);
  const path = String(body?.path ?? "");
  if (!body || !isValidTagPath(path)) {
    return apiError(400, "TAG_INVALID", "The tag is invalid.");
  }

  const result = await rewriteTag(context, path, null);
  if (!result) {
    return apiError(404, "TAG_NOT_FOUND", "Tag not found");
  }
  return json(result);
}
