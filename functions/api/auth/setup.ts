import { configuredPasswordHash, createSessionCookie, hashPassword, savePasswordHash } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface SetupBody {
  password?: string;
}

function validPin(value: string): boolean {
  return /^\d{4}$/.test(value);
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  // Checked up front: createSessionCookie throws without it, and an unhandled
  // throw surfaces in the UI as an unreadable generic failure.
  if (!context.env.SESSION_SECRET) {
    return apiError(500, "INTERNAL_ERROR", "The server is not configured correctly.");
  }

  try {
    if (await configuredPasswordHash(context.env)) {
      return apiError(409, "PASSCODE_ALREADY_CONFIGURED", "Passcode already configured");
    }
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode configuration could not be checked.");
  }

  const body = await readJson<SetupBody>(context.request, 20_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }
  const password = String(body.password ?? "");
  if (!validPin(password)) {
    return apiError(400, "PASSCODE_INVALID", "Passcode must be 4 digits");
  }

  try {
    // Mint the cookie before persisting the hash: if minting fails, nothing was
    // saved, so the passcode state and the "Could not save" error can't diverge.
    const cookie = await createSessionCookie(context.env);
    await savePasswordHash(context.env, await hashPassword(password));
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode could not be configured.");
  }
}
