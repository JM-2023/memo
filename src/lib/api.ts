import type { Memo, NewImagePayload, TagMeta } from "./types";

export type ApiErrorParams = Record<string, string | number | boolean | null>;

interface ApiErrorPayload {
  code?: unknown;
  error?: unknown;
  params?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly params?: ApiErrorParams
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthRequiredError extends ApiError {
  constructor(message = "Authentication required", status = 401, params?: ApiErrorParams) {
    super("AUTH_REQUIRED", status, message, params);
    this.name = "AuthRequiredError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init
  });
  if (!response.ok) {
    let code = "REQUEST_FAILED";
    let message = `Request failed (${response.status})`;
    let params: ApiErrorParams | undefined;
    try {
      const data = (await response.json()) as ApiErrorPayload;
      if (typeof data.code === "string" && data.code) code = data.code;
      if (typeof data.error === "string" && data.error) message = data.error;
      if (data.params && typeof data.params === "object" && !Array.isArray(data.params)) {
        params = data.params as ApiErrorParams;
      }
    } catch {
      // Keep the status-based fallback for non-JSON error responses.
    }
    if (response.status === 401 && code === "AUTH_REQUIRED") {
      throw new AuthRequiredError(message, response.status, params);
    }
    throw new ApiError(code, response.status, message, params);
  }
  return (await response.json()) as T;
}

export function getAuthStatus(): Promise<{ needsSetup: boolean }> {
  return request("/api/auth/status");
}

export function login(password: string): Promise<{ ok: boolean }> {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
}

export function setupPassword(password: string): Promise<{ ok: boolean }> {
  return request("/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) });
}

export function changePassword(current: string, next: string): Promise<{ ok: boolean }> {
  return request("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current, next }) });
}

export function logout(): Promise<{ ok: boolean }> {
  return request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
}

export function bootstrap(): Promise<{ memos: Memo[]; tags: TagMeta[]; cursor: number; cacheKey?: string; serverTime: string }> {
  return request("/api/bootstrap");
}

/** Everything changed after `cursor`: memos, hard-deleted ids, tag meta. */
export function syncSince(
  cursor: number
): Promise<{ memos: Memo[]; purged: string[]; tags: TagMeta[]; cursor: number; cacheKey?: string; serverTime: string }> {
  return request(`/api/sync?since=${encodeURIComponent(cursor)}`);
}

function imageBody(images: NewImagePayload[]) {
  return images.map((image) => ({
    dataBase64: image.dataBase64,
    mime: image.mime,
    width: image.width,
    height: image.height
  }));
}

export function createMemo(content: string, images: NewImagePayload[]): Promise<{ memo: Memo }> {
  return request("/api/memos", { method: "POST", body: JSON.stringify({ content, images: imageBody(images) }) });
}

export function updateMemo(
  id: string,
  changes: { content?: string; addImages?: NewImagePayload[]; removeImageIds?: string[]; pinned?: boolean }
): Promise<{ memo: Memo }> {
  return request(`/api/memos/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      content: changes.content,
      addImages: changes.addImages ? imageBody(changes.addImages) : undefined,
      removeImageIds: changes.removeImageIds,
      pinned: changes.pinned
    })
  });
}

/** Move a memo to the recycle bin (attachments kept for restore). */
export function trashMemo(id: string): Promise<{ ok: boolean; memo: Memo }> {
  return request(`/api/memos/${id}`, { method: "DELETE" });
}

export function restoreMemo(id: string): Promise<{ memo: Memo }> {
  return request(`/api/memos/${id}`, { method: "PUT", body: JSON.stringify({ restore: true }) });
}

/** Hard delete a single memo — row and images are gone for good. */
export function purgeMemo(id: string): Promise<{ ok: boolean; purgedIds: string[] }> {
  return request(`/api/memos/${id}?permanent=1`, { method: "DELETE" });
}

/** Hard delete every memo in the recycle bin. */
export function emptyTrash(): Promise<{ ok: boolean; purgedIds: string[] }> {
  return request("/api/trash", { method: "DELETE" });
}

export function pinTag(path: string, pinned: boolean): Promise<{ tag: TagMeta }> {
  return request("/api/tags/pin", { method: "POST", body: JSON.stringify({ path, pinned }) });
}

/** Rewrites #from (and descendants) in every memo; pin state moves along. */
export function renameTag(from: string, to: string): Promise<{ memos: Memo[]; tags: TagMeta[]; updated: number }> {
  return request("/api/tags/rename", { method: "POST", body: JSON.stringify({ from, to }) });
}

/** Strips the #tag token (and descendants) out of every memo's text. */
export function removeTag(path: string): Promise<{ memos: Memo[]; tags: TagMeta[]; updated: number }> {
  return request("/api/tags/remove", { method: "POST", body: JSON.stringify({ path }) });
}
