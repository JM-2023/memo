// Bounded, resumable machinery shared by tag rename and remove. Memo text is
// the tag source of truth, so encrypted rows must be scanned in small keyset
// pages. The opaque cursor freezes the initial max id and makes retries finite.

import { extractTags, isValidTagPath, renameTagInContent, tagMatches } from "../../../src/lib/tags";
import { openContentRows, sealContent, type ContentFormat } from "./crypto";
import {
  claimSeq,
  claimedSeq,
  CURRENT_SEQ_SQL,
  groupImages,
  MEMO_COLUMNS,
  shapeMemo,
  type ImageMetaRow,
  type MemoJson,
  type MemoRow,
  type TagMetaJson
} from "./memos";
import { nowIso } from "./response";
import type { AppContext } from "./types";

export const MAX_TAG_PATH_BYTES = 128;
// Scan pages are capped by rows and by stored characters (decrypt + parse
// CPU scales with bytes, not rows), so short memos travel hundreds at a time
// while a run of 40k-character memos still stays small. Most pages hold no
// match at all and cost one round trip; validation never writes, so its pages
// are larger.
const VALIDATE_PAGE_ROWS = 400;
const VALIDATE_PAGE_CHARS = 800_000;
const WRITE_PAGE_ROWS = 200;
const WRITE_PAGE_CHARS = 400_000;
// Each rewritten memo is one statement in the write batch. Together with
// auth, lease, scan, image metadata and the final tag-meta batch this keeps a
// page under the Free plan's 50 queries per invocation; a page with more
// matches stops just before the first one that does not fit.
const MAX_WRITES_PER_PAGE = 30;
const MAX_CURSOR_CHARS = 2_048;
const MAX_ID_CHARS = 128;

type TagOperation = "rename" | "remove";
type TagPhase = "validate" | "write";

interface TagCursor {
  v: 3;
  op: TagOperation;
  phase: TagPhase;
  operationId: string;
  from: string;
  to: string | null;
  after: string;
  maxId: string;
  snapshotSeq: number;
  found: boolean;
  updated: number;
  retries: number;
  /** Rows finished in the current phase, and the frozen row count. Optional
   *  so a continuation minted before progress existed still resumes. */
  scanned?: number;
  total?: number;
}

interface RewriteResult {
  memos: MemoJson[];
  tags: TagMetaJson[];
  updated: number;
  hasMore: boolean;
  nextAfter: string | null;
  /** Rows scanned across every pass so far, of `total` (a rename scans twice). */
  progress: { done: number; total: number };
}

interface PreparedMemo {
  row: MemoRow;
  stored: string;
  format: ContentFormat;
  expectedSeq: number;
  mutationToken: string;
}

export class InvalidTagContinuationError extends Error {
  constructor() {
    super("The tag-operation continuation is invalid.");
    this.name = "InvalidTagContinuationError";
  }
}

export class InvalidTagTargetError extends Error {
  constructor() {
    super("The renamed tag path would exceed the allowed size.");
    this.name = "InvalidTagTargetError";
  }
}

export class TagOperationConflictError extends Error {
  constructor() {
    super("A memo kept changing while the tag operation was running.");
    this.name = "TagOperationConflictError";
  }
}

export class TagOperationBusyError extends Error {
  constructor(readonly blocker: BlockingTagOperation | null = null) {
    super("Another global tag operation is already running.");
    this.name = "TagOperationBusyError";
  }
}

export interface BlockingTagOperation {
  operationId: string;
  kind: TagOperation;
  from: string;
  to: string | null;
  expiresAt: number;
}

