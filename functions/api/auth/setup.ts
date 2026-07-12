import { claimInitialPassword, configuredAuthState, createSessionCookie, hashPassword } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface SetupBody {
  password?: string;
}

function validPin(value: string): boolean {
  return /^\d{4,18}$/.test(value);
}

/** Public hosts must be provisioned with APP_PASSWORD_HASH during deployment. */
export function allowsInAppSetup(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  );
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
    if (await configuredAuthState(context.env)) {
      return apiError(409, "PASSCODE_ALREADY_CONFIGURED", "Passcode already configured");
    }
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode configuration could not be checked.");
  }

  if (!allowsInAppSetup(context.request)) {
    return apiError(
      503,
      "INTERNAL_ERROR",
      "Public passcode setup is disabled. Configure APP_PASSWORD_HASH during deployment."
    );
  }

  const body = await readJson<SetupBody>(context.request, 20_000).catch(() => null);
  if (!body) {
    return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body");
  }
  const password = String(body.password ?? "");
  if (!validPin(password)) {
    return apiError(400, "PASSCODE_INVALID", "Passcode must be 4-18 digits");
  }

  try {
    // Prepare every fallible artifact before claiming the one canonical row.
    // A missing session secret can therefore never leave setup half-finished.
    const [passwordHash, cookie] = await Promise.all([
      hashPassword(password),
      createSessionCookie(context.env, 0)
    ]);
    const claimed = await claimInitialPassword(context.env, passwordHash);
    if (!claimed) {
      return apiError(409, "PASSCODE_ALREADY_CONFIGURED", "Passcode already configured");
    }
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "The passcode could not be configured.");
  }
}
