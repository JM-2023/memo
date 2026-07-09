export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
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
  | "MEMO_TRASHED"
  | "MEMO_EMPTY"
  | "IMAGE_LIMIT_EXCEEDED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_TYPE_UNSUPPORTED"
  | "TAG_INVALID"
  | "TAG_NAME_UNCHANGED"
  | "TAG_NOT_FOUND"
  | "IMAGE_NOT_FOUND"
  | "INVALID_ORIGIN"
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
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    throw new Error("Request body is too large");
  }
  return request.json() as Promise<T>;
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