interface BlockingTagOperationRow {
  operation_id: string;
  operation_kind: string;
  from_path: string;
  to_path: string | null;
  expires_at: number;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_OPERATION_LEASE_MS = 60_000;

export function validTagOperationId(value: string): boolean {
  return OPERATION_ID_PATTERN.test(value);
}

export async function getBlockingTagOperation(context: AppContext): Promise<BlockingTagOperation | null> {
  const row = await context.env.DB
    .prepare(
      `SELECT operation_id, operation_kind, from_path, to_path, expires_at
       FROM tag_operation_lock WHERE id = 1 AND completed = 0`
    )
    .first<BlockingTagOperationRow>();
  if (!row || (row.operation_kind !== "rename" && row.operation_kind !== "remove")) return null;
  return {
    operationId: row.operation_id,
    kind: row.operation_kind,
    from: row.from_path,
    to: row.to_path,
    expiresAt: Number(row.expires_at)
  };
}

/**
 * An active job remains exclusive. Once its lease expires, an authenticated
 * client receives enough opaque state to replay that same idempotent spec
 * from the beginning before attempting a different global tag mutation.
 */
export function tagOperationBusyParams(blocker: BlockingTagOperation | null): Record<string, string | number | null> | undefined {
  if (!blocker) return undefined;
  const retryAfterMs = Math.max(0, blocker.expiresAt - Date.now());
  if (retryAfterMs > 0) return { retryAfterMs };
  return {
    repairOperationId: blocker.operationId,
    repairKind: blocker.kind,
    repairFrom: blocker.from,
    repairTo: blocker.to
  };
}

async function acquireTagOperation(
  context: AppContext,
  operationId: string,
  op: TagOperation,
  from: string,
  to: string | null,
  continuation: boolean
): Promise<void> {
  const now = Date.now();
  const row = continuation
    ? await context.env.DB
        .prepare(
          `UPDATE tag_operation_lock SET expires_at = ?
           WHERE id = 1 AND completed = 0 AND operation_id = ?
             AND operation_kind = ? AND from_path = ?
             AND COALESCE(to_path, '') = COALESCE(?, '')
           RETURNING operation_id`
        )
        .bind(now + TAG_OPERATION_LEASE_MS, operationId, op, from, to)
        .first<{ operation_id: string }>()
    : await context.env.DB
        .prepare(
          `INSERT INTO tag_operation_lock (id, operation_id, operation_kind, from_path, to_path, expires_at, completed)
           VALUES (1, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             operation_id = excluded.operation_id,
             operation_kind = excluded.operation_kind,
             from_path = excluded.from_path,
             to_path = excluded.to_path,
             expires_at = excluded.expires_at,
             completed = 0
           WHERE tag_operation_lock.completed = 1
              OR (
                tag_operation_lock.completed = 0
                AND tag_operation_lock.operation_kind = excluded.operation_kind
                AND tag_operation_lock.from_path = excluded.from_path
                AND COALESCE(tag_operation_lock.to_path, '') = COALESCE(excluded.to_path, '')
              )
           RETURNING operation_id`
        )
        .bind(operationId, op, from, to, now + TAG_OPERATION_LEASE_MS)
        .first<{ operation_id: string }>();
  if (row?.operation_id !== operationId) {
    throw new TagOperationBusyError(await getBlockingTagOperation(context));
  }
}

export async function releaseTagOperation(context: AppContext, operationId: string): Promise<void> {
  await context.env.DB
    .prepare("UPDATE tag_operation_lock SET completed = 1, expires_at = 0 WHERE id = 1 AND operation_id = ?")
    .bind(operationId)
    .run();
}

/** Leave a partially written job incomplete, but let the same spec repair it immediately. */
export async function abandonTagOperation(context: AppContext, operationId: string): Promise<void> {
  await context.env.DB
    .prepare("UPDATE tag_operation_lock SET expires_at = 0 WHERE id = 1 AND completed = 0 AND operation_id = ?")
    .bind(operationId)
    .run();
}

export function validTagPath(path: string): boolean {
  return isValidTagPath(path) && new TextEncoder().encode(path).byteLength <= MAX_TAG_PATH_BYTES;
}

function encodeCursor(cursor: TagCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string, operationId: string, op: TagOperation, from: string, to: string | null): TagCursor | null {
  if (!value || value.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Partial<TagCursor>;
    if (
      parsed.v !== 3 ||
      parsed.op !== op ||
      (parsed.phase !== "validate" && parsed.phase !== "write") ||
      parsed.operationId !== operationId ||
      parsed.from !== from ||
      parsed.to !== to ||
      typeof parsed.after !== "string" ||
      typeof parsed.maxId !== "string" ||
      parsed.after.length > MAX_ID_CHARS ||
      parsed.maxId.length > MAX_ID_CHARS ||
      parsed.after > parsed.maxId ||
      !Number.isSafeInteger(parsed.snapshotSeq) ||
      Number(parsed.snapshotSeq) < 0 ||
      typeof parsed.found !== "boolean" ||
      !Number.isSafeInteger(parsed.updated) ||
      Number(parsed.updated) < 0 ||
      !Number.isSafeInteger(parsed.retries) ||
      Number(parsed.retries) < 0 ||
      Number(parsed.retries) > 3 ||
      (parsed.scanned !== undefined && (!Number.isSafeInteger(parsed.scanned) || Number(parsed.scanned) < 0)) ||
      (parsed.total !== undefined && (!Number.isSafeInteger(parsed.total) || Number(parsed.total) < 0))
    ) {
      return null;
    }
    return parsed as TagCursor;
  } catch {
    return null;
  }
}

function sourceRange(path: string): [string, string, string] {
  return [path, `${path}/`, `${path}0`];
}

const SOURCE_PATH_SQL = "(path = ? COLLATE BINARY OR (path COLLATE BINARY >= ? AND path COLLATE BINARY < ?))";

async function initialCursor(
  context: AppContext,
  operationId: string,
  op: TagOperation,
  from: string,
  to: string | null
): Promise<TagCursor> {
  const range = sourceRange(from);
  const [counterResult, boundaryResult, metaResult] = await context.env.DB.batch([
    context.env.DB.prepare("SELECT n FROM sync_counter WHERE id = 1"),
    context.env.DB.prepare("SELECT COALESCE(MAX(id), '') AS max_id, COUNT(*) AS total FROM memos"),
    context.env.DB
      .prepare(
        `SELECT 1 AS found FROM tag_meta
         WHERE ${SOURCE_PATH_SQL} AND pinned_at IS NOT NULL AND seq <= ${CURRENT_SEQ_SQL}
         LIMIT 1`
      )
      .bind(...range)
  ]);
  const snapshotSeq = Number((counterResult.results?.[0] as { n?: unknown } | undefined)?.n ?? 0);
  const boundary = boundaryResult.results?.[0] as { max_id?: unknown; total?: unknown } | undefined;
  const maxId = String(boundary?.max_id ?? "");
  const total = Number(boundary?.total ?? 0);
  const found = Boolean(metaResult.results?.[0]);
  return {
    v: 3,
    op,
    phase: to === null ? "write" : "validate",
    operationId,
    from,
    to,
    after: "",
    maxId,
    snapshotSeq,
    found,
    updated: 0,
    retries: 0,
    scanned: 0,
    total: Number.isSafeInteger(total) && total > 0 ? total : 0
  };
}

/** Overall progress: a rename's write pass follows a full validation pass. */
function progressOf(state: TagCursor): { done: number; total: number } {
  const total = state.total ?? 0;
  const passes = state.to === null ? 1 : 2;
  const done = (state.phase === "write" && state.to !== null ? total : 0) + Math.min(state.scanned ?? 0, total);
  return { done: Math.min(done, total * passes), total: total * passes };
}

/**
 * One keyset page of the frozen snapshot, cut at `rowLimit` rows or once the
 * stored characters before a row reach `charBudget` (the first row always
 * fits, so every page advances). `hasMore` reports rows left beyond the cut.
 */
async function scanPage(
  context: AppContext,
  state: TagCursor,
  rowLimit: number,
  charBudget: number
): Promise<{ rows: MemoRow[]; hasMore: boolean }> {
  const result = await context.env.DB
    .prepare(
      `WITH page AS MATERIALIZED (
         SELECT ${MEMO_COLUMNS} FROM memos
         WHERE id > ? AND id <= ? AND seq <= ?
         ORDER BY id COLLATE BINARY LIMIT ?
       ),
       sized AS (
         SELECT *, COALESCE(SUM(length(content)) OVER (
           ORDER BY id COLLATE BINARY ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS chars_before
         FROM page
       )
       SELECT ${MEMO_COLUMNS}, (SELECT COUNT(*) FROM page) AS page_rows
       FROM sized WHERE chars_before < ? ORDER BY id COLLATE BINARY`
    )
    .bind(state.after, state.maxId, state.snapshotSeq, rowLimit + 1, charBudget)
    .all<MemoRow & { page_rows: number }>();
  const fetched = result.results ?? [];
  const pageRows = Number(fetched[0]?.page_rows ?? 0);
  const rows = fetched.slice(0, rowLimit).map(({ page_rows: _pageRows, ...row }) => row);
  return { rows, hasMore: pageRows > rows.length };
}

/** Read-only first pass: no rename page is committed until every target path is known to fit. */
async function validateMemoPage(rows: MemoRow[], from: string, to: string, context: AppContext): Promise<boolean> {
  await openContentRows(context.env, rows);
  let found = false;
  for (const row of rows) {
    for (const tag of extractTags(row.content)) {
      if (!tagMatches(tag, from)) continue;
      found = true;
      if (!validTagPath(`${to}${tag.slice(from.length)}`)) throw new InvalidTagTargetError();
    }
  }
  return found;
}

/**
 * Rewrite a scanned page, up to MAX_WRITES_PER_PAGE changed memos. `rows` is
 * the prefix actually covered: it ends just before the first change that did
 * not fit, so the next page resumes there.
 */
async function prepareChanged(
  pageRows: MemoRow[],
  from: string,
  to: string | null,
  context: AppContext
): Promise<{ prepared: PreparedMemo[]; rows: MemoRow[] }> {
  const key = await openContentRows(context.env, pageRows);
  const now = nowIso();
  if (to !== null) {
    for (const row of pageRows) {
      for (const tag of extractTags(row.content)) {
        if (tagMatches(tag, from) && !validTagPath(`${to}${tag.slice(from.length)}`)) throw new InvalidTagTargetError();
      }
    }
  }
  let changed = pageRows
    .map((row) => ({ row, next: renameTagInContent(row.content, from, to) }))
    .filter(({ row, next }) => next !== row.content);
  let rows = pageRows;
  if (changed.length > MAX_WRITES_PER_PAGE) {
    rows = pageRows.slice(0, pageRows.indexOf(changed[MAX_WRITES_PER_PAGE].row));
    changed = changed.slice(0, MAX_WRITES_PER_PAGE);
  }

  const prepared: PreparedMemo[] = [];
  // The write cap bounds the page's CPU; four sealers avoid a burst of
  // thirty AES-GCM operations on the Free-plan request path.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, changed.length) }, async () => {
    while (cursor < changed.length) {
      const item = changed[cursor++];
      const format: ContentFormat = key ? "enc1" : "plain";
      prepared.push({
        row: { ...item.row, content: item.next, content_format: format, updated_at: now },
        stored: key ? await sealContent(key, item.next) : item.next,
        format,
        expectedSeq: item.row.seq,
        mutationToken: crypto.randomUUID()
      });
    }
  });
  await Promise.all(workers);
  // Parallel sealing can reorder pushes; restore the stable page order.
  const order = new Map(rows.map((row, index) => [row.id, index]));
  prepared.sort((left, right) => (order.get(left.row.id) ?? 0) - (order.get(right.row.id) ?? 0));
  return { prepared, rows };
}

