import { configuredAuthState, createSessionCookie, verifyPassword } from "../_utils/auth";
import { scheduleEncryptionBackfill } from "../_utils/crypto";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface LoginBody {
  password?: string;
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  // Without this, createSessionCookie's throw lands in the catch below and a
  // missing secret masquerades as 401 "Invalid login" even for the correct
  // passcode. Server misconfiguration must not look like a wrong password.
  if (!context.env.SESSION_SECRET) {
    return apiError(500, "INTERNAL_ERROR", "The server is not configured correctly.");
  }

  const body = await readJson<LoginBody>(context.request, 20_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }
  try {
    // Hash and generation come from the same row read. A concurrent passcode
    // change can only make this cookie stale; it cannot promote the verified
    // old passcode into a cookie carrying the new generation.
    const state = await configuredAuthState(context.env);
    if (!state || !(await verifyPassword(String(body.password ?? ""), state.passwordHash))) {
      return apiError(401, "INVALID_LOGIN", "Invalid login");
    }
    // A fresh login is a natural moment to seal pre-encryption rows.
    scheduleEncryptionBackfill(context);
    return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, state.sessionGeneration) } });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The login request could not be completed.");
  }
}
