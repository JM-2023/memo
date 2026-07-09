import { clearSessionCookie } from "../_utils/auth";
import { json, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