async function writeMemoPage(
  context: AppContext,
  prepared: PreparedMemo[],
  operationId: string
): Promise<{ rows: MemoRow[]; conflicts: Set<string> }> {
  if (prepared.length === 0) return { rows: [], conflicts: new Set() };
  const db = context.env.DB;
  const expectedPredicate = prepared.map(() => "(id = ? AND seq = ?)").join(" OR ");
  const expectedBindings = prepared.flatMap((memo) => [memo.row.id, memo.expectedSeq]);
  const ownsLockSql =
    "EXISTS (SELECT 1 FROM tag_operation_lock WHERE id = 1 AND operation_id = ? AND completed = 0)";
  const statements: D1PreparedStatement[] = [
    claimSeq(
      db,
      `EXISTS (SELECT 1 FROM memos WHERE ${expectedPredicate}) AND ${ownsLockSql}`,
      [...expectedBindings, operationId]
    )
  ];
  for (const memo of prepared) {
    statements.push(
      db
        .prepare(
          `UPDATE memos
           SET content = ?, content_format = ?, updated_at = ?, seq = ${CURRENT_SEQ_SQL}, mutation_token = ?
           WHERE id = ? AND seq = ? AND ${ownsLockSql}
           RETURNING id, seq`
        )
        .bind(memo.stored, memo.format, memo.row.updated_at, memo.mutationToken, memo.row.id, memo.expectedSeq, operationId)
    );
  }
  statements.push(
    db
      .prepare(`SELECT ${ownsLockSql} AS owned`)
      .bind(operationId)
  );

  const results = await db.batch(statements);
  const lockResult = results[prepared.length + 1]?.results?.[0] as { owned?: unknown } | undefined;
  if (!lockResult?.owned) throw new TagOperationBusyError();
  const seq = claimedSeq(results[0]);
  const succeeded = new Set<string>();
  if (seq !== null) {
    prepared.forEach((memo, index) => {
      const returned = results[index + 1]?.results?.[0] as { id?: unknown } | undefined;
      if (returned?.id === memo.row.id) succeeded.add(memo.row.id);
    });
  }
  const rows = prepared.filter((memo) => succeeded.has(memo.row.id)).map((memo) => ({ ...memo.row, seq: seq as number }));
  const conflicts = new Set(prepared.filter((memo) => !succeeded.has(memo.row.id)).map((memo) => memo.row.id));
  return { rows, conflicts };
}

