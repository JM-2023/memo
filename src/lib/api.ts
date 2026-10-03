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

/**
 * A 401 for a session that was revoked (passcode changed elsewhere, or the
 * database replaced), as opposed to one that simply expired or never existed.
 * Only a revocation clears this device's local data.
 */
export function isSessionRevoked(cause: unknown): boolean {
  return cause instanceof AuthRequiredError && cause.params?.reason === "revoked";
}

let lastAuthLossRevoked = false;

/** Whether the most recent 401 from any request was a revocation. */
export function lastAuthLossWasRevocation(): boolean {
  return lastAuthLossRevoked;
}

export const API_REQUEST_TIMEOUT_MS = 30_000;
/** Ceiling for the size-scaled lifetime of a large upload (images, imports). */
export const API_UPLOAD_TIMEOUT_MAX_MS = 180_000;

/**
 * A memo with nine photos is ~11MB of JSON; on a ~1Mbps uplink that alone
 * outlasts the base 30s, and a retry would time out the same way. Grant 1.5s
 * per 100KB of body on top of the base, capped so a dead connection still
 * fails in finite time. Uploads that report progress (XHR) are not bound by
 * this while bytes keep moving; it then covers only the wait before the first
 * progress event and the wait for the reply once the body is out.
 */
export function requestTimeoutMs(bodyChars: number): number {
  const extra = Math.ceil(Math.max(0, bodyChars) / 100_000) * 1_500;
  return Math.min(API_UPLOAD_TIMEOUT_MAX_MS, API_REQUEST_TIMEOUT_MS + extra);
}

export interface RequestOptions {
  /** Fraction (0..1) of the request body sent so far; switches the transport to XHR. */
  onUploadProgress?: (fraction: number) => void;
}

interface UploadHooks {
  /** Fraction (0..1) of the body sent so far. */
  onProgress: (fraction: number) => void;
  /** The last body byte has left the browser; only the server's answer is outstanding. */
  onSent: () => void;
}

/**
 * fetch() cannot report upload progress, so bodies that want it go through
 * XMLHttpRequest and come back as a regular Response for the shared handling.
 * Network failures reject with a TypeError, as fetch does.
 */
function sendWithProgress(path: string, init: RequestInit, signal: AbortSignal, hooks: UploadHooks): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open(init.method ?? "GET", path);
    xhr.responseType = "text";
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) hooks.onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.upload.onload = () => hooks.onSent();
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status > 599) {
        reject(new TypeError("Network request failed"));
        return;
      }
      const body = xhr.status === 204 || xhr.status === 205 ? null : xhr.responseText;
      resolve(new Response(body, { status: xhr.status, statusText: xhr.statusText }));
    };
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.onabort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.send(typeof init.body === "string" ? init.body : null);
  });
}

/**
 * Give every API call a finite lifetime while preserving an explicit caller
 * abort (used by the background sync hook). A private controller lets us
 * distinguish a network timeout from navigation/unmount cancellation.
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions,
  read: (response: Response) => Promise<T> = (response) => response.json()
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  // True while an XHR upload is still sending its body: a timeout then means
  // the connection stalled, not that the server was slow to answer.
  let uploading = false;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const arm = (ms: number) => {
    globalThis.clearTimeout(timeout);
    timeout = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const lifetime = requestTimeoutMs(typeof init?.body === "string" ? init.body.length : 0);
  arm(lifetime);
  const callerSignal = init?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    let response: Response;
    try {
      const onUploadProgress = options?.onUploadProgress;
      if (init && onUploadProgress && typeof init.body === "string" && typeof XMLHttpRequest !== "undefined") {
        uploading = true;
        const sent = () => {
          uploading = false;
          arm(lifetime);
        };
        response = await sendWithProgress(path, init, controller.signal, {
          // A body that keeps moving is never cut off at a fixed lifetime: each
          // progress event restarts the base window, so only a stalled upload
          // times out. Once the body is out, the size-scaled lifetime bounds
          // the wait for the server's answer.
          onProgress: (fraction) => {
            if (fraction >= 1) {
              if (uploading) sent();
            } else if (uploading) arm(API_REQUEST_TIMEOUT_MS);
            onUploadProgress(fraction);
          },
          onSent: () => {
            if (uploading) sent();
          }
        });
      } else {
        response = await fetch(path, {
          credentials: "same-origin",
          cache: "no-store",
          headers: init?.body ? { "Content-Type": "application/json" } : undefined,
          ...init,
          signal: controller.signal
        });
      }
    } catch (cause) {
      // Offline, DNS, or a dropped connection: fetch rejects with a bare
      // TypeError whose text differs per browser ("Failed to fetch", "Load
      // failed"), which is no message to show anyone.
      if (!timedOut && !callerSignal?.aborted && cause instanceof TypeError) {
        throw new ApiError("NETWORK_ERROR", 0, "The server could not be reached. Check your connection and try again.");
      }
      throw cause;
    }
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
        const authError = new AuthRequiredError(message, response.status, params);
        lastAuthLossRevoked = isSessionRevoked(authError);
        throw authError;
      }
      throw new ApiError(code, response.status, message, params, current);
    }
    return await read(response);
  } catch (cause) {
    if (timedOut && uploading) {
      throw new ApiError("NETWORK_ERROR", 0, "The upload stopped making progress. Check your connection and try again.");
    }
    if (timedOut) {
      throw new ApiError("REQUEST_TIMEOUT", 408, "The server took too long to respond. Try again.");
    }
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function getAuthStatus(): Promise<{ needsSetup: boolean; setupAllowed?: boolean }> {
  return request("/api/auth/status");
}

export function login(password: string): Promise<{ ok: boolean }> {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
}

export function setupPassword(password: string): Promise<{ ok: boolean }> {
  return request("/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) });
}

/** Check the current passcode of a signed-in session; changes nothing. */
export function verifyPasscode(password: string): Promise<{ ok: boolean }> {
  return request("/api/auth/verify", { method: "POST", body: JSON.stringify({ password }) });
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
  /** Opaque keyset cursor for the next page (newest memo first). */
  nextAfter?: string | null;
  /** First page only: every memo at the frozen cursor, for load progress. */
  total?: number;
}

