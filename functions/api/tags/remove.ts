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

interface RemoveBody {
  path?: string;
  operationId?: unknown;
  after?: unknown;
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
  if (!body || !validTagPath(path)) {
    return apiError(400, "TAG_INVALID", "The tag is invalid.");
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
    result = await rewriteTag(context, path, null, operationId, body.after);
  } catch (error) {
    if (error instanceof InvalidTagContinuationError) {
      return apiError(400, "INVALID_REQUEST_BODY", "The tag-operation continuation is invalid.");
    }
    if (error instanceof InvalidTagTargetError) {
      await releaseTagOperation(context, operationId);
      return apiError(400, "TAG_INVALID", "The tag path is too long.");
    }
    if (error instanceof TagOperationConflictError) {
      await abandonTagOperation(context, operationId);
      return apiError(409, "VERSION_CONFLICT", "A memo kept changing. Retry the tag removal.");
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
