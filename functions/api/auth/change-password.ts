import { bumpSessionGeneration, createSessionCookie, hashPassword, requireAuth, savePasswordHash, verifyLocalPassword } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface ChangeBody {
  current?: string;
  next?: string;
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<ChangeBody>(context.request, 20_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }
  const current = String(body.current ?? "");
  const next = String(body.next ?? "");
  if (!/^\d{4,18}$/.test(next)) {
    return apiError(400, "PASSCODE_INVALID", "Passcode must be 4-18 digits");
  }

  try {
    if (!(await verifyLocalPassword(context.env, current))) {
      return apiError(401, "WRONG_CURRENT_PASSCODE", "Wrong current passcode");
    }
    await savePasswordHash(context.env, await hashPassword(next));
    // Sign every other device out; then mint a fresh cookie for this one.
    await bumpSessionGeneration(context.env);
    return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env) } });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode could not be changed.");
  }
}
