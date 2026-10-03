import { appendTagToContent } from "../../../src/lib/tags";
import { requireAuth } from "../_utils/auth";
import { contentKeyOf, openContentRows, sealContent } from "../_utils/crypto";
import { CURRENT_SEQ_SQL, groupImages, MEMO_COLUMNS, shapeMemo, type ImageMetaRow, type MemoJson, type MemoRow } from "../_utils/memos";
import { apiError, json, nowIso, readJson, requireSameOrigin, type ApiErrorCode } from "../_utils/response";
import { validTagPath } from "../_utils/tagops";
import type { AppContext } from "../_utils/types";
import { MAX_CONTENT_CHARS, VALID_ENTITY_ID } from "./index";

/** Set-based ops cost a fixed handful of statements whatever the count. */
export const MAX_BATCH_ITEMS = 200;
/** Tagging rewrites content row by row: one statement per memo, kept well
 *  inside the Free plan's 50 queries per invocation. */
export const MAX_TAG_BATCH_ITEMS = 30;

interface BatchItem {
  id: string;
  expectedSeq: number;
}

interface BatchBody {
  op?: unknown;
  items?: unknown;
  tag?: unknown;
}

interface HeaderRow {
  id: string;
  deleted_at: string | null;
  seq: number;
}

export interface MemoBatchResult {
  /** trash / restore: the fields that changed, applied over the caller's copy at `expectedSeq`. */
  patches: { id: string; deletedAt: string | null; seq: number }[];
  /** tag: memos whose content (or the caller's stale copy) changed. */
  memos: MemoJson[];
  /** purge: new tombstones, plus earlier ones for ids already gone. */
  purged: { id: string; seq: number }[];
  /** tag: ids already carrying the tag at the caller's version. */
  unchanged: string[];
  /** Per-item refusals; the rest of the batch still applied. */
  failed: { id: string; code: ApiErrorCode }[];
}

function emptyResult(): MemoBatchResult {
  return { patches: [], memos: [], purged: [], unchanged: [], failed: [] };
}

function parseItems(value: unknown, limit: number): BatchItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) return null;
  const items: BatchItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const { id, expectedSeq } = raw as { id?: unknown; expectedSeq?: unknown };
    if (typeof id !== "string" || !VALID_ENTITY_ID.test(id)) return null;
    if (typeof expectedSeq !== "number" || !Number.isSafeInteger(expectedSeq) || expectedSeq < 0) return null;
    // A repeated id would be counted twice when claiming seq numbers.
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, expectedSeq });
  }
  return items;
}

/** Requested rows still at the caller's version and in the op's source state, numbered for seq allocation. */
function targetSql(stateSql: string): string {
  return `SELECT m.id, ROW_NUMBER() OVER (ORDER BY m.id COLLATE BINARY) AS rn
          FROM memos AS m
          JOIN json_each(?) AS j
            ON m.id = json_extract(j.value, '$.id') AND m.seq = json_extract(j.value, '$.seq')
          WHERE ${stateSql}`;
}

const REQUESTED_IDS_SQL = "SELECT json_extract(value, '$.id') FROM json_each(?)";

/**
 * Trash or restore every matching item in one transaction. Like Empty Trash,
 * each memo gets its own seq from one counter claim, so sync pages stay
 * bounded; a row another client changed meanwhile is left alone and reported.
 */
