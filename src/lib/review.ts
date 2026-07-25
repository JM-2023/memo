// Daily review — a per-day sample of the notebook, computed entirely on the
// client. The whole corpus is already local (bootstrap + sync keep every memo
// in memory), so the server never takes part: the first visit of a local day
// draws the batch and freezes it in localStorage; later visits replay the
// frozen id list. The draw itself is seeded by (day, scope, range), which
// makes it reproducible — clearing storage and re-drawing the same day over
// the same notebook yields the same batch. Like the sort key and saved
// filters, settings and the frozen batch are workspace furniture: per-device,
// outside the encrypted sync pipeline, surviving logout.

import { dateKey } from "./dates";
import { tagMatches, tagsOf } from "./tags";
import type { Memo } from "./types";

export type ReviewScope = "all" | "include" | "exclude" | "untagged";
export type ReviewRange = "all" | "1m" | "3m" | "6m" | "1y";

export interface ReviewSettings {
  scope: ReviewScope;
  /** Tag paths for include/exclude — hierarchical, so 领域 covers 领域/子类. */
  tags: string[];
  /** Only memos created inside this window are drawn. */
  range: ReviewRange;
  /** Batch size per day. */
  count: number;
}

export interface ReviewDay {
  /** Local day key ("2026-07-25") the batch belongs to. */
  day: string;
  /** Fingerprint of the settings the batch was drawn under. */
  fingerprint: string;
  /** Frozen draw order. Memos deleted since simply drop out at render time. */
  ids: string[];
}

export const REVIEW_COUNT_MIN = 1;
export const REVIEW_COUNT_MAX = 50;

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = Object.freeze({
  scope: "all" as ReviewScope,
  tags: [],
  range: "all" as ReviewRange,
  count: 10
});

const SETTINGS_KEY = "memo-review-settings";
const DAY_KEY = "memo-review-day";
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const SCOPES: readonly ReviewScope[] = ["all", "include", "exclude", "untagged"];
const RANGES: readonly ReviewRange[] = ["all", "1m", "3m", "6m", "1y"];
const RANGE_MONTHS: Record<Exclude<ReviewRange, "all">, number> = { "1m": 1, "3m": 3, "6m": 6, "1y": 12 };

/** Coerce unknown input into well-formed settings; tags come out sorted and
    deduplicated so equal selections always share one fingerprint. */
function normalizeSettings(raw: Record<string, unknown>): ReviewSettings {
  const scope = SCOPES.includes(raw.scope as ReviewScope) ? (raw.scope as ReviewScope) : DEFAULT_REVIEW_SETTINGS.scope;
  const range = RANGES.includes(raw.range as ReviewRange) ? (raw.range as ReviewRange) : DEFAULT_REVIEW_SETTINGS.range;
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0))].sort()
    : [];
  const parsedCount = typeof raw.count === "number" && Number.isFinite(raw.count) ? Math.round(raw.count) : DEFAULT_REVIEW_SETTINGS.count;
  const count = Math.min(REVIEW_COUNT_MAX, Math.max(REVIEW_COUNT_MIN, parsedCount));
  return { scope, tags, range, count };
}

/** Parse a stored settings payload, falling back per field. Pure, for tests. */
export function parseReviewSettings(json: string | null): ReviewSettings {
  if (!json) return normalizeSettings({});
  try {
    const data: unknown = JSON.parse(json);
    return normalizeSettings(typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {});
  } catch {
    return normalizeSettings({});
  }
}

export function loadReviewSettings(): ReviewSettings {
  try {
    return parseReviewSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return normalizeSettings({});
  }
}

export function persistReviewSettings(settings: ReviewSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked — the in-memory settings still drive the session.
  }
}

/** Canonical settings identity; any change invalidates the frozen batch. */
export function reviewFingerprint(settings: ReviewSettings): string {
  return JSON.stringify([settings.scope, [...settings.tags].sort(), settings.range, settings.count]);
}

/** The draw seed deliberately leaves `count` out: raising the daily quota
    mid-day extends the same shuffled order instead of dealing a new hand. */