/**
 * One cold-start page. The server sizes pages by row count and content size;
 * a continuation passes the previous page's nextAfter and the frozen cursor.
 */
export function bootstrap(after?: string | null, snapshot?: number): Promise<BootstrapResponse> {
  const params = new URLSearchParams();
  if (after !== undefined && after !== null) params.set("after", after);
  if (snapshot !== undefined) params.set("snapshot", String(snapshot));
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
    height: image.height,
    thumbBase64: image.thumbBase64,
    thumbMime: image.thumbMime
  }));
}

export function createMemo(
  id: string,
  content: string,
  images: NewImagePayload[],
  options?: RequestOptions
): Promise<{ memo: Memo; idempotent?: boolean }> {
  return request("/api/memos", { method: "POST", body: JSON.stringify({ id, content, images: imageBody(images) }) }, options);
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
  changes: { expectedSeq: number; content?: string; addImages?: NewImagePayload[]; removeImageIds?: string[]; pinned?: boolean },
  options?: RequestOptions
): Promise<MemoMutationResponse> {
  return request(
    `/api/memos/${id}`,
    {
      method: "PUT",
      body: JSON.stringify({
        content: changes.content,
        addImages: changes.addImages ? imageBody(changes.addImages) : undefined,
        removeImageIds: changes.removeImageIds,
        pinned: changes.pinned,
        expectedSeq: changes.expectedSeq
      })
    },
    options
  );
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

export type MemoBatchOp = "trash" | "restore" | "purge" | "tag";

export interface MemoBatchFailure {
  id: string;
  code: string;
  params?: ApiErrorParams;
}

/** One select-mode action's outcome, merged across its requests. */
export interface MemoBatchResult {
  /** trash / restore: apply over the caller's copy at the version it sent. */
  patches: { id: string; deletedAt: string | null; seq: number }[];
  /** tag: memos that now carry the tag and differ from the caller's copy. */
  memos: Memo[];
  purged: PurgedMemo[];
  /** tag: already carried it at the caller's version. */
  unchanged: string[];
  failed: MemoBatchFailure[];
}

// Server ceilings (functions/api/memos/batch.ts): set-based ops are a fixed
// few statements per request; tagging is one statement per memo.
const MEMO_BATCH_CHUNK = 200;
const MEMO_TAG_BATCH_CHUNK = 30;

/**
 * Apply one action to many memos through POST /api/memos/batch, a chunk per
 * request, reporting how many items have been settled. A failed request
 * (network, timeout, server) marks its chunk and every later one as failed
 * with that error, keeping what earlier chunks committed; a lost session
 * still throws so the caller can drop to login.
 */
export async function batchMemos(
  op: MemoBatchOp,
  items: readonly { id: string; expectedSeq: number }[],
  options: { tag?: string; onProgress?: (settled: number) => void } = {}
): Promise<MemoBatchResult> {
  const total: MemoBatchResult = { patches: [], memos: [], purged: [], unchanged: [], failed: [] };
  const size = op === "tag" ? MEMO_TAG_BATCH_CHUNK : MEMO_BATCH_CHUNK;
  for (let start = 0; start < items.length; start += size) {
    const chunk = items.slice(start, start + size);
    try {
      const page = await request<Partial<MemoBatchResult>>("/api/memos/batch", {
        method: "POST",
        body: JSON.stringify(op === "tag" ? { op, tag: options.tag, items: chunk } : { op, items: chunk })
      });
      total.patches.push(...(page.patches ?? []));
      total.memos.push(...(page.memos ?? []));
      total.purged.push(...(page.purged ?? []));
      total.unchanged.push(...(page.unchanged ?? []));
      total.failed.push(...(page.failed ?? []));
    } catch (cause) {
      if (cause instanceof AuthRequiredError) throw cause;
      const code = cause instanceof ApiError ? cause.code : "REQUEST_FAILED";
      const params = cause instanceof ApiError ? cause.params : undefined;
      total.failed.push(...items.slice(start).map((item) => ({ id: item.id, code, params })));
      options.onProgress?.(items.length);
      return total;
    }
    options.onProgress?.(Math.min(items.length, start + size));
  }
  return total;
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
  /** Rows scanned so far across every server pass, of `total`. */
  progress?: { done: number; total: number };
}

/** Share of a multi-request job finished so far, 0–1. */
export type ProgressListener = (fraction: number) => void;

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

async function tagMutationPages(
  path: TagMutationPath,
  body: Record<string, string>,
  operationId: string,
  onProgress?: ProgressListener
): Promise<TagMutationResponse> {
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
    if (page.progress && page.progress.total > 0) onProgress?.(Math.min(1, page.progress.done / page.progress.total));
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

async function tagMutationAll(path: TagMutationPath, body: Record<string, string>, onProgress?: ProgressListener): Promise<TagMutationResponse> {
  const operationId = crypto.randomUUID();
  try {
    return await tagMutationPages(path, body, operationId, onProgress);
  } catch (cause) {
    const repaired = await repairBlockedTagOperation(cause);
    if (!repaired) throw cause;
    const desired = await tagMutationPages(path, body, operationId, onProgress);
    mergeTagMutation(repaired, desired);
    return repaired;
  }
}

export function renameTag(from: string, to: string, onProgress?: ProgressListener): Promise<TagMutationResponse> {
  return tagMutationAll("/api/tags/rename", { from, to }, onProgress);
}

/** Strips the #tag token (and descendants) out of every memo's text. */
export function removeTag(path: string, onProgress?: ProgressListener): Promise<TagMutationResponse> {
  return tagMutationAll("/api/tags/remove", { path }, onProgress);
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

export interface BackupTag {
  path: string;
  pinnedAt: string | null;
}

export interface BackupPayload {
  format: "memo-backup";
  version: number;
  exportedAt: string;
  memos: BackupMemo[];
  tags: BackupTag[];
}

/** One record read from a backup file, in file order. */
export type BackupItem = { kind: "memo"; memo: BackupMemo } | { kind: "tag"; tag: BackupTag };

export interface ExportProgress {
  done: number;
  total: number;
}

export interface ImportTotals {
  imported: number;
  skipped: number;
  images: number;
}

export interface ImportProgress extends ImportTotals {
  /** Memos sent so far, imported or skipped. */
  done: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * The whole notebook (plaintext content + inline image data) as one file.
 * Each page arrives as a verbatim slice of that file and stays an opaque Blob
 * part, so the notebook never sits in the JS heap as strings or objects.
 */
export async function exportData(
  options: { signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void } = {}
): Promise<Blob> {
  const { signal, onProgress } = options;
  const parts: Blob[] = [];
  let after: string | null = null;
  let done = 0;
  let total = 0;
  for (;;) {
    throwIfAborted(signal);
    const query: string = after ? `&after=${encodeURIComponent(after)}` : "";
    const page = await request(`/api/export?parts=1${query}`, { signal }, undefined, async (response) => {
      // Every parts-mode page carries its count. A page without one is a
      // server that ignored ?parts=1 (an older deploy) and sent a whole
      // legacy page; wrapping that as the last slice would download a
      // silently truncated backup, so stop instead.
      const rawCount = response.headers.get("X-Export-Count");
      const count = rawCount !== null && /^\d+$/.test(rawCount) ? Number(rawCount) : Number.NaN;
      if (!Number.isSafeInteger(count)) {
        throw new ApiError("EXPORT_FORMAT_UNSUPPORTED", response.status, "The server sent an export page in an unsupported format.");
      }
      return {
        body: await response.blob(),
        next: response.headers.get("X-Export-Next"),
        count,
        total: response.headers.get("X-Export-Total")
      };
    });
    parts.push(page.body);
    if (page.total !== null) total = Number(page.total) || 0;
    done += page.count;
    onProgress?.({ done, total: Math.max(total, done) });
    if (!page.next) break;
    if (page.next === after) throw new Error("Export page did not advance");
    after = page.next;
  }
  return new Blob(parts, { type: "application/json" });
}

/**
 * Whether a failed import chunk might go through on a rerun: the network,
 * a timeout, rate limiting or a server-side failure. A 4xx rejection of the
 * chunk itself (an invalid memo, an over-long text) fails the same way every
 * time, and a malformed file stays malformed.
 */
export function isTransientImportFailure(cause: unknown): boolean {
  // request() reports a dropped connection or a stalled upload as
  // NETWORK_ERROR (status 0); a raw TypeError can still reach here from
  // code that calls fetch directly.
  if (cause instanceof ApiError) {
    return cause.code === "NETWORK_ERROR" || cause.status >= 500 || cause.status === 408 || cause.status === 429;
  }
  return cause instanceof TypeError;
}

/** Merge a backup into the notebook; existing ids are left untouched. */
export function importData(payload: Pick<BackupPayload, "format" | "version" | "memos" | "tags">): Promise<ImportTotals> {
  return request("/api/import", { method: "POST", body: JSON.stringify(payload) });
}

// The import API's per-request budget (functions/api/import.ts): text memos
// share three statements per chunk (counter claim, set insert, tombstone
// sweep), each memo with images adds one multi-row insert, each tag two.
// The ceiling keeps generous distance from D1's per-request query budget.
const IMPORT_MAX_STATEMENTS = 35;
const IMPORT_MAX_MEMOS = 100;
const IMPORT_MAX_TAGS = 18;
// A content char costs at most ~6 JSON chars server-side (an escaped control
// char), so 90k keeps a chunk's text inside one json_each group there.
const IMPORT_MAX_TEXT_CHARS = 90_000;

/**
 * Stream backup records to the server in chunks sized to the import API's
 * budgets, keeping large inline-image imports below intermediary/body
 * limits. Only the chunk being sent is held in memory. `signal` stops the
 * run between chunks, so the totals always match what the server committed;
 * earlier chunks stay imported and a rerun skips their stable ids.
 */
export async function importDataInChunks(
  items: AsyncIterable<BackupItem> | Iterable<BackupItem>,
  options: { signal?: AbortSignal; onProgress?: (progress: ImportProgress) => void; maxBase64Chars?: number } = {}
): Promise<ImportTotals> {
  const { signal, onProgress, maxBase64Chars = 8_000_000 } = options;
  const progress: ImportProgress = { done: 0, imported: 0, skipped: 0, images: 0 };
  let memos: BackupMemo[] = [];
  let tags: BackupTag[] = [];
  let cost = 0;
  let weight = 0;
  let text = 0;

  async function flush() {
    if (memos.length === 0 && tags.length === 0) return;
    throwIfAborted(signal);
    const result = await importData({ format: "memo-backup", version: 1, memos, tags });
    progress.done += memos.length;
    progress.imported += result.imported;
    progress.skipped += result.skipped;
    progress.images += result.images;
    memos = [];
    tags = [];
    cost = 0;
    weight = 0;
    text = 0;
    onProgress?.({ ...progress });
  }

  for await (const item of items) {
    if (item.kind === "tag") {
      if (tags.length >= IMPORT_MAX_TAGS || cost + 2 > IMPORT_MAX_STATEMENTS) await flush();
      tags.push(item.tag);
      cost += 2;
      continue;
    }
    const memo = item.memo;
    const images = Array.isArray(memo.images) ? memo.images : [];
    const chars = String(memo.content ?? "").length;
    const memoWeight = chars + images.reduce((sum, image) => sum + String(image.dataBase64 ?? "").length, 0);
    const imageCost = images.length > 0 ? 1 : 0;
    const fits =
      cost + (memos.length === 0 ? 3 : 0) + imageCost <= IMPORT_MAX_STATEMENTS &&
      (memos.length === 0 ||
        (memos.length < IMPORT_MAX_MEMOS && weight + memoWeight <= maxBase64Chars && text + chars <= IMPORT_MAX_TEXT_CHARS));
    if (!fits) await flush();
    cost += (memos.length === 0 ? 3 : 0) + imageCost;
    memos.push(memo);
    weight += memoWeight;
    text += chars;
  }
  await flush();
  return { imported: progress.imported, skipped: progress.skipped, images: progress.images };
}
