import { requireAuth } from "./_utils/auth";
import { contentKeyOf, sealContent, type ContentFormat } from "./_utils/crypto";
import { claimSeq, claimedSeq, CURRENT_SEQ_SQL } from "./_utils/memos";
import { validTagPath } from "./_utils/tagops";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "./_utils/response";
import type { AppContext } from "./_utils/types";
import { base64Bytes, MAX_CONTENT_CHARS, validateImages } from "./memos/index";

interface BackupMemo {
  id?: unknown;
  content?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  pinnedAt?: unknown;
  deletedAt?: unknown;
  images?: unknown;
}

interface BackupBody {
  format?: unknown;
  version?: unknown;
  memos?: unknown;
  tags?: unknown;
}

interface CleanImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  dataBase64: string;
}

interface CleanMemo {
  id: string;
  content: string;
  stored: string;
  format: ContentFormat;
  mutationToken: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  deletedAt: string | null;
  images: CleanImage[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// One legal memo may carry nine ~1.2MB base64 images; 14MB accepts that
// worst-case single item while staying far below the old 95MB request buffer.
const MAX_REQUEST_BYTES = 14_000_000;
// Auth consumes another D1 read. Keeping business statements <=36 leaves
// ample room below the Free-plan 50-query per-invocation ceiling.
const MAX_WRITE_STATEMENTS = 36;
// Text memos are written set-wise (one claim + one INSERT per json_each
// group), so a chunk's statement cost no longer grows with its memo count.
const MAX_INPUT_MEMOS = 100;
const MAX_INPUT_TAGS = 18;
// D1 caps a bound string at 2MB. A JSON group of at most 600k UTF-16 units
// stays below that even if every unit encodes as three UTF-8 bytes.
const MAX_GROUP_JSON_CHARS = 600_000;

function isoOr(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function imageDimension(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function imageInsert(db: D1Database, memo: CleanMemo): D1PreparedStatement {
  const selects: string[] = [];
  const bindings: unknown[] = [];
  memo.images.forEach((image, index) => {
    selects.push(
      `${index === 0 ? "SELECT" : "UNION ALL SELECT"} ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM memos WHERE id = ? AND mutation_token = ?)`
    );
    bindings.push(
      image.id,
      memo.id,
      index,
      image.mime,
      image.width,
      image.height,
      base64Bytes(image.dataBase64),
      image.dataBase64,
      memo.createdAt,
      memo.id,
      memo.mutationToken
    );
  });
  return db
    .prepare(
      `INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at)
       ${selects.join("\n")}`
    )
    .bind(...bindings);
}

/**
 * Merge one bounded backup chunk. Existing ids win and retries are idempotent.
 * Every conditional sequence claim and its data writes share one D1 batch;
 * `mutation_token` prevents a concurrent loser from attaching its images to
 * the winner's memo.
 */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  const body = await readJson<BackupBody>(context.request, MAX_REQUEST_BYTES).catch(() => null);
  if (!body || body.format !== "memo-backup" || body.version !== 1 || !Array.isArray(body.memos)) {
    return apiError(400, "INVALID_REQUEST_BODY", "This is not a memo backup file.");
  }
  if (body.memos.length > MAX_INPUT_MEMOS || (Array.isArray(body.tags) && body.tags.length > MAX_INPUT_TAGS)) {
    return apiError(413, "INVALID_REQUEST_BODY", "This import chunk has too many items. Split it into smaller chunks and retry.");
  }

  const now = nowIso();
  const seenMemoIds = new Set<string>();
  const seenImageIds = new Set<string>();
  const rawMemos: Omit<CleanMemo, "stored" | "format" | "mutationToken">[] = [];
  let skipped = 0;
  for (const raw of body.memos as BackupMemo[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!ID_PATTERN.test(id)) {
      return apiError(400, "BACKUP_MEMO_INVALID", "Every backup memo must have a valid stable id.");
    }
    if (seenMemoIds.has(id)) {
      return apiError(400, "BACKUP_MEMO_INVALID", "Memo ids must be unique within an import chunk.");
    }
    seenMemoIds.add(id);
    if (typeof raw.content !== "string") {
      return apiError(400, "BACKUP_MEMO_INVALID", "Every backup memo must contain text content.");
    }
    const content = raw.content;
    if (content.length > MAX_CONTENT_CHARS) {
      return apiError(400, "MEMO_CONTENT_TOO_LONG", `A memo can contain up to ${MAX_CONTENT_CHARS} characters.`, {
        max: MAX_CONTENT_CHARS
      });
    }
    if (!Array.isArray(raw.images)) {
      return apiError(400, "BACKUP_IMAGE_INVALID", "Every backup memo must contain an image list.");
    }
    const validated = validateImages(raw.images, { requireStableFields: true });
    if (validated.error) {
      const code = validated.error.code === "INVALID_REQUEST_BODY" ? "BACKUP_IMAGE_INVALID" : validated.error.code;
      return apiError(400, code, validated.error.error, validated.error.params);
    }
    const images: CleanImage[] = [];
    for (const image of validated.images) {
      if (seenImageIds.has(image.id)) {
        return apiError(400, "BACKUP_IMAGE_INVALID", "Image ids must be unique across the backup.");
      }
      seenImageIds.add(image.id);
      images.push({
        ...image,
        width: imageDimension(image.width),
        height: imageDimension(image.height)
      });
    }
    if (!content.trim() && images.length === 0) {
      return apiError(400, "BACKUP_MEMO_INVALID", "A backup memo must contain text or at least one image.");
    }
    rawMemos.push({
      id,
      content,
      createdAt: isoOr(raw.createdAt, now),
      updatedAt: isoOr(raw.updatedAt, now),
      pinnedAt: isoOrNull(raw.pinnedAt),
      deletedAt: isoOrNull(raw.deletedAt),
      images
    });
  }

  const tags: { path: string; pinnedAt: string }[] = [];
  const seenTagPaths = new Set<string>();
  if (Array.isArray(body.tags)) {
    for (const tag of body.tags as { path?: unknown; pinnedAt?: unknown }[]) {
      const path = typeof tag?.path === "string" ? tag.path.trim() : "";
      const pinnedAt = isoOrNull(tag?.pinnedAt);
      if (!validTagPath(path) || !pinnedAt || seenTagPaths.has(path)) continue;
      seenTagPaths.add(path);
      tags.push({ path, pinnedAt });
    }
  }

  // Lower bound (one text group); the exact cost is checked after sealing.
  const imageMemoCount = rawMemos.filter((memo) => memo.images.length > 0).length;
  const fixedCost = imageMemoCount + tags.length * 2;
  if ((rawMemos.length > 0 ? 3 : 0) + fixedCost > MAX_WRITE_STATEMENTS) {
    return apiError(413, "INVALID_REQUEST_BODY", "This import chunk is too large. Split it into smaller chunks and retry.");
  }

  const db = context.env.DB;
  let pendingMemos = rawMemos;
  if (rawMemos.length > 0) {
    // json_each keeps both preflights at one bound value, well inside D1's
    // 100-parameter ceiling however many memos and images the chunk holds.
    const existingResult = await db
      .prepare("SELECT id FROM memos WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(rawMemos.map((memo) => memo.id)))
      .all<{ id: string }>();
    const existingIds = new Set((existingResult.results ?? []).map((row) => row.id));
    skipped += existingIds.size;
    pendingMemos = rawMemos.filter((memo) => !existingIds.has(memo.id));
  }

  const pendingImageIds = pendingMemos.flatMap((memo) => memo.images.map((image) => image.id));
  if (pendingImageIds.length > 0) {
    const collision = await db
      .prepare("SELECT id FROM memo_images WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1")
      .bind(JSON.stringify(pendingImageIds))
      .first<{ id: string }>();
    if (collision) {
      return apiError(409, "BACKUP_IMAGE_INVALID", "An imported image id already belongs to another memo.");
    }
  }

  const key = await contentKeyOf(context.env);
  // One token per request: image and tombstone writes still only touch rows
  // this request inserted, because a concurrent winner carries its own token.
  const mutationToken = crypto.randomUUID();
  const format: ContentFormat = key ? "enc1" : "plain";
  const memos = new Array<CleanMemo>(pendingMemos.length);
  let sealCursor = 0;
  const sealers = Array.from({ length: Math.min(4, pendingMemos.length) }, async () => {
    while (sealCursor < pendingMemos.length) {
      const index = sealCursor++;
      const memo = pendingMemos[index];
      memos[index] = {
        ...memo,
        stored: key ? await sealContent(key, memo.content) : memo.content,
        format,
        mutationToken
      };
    }
  });
  await Promise.all(sealers);

  // Rows travel as JSON arrays; a group closes before its JSON would pass
  // the bound-value ceiling. A normal chunk is a single group.
  const groups: string[][] = [];
  let groupChars = 0;
  for (const memo of memos) {
    const row = JSON.stringify([memo.id, memo.stored, memo.createdAt, memo.updatedAt, memo.pinnedAt, memo.deletedAt]);
    const current = groups[groups.length - 1];
    if (!current || groupChars + row.length + 1 > MAX_GROUP_JSON_CHARS) {
      groups.push([row]);
      groupChars = row.length + 2;
    } else {
      current.push(row);
      groupChars += row.length + 1;
    }
  }
  if (groups.length * 2 + (memos.length > 0 ? 1 : 0) + fixedCost > MAX_WRITE_STATEMENTS) {
    return apiError(413, "INVALID_REQUEST_BODY", "This import chunk is too large. Split it into smaller chunks and retry.");
  }

  const statements: D1PreparedStatement[] = [];
  const insertIndexes: number[] = [];
  for (const rows of groups) {
    const rowsJson = `[${rows.join(",")}]`;
    // Set-based claim, as in trash.ts: the counter advances once by the
    // number of rows still absent, and the INSERT hands those rows the
    // claimed range in file order. Both run in one batch transaction, so they
    // see the same absent set; a group with nothing new claims nothing.
    statements.push(
      db
        .prepare(
          `UPDATE sync_counter
           SET n = n + (SELECT COUNT(*) FROM json_each(?1) j WHERE NOT EXISTS (SELECT 1 FROM memos WHERE id = json_extract(j.value, '$[0]')))
           WHERE id = 1 AND EXISTS (SELECT 1 FROM json_each(?1) j WHERE NOT EXISTS (SELECT 1 FROM memos WHERE id = json_extract(j.value, '$[0]')))
           RETURNING n`
        )
        .bind(rowsJson)
    );
    insertIndexes.push(statements.length);
    statements.push(
      db
        .prepare(
          `INSERT INTO memos (id, content, content_format, mutation_token, created_at, updated_at, pinned_at, deleted_at, seq)
           SELECT id, content, ?2, ?3, created_at, updated_at, pinned_at, deleted_at,
                  ${CURRENT_SEQ_SQL} - COUNT(*) OVER () + ROW_NUMBER() OVER (ORDER BY ord)
           FROM (
             SELECT CAST(j.key AS INTEGER) AS ord,
                    json_extract(j.value, '$[0]') AS id,
                    json_extract(j.value, '$[1]') AS content,
                    json_extract(j.value, '$[2]') AS created_at,
                    json_extract(j.value, '$[3]') AS updated_at,
                    json_extract(j.value, '$[4]') AS pinned_at,
                    json_extract(j.value, '$[5]') AS deleted_at
             FROM json_each(?1) j
           ) AS src
           WHERE NOT EXISTS (SELECT 1 FROM memos m WHERE m.id = src.id)
           RETURNING id`
        )
        .bind(rowsJson, format, mutationToken)
    );
  }
  if (memos.length > 0) {
    statements.push(
      db
        .prepare(
          `DELETE FROM tombstones
           WHERE id IN (SELECT value FROM json_each(?1))
             AND EXISTS (SELECT 1 FROM memos m WHERE m.id = tombstones.id AND m.mutation_token = ?2)`
        )
        .bind(JSON.stringify(memos.map((memo) => memo.id)), mutationToken)
    );
  }
  const imageIndexes: { memoId: string; index: number; imageCount: number }[] = [];
  for (const memo of memos) {
    if (memo.images.length === 0) continue;
    imageIndexes.push({ memoId: memo.id, index: statements.length, imageCount: memo.images.length });
    statements.push(imageInsert(db, memo));
  }

  const tagClaimIndexes: number[] = [];
  for (const tag of tags) {
    tagClaimIndexes.push(statements.length);
    statements.push(
      claimSeq(db, "NOT EXISTS (SELECT 1 FROM tag_meta WHERE path = ?)", [tag.path]),
      db
        .prepare(
          `INSERT INTO tag_meta (path, pinned_at, updated_at, seq)
           SELECT ?, ?, ?, ${CURRENT_SEQ_SQL}
           WHERE NOT EXISTS (SELECT 1 FROM tag_meta WHERE path = ?)`
        )
        .bind(tag.path, tag.pinnedAt, now, tag.path)
    );
  }

  let results: D1Result<unknown>[];
  try {
    results = statements.length > 0 ? await db.batch(statements) : [];
  } catch (error) {
    // The preflight above gives normal conflicts a useful 409. A plain INSERT
    // remains the transactional race guard: if another request claims an image
    // id after preflight, D1 rolls the batch back instead of silently dropping
    // that attachment as INSERT OR IGNORE did.
    if (error instanceof Error && /UNIQUE constraint failed:\s*memo_images\.id/i.test(error.message)) {
      return apiError(409, "BACKUP_IMAGE_INVALID", "An imported image id already belongs to another memo.");
    }
    throw error;
  }
  const insertedIds = new Set<string>();
  for (const index of insertIndexes) {
    for (const row of (results[index]?.results ?? []) as { id?: unknown }[]) {
      if (typeof row.id === "string") insertedIds.add(row.id);
    }
  }
  const imported = insertedIds.size;
  skipped += memos.length - imported;
  let importedImages = 0;
  for (const { memoId, index, imageCount } of imageIndexes) {
    if (!insertedIds.has(memoId)) continue;
    const changes = Number(results[index]?.meta?.changes ?? 0);
    importedImages += Math.max(0, Math.min(imageCount, changes));
  }
  // Reading the claim results is intentional even though imported tag count
  // is not part of backup-v1's response: it makes missing-counter failures
  // surface through the batch instead of being mistaken for success.
  for (const index of tagClaimIndexes) claimedSeq(results[index]);

  return json({ imported, skipped, images: importedImages });
}
