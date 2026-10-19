// Daily review — a per-day sample of the notebook, computed entirely on the
// client. The whole corpus is already local (bootstrap + sync keep every memo
// in memory), so the server never takes part: the first visit of a local day
// draws the batch and freezes it in localStorage; later visits replay the
// frozen id list. The draw itself is seeded by (day, scope, range), which
// makes it reproducible — clearing storage and re-drawing the same day over
// the same notebook yields the same batch. Like the sort key and saved
// filters, settings and the frozen batch are workspace furniture: per-device,
// outside the encrypted sync pipeline and cleared by ordinary logout. So are
// the day's seen ids and the "Not again" list — memo ids only, never text.

import { addDays, dateKey, dateKeyOf } from "./dates";
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

/** Which anniversary a memo came back on. */
export type ReviewSpan = "week" | "month" | "halfYear" | "year";

/**
 * Why a memo is in the day's batch: written on this date in an earlier year,
 * on an anniversary (a week, a month, six months or a year back, give or
 * take a day), or drawn by chance from the rest.
 */
export type ReviewPick =
  | { reason: "onThisDay"; years: number }
  | { reason: "anniversary"; span: ReviewSpan }
  | { reason: "random" };

export type ReviewReason = ReviewPick["reason"];

export const RANDOM_PICK: ReviewPick = Object.freeze({ reason: "random" as const });

export interface ReviewDay {
  /** Local day key ("2026-07-25") the batch belongs to. */
  day: string;
  /** Fingerprint of the settings the batch was drawn under. */
  fingerprint: string;
  /** Frozen draw order. Memos deleted since simply drop out at render time. */
  ids: string[];
  /** Why each id was drawn. A day frozen before reasons were kept has none:
      its memos read as random draws (reviewPickOf). */
  reasons: Record<string, ReviewPick>;
}

export const REVIEW_COUNT_MIN = 1;
export const REVIEW_COUNT_MAX = 50;

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = Object.freeze({
  scope: "all" as ReviewScope,
  tags: [],
  range: "all" as ReviewRange,
  count: 10
});

/** Exported so open tabs can follow each other's changes (storage events). */
export const SETTINGS_KEY = "memo-review-settings";
const DAY_KEY = "memo-review-day";
/** The ids of today's cards the reader has seen. */
export const SEEN_KEY = "memo-review-seen";
/** Memos the reader asked never to be drawn again, on this device. */
export const HIDDEN_KEY = "memo-review-hidden";
/** Generous ceilings: a stored list never grows without bound. */
const SEEN_MAX = 200;
const HIDDEN_MAX = 5000;
const NO_IDS: ReadonlySet<string> = new Set();
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

/** Keep an include/exclude scope on the same subtree after a tag rename.
    Returns `settings` itself when no listed tag moved. */
export function renameReviewSettingsTag(settings: ReviewSettings, from: string, to: string): ReviewSettings {
  if (!settings.tags.some((tag) => tagMatches(tag, from))) return settings;
  return normalizeSettings({ ...settings, tags: settings.tags.map((tag) => (tagMatches(tag, from) ? to + tag.slice(from.length) : tag)) });
}

/** Drop a removed tag subtree from the scope. An include/exclude list left
    empty — a state the settings dialog will not save — falls back to all
    memos instead of drawing nothing. */
