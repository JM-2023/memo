import { changePasswordAtomically, configuredAuthState, createSessionCookie, hashPassword, requireAuth, verifyPassword } from "../_utils/auth";
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
    const state = await configuredAuthState(context.env);
    if (!state || !(await verifyPassword(current, state.passwordHash))) {
      return apiError(401, "WRONG_CURRENT_PASSCODE", "Wrong current passcode");
    }
    const changed = await changePasswordAtomically(context.env, state, await hashPassword(next));
    if (!changed) {
      return apiError(409, "WRONG_CURRENT_PASSCODE", "The passcode changed before this request completed. Try again.");
    }
    // The conditional update signs every other device out; this request gets a
    // cookie carrying the exact generation returned by that same statement.
    return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, changed.sessionGeneration) } });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode could not be changed.");
  }
}
