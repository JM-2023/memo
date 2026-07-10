import { requireAuth } from "./_utils/auth";
import { openContentRows } from "./_utils/crypto";
import { MEMO_COLUMNS, type MemoRow, type TagMetaRow } from "./_utils/memos";
import { apiError, nowIso } from "./_utils/response";
import type { AppContext } from "./_utils/types";

interface ImageDataRow {
  id: string;
  memo_id: string;
  ord: number;
  mime: string;
  width: number;
  height: number;
  data_base64: string;
}

interface ExportCursor {
  v: 1;
  after: string;
  maxId: string;
  exportedAt: string;
}

interface ExportMemo {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  deletedAt: string | null;
  images: { id: string; mime: string; width: number; height: number; dataBase64: string }[];
}

const MAX_CURSOR_CHARS = 1_024;
const MAX_ID_CHARS = 128;
const MAX_MEMOS_PER_PAGE = 50;
const TARGET_IMAGE_BYTES_PER_PAGE = 6_000_000;

function encodeCursor(cursor: ExportCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string | null): ExportCursor | null {
  if (!value || value.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Partial<ExportCursor>;
    if (
      parsed.v !== 1 ||
      typeof parsed.after !== "string" ||
      typeof parsed.maxId !== "string" ||
      typeof parsed.exportedAt !== "string" ||
      parsed.after.length === 0 ||
      parsed.after.length > MAX_ID_CHARS ||
      parsed.maxId.length > MAX_ID_CHARS ||
      parsed.after > parsed.maxId ||
      parsed.exportedAt.length > 40 ||
      Number.isNaN(Date.parse(parsed.exportedAt))
    ) {
      return null;
    }
    return parsed as ExportCursor;
  } catch {
    return null;
  }
}

/** Serialize one bounded page with backpressure instead of one giant string. */
function streamedPage(
  exportedAt: string,
  memos: ExportMemo[],
  tags: { path: string; pinnedAt: string | null }[],
  hasMore: boolean,
  nextAfter: string | null
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let phase: "head" | "memos" | "tags-head" | "tags" | "tail" | "done" = "head";
  let memoIndex = 0;
  let tagIndex = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === "head") {
        controller.enqueue(encoder.encode(`{"format":"memo-backup","version":1,"exportedAt":${JSON.stringify(exportedAt)},"memos":[`));
        phase = "memos";
        return;
      }
      if (phase === "memos") {
        if (memoIndex < memos.length) {
          controller.enqueue(encoder.encode(`${memoIndex === 0 ? "" : ","}${JSON.stringify(memos[memoIndex++])}`));
          return;
        }
        phase = "tags-head";
      }
      if (phase === "tags-head") {
        controller.enqueue(encoder.encode(`],"tags":[`));
        phase = "tags";
        return;
      }
      if (phase === "tags") {
        if (tagIndex < tags.length) {
          controller.enqueue(encoder.encode(`${tagIndex === 0 ? "" : ","}${JSON.stringify(tags[tagIndex++])}`));
          return;
        }
        phase = "tail";
      }
      if (phase === "tail") {
        controller.enqueue(encoder.encode(`],"hasMore":${hasMore},"nextAfter":${JSON.stringify(nextAfter)}}`));
        phase = "done";
        return;
      }
      controller.close();
    }
  });
}