export function removeReviewSettingsTag(settings: ReviewSettings, path: string): ReviewSettings {
  if (!settings.tags.some((tag) => tagMatches(tag, path))) return settings;
  const tags = settings.tags.filter((tag) => !tagMatches(tag, path));
  const scoped = settings.scope === "include" || settings.scope === "exclude";
  return normalizeSettings({ ...settings, tags, scope: scoped && tags.length === 0 ? "all" : settings.scope });
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

/** Active memos that qualify for review under `settings` as of `now`, less
    the ones set aside with "Not again" (`excluded`). */
export function eligibleReviewMemos(memos: readonly Memo[], settings: ReviewSettings, now = new Date(), excluded: ReadonlySet<string> = NO_IDS): Memo[] {
  const cutoff = settings.range === "all" ? null : monthsAgo(now, RANGE_MONTHS[settings.range]).toISOString();
  return memos.filter((memo) => {
    if (memo.deletedAt) return false;
    if (excluded.has(memo.id)) return false;
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

const SPANS: readonly ReviewSpan[] = ["week", "month", "halfYear", "year"];

/** How far back each anniversary lies from a local day. */
const SPAN_BACK: Record<ReviewSpan, (day: Date) => Date> = {
  week: (day) => addDays(day, -7),
  month: (day) => monthsAgo(day, 1),
  halfYear: (day) => monthsAgo(day, 6),
  year: (day) => monthsAgo(day, 12)
};

function dateOfKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Why a memo written at `createdAt` (local time) would come back on `day`
 * ahead of chance, if it would. On this day: the same month and date in an
 * earlier year — on the last day of a short February, a 29th counts. An
 * anniversary: a week, a month, six months or a year back, a day either
 * side (the year's own date is already "on this day"). Pure, for tests.
 */
export function reviewPickFor(createdAt: string, day: string, anniversaries = anniversaryKeys(day)): ReviewPick {
  const written = dateKeyOf(createdAt);
  if (written >= day) return RANDOM_PICK;
  const [year, month, date] = day.split("-").map(Number);
  const [writtenYear, writtenMonth, writtenDate] = written.split("-").map(Number);
  const lastOfMonth = new Date(year, month, 0).getDate();
  if (writtenMonth === month && (writtenDate === date || (date === lastOfMonth && writtenDate > date))) {
    return { reason: "onThisDay", years: year - writtenYear };
  }
  const span = anniversaries.get(written);
  return span ? { reason: "anniversary", span } : RANDOM_PICK;
}

/** The local day keys each anniversary of `day` covers, a day either side. */
function anniversaryKeys(day: string): Map<string, ReviewSpan> {
  const today = dateOfKey(day);
  const keys = new Map<string, ReviewSpan>();
  for (const span of SPANS) {
    const target = SPAN_BACK[span](today);
    for (const shift of [-1, 0, 1]) {
      const key = dateKey(addDays(target, shift));
      if (!keys.has(key)) keys.set(key, span);
    }
  }
  return keys;
}

export interface ReviewDraw {
  ids: string[];
  reasons: Record<string, ReviewPick>;
}

/**
 * The day's weighted draw, still a pure function of (pool, seedKey, day):
 * memos written on this date in earlier years come first, then the
 * anniversaries, then a seeded random remainder — up to `count` in all.
 * Each tier is shuffled whole under its own seed, so the order never
 * depends on `count`: raising the quota extends the same hand.
 */
export function drawReview(eligible: readonly Memo[], count: number, seedKey: string, day: string): ReviewDraw {
  const take = Math.max(0, count);
  const picks = new Map<string, ReviewPick>();
  const onThisDay: Memo[] = [];
  const anniversaries: Memo[] = [];
  const rest: Memo[] = [];
  const keys = anniversaryKeys(day);
  for (const memo of eligible) {
    const pick = reviewPickFor(memo.createdAt, day, keys);
    picks.set(memo.id, pick);
    if (pick.reason === "onThisDay") onThisDay.push(memo);
    else if (pick.reason === "anniversary") anniversaries.push(memo);
    else rest.push(memo);
  }
  const ids = [
    ...pickReviewIds(onThisDay, onThisDay.length, `${seedKey}|onThisDay`),
    ...pickReviewIds(anniversaries, anniversaries.length, `${seedKey}|anniversary`)
  ].slice(0, take);
  ids.push(...pickReviewIds(rest, take - ids.length, seedKey));
  const reasons: Record<string, ReviewPick> = {};
  for (const id of ids) reasons[id] = picks.get(id) ?? RANDOM_PICK;
  return { ids, reasons };
}

/** Draw today's batch. The caller freezes the result via persistReviewDay. */
export function buildReviewDay(memos: readonly Memo[], settings: ReviewSettings, now = new Date(), excluded: ReadonlySet<string> = NO_IDS): ReviewDay {
  const day = dateKey(now);
  const eligible = eligibleReviewMemos(memos, settings, now, excluded);
  const { ids, reasons } = drawReview(eligible, settings.count, reviewSeedKey(settings, day), day);
  return { day, fingerprint: reviewFingerprint(settings), ids, reasons };
}

/** Why `id` is in `day`'s batch; a day stored before reasons were kept reads as random. */
export function reviewPickOf(day: ReviewDay, id: string): ReviewPick {
  return Object.prototype.hasOwnProperty.call(day.reasons, id) ? day.reasons[id] : RANDOM_PICK;
}

/** How many of `ids` came back for each reason — the banner's breakdown. */
export function reviewBreakdown(day: ReviewDay, ids: readonly string[]): Record<ReviewReason, number> {
  const tally: Record<ReviewReason, number> = { onThisDay: 0, anniversary: 0, random: 0 };
  for (const id of ids) tally[reviewPickOf(day, id).reason] += 1;
  return tally;
}

/**
 * How long ago `createdAt` was, in the one unit a person would say it in:
 * days under two weeks (0 is today), weeks under two months, months under a
 * year, years beyond. Calendar-based, in local time. Pure, for tests.
 */
export function reviewAge(createdAt: string, now = new Date()): { value: number; unit: "day" | "week" | "month" | "year" } {
  const written = new Date(createdAt);
  const from = new Date(written.getFullYear(), written.getMonth(), written.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  if (days < 14) return { value: days, unit: "day" };
  const months = Math.max(0, (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() - (to.getDate() < from.getDate() ? 1 : 0));
  if (months < 2) return { value: Math.floor(days / 7), unit: "week" };
  if (months < 12) return { value: months, unit: "month" };
  return { value: Math.floor(months / 12), unit: "year" };
}

/** True while a frozen batch still answers for `settings` today. */
export function reviewDayValid(stored: ReviewDay | null, settings: ReviewSettings, now = new Date()): stored is ReviewDay {
  return stored !== null && stored.day === dateKey(now) && stored.fingerprint === reviewFingerprint(settings);
}

/** An empty batch only stands while there is still nothing to draw: one
    frozen over an empty pool (a new notebook, a scope nothing matched yet)
    goes stale once a memo qualifies, instead of keeping Review empty all day. */
export function reviewDayStarved(
  stored: ReviewDay,
  memos: readonly Memo[],
  settings: ReviewSettings,
  now = new Date(),
  excluded: ReadonlySet<string> = NO_IDS
): boolean {
  return stored.ids.length === 0 && eligibleReviewMemos(memos, settings, now, excluded).length > 0;
}

function parsePick(raw: unknown): ReviewPick | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.reason === "random") return RANDOM_PICK;
  if (value.reason === "onThisDay" && typeof value.years === "number" && Number.isInteger(value.years) && value.years >= 1) {
    return { reason: "onThisDay", years: value.years };
  }
  if (value.reason === "anniversary" && SPANS.includes(value.span as ReviewSpan)) return { reason: "anniversary", span: value.span as ReviewSpan };
  return null;
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
  // Reasons arrived later: a day stored without them (or with one that no
  // longer parses) keeps its ids, and those memos read as random draws.
  const rawReasons = typeof raw.reasons === "object" && raw.reasons !== null && !Array.isArray(raw.reasons) ? (raw.reasons as Record<string, unknown>) : {};
  const reasons: Record<string, ReviewPick> = {};
  for (const id of ids) {
    const pick = Object.prototype.hasOwnProperty.call(rawReasons, id) ? parsePick(rawReasons[id]) : null;
    if (pick) reasons[id] = pick;
  }
  return { day: raw.day, fingerprint: raw.fingerprint, ids, reasons };
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

/** Unique non-empty string ids, in order, the newest `max` kept. */
function parseIdList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0))];
  return ids.slice(Math.max(0, ids.length - max));
}

/** The cards of one local day the reader has seen. Kept by day, not by
    batch: a settings change that re-deals mid-day keeps what was seen. */
export interface ReviewSeen {
  day: string;
  ids: string[];
}

export const NO_REVIEW_SEEN: ReviewSeen = Object.freeze({ day: "", ids: [] as string[] });

/** Parse a stored seen record, dropping anything malformed. Pure, for tests. */
export function parseReviewSeen(json: string | null): ReviewSeen {
  if (!json) return NO_REVIEW_SEEN;
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== "object" || data === null) return NO_REVIEW_SEEN;
    const raw = data as Record<string, unknown>;
    if (typeof raw.day !== "string" || !DAY_PATTERN.test(raw.day)) return NO_REVIEW_SEEN;
    return { day: raw.day, ids: parseIdList(raw.ids, SEEN_MAX) };
  } catch {
    return NO_REVIEW_SEEN;
  }
}