async function moveMany(context: AppContext, items: BatchItem[], op: "trash" | "restore"): Promise<MemoBatchResult> {
  const db = context.env.DB;
  const itemsJson = JSON.stringify(items.map((item) => ({ id: item.id, seq: item.expectedSeq })));
  const restoring = op === "restore";
  const target = targetSql(restoring ? "m.deleted_at IS NOT NULL" : "m.deleted_at IS NULL");
  const deletedAt = restoring ? null : nowIso();
  const results = await db.batch([
    db
      .prepare(
        `WITH target AS MATERIALIZED (${target})
         UPDATE sync_counter SET n = n + (SELECT COUNT(*) FROM target)
         WHERE id = 1 AND EXISTS (SELECT 1 FROM target)
         RETURNING n`
      )
      .bind(itemsJson),
    db
      .prepare(
        `WITH target AS MATERIALIZED (${target})
         UPDATE memos
         SET deleted_at = ?,
             seq = ${CURRENT_SEQ_SQL} - (SELECT COUNT(*) FROM target) + (SELECT rn FROM target WHERE target.id = memos.id)
         WHERE id IN (SELECT id FROM target)
         RETURNING id, deleted_at, seq`
      )
      .bind(itemsJson, deletedAt),
    db.prepare(`SELECT id, deleted_at, seq FROM memos WHERE id IN (${REQUESTED_IDS_SQL})`).bind(itemsJson)
  ]);
  const moved = new Map(((results[1]?.results ?? []) as HeaderRow[]).map((row) => [row.id, row]));
  const current = new Map(((results[2]?.results ?? []) as HeaderRow[]).map((row) => [row.id, row]));
  const result = emptyResult();
  for (const item of items) {
    const row = moved.get(item.id) ?? current.get(item.id);
    if (!row) result.failed.push({ id: item.id, code: "MEMO_NOT_FOUND" });
    else if (!moved.has(item.id) && row.seq !== item.expectedSeq) result.failed.push({ id: item.id, code: "VERSION_CONFLICT" });
    // Moved now, or already where the caller wanted it at their version.
    else result.patches.push({ id: row.id, deletedAt: row.deleted_at, seq: row.seq });
  }
  return result;
}

/** Permanently delete trashed items: tombstones, attachments and rows in one transaction. */
async function purgeMany(context: AppContext, items: BatchItem[]): Promise<MemoBatchResult> {
  // Irreversible: refuse while the deployment key cannot read existing rows.
  await contentKeyOf(context.env);
  const db = context.env.DB;
  const itemsJson = JSON.stringify(items.map((item) => ({ id: item.id, seq: item.expectedSeq })));
  const target = targetSql("m.deleted_at IS NOT NULL");
  const results = await db.batch([
    db
      .prepare(
        `WITH target AS MATERIALIZED (${target})
         UPDATE sync_counter SET n = n + (SELECT COUNT(*) FROM target)
         WHERE id = 1 AND EXISTS (SELECT 1 FROM target)
         RETURNING n`
      )
      .bind(itemsJson),
    db
      .prepare(
        `WITH target AS MATERIALIZED (${target})
         INSERT OR REPLACE INTO tombstones (id, seq)
         SELECT id, ${CURRENT_SEQ_SQL} - (SELECT COUNT(*) FROM target) + rn FROM target
         RETURNING id, seq`
      )
      .bind(itemsJson),
    db.prepare(`DELETE FROM memo_images WHERE memo_id IN (SELECT id FROM (${target}))`).bind(itemsJson),
    db.prepare(`DELETE FROM memos WHERE id IN (SELECT id FROM (${target}))`).bind(itemsJson),
    db.prepare(`SELECT id, deleted_at, seq FROM memos WHERE id IN (${REQUESTED_IDS_SQL})`).bind(itemsJson),
    db.prepare(`SELECT id, seq FROM tombstones WHERE id IN (${REQUESTED_IDS_SQL})`).bind(itemsJson)
  ]);
  const purged = new Map(((results[1]?.results ?? []) as { id: string; seq: number }[]).map((row) => [row.id, row]));
  const survivors = new Map(((results[4]?.results ?? []) as HeaderRow[]).map((row) => [row.id, row]));
  const tombstones = new Map(((results[5]?.results ?? []) as { id: string; seq: number }[]).map((row) => [row.id, row]));
  const result = emptyResult();
  for (const item of items) {
    const done = purged.get(item.id);
    const survivor = survivors.get(item.id);
    const earlier = tombstones.get(item.id);
    if (done) result.purged.push(done);
    else if (survivor) result.failed.push({ id: item.id, code: survivor.seq !== item.expectedSeq ? "VERSION_CONFLICT" : "MEMO_NOT_TRASHED" });
    else if (earlier) result.purged.push(earlier);
    else result.failed.push({ id: item.id, code: "MEMO_NOT_FOUND" });
  }
  result.purged.sort((left, right) => left.seq - right.seq);
  return result;
}

/**
 * Append one tag to each memo on the server, against its current content, so
 * the client never uploads memo text for a bulk tag. A memo that changed
 * between this read and the write is reported as a conflict, never clobbered.
 */