/**
 * A backup page. The browser follows `nextAfter` across HTTP requests, then
 * assembles the ordinary backup-v1 object. This resets D1's per-invocation
 * query budget on every page; an unbounded loop inside one Worker would still
 * hit the 50-query ceiling even if its response body were streamed.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const denied = await requireAuth(context);
  if (denied) return denied;

  const url = new URL(context.request.url);
  const afterParam = url.searchParams.get("after");
  const continuation = afterParam === null ? null : decodeCursor(afterParam);
  if (afterParam !== null && !continuation) {
    return apiError(400, "INVALID_REQUEST_BODY", "The export continuation is invalid.");
  }

  const db = context.env.DB;
  let state: ExportCursor;
  if (continuation) {
    state = continuation;
  } else {
    const boundary = await db.prepare("SELECT COALESCE(MAX(id), '') AS max_id FROM memos").first<{ max_id: string }>();
    state = { v: 1, after: "", maxId: boundary?.max_id ?? "", exportedAt: nowIso() };
  }

  const candidateResult = await db
    .prepare(
      `SELECT m.id, COALESCE(SUM(i.bytes), 0) AS image_bytes
       FROM memos m LEFT JOIN memo_images i ON i.memo_id = m.id
       WHERE m.id > ? AND m.id <= ?
       GROUP BY m.id
       ORDER BY m.id COLLATE BINARY
       LIMIT ?`
    )
    .bind(state.after, state.maxId, MAX_MEMOS_PER_PAGE + 1)
    .all<{ id: string; image_bytes: number }>();

  const candidates = candidateResult.results ?? [];
  const selected: { id: string; image_bytes: number }[] = [];
  let imageBytes = 0;
  for (const candidate of candidates.slice(0, MAX_MEMOS_PER_PAGE)) {
    const bytes = Math.max(0, Number(candidate.image_bytes) || 0);
    if (selected.length > 0 && imageBytes + bytes > TARGET_IMAGE_BYTES_PER_PAGE) break;
    selected.push(candidate);
    imageBytes += bytes;
  }

  const lastId = selected.length > 0 ? selected[selected.length - 1].id : state.after;
  const hasMore = selected.length > 0 && (selected.length < candidates.length || lastId < state.maxId);
  const statements: D1PreparedStatement[] = [];
  if (selected.length > 0) {
    const ids = selected.map((candidate) => candidate.id);
    const placeholders = ids.map(() => "?").join(", ");
    statements.push(
      db.prepare(`SELECT ${MEMO_COLUMNS} FROM memos WHERE id IN (${placeholders}) ORDER BY id COLLATE BINARY`).bind(...ids),
      db
        .prepare(
          `SELECT id, memo_id, ord, mime, width, height, data_base64
           FROM memo_images WHERE memo_id IN (${placeholders})
           ORDER BY memo_id COLLATE BINARY, ord`
        )
        .bind(...ids)
    );
  }
  if (!continuation) {
    statements.push(db.prepare("SELECT path, pinned_at, seq FROM tag_meta WHERE pinned_at IS NOT NULL ORDER BY path COLLATE BINARY"));
  }

  const results = statements.length > 0 ? await db.batch(statements) : [];
  let resultIndex = 0;
  const memoRows = selected.length > 0 ? ((results[resultIndex++]?.results ?? []) as unknown as MemoRow[]) : [];
  const imageRows = selected.length > 0 ? ((results[resultIndex++]?.results ?? []) as unknown as ImageDataRow[]) : [];
  const tagRows = !continuation ? ((results[resultIndex++]?.results ?? []) as unknown as TagMetaRow[]) : [];

  await openContentRows(context.env, memoRows);
  const imagesByMemo = new Map<string, ImageDataRow[]>();
  for (const row of imageRows) {
    const list = imagesByMemo.get(row.memo_id) ?? [];
    list.push(row);
    imagesByMemo.set(row.memo_id, list);
  }
  const memos: ExportMemo[] = memoRows.map((memo) => ({
    id: memo.id,
    content: memo.content,
    createdAt: memo.created_at,
    updatedAt: memo.updated_at,
    pinnedAt: memo.pinned_at,
    deletedAt: memo.deleted_at,
    images: (imagesByMemo.get(memo.id) ?? []).map((image) => ({
      id: image.id,
      mime: image.mime,
      width: image.width,
      height: image.height,
      dataBase64: image.data_base64
    }))
  }));
  const tags = tagRows.map((tag) => ({ path: tag.path, pinnedAt: tag.pinned_at }));
  const nextAfter = hasMore ? encodeCursor({ ...state, after: lastId }) : null;

  return new Response(streamedPage(state.exportedAt, memos, tags, hasMore, nextAfter), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