export function loadReviewSeen(): ReviewSeen {
  try {
    return parseReviewSeen(localStorage.getItem(SEEN_KEY));
  } catch {
    return NO_REVIEW_SEEN;
  }
}

/** `seen` with `id` added for `day` (a record from another day starts over). */
export function withReviewSeen(seen: ReviewSeen, day: string, id: string): ReviewSeen {
  if (seen.day === day && seen.ids.includes(id)) return seen;
  return { day, ids: parseIdList([...(seen.day === day ? seen.ids : []), id], SEEN_MAX) };
}

export function persistReviewSeen(seen: ReviewSeen): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage blocked — the cards simply count as unseen on the next visit.
  }
}

/** Parse the stored "Not again" list. Pure, for tests. */
export function parseReviewHidden(json: string | null): string[] {
  if (!json) return [];
  try {
    return parseIdList(JSON.parse(json), HIDDEN_MAX);
  } catch {
    return [];
  }
}

export function loadReviewHidden(): string[] {
  try {
    return parseReviewHidden(localStorage.getItem(HIDDEN_KEY));
  } catch {
    return [];
  }
}

export function persistReviewHidden(ids: readonly string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(HIDDEN_KEY);
    else localStorage.setItem(HIDDEN_KEY, JSON.stringify(parseIdList(ids, HIDDEN_MAX)));
  } catch {
    // Storage blocked — the list still holds for this session.
  }
}

