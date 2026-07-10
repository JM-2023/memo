import { tagRenamePathsOverlap } from "../../../src/lib/tags";
import { requireAuth } from "../_utils/auth";
import { DecryptionError } from "../_utils/crypto";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import {
  InvalidTagContinuationError,
  InvalidTagTargetError,
  abandonTagOperation,
  releaseTagOperation,
  rewriteTag,
  tagOperationBusyParams,
  TagOperationBusyError,
  TagOperationConflictError,
  validTagOperationId,
  validTagPath
} from "../_utils/tagops";
import type { AppContext } from "../_utils/types";

interface RenameBody {
  from?: string;
  to?: string;
  operationId?: unknown;
  after?: unknown;
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
  if (!body || !validTagPath(from) || !validTagPath(to)) {
    return apiError(400, "TAG_INVALID", "The tag name is invalid.");
  }
  if (from === to) {
    return apiError(400, "TAG_NAME_UNCHANGED", "The new tag name is unchanged.");
  }
  // Replaying a -> a/b grows the path again; replaying a/b -> a can shrink an
  // already-rewritten descendant again. Recovery is safe only for disjoint
  // source/target subtrees.
  if (tagRenamePathsOverlap(from, to)) {
    return apiError(400, "TAG_INVALID", "A tag cannot be renamed to an ancestor or descendant of itself.");
  }

  const operationId = typeof body.operationId === "string" ? body.operationId : "";
  if (!validTagOperationId(operationId)) {
    return apiError(400, "INVALID_REQUEST_BODY", "The tag-operation id is invalid.");
  }

  if (body.after !== undefined && typeof body.after !== "string") {
    return apiError(400, "INVALID_REQUEST_BODY", "The tag-operation continuation is invalid.");
  }
  let result;
  try {
    result = await rewriteTag(context, from, to, operationId, body.after);
  } catch (error) {
    if (error instanceof InvalidTagContinuationError) {
      return apiError(400, "INVALID_REQUEST_BODY", "The tag-operation continuation is invalid.");
    }
    if (error instanceof InvalidTagTargetError) {
      await releaseTagOperation(context, operationId);
      return apiError(400, "TAG_INVALID", "The renamed tag path is too long.");
    }
    if (error instanceof TagOperationConflictError) {
      await abandonTagOperation(context, operationId);
      return apiError(409, "VERSION_CONFLICT", "A memo kept changing. Retry the tag rename.");
    }
    if (error instanceof TagOperationBusyError) {
      return apiError(
        409,
        "TAG_OPERATION_BUSY",
        "Another global tag operation is already running.",
        tagOperationBusyParams(error.blocker)
      );
    }
    if (error instanceof DecryptionError) {
      await abandonTagOperation(context, operationId);
    }
    throw error;
  }
  if (!result) {
    return apiError(404, "TAG_NOT_FOUND", "Tag not found");
  }
  return json(result);
}
