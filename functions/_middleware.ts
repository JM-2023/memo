import type { AppContext } from "./api/_utils/types";
import { DecryptionError } from "./api/_utils/crypto";
import { apiError } from "./api/_utils/response";

// The app is fully self-contained (no external scripts, fonts, or API hosts),
// so everything locks to 'self'. 'unsafe-inline' for styles covers React's
// style attributes; data:/blob: under img covers inline image previews and
// the D1-served attachments. img-src additionally allows https: — memo text
// may embed external image links that render as previews without being stored.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const CANONICAL_HOST = "notes.example";

export async function onRequest(context: AppContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  // Redirect only the production Pages hostname. Hash/branch preview hosts are
  // intentionally left on their isolated preview bindings and secrets.
  if (requestUrl.hostname === "project.pages.dev") {
    requestUrl.protocol = "https:";
    requestUrl.hostname = CANONICAL_HOST;
    requestUrl.port = "";
    return Response.redirect(requestUrl.toString(), 301);
  }

  let response: Response;
  try {
    response = await context.next();
  } catch (error) {
    console.error("Unhandled request error", error);
    response =
      error instanceof DecryptionError
        ? apiError(503, "DECRYPTION_FAILED", "Encrypted memo content is unavailable. Check the server encryption key before retrying.")
        : apiError(500, "INTERNAL_ERROR", "An unexpected server error occurred.");
  }
  const headers = new Headers(response.headers);
  if (requestUrl.pathname.startsWith("/api/") && !headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, noimageindex");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