/** One chip in the settings dialog's tag picker. `label` is what the chip
    reads: the full `#path`, or — inside a group its root chip leads — the
    path below that root, `/cooking`. */
export interface ReviewTagChip {
  path: string;
  label: string;
}

/** The picker's candidates. A pick matches its whole subtree, so every
    ancestor of a tag in use is a candidate too (`life` for `life/cooking`)
    even when no memo spells it out. The tags already chosen when the dialog
    opened come first as `pinned`; the rest are grouped under their
    top-level tag, in tree order. */
export interface ReviewTagChoices {
  pinned: ReviewTagChip[];
  groups: { root: string; chips: ReviewTagChip[] }[];
}

export function reviewTagChoices(knownTags: readonly string[], chosen: readonly string[], locale = "en-US"): ReviewTagChoices {
  const paths = new Set<string>();
  for (const tag of [...knownTags, ...chosen]) {
    const parts = tag.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) paths.add(parts.slice(0, depth).join("/"));
  }
  // Tree order: segment by segment, a parent before its children.
  const treeOrder = (a: string, b: string) => {
    const left = a.split("/");
    const right = b.split("/");
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const order = left[index].localeCompare(right[index], locale);
      if (order !== 0) return order;
    }
    return left.length - right.length;
  };
  const pinnedSet = new Set(chosen);
  const pinned = [...pinnedSet].sort(treeOrder).map((path) => ({ path, label: `#${path}` }));
  const groups: ReviewTagChoices["groups"] = [];
  for (const path of [...paths].filter((candidate) => !pinnedSet.has(candidate)).sort(treeOrder)) {
    const root = path.split("/")[0];
    let group = groups[groups.length - 1];
    if (!group || group.root !== root) {
      group = { root, chips: [] };
      groups.push(group);
    }
    // A relative label only reads right after the root chip it hangs from;
    // a group whose root is pinned above spells its paths out.
    const rootLeads = group.chips[0]?.path === root;
    group.chips.push({ path, label: path === root || !rootLeads ? `#${path}` : `/${path.slice(root.length + 1)}` });
  }
  return { pinned, groups };
}
