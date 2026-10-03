import type { AppContext } from "./api/_utils/types";
import { renewedSessionCookie } from "./api/_utils/auth";
import { DecryptionError } from "./api/_utils/crypto";
import { apiError, isStorageFullError } from "./api/_utils/response";

// The app's own scripts, styles, and fonts stay locked to 'self'.
// 'unsafe-inline' for styles covers React's style attributes; data:/blob:
// under img covers inline image previews and the D1-served attachments.
// The deliberate exceptions:
// - img-src https:: memo text may embed external image links that render as
//   previews without being stored.
// - script-src 'wasm-unsafe-eval': the semantic model runs on same-origin
//   onnxruntime WASM, and browsers gate WebAssembly compilation behind this
//   keyword (it does not permit JS eval).
// - connect-src lists exactly the embedding-model sources — the pinned
//   Hugging Face revision and its CDN hosts first, plus our GitHub release
//   archive as a best-effort secondary/manual source. Model files are fetched
//   once per device,
//   verified against the SHA-256 manifest in src/lib/modelManifest.ts, and
//   frozen into IndexedDB; no other cross-origin request exists.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self' https://github.com https://objects.githubusercontent.com https://release-assets.githubusercontent.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export async function onRequest(context: AppContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const canonicalHost = context.env.CANONICAL_HOST?.trim().toLowerCase();
  const productionPagesHost = context.env.PRODUCTION_PAGES_HOST?.trim().toLowerCase();
  // Redirect only the production Pages hostname. Hash/branch preview hosts are
  // intentionally left on their isolated preview bindings and secrets.
  if (canonicalHost && productionPagesHost && requestUrl.hostname.toLowerCase() === productionPagesHost) {
    requestUrl.protocol = "https:";
    requestUrl.hostname = canonicalHost;
    requestUrl.port = "";
    return Response.redirect(requestUrl.toString(), 301);
  }

  let response: Response;
  try {
    response = await context.next();
  } catch (error) {
    console.error("Unhandled request error", error);
    // A full database is the one write failure the owner can act on, so it
    // gets its own code instead of the generic 500.
    response =
      error instanceof DecryptionError
        ? apiError(503, "DECRYPTION_FAILED", "Encrypted memo content is unavailable. Check the server encryption key before retrying.")
        : isStorageFullError(error)
          ? apiError(507, "STORAGE_FULL", "The D1 database is full. Free space by emptying Trash or permanently deleting memos with images.")
          : apiError(500, "INTERNAL_ERROR", "An unexpected server error occurred.");
  }
  const headers = new Headers(response.headers);
  if (requestUrl.pathname.startsWith("/api/") && !headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  // Sliding session: a successful sync/bootstrap re-signs a cookie that is
  // getting old, so a device in daily use never meets the hard expiry.
  if (response.ok && !headers.has("Set-Cookie")) {
    const renewed = await renewedSessionCookie(context).catch(() => null);
    if (renewed) headers.append("Set-Cookie", renewed);
  }
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, noimageindex");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
