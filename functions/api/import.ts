import { requireAuth } from "./_utils/auth";
import { contentKeyOf, sealContent } from "./_utils/crypto";
import { apiError, json, nowIso, readJson, requireSameOrigin } from "./_utils/response";
import type { AppContext } from "./_utils/types";
import { base64Bytes, MAX_CONTENT_CHARS, MAX_IMAGE_BASE64_CHARS, MAX_IMAGES_PER_MEMO } from "./memos/index";
import { isValidTagPath } from "../../src/lib/tags";

interface BackupImage {
  id?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  dataBase64?: unknown;
}

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

const ALLOWED_MIMES = new Set(["image/webp", "image/jpeg", "image/png", "image/gif"]);
// Export ids are UUIDs; anything else in a hand-edited file is skipped rather
// than guessed at (ids end up in image URLs and sync payloads).
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Statements per D1 batch — imports of any size stream through in chunks. */
const BATCH_SIZE = 25;

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

/**
 * Merge a backup produced by /api/export into this notebook. Existing rows
 * always win: a memo id that is already present is skipped wholesale, so
 * importing is additive and re-running the same file is a no-op. Inserted
 * rows claim fresh seqs (one counter bump for the whole block), which is how
 * other devices pull the imported memos through the normal /api/sync path.
 */
export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const denied = await requireAuth(context);
  if (denied) return denied;

  // Workers accept request bodies up to ~100MB; inline image data is what
  // makes backups heavy, so allow most of that headroom.
  const body = await readJson<BackupBody>(context.request, 95_000_000).catch(() => null);
  if (!body || body.format !== "memo-backup" || body.version !== 1 || !Array.isArray(body.memos)) {
    return apiError(400, "INVALID_REQUEST_BODY", "This is not a memo backup file.");
  }

  const db = context.env.DB;
  const [memoIdResult, imageIdResult, tagPathResult] = await db.batch([
    db.prepare("SELECT id FROM memos"),
    db.prepare("SELECT id FROM memo_images"),
    db.prepare("SELECT path FROM tag_meta")
  ]);
  const existingMemoIds = new Set(((memoIdResult.results ?? []) as { id: string }[]).map((row) => row.id));
  const existingImageIds = new Set(((imageIdResult.results ?? []) as { id: string }[]).map((row) => row.id));
  const existingTagPaths = new Set(((tagPathResult.results ?? []) as { path: string }[]).map((row) => row.path));

  const now = nowIso();
  const contentKey = await contentKeyOf(context.env);

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
    createdAt: string;
    updatedAt: string;
    pinnedAt: string | null;
    deletedAt: string | null;
    images: CleanImage[];
  }

  const inserts: CleanMemo[] = [];
  let skipped = 0;
  const seenIds = new Set<string>();
  for (const raw of body.memos as BackupMemo[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const content = typeof raw?.content === "string" ? raw.content.slice(0, MAX_CONTENT_CHARS) : "";
    if (!ID_PATTERN.test(id) || seenIds.has(id)) {
      skipped += 1;
      continue;
    }
    seenIds.add(id);
    if (existingMemoIds.has(id)) {
      skipped += 1;
      continue;
    }
    const images: CleanImage[] = [];
    if (Array.isArray(raw.images)) {
      for (const image of (raw.images as BackupImage[]).slice(0, MAX_IMAGES_PER_MEMO)) {
        const imageId = typeof image?.id === "string" && ID_PATTERN.test(image.id) ? image.id : crypto.randomUUID();
        const data = typeof image?.dataBase64 === "string" ? image.dataBase64 : "";
        const mime = typeof image?.mime === "string" ? image.mime : "";
        if (!data || data.length > MAX_IMAGE_BASE64_CHARS || !ALLOWED_MIMES.has(mime) || existingImageIds.has(imageId)) {
          continue;
        }
        existingImageIds.add(imageId);
        images.push({
          id: imageId,
          mime,
          width: imageDimension(image.width),
          height: imageDimension(image.height),
          dataBase64: data
        });
      }
    }
    if (!content.trim() && images.length === 0) {
      skipped += 1;
      continue;
    }
    inserts.push({
      id,
      content,
      createdAt: isoOr(raw.createdAt, now),
      updatedAt: isoOr(raw.updatedAt, now),
      pinnedAt: isoOrNull(raw.pinnedAt),
      deletedAt: isoOrNull(raw.deletedAt),
      images
    });
  }

  const newTags: { path: string; pinnedAt: string }[] = [];
  if (Array.isArray(body.tags)) {
    for (const tag of body.tags as { path?: unknown; pinnedAt?: unknown }[]) {
      const path = typeof tag?.path === "string" ? tag.path.trim() : "";
      const pinnedAt = isoOrNull(tag?.pinnedAt);
      if (!isValidTagPath(path) || !pinnedAt || existingTagPaths.has(path)) continue;
      existingTagPaths.add(path);
      newTags.push({ path, pinnedAt });
    }
  }

  let importedImages = 0;
  if (inserts.length > 0 || newTags.length > 0) {
    // One counter bump claims a contiguous seq block for every new row.
    const seqRows = inserts.length + newTags.length;
    const counter = await db
      .prepare("UPDATE sync_counter SET n = n + ? WHERE id = 1 RETURNING n")
      .bind(seqRows)
      .first<{ n: number }>();
    if (!counter) {
      return apiError(500, "INTERNAL_ERROR", "sync_counter row missing — run migrations");
    }
    let seq = counter.n - seqRows;

    // A memo and its images always travel in the same batch, so a failed
    // chunk can never leave a half-written memo behind.
    const groups: D1PreparedStatement[][] = [];
    for (const memo of inserts) {
      seq += 1;
      const stored = contentKey ? await sealContent(contentKey, memo.content) : memo.content;
      const group = [
        db
          .prepare("INSERT INTO memos (id, content, created_at, updated_at, pinned_at, deleted_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(memo.id, stored, memo.createdAt, memo.updatedAt, memo.pinnedAt, memo.deletedAt, seq),
        // A purged-then-reimported id must not resurface as a purge on sync.
        db.prepare("DELETE FROM tombstones WHERE id = ?").bind(memo.id)
      ];
      memo.images.forEach((image, index) => {
        importedImages += 1;
        group.push(
          db
            .prepare("INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(image.id, memo.id, index, image.mime, image.width, image.height, base64Bytes(image.dataBase64), image.dataBase64, memo.createdAt)
        );
      });
      groups.push(group);
    }
    for (const tag of newTags) {
      seq += 1;
      groups.push([
        db.prepare("INSERT INTO tag_meta (path, pinned_at, updated_at, seq) VALUES (?, ?, ?, ?)").bind(tag.path, tag.pinnedAt, now, seq)
      ]);
    }

    let pending: D1PreparedStatement[] = [];
    for (const group of groups) {
      if (pending.length > 0 && pending.length + group.length > BATCH_SIZE) {
        await db.batch(pending);
        pending = [];
      }
      pending.push(...group);
    }
    if (pending.length > 0) {
      await db.batch(pending);
    }
  }

  return json({ imported: inserts.length, skipped, images: importedImages });
}
