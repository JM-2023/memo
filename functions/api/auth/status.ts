import { configuredAuthState } from "../_utils/auth";
import { json } from "../_utils/response";
import type { AppContext } from "../_utils/types";
import { allowsInAppSetup } from "./setup";

export async function onRequestGet(context: AppContext): Promise<Response> {
  const hasConfiguredPassword = Boolean(await configuredAuthState(context.env));
  // Public hosts cannot create the first passcode in the app; telling the
  // client up front lets it explain the deploy step instead of offering a
  // keypad whose submit can only fail. Hostname rules are not secret.
  return json({ needsSetup: !hasConfiguredPassword, setupAllowed: allowsInAppSetup(context.request) });
}
