import type { AppContext } from "./api/_utils/types";
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

export async function onRequest(context: AppContext): Promise<Response> {
  let response: Response;
  try {
    response = await context.next();
  } catch (error) {
    console.error("Unhandled request error", error);
    response = apiError(500, "INTERNAL_ERROR", "An unexpected server error occurred.");
  }
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, noimageindex");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
