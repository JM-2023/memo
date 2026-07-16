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

interface MemoResultIndexes {
  claim: number;
  images: number | null;
  imageCount: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// One legal memo may carry nine ~1.2MB base64 images; 14MB accepts that
// worst-case single item while staying far below the old 95MB request buffer.
const MAX_REQUEST_BYTES = 14_000_000;
// Auth consumes another D1 read. Keeping business statements <=36 leaves
// ample room below the Free-plan 50-query per-invocation ceiling.
const MAX_WRITE_STATEMENTS = 36;
const MAX_INPUT_MEMOS = 12;
const MAX_INPUT_TAGS = 18;

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

  const statementCost = rawMemos.reduce((sum, memo) => sum + 3 + (memo.images.length > 0 ? 1 : 0), 0) + tags.length * 2;
  if (statementCost > MAX_WRITE_STATEMENTS) {
    return apiError(413, "INVALID_REQUEST_BODY", "This import chunk is too large. Split it into smaller chunks and retry.");
  }

  const db = context.env.DB;
  let pendingMemos = rawMemos;
  if (rawMemos.length > 0) {
    const memoPlaceholders = rawMemos.map(() => "?").join(", ");
    const existingResult = await db
      .prepare(`SELECT id FROM memos WHERE id IN (${memoPlaceholders})`)
      .bind(...rawMemos.map((memo) => memo.id))
      .all<{ id: string }>();
    const existingIds = new Set((existingResult.results ?? []).map((row) => row.id));
    skipped += existingIds.size;
    pendingMemos = rawMemos.filter((memo) => !existingIds.has(memo.id));
  }

  const pendingImageIds = pendingMemos.flatMap((memo) => memo.images.map((image) => image.id));
  if (pendingImageIds.length > 0) {
    const imagePlaceholders = pendingImageIds.map(() => "?").join(", ");
    const collision = await db
      .prepare(`SELECT id FROM memo_images WHERE id IN (${imagePlaceholders}) LIMIT 1`)
      .bind(...pendingImageIds)
      .first<{ id: string }>();
    if (collision) {
      return apiError(409, "BACKUP_IMAGE_INVALID", "An imported image id already belongs to another memo.");
    }
  }

  const key = await contentKeyOf(context.env);
  const memos = new Array<CleanMemo>(pendingMemos.length);
  let sealCursor = 0;
  const sealers = Array.from({ length: Math.min(4, pendingMemos.length) }, async () => {
    while (sealCursor < pendingMemos.length) {
      const index = sealCursor++;
      const memo = pendingMemos[index];
      memos[index] = {
        ...memo,
        stored: key ? await sealContent(key, memo.content) : memo.content,
        format: key ? "enc1" : "plain",
        mutationToken: crypto.randomUUID()
      };
    }
  });
  await Promise.all(sealers);

  const statements: D1PreparedStatement[] = [];
  const memoIndexes: MemoResultIndexes[] = [];
  for (const memo of memos) {
    const claim = statements.length;
    statements.push(
      claimSeq(db, "NOT EXISTS (SELECT 1 FROM memos WHERE id = ?)", [memo.id]),
      db
        .prepare(
          `INSERT INTO memos (id, content, content_format, mutation_token, created_at, updated_at, pinned_at, deleted_at, seq)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ${CURRENT_SEQ_SQL}
           WHERE NOT EXISTS (SELECT 1 FROM memos WHERE id = ?)`
        )
        .bind(
          memo.id,
          memo.stored,
          memo.format,
          memo.mutationToken,
          memo.createdAt,
          memo.updatedAt,
          memo.pinnedAt,
          memo.deletedAt,
          memo.id
        ),
      db
        .prepare("DELETE FROM tombstones WHERE id = ? AND EXISTS (SELECT 1 FROM memos WHERE id = ? AND mutation_token = ?)")
        .bind(memo.id, memo.id, memo.mutationToken)
    );
    let images: number | null = null;
    if (memo.images.length > 0) {
      images = statements.length;
      statements.push(imageInsert(db, memo));
    }
    memoIndexes.push({ claim, images, imageCount: memo.images.length });
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
  let imported = 0;
  let importedImages = 0;
  memoIndexes.forEach((indexes) => {
    if (claimedSeq(results[indexes.claim]) === null) {
      skipped += 1;
      return;
    }
    imported += 1;
    if (indexes.images !== null) {
      const changes = Number(results[indexes.images]?.meta?.changes ?? 0);
      importedImages += Math.max(0, Math.min(indexes.imageCount, changes));
    }
  });
  // Reading the claim results is intentional even though imported tag count
  // is not part of backup-v1's response: it makes missing-counter failures
  // surface through the batch instead of being mistaken for success.
  for (const index of tagClaimIndexes) claimedSeq(results[index]);

  return json({ imported, skipped, images: importedImages });
}