async function tagMany(context: AppContext, items: BatchItem[], tag: string): Promise<MemoBatchResult> {
  const db = context.env.DB;
  const read = await db
    .prepare(`SELECT ${MEMO_COLUMNS} FROM memos WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(items.map((item) => item.id)))
    .all<MemoRow>();
  const rows = read.results ?? [];
  const key = await openContentRows(context.env, rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = emptyResult();
  const stale: MemoRow[] = [];
  const pending: { row: MemoRow; next: string }[] = [];
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) {
      result.failed.push({ id: item.id, code: "MEMO_NOT_FOUND" });
      continue;
    }
    if (row.deleted_at !== null) {
      result.failed.push({ id: item.id, code: "MEMO_TRASHED" });
      continue;
    }
    const next = appendTagToContent(row.content, tag);
    if (next === row.content) {
      // Already tagged; hand back the server copy if the caller's is older.
      if (row.seq === item.expectedSeq) result.unchanged.push(row.id);
      else stale.push(row);
    } else if (next.length > MAX_CONTENT_CHARS) {
      result.failed.push({ id: item.id, code: "MEMO_CONTENT_TOO_LONG" });
    } else {
      pending.push({ row, next });
    }
  }

  const written: MemoRow[] = [];
  if (pending.length > 0) {
    const now = nowIso();
    const format = key ? "enc1" : "plain";
    const stored = await Promise.all(pending.map(({ next }) => (key ? sealContent(key, next) : next)));
    const expectedJson = JSON.stringify(pending.map(({ row }) => ({ id: row.id, seq: row.seq })));
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE sync_counter SET n = n + ?
           WHERE id = 1 AND EXISTS (SELECT 1 FROM (${targetSql("m.deleted_at IS NULL")}))
           RETURNING n`
        )
        .bind(pending.length, expectedJson)
    ];
    pending.forEach(({ row }, index) => {
      statements.push(
        db
          .prepare(
            `UPDATE memos
             SET content = ?, content_format = ?, updated_at = ?, seq = ${CURRENT_SEQ_SQL} - ? + ?, mutation_token = ?
             WHERE id = ? AND seq = ? AND deleted_at IS NULL
             RETURNING id, seq`
          )
          .bind(stored[index], format, now, pending.length, index + 1, crypto.randomUUID(), row.id, row.seq)
      );
    });
    const results = await db.batch(statements);
    pending.forEach(({ row, next }, index) => {
      const returned = results[index + 1]?.results?.[0] as { id?: unknown; seq?: unknown } | undefined;
      if (returned?.id === row.id && typeof returned.seq === "number") {
        written.push({ ...row, content: next, content_format: format, updated_at: now, seq: returned.seq });
      } else {
        result.failed.push({ id: row.id, code: "VERSION_CONFLICT" });
      }
    });
  }

  const shaped = [...written, ...stale];
  if (shaped.length > 0) {
    const images = await db
      .prepare(
        `SELECT id, memo_id, ord, mime, width, height, bytes FROM memo_images
         WHERE memo_id IN (SELECT value FROM json_each(?))
         ORDER BY memo_id COLLATE BINARY, ord`
      )
      .bind(JSON.stringify(shaped.map((row) => row.id)))
      .all<ImageMetaRow>();
    const imagesByMemo = groupImages(images.results ?? []);
    result.memos = shaped.map((row) => shapeMemo(row, imagesByMemo.get(row.id) ?? []));
  }
  return result;
}

/**
 * POST /api/memos/batch — one request for a select-mode action over many
 * memos: `{ op: "trash" | "restore" | "purge", items: [{ id, expectedSeq }] }`
 * (up to 200) or `{ op: "tag", tag, items }` (up to 30). Items are judged one
 * by one: version conflicts and missing rows come back in `failed` while the
 * rest of the batch commits.
 */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<BatchBody>(context.request, 200_000).catch(() => null);
  const op = body?.op;
  if (op !== "trash" && op !== "restore" && op !== "purge" && op !== "tag") {
    return apiError(400, "INVALID_REQUEST_BODY", "Unknown batch operation.");
  }
  const items = parseItems(body?.items, op === "tag" ? MAX_TAG_BATCH_ITEMS : MAX_BATCH_ITEMS);
  if (!items) return apiError(400, "INVALID_REQUEST_BODY", "Invalid batch items.");

  if (op === "tag") {
    const tag = typeof body?.tag === "string" ? body.tag : "";
    if (!validTagPath(tag)) return apiError(400, "TAG_INVALID", "The tag name is invalid.");
    return json(await tagMany(context, items, tag));
  }
  if (op === "purge") return json(await purgeMany(context, items));
  return json(await moveMany(context, items, op));
}