async function imageMetaFor(context: AppContext, ids: string[]): Promise<Map<string, ImageMetaRow[]>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await context.env.DB
    .prepare(
      `SELECT id, memo_id, ord, mime, width, height, bytes
       FROM memo_images WHERE memo_id IN (${placeholders})
       ORDER BY memo_id COLLATE BINARY, ord`
    )
    .bind(...ids)
    .all<ImageMetaRow>();
  return groupImages(result.results ?? []);
}

async function assertTagMetaTargetsFit(context: AppContext, state: TagCursor): Promise<void> {
  if (state.to === null) return;
  const range = sourceRange(state.from);
  const suffixStart = Array.from(state.from).length + 1;
  const tooLong = await context.env.DB
    .prepare(
      `SELECT 1 AS invalid FROM tag_meta
       WHERE ${SOURCE_PATH_SQL} AND pinned_at IS NOT NULL AND seq <= ?
         AND length(CAST((? || substr(path, ?)) AS BLOB)) > ?
       LIMIT 1`
    )
    .bind(...range, state.snapshotSeq, state.to, suffixStart, MAX_TAG_PATH_BYTES)
    .first<{ invalid: number }>();
  if (tooLong) throw new InvalidTagTargetError();
}

async function finishTagMeta(
  context: AppContext,
  state: TagCursor,
  operationId: string
): Promise<{ tags: TagMetaJson[]; found: boolean }> {
  const db = context.env.DB;
  const range = sourceRange(state.from);
  const ownsLockSql =
    "EXISTS (SELECT 1 FROM tag_operation_lock WHERE id = 1 AND operation_id = ? AND completed = 0)";

  await assertTagMetaTargetsFit(context, state);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `WITH source_count(value) AS (
           SELECT COUNT(*) FROM tag_meta
           WHERE ${SOURCE_PATH_SQL} AND pinned_at IS NOT NULL AND seq <= ?
         )
         UPDATE sync_counter
         SET n = n + ${state.to === null ? "" : "2 * "}(SELECT value FROM source_count)
         WHERE id = 1 AND (SELECT value FROM source_count) > 0 AND ${ownsLockSql}
         RETURNING n`
      )
      .bind(...range, state.snapshotSeq, operationId)
  ];
  if (state.to === null) {
    statements.push(
      db
        .prepare(
          `WITH source AS MATERIALIZED (
             SELECT path, ROW_NUMBER() OVER (ORDER BY path COLLATE BINARY) AS rn
             FROM tag_meta
             WHERE ${SOURCE_PATH_SQL} AND pinned_at IS NOT NULL AND seq <= ? AND ${ownsLockSql}
           )
           UPDATE tag_meta
           SET pinned_at = NULL,
               updated_at = ?,
               seq = ${CURRENT_SEQ_SQL} - (SELECT COUNT(*) FROM source)
                 + (SELECT rn FROM source WHERE source.path = tag_meta.path)
           WHERE path IN (SELECT path FROM source)`
        )
        .bind(...range, state.snapshotSeq, operationId, nowIso())
    );
  } else {
    const now = nowIso();
    const suffixStart = Array.from(state.from).length + 1;
    statements.push(
      db
        .prepare(
          `WITH source AS MATERIALIZED (
             SELECT path, pinned_at, ROW_NUMBER() OVER (ORDER BY path COLLATE BINARY) AS rn
             FROM tag_meta
             WHERE ${SOURCE_PATH_SQL} AND pinned_at IS NOT NULL AND seq <= ? AND ${ownsLockSql}
           )
           INSERT INTO tag_meta (path, pinned_at, updated_at, seq)
           SELECT ? || substr(path, ?), pinned_at, ?,
                  ${CURRENT_SEQ_SQL} - 2 * (SELECT COUNT(*) FROM source) + rn
           FROM source
           WHERE true
           ON CONFLICT(path) DO UPDATE SET
             pinned_at = COALESCE(tag_meta.pinned_at, excluded.pinned_at),
             updated_at = excluded.updated_at,
             seq = excluded.seq`
        )
        .bind(...range, state.snapshotSeq, operationId, state.to, suffixStart, now),
      db
        .prepare(
          `WITH source AS MATERIALIZED (
             SELECT path, ROW_NUMBER() OVER (ORDER BY path COLLATE BINARY) AS rn
             FROM tag_meta
             WHERE ${SOURCE_PATH_SQL} AND pinned_at IS NOT NULL AND seq <= ? AND ${ownsLockSql}
           )
           UPDATE tag_meta
           SET pinned_at = NULL,
               updated_at = ?,
               seq = ${CURRENT_SEQ_SQL} - (SELECT COUNT(*) FROM source)
                 + (SELECT rn FROM source WHERE source.path = tag_meta.path)
           WHERE path IN (SELECT path FROM source)`
        )
        .bind(...range, state.snapshotSeq, operationId, now)
    );
  }
  // Completion is part of the same D1 transaction as the last metadata page.
  // A Worker interruption can therefore leave either both committed or both
  // absent, never a finished rewrite behind an incomplete global lock.
  statements.push(
    db
      .prepare(
        `UPDATE tag_operation_lock SET completed = 1, expires_at = 0
         WHERE id = 1 AND operation_id = ? AND completed = 0
         RETURNING operation_id`
      )
      .bind(operationId)
  );

  const results = await db.batch(statements);
  const completion = results[results.length - 1]?.results?.[0] as { operation_id?: unknown } | undefined;
  if (completion?.operation_id !== operationId) throw new TagOperationBusyError();
  const seq = claimedSeq(results[0]);
  if (seq === null) return { tags: [], found: false };
  // Metadata rows have distinct seq values and are intentionally delivered by
  // the immediately-following bounded sync. Returning every pinned descendant
  // here would recreate an unbounded mutation response.
  return { tags: [], found: true };
}