function reviewSeedKey(settings: ReviewSettings, day: string): string {
  return JSON.stringify([day, settings.scope, [...settings.tags].sort(), settings.range]);
}

/** `now` minus calendar months, day-of-month clamped (Mar 31 − 1mo → Feb 28). */
function monthsAgo(now: Date, months: number): Date {
  const target = new Date(now);
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() - months);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/** Active memos that qualify for review under `settings` as of `now`. */
export function eligibleReviewMemos(memos: readonly Memo[], settings: ReviewSettings, now = new Date()): Memo[] {
  const cutoff = settings.range === "all" ? null : monthsAgo(now, RANGE_MONTHS[settings.range]).toISOString();
  return memos.filter((memo) => {
    if (memo.deletedAt) return false;
    if (cutoff !== null && memo.createdAt < cutoff) return false;
    if (settings.scope === "all") return true;
    const tags = tagsOf(memo);
    if (settings.scope === "untagged") return tags.length === 0;
    const hit = settings.tags.some((path) => tags.some((tag) => tagMatches(tag, path)));
    return settings.scope === "include" ? hit : !hit;
  });
}

/* xmur3-style string hash + mulberry32 PRNG — tiny and seedable. The goal is
   reproducibility (same day + settings + pool ⇒ same batch on any device),
   not cryptographic quality. */
function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let index = 0; index < input.length; index += 1) {
    h = Math.imul(h ^ input.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded draw of up to `count` ids — a partial Fisher–Yates over the pool
    sorted by id, so the outcome is a pure function of (pool, seedKey). */
export function pickReviewIds(eligible: readonly Memo[], count: number, seedKey: string): string[] {
  const pool = eligible.map((memo) => memo.id).sort();
  const rand = mulberry32(hashSeed(seedKey));
  const take = Math.min(Math.max(0, count), pool.length);
  for (let index = 0; index < take; index += 1) {
    const swap = index + Math.floor(rand() * (pool.length - index));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, take);
}

/** Draw today's batch. The caller freezes the result via persistReviewDay. */
export function buildReviewDay(memos: readonly Memo[], settings: ReviewSettings, now = new Date()): ReviewDay {
  const day = dateKey(now);
  const eligible = eligibleReviewMemos(memos, settings, now);
  return {
    day,
    fingerprint: reviewFingerprint(settings),
    ids: pickReviewIds(eligible, settings.count, reviewSeedKey(settings, day))
  };
}

/** True while a frozen batch still answers for `settings` today. */
export function reviewDayValid(stored: ReviewDay | null, settings: ReviewSettings, now = new Date()): stored is ReviewDay {
  return stored !== null && stored.day === dateKey(now) && stored.fingerprint === reviewFingerprint(settings);
}

/** Parse a stored batch, dropping anything malformed. Pure, for tests. */
export function parseReviewDay(json: string | null): ReviewDay | null {
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw.day !== "string" || !DAY_PATTERN.test(raw.day)) return null;
  if (typeof raw.fingerprint !== "string" || !raw.fingerprint) return null;
  if (!Array.isArray(raw.ids)) return null;
  const ids: string[] = [];
  for (const id of raw.ids) {
    if (typeof id !== "string" || !id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= REVIEW_COUNT_MAX) break;
  }
  return { day: raw.day, fingerprint: raw.fingerprint, ids };
}

export function loadReviewDay(): ReviewDay | null {
  try {
    return parseReviewDay(localStorage.getItem(DAY_KEY));
  } catch {
    return null;
  }
}

export function persistReviewDay(day: ReviewDay): void {
  try {
    localStorage.setItem(DAY_KEY, JSON.stringify(day));
  } catch {
    // Storage blocked — the batch simply regenerates on the next visit.
  }
}

export function clearReviewDay(): void {
  try {
    localStorage.removeItem(DAY_KEY);
  } catch {
    // Ignore: an unreadable record fails parseReviewDay and regenerates anyway.
  }
}
