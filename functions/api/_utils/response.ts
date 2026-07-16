export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_LOGIN"
  | "WRONG_CURRENT_PASSCODE"
  | "PASSCODE_INVALID"
  | "PASSCODE_ALREADY_CONFIGURED"
  | "INVALID_REQUEST_BODY"
  | "MEMO_NOT_FOUND"
  | "MEMO_ID_RETIRED"
  | "MEMO_TRASHED"
  | "MEMO_NOT_TRASHED"
  | "MEMO_EMPTY"
  | "MEMO_CONTENT_TOO_LONG"
  | "IMAGE_LIMIT_EXCEEDED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_TYPE_UNSUPPORTED"
  | "BACKUP_MEMO_INVALID"
  | "BACKUP_IMAGE_INVALID"
  | "TAG_INVALID"
  | "TAG_NAME_UNCHANGED"
  | "TAG_NOT_FOUND"
  | "TAG_OPERATION_BUSY"
  | "IMAGE_NOT_FOUND"
  | "INVALID_ORIGIN"
  | "VERSION_CONFLICT"
  | "DECRYPTION_FAILED"
  | "INTERNAL_ERROR";

export type ApiErrorParams = Record<string, string | number | boolean | null>;

/**
 * `error` remains a human-readable English fallback for older clients, while
 * `code` and `params` let the current client localize without matching text.
 */
export function apiError(status: number, code: ApiErrorCode, error: string, params?: ApiErrorParams): Response {
  return json(params ? { code, error, params } : { code, error }, { status });
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Request body is too large");
  if (!request.body) throw new Error("Request body is missing");

  // Content-Length is optional for streamed/chunked requests. Count actual
  // bytes while reading so endpoint limits remain real memory bounds.
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("Request body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}

export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }
  const expected = new URL(request.url).origin;
  if (origin !== expected) {
    return apiError(403, "INVALID_ORIGIN", "The request origin is not allowed.");
  }
  return null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
