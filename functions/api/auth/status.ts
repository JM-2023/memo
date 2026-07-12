import { configuredAuthState } from "../_utils/auth";
import { json } from "../_utils/response";
import type { AppContext } from "../_utils/types";

export async function onRequestGet(context: AppContext): Promise<Response> {
  const hasConfiguredPassword = Boolean(await configuredAuthState(context.env));
  return json({ needsSetup: !hasConfiguredPassword });
}