/** Rewrite one bounded memo page, then migrate tag metadata on the final page. */
export async function rewriteTag(
  context: AppContext,
  from: string,
  to: string | null,
  operationId: string,
  after?: string | null
): Promise<RewriteResult | null> {
  const op: TagOperation = to === null ? "remove" : "rename";
  if (!validTagOperationId(operationId)) throw new InvalidTagContinuationError();
  let state: TagCursor | null;
  if (after === undefined || after === null) {
    await acquireTagOperation(context, operationId, op, from, to, false);
    state = await initialCursor(context, operationId, op, from, to);
  } else {
    state = decodeCursor(after, operationId, op, from, to);
    if (state) await acquireTagOperation(context, operationId, op, from, to, true);
  }
  if (!state) throw new InvalidTagContinuationError();


  if (state.phase === "validate") {
    if (to === null) throw new InvalidTagContinuationError();
    const page = await scanPage(context, state, VALIDATE_PAGE_ROWS, VALIDATE_PAGE_CHARS);
    const found = state.found || (await validateMemoPage(page.rows, from, to, context));
    const scanned = (state.scanned ?? 0) + page.rows.length;
    if (page.hasMore) {
      const next: TagCursor = { ...state, after: page.rows[page.rows.length - 1]?.id ?? state.after, found, retries: 0, scanned };
      return { memos: [], tags: [], updated: 0, hasMore: true, nextAfter: encodeCursor(next), progress: progressOf(next) };
    }
    // Validation covered the frozen sequence range. Start a second bounded
    // pass for writes; concurrent edits move above snapshotSeq and are left
    // for their author instead of invalidating an already-written prefix.
    await assertTagMetaTargetsFit(context, { ...state, found });
    const next: TagCursor = { ...state, phase: "write", after: "", found, retries: 0, scanned: 0 };
    return { memos: [], tags: [], updated: 0, hasMore: true, nextAfter: encodeCursor(next), progress: progressOf(next) };
  }

  const page = await scanPage(context, state, WRITE_PAGE_ROWS, WRITE_PAGE_CHARS);
  const { prepared, rows: pageRows } = await prepareChanged(page.rows, from, to, context);
  const hasScanMore = page.hasMore || pageRows.length < page.rows.length;
  const writeResult = await writeMemoPage(context, prepared, operationId);
  const imagesByMemo = await imageMetaFor(context, writeResult.rows.map((row) => row.id));
  const memos = writeResult.rows.map((row) => shapeMemo(row, imagesByMemo.get(row.id) ?? []));

  const found = state.found || prepared.length > 0;
  const updatedTotal = state.updated + writeResult.rows.length;
  const firstConflict = pageRows.find((row) => writeResult.conflicts.has(row.id));
  if (firstConflict) {
    const conflictIndex = pageRows.findIndex((row) => row.id === firstConflict.id);
    const retryAfter = conflictIndex > 0 ? pageRows[conflictIndex - 1].id : state.after;
    const retries = retryAfter === state.after ? state.retries + 1 : 0;
    if (retries > 3) throw new TagOperationConflictError();
    const next: TagCursor = { ...state, after: retryAfter, found, updated: updatedTotal, retries, scanned: (state.scanned ?? 0) + conflictIndex };
    return { memos, tags: [], updated: writeResult.rows.length, hasMore: true, nextAfter: encodeCursor(next), progress: progressOf(next) };
  }

  const scanned = (state.scanned ?? 0) + pageRows.length;
  if (hasScanMore) {
    const next: TagCursor = { ...state, after: pageRows[pageRows.length - 1]?.id ?? state.after, found, updated: updatedTotal, retries: 0, scanned };
    return { memos, tags: [], updated: writeResult.rows.length, hasMore: true, nextAfter: encodeCursor(next), progress: progressOf(next) };
  }

  const meta = await finishTagMeta(context, { ...state, found, updated: updatedTotal }, operationId);
  if (!found && !meta.found) return null;
  const total = progressOf(state).total;
  return { memos, tags: meta.tags, updated: writeResult.rows.length, hasMore: false, nextAfter: null, progress: { done: total, total } };
}
