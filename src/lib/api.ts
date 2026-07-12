import type { Memo, NewImagePayload, TagMeta } from "./types";
import type { PurgedMemo } from "./syncState";

export type ApiErrorParams = Record<string, string | number | boolean | null>;

interface ApiErrorPayload {
  code?: unknown;
  error?: unknown;
  params?: unknown;
  current?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly params?: ApiErrorParams,
    /** Current server value supplied with VERSION_CONFLICT. */
    readonly current?: Memo
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

export const API_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Give every API call a finite lifetime while preserving an explicit caller
 * abort (used by the background sync hook). A private controller lets us
 * distinguish a network timeout from navigation/unmount cancellation.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);
  const callerSignal = init?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
      signal: controller.signal
    });
    if (!response.ok) {
      let code = "REQUEST_FAILED";
      let message = `Request failed (${response.status})`;
      let params: ApiErrorParams | undefined;
      let current: Memo | undefined;
      try {
        const data = (await response.json()) as ApiErrorPayload;
        if (typeof data.code === "string" && data.code) code = data.code;
        if (typeof data.error === "string" && data.error) message = data.error;
        if (data.params && typeof data.params === "object" && !Array.isArray(data.params)) {
          params = data.params as ApiErrorParams;
        }
        if (data.current && typeof data.current === "object" && !Array.isArray(data.current)) {
          current = data.current as Memo;
        }
      } catch {
        if (timedOut) throw new ApiError("REQUEST_TIMEOUT", 408, "The server took too long to respond. Try again.");
        // Keep the status-based fallback for non-JSON error responses.
      }
      if (response.status === 401 && code === "AUTH_REQUIRED") {
        throw new AuthRequiredError(message, response.status, params);
      }
      throw new ApiError(code, response.status, message, params, current);
    }
    return (await response.json()) as T;
  } catch (cause) {
    if (timedOut) {
      throw new ApiError("REQUEST_TIMEOUT", 408, "The server took too long to respond. Try again.");
    }
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
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

export interface BootstrapResponse {
  memos: Memo[];
  tags: TagMeta[];
  cursor: number;
  syncEpoch: string;
  cacheKey?: string;
  serverTime: string;
  hasMore?: boolean;
  nextAfter?: string | number | null;
}

export function bootstrap(after?: string | number | null, snapshot?: string | number): Promise<BootstrapResponse> {
  const params = new URLSearchParams();
  if (after !== undefined && after !== null) params.set("after", String(after));
  if (snapshot !== undefined) {
    params.set("snapshot", String(snapshot));
    params.set("limit", "100");
  }
  const query = params.size > 0 ? `?${params}` : "";
  return request(`/api/bootstrap${query}`);
}

/** Everything changed after `cursor`: memos, hard-deleted ids, tag meta. */
export interface SyncResponse {
  memos: Memo[];
  purged: PurgedMemo[];
  tags: TagMeta[];
  cursor: number;
  syncEpoch: string;
  hasMore?: boolean;
  cacheKey?: string;
  serverTime: string;
}

export interface SyncRequestOptions extends Pick<RequestInit, "signal"> {
  /** Request the authenticated IndexedDB key during warm startup only. */
  includeCacheKey?: boolean;
}

export function syncSince(cursor: number, options?: SyncRequestOptions): Promise<SyncResponse> {
  const params = new URLSearchParams({ since: String(cursor) });
  if (options?.includeCacheKey) params.set("cacheKey", "1");
  return request(`/api/sync?${params}`, { signal: options?.signal });
}

function imageBody(images: NewImagePayload[]) {
  return images.map((image) => ({
    id: image.id,
    dataBase64: image.dataBase64,
    mime: image.mime,
    width: image.width,
    height: image.height
  }));
}

export function createMemo(id: string, content: string, images: NewImagePayload[]): Promise<{ memo: Memo; idempotent?: boolean }> {
  return request("/api/memos", { method: "POST", body: JSON.stringify({ id, content, images: imageBody(images) }) });
}

export interface MemoPatch {
  id: string;
  pinnedAt: string | null;
  seq: number;
}

export interface MemoMutationResponse {
  memo?: Memo;
  memoPatch?: MemoPatch;
}

export function updateMemo(
  id: string,
  changes: { expectedSeq: number; content?: string; addImages?: NewImagePayload[]; removeImageIds?: string[]; pinned?: boolean }
): Promise<MemoMutationResponse> {
  return request(`/api/memos/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      content: changes.content,
      addImages: changes.addImages ? imageBody(changes.addImages) : undefined,
      removeImageIds: changes.removeImageIds,
      pinned: changes.pinned,
      expectedSeq: changes.expectedSeq
    })
  });
}

/** Move a memo to the recycle bin (attachments kept for restore). */
export function trashMemo(id: string, expectedSeq: number): Promise<{ ok: boolean; memo: Memo }> {
  return request(`/api/memos/${id}?expectedSeq=${encodeURIComponent(expectedSeq)}`, { method: "DELETE" });
}

export function restoreMemo(id: string, expectedSeq: number): Promise<{ memo: Memo }> {
  return request(`/api/memos/${id}`, { method: "PUT", body: JSON.stringify({ restore: true, expectedSeq }) });
}

/** Hard delete a single memo — row and images are gone for good. */
export function purgeMemo(id: string, expectedSeq: number): Promise<{ ok: boolean; purged: PurgedMemo[] }> {
  return request(`/api/memos/${id}?permanent=1&expectedSeq=${encodeURIComponent(expectedSeq)}`, { method: "DELETE" });
}

/** Hard delete every memo in the recycle bin. */
export function emptyTrash(): Promise<{ ok: boolean; purged: PurgedMemo[] }> {
  return request("/api/trash", { method: "DELETE" });
}

/** Rewrites #from (and descendants) in every memo; pin state moves along. */
export interface TagMutationResponse {
  memos: Memo[];
  tags: TagMeta[];
  updated: number;
  hasMore?: boolean;
  nextAfter?: string | number | null;
}

type TagMutationPath = "/api/tags/rename" | "/api/tags/remove";

function emptyTagMutation(): TagMutationResponse {
  return { memos: [], tags: [], updated: 0, hasMore: false, nextAfter: null };
}

function mergeTagMutation(target: TagMutationResponse, source: TagMutationResponse): void {
  target.memos.push(...source.memos);
  target.tags.push(...source.tags);
  // `target` may contain an automatically repaired older job. The user-facing
  // count should describe only the operation they just requested.
  target.updated = source.updated;
}

async function tagMutationPages(path: TagMutationPath, body: Record<string, string>, operationId: string): Promise<TagMutationResponse> {
  const aggregate: TagMutationResponse = { memos: [], tags: [], updated: 0, hasMore: false, nextAfter: null };
  let after: string | number | null | undefined;
  do {
    const page = await request<TagMutationResponse>(path, {
      method: "POST",
      body: JSON.stringify(after === undefined ? { ...body, operationId } : { ...body, operationId, after })
    });
    aggregate.memos.push(...page.memos);
    aggregate.tags.push(...page.tags);
    aggregate.updated += page.updated;
    if (!page.hasMore) break;
    if (page.nextAfter === undefined || page.nextAfter === null || page.nextAfter === after) {
      throw new Error("Tag operation page did not advance");
    }
    after = page.nextAfter;
  } while (true);
  return aggregate;
}

interface TagRepairSpec {
  path: TagMutationPath;
  body: Record<string, string>;
  operationId: string;
}

function tagRepairSpec(cause: unknown): TagRepairSpec | null {
  if (!(cause instanceof ApiError) || cause.code !== "TAG_OPERATION_BUSY" || !cause.params) return null;
  const operationId = cause.params.repairOperationId;
  const kind = cause.params.repairKind;
  const from = cause.params.repairFrom;
  const to = cause.params.repairTo;
  if (typeof operationId !== "string" || typeof from !== "string") return null;
  if (kind === "rename" && typeof to === "string") {
    return { path: "/api/tags/rename", body: { from, to }, operationId };
  }
  if (kind === "remove" && to === null) {
    return { path: "/api/tags/remove", body: { path: from }, operationId };
  }
  return null;
}

/** Finish one expired partial rewrite before allowing a different tag job. */
async function repairBlockedTagOperation(cause: unknown): Promise<TagMutationResponse | undefined> {
  const repair = tagRepairSpec(cause);
  if (!repair) return undefined;
  try {
    return await tagMutationPages(repair.path, repair.body, repair.operationId);
  } catch (repairCause) {
    // Replaying from the beginning can find no source token because the old
    // pages already finished every memo. rewriteTag still completes the lock.
    if (repairCause instanceof ApiError && repairCause.code === "TAG_NOT_FOUND") return emptyTagMutation();
    throw repairCause;
  }
}

export async function pinTag(path: string, pinned: boolean): Promise<{ tag: TagMeta }> {
  const perform = () => request<{ tag: TagMeta }>("/api/tags/pin", { method: "POST", body: JSON.stringify({ path, pinned }) });
  try {
    return await perform();
  } catch (cause) {
    const repaired = await repairBlockedTagOperation(cause);
    if (!repaired) throw cause;
    return perform();
  }
}

async function tagMutationAll(path: TagMutationPath, body: Record<string, string>): Promise<TagMutationResponse> {
  const operationId = crypto.randomUUID();
  try {
    return await tagMutationPages(path, body, operationId);
  } catch (cause) {
    const repaired = await repairBlockedTagOperation(cause);
    if (!repaired) throw cause;
    const desired = await tagMutationPages(path, body, operationId);
    mergeTagMutation(repaired, desired);
    return repaired;
  }
}

export function renameTag(from: string, to: string): Promise<TagMutationResponse> {
  return tagMutationAll("/api/tags/rename", { from, to });
}

/** Strips the #tag token (and descendants) out of every memo's text. */
export function removeTag(path: string): Promise<TagMutationResponse> {
  return tagMutationAll("/api/tags/remove", { path });
}

// ---- Backup (export / import) ----

export interface BackupImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  dataBase64: string;
}

export interface BackupMemo {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  deletedAt: string | null;
  images: BackupImage[];
}

export interface BackupPayload {
  format: "memo-backup";
  version: number;
  exportedAt: string;
  memos: BackupMemo[];
  tags: { path: string; pinnedAt: string | null }[];
}

/** The whole notebook (plaintext content + inline image data) as one file. */
export async function exportData(): Promise<Blob> {
  type ExportPage = BackupPayload & { hasMore?: boolean; nextAfter?: string | null };
  let after: string | null | undefined;
  let wroteHead = false;
  let wroteMemo = false;
  const parts: BlobPart[] = [];
  const tagParts: string[] = [];
  do {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const page = await request<ExportPage>(`/api/export${query}`);
    if (!wroteHead) {
      parts.push(`{"format":"memo-backup","version":1,"exportedAt":${JSON.stringify(page.exportedAt)},"memos":[`);
      wroteHead = true;
    }
    if (page.memos.length > 0) {
      const serialized = page.memos.map((memo) => JSON.stringify(memo)).join(",");
      parts.push(wroteMemo ? `,${serialized}` : serialized);
      wroteMemo = true;
    }
    if (page.tags.length > 0) tagParts.push(...page.tags.map((tag) => JSON.stringify(tag)));
    if (!page.hasMore) break;
    if (!page.nextAfter || page.nextAfter === after) throw new Error("Export page did not advance");
    after = page.nextAfter;
  } while (true);
  parts.push(`],"tags":[${tagParts.join(",")}]}`);
  return new Blob(parts, { type: "application/json" });
}

/** Merge a backup into the notebook; existing ids are left untouched. */
export function importData(payload: BackupPayload): Promise<{ imported: number; skipped: number; images: number }> {
  return request("/api/import", { method: "POST", body: JSON.stringify(payload) });
}

/** Keep large inline-image imports below intermediary/body limits. */
export async function importDataInChunks(
  payload: BackupPayload,
  maxBase64Chars = 8_000_000
): Promise<{ imported: number; skipped: number; images: number }> {
  type ImportChunk = Pick<BackupPayload, "memos" | "tags">;
  const chunks: ImportChunk[] = [];
  const sourceTags = Array.isArray(payload.tags) ? payload.tags : [];
  let memoIndex = 0;
  let tagIndex = 0;
  // Keep generous distance from D1's per-request query budget. The import API
  // reserves four statements per memo (images use one multi-row insert) and
  // two per tag.
  const MAX_STATEMENT_COST = 35;
  while (memoIndex < payload.memos.length || tagIndex < sourceTags.length) {
    const memos: BackupMemo[] = [];
    const tags: BackupPayload["tags"] = [];
    let cost = 0;
    let weight = 0;
    while (memoIndex < payload.memos.length) {
      const memo = payload.memos[memoIndex];
      const images = Array.isArray(memo.images) ? memo.images : [];
      const memoCost = 4;
      const memoWeight = String(memo.content ?? "").length + images.reduce((sum, image) => sum + String(image.dataBase64 ?? "").length, 0);
      if (cost > 0 && (cost + memoCost > MAX_STATEMENT_COST || weight + memoWeight > maxBase64Chars)) break;
      memos.push(memo);
      memoIndex += 1;
      cost += memoCost;
      weight += memoWeight;
    }
    while (tagIndex < sourceTags.length && cost + 2 <= MAX_STATEMENT_COST) {
      tags.push(sourceTags[tagIndex]);
      tagIndex += 1;
      cost += 2;
    }
    chunks.push({ memos, tags });
  }
  if (chunks.length === 0) chunks.push({ memos: [], tags: [] });

  const total = { imported: 0, skipped: 0, images: 0 };
  for (let index = 0; index < chunks.length; index += 1) {
    const result = await importData({
      ...payload,
      memos: chunks[index].memos,
      tags: chunks[index].tags
    });
    total.imported += result.imported;
    total.skipped += result.skipped;
    total.images += result.images;
  }
  return total;
}
