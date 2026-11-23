import type { StorageReport } from "./api";
import type { Memo, MemoImage } from "./types";

/** Trash older than this is called out as the first thing to let go of. */
export const STALE_TRASH_DAYS = 30;
const DAY_MS = 86_400_000;

/** Past this share of the ceiling the view says the database is nearly full. */
export const NEARLY_FULL_RATIO = 0.8;

const UNITS = [
  ["B", 1],
  ["KB", 1e3],
  ["MB", 1e6],
  ["GB", 1e9]
] as const;

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * Decimal units, as Cloudflare states its limits (500 MB). Three significant
 * figures at most — "860 KB", "12.4 MB", "1.2 GB" — and a figure that
 * rounds up to 1000 steps to the next unit instead of reading "1000 KB".
 */
export function formatBytes(bytes: number, locale: string): string {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let index = UNITS.length - 1;
  while (index > 0 && value < UNITS[index][1]) index -= 1;
  for (;;) {
    const [unit, size] = UNITS[index];
    const scaled = value / size;
    // Decided on the rounded figure: 99.96 is "100", not "100.0".
    const digits = index === 0 || Number(scaled.toFixed(1)) >= 100 ? 0 : 1;
    const rounded = Number(scaled.toFixed(digits));
    if (rounded >= 1000 && index < UNITS.length - 1) {
      index += 1;
      continue;
    }
    return `${numberFormat(locale, digits).format(rounded)} ${unit}`;
  }
}

/** What a stored original costs before its preview is counted: base64 of the bytes. */
export function estimateStoredBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 3) * 4;
}

export type StoragePartKey = "images" | "text" | "trash" | "other";

export interface StoragePart {
  key: StoragePartKey;
  bytes: number;
}

export interface StorageSummary {
  /** The database file, or the sum of its content when the runtime gives no size. */
  used: number;
  limit: number;
  /** Whether `used` is D1's own figure rather than a sum of content. */
  measured: boolean;
  /** used / limit, uncapped. */
  ratio: number;
  /** In the meter's order: images, text, Trash, then everything else. */
  parts: StoragePart[];
}

/**
 * The meter's reading. Images and text are what is outside Trash; Trash is
 * both of its kinds together, the share one action can give back; "other"
 * is the rest of the file — indexes, sync history, tags, free pages.
 */
export function summarizeStorage(report: StorageReport): StorageSummary {
  const images = report.notes.imageBytes;
  const text = report.notes.textBytes;
  const trash = report.trash.textBytes + report.trash.imageBytes;
  const known = images + text + trash;
  const measured = report.database.bytes !== null;
  const used = measured ? Math.max(report.database.bytes ?? 0, known) : known;
  const limit = Math.max(1, report.database.limitBytes);
  return {
    used,
    limit,
    measured,
    ratio: used / limit,
    parts: [
      { key: "images", bytes: images },
      { key: "text", bytes: text },
      { key: "trash", bytes: trash },
      { key: "other", bytes: Math.max(0, used - known) }
    ]
  };
}

export interface StoredImageEntry {
  image: MemoImage;
  memo: Memo;
  /** Its place among the memo's attachments. */
  index: number;
  /** What it takes in D1: exact from the report, else estimated from its size. */
  bytes: number;
}

export type ImageSort = "newest" | "largest";

/**
 * Every stored attachment of these memos (Trash included), sized from the
 * report when there is one. Linked images live elsewhere and cost nothing,
 * so they are not here.
 */
export function storedImageEntries(memos: readonly Memo[], report: StorageReport | null): StoredImageEntry[] {
  const sizes = report ? new Map(report.images.map((image) => [image.id, image.bytes])) : null;
  const entries: StoredImageEntry[] = [];
  for (const memo of memos) {
    memo.images.forEach((image, index) => {
      entries.push({ image, memo, index, bytes: sizes?.get(image.id) ?? estimateStoredBytes(image.bytes) });
    });
  }
  return entries;
}

function newestFirst(a: StoredImageEntry, b: StoredImageEntry): number {
  if (a.memo.createdAt !== b.memo.createdAt) return a.memo.createdAt < b.memo.createdAt ? 1 : -1;
  if (a.memo.id !== b.memo.id) return a.memo.id < b.memo.id ? -1 : 1;
  return a.index - b.index;
}

/** Newest memo first (attachments in their own order), or the largest first. */
export function sortImageEntries(entries: readonly StoredImageEntry[], sort: ImageSort): StoredImageEntry[] {
  return [...entries].sort(sort === "largest" ? (a, b) => b.bytes - a.bytes || newestFirst(a, b) : newestFirst);
}

/** Whole days a memo has been in Trash; 0 for one that is not there. */
export function daysInTrash(memo: Memo, now: number): number {
  if (!memo.deletedAt) return 0;
  const since = Date.parse(memo.deletedAt);
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / DAY_MS)) : 0;
}

/** Trashed memos that have sat there at least `days`, longest first. */
export function staleTrash(memos: readonly Memo[], now: number, days = STALE_TRASH_DAYS): Memo[] {
  return memos
    .filter((memo) => memo.deletedAt && daysInTrash(memo, now) >= days)
    .sort((a, b) => (a.deletedAt ?? "").localeCompare(b.deletedAt ?? ""));
}

const encoder = new TextEncoder();

/**
 * What these memos take in D1 together: the report's figure for each
 * trashed one it lists, else the text's UTF-8 bytes plus its attachments
 * (as reported, or estimated).
 */
export function storedBytesOf(memos: readonly Memo[], report: StorageReport | null): number {
  const reported = new Map(report?.trashMemos.map((item) => [item.id, item.bytes]));
  const sizes = new Map(report?.images.map((image) => [image.id, image.bytes]));
  let total = 0;
  for (const memo of memos) {
    const known = reported.get(memo.id);
    total +=
      known ??
      encoder.encode(memo.content).length + memo.images.reduce((sum, image) => sum + (sizes.get(image.id) ?? estimateStoredBytes(image.bytes)), 0);
  }
  return total;
}
