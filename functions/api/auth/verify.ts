import { configuredAuthState, requireAuth, verifiedSession, verifyPassword } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface VerifyBody {
  password?: string;
}

/**
 * Check the current passcode for a signed-in session without changing
 * anything, so Change Passcode can reject a wrong one at its first step
 * instead of after the new passcode was typed twice. Like change-password it
 * sits behind requireAuth and the same-origin check.
 */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<VerifyBody>(context.request, 20_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }
  try {
    const state = verifiedSession(context)?.state ?? (await configuredAuthState(context.env));
    if (!state || !(await verifyPassword(String(body.password ?? ""), state.passwordHash))) {
      return apiError(401, "WRONG_CURRENT_PASSCODE", "Wrong current passcode");
    }
    return json({ ok: true });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode could not be checked.");
  }
}
