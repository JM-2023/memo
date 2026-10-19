import { stripLinks } from "./content";
import { addDays, dateKey, dateKeyOf, daysBetweenInclusive, startOfWeek } from "./dates";
import type { Memo } from "./types";

/**
 * "字" as a memo user reads it: non-whitespace characters of the note text.
 * URLs and image markup don't count — they're references, not writing.
 */
export function wordCount(content: string): number {
  return stripLinks(content).replace(/\s/g, "").length;
}

// Per-memo derived-value caches. Memo objects are immutable snapshots, so a
// WeakMap keyed on the object invalidates itself on edit and never leaks.
const memoWordCache = new WeakMap<Memo, number>();
const memoDayCache = new WeakMap<Memo, string>();

export function wordCountOf(memo: Memo): number {
  let count = memoWordCache.get(memo);
  if (count === undefined) {
    count = wordCount(memo.content);
    memoWordCache.set(memo, count);
  }
  return count;
}

/** Local-day key of a memo's creation time (cached). */
export function dayKeyOf(memo: Memo): string {
  let key = memoDayCache.get(memo);
  if (!key) {
    key = dateKeyOf(memo.createdAt);
    memoDayCache.set(memo, key);
  }
  return key;
}

export interface PeriodStats {
  memoCount: number;
  wordSum: number;
}

export type PeriodKind = "week" | "month" | "year";

/**
 * Memos written on the local days `start`..`end` (day keys, both inclusive)
 * and their characters — the same days the heatmap's cells count.
 */
export function rangeStats(memos: Memo[], start: string, end: string): PeriodStats {
  let memoCount = 0;
  let wordSum = 0;
  for (const memo of memos) {
    const key = dayKeyOf(memo);
    if (key >= start && key <= end) {
      memoCount += 1;
      wordSum += wordCountOf(memo);
    }
  }
  return { memoCount, wordSum };
}

export interface TotalStats {
  memoCount: number;
  /** Days since the first memo, inclusive. 0 when empty. */
  daySpan: number;
  /** Distinct local days that have at least one memo. */
  activeDays: number;
}

export function totalStats(memos: Memo[], now = new Date()): TotalStats {
  if (memos.length === 0) {
    return { memoCount: 0, daySpan: 0, activeDays: 0 };
  }
  let firstMs = Number.POSITIVE_INFINITY;
  const days = new Set<string>();
  for (const memo of memos) {
    const created = new Date(memo.createdAt);
    firstMs = Math.min(firstMs, created.getTime());
    days.add(dateKey(created));
  }
  return {
    memoCount: memos.length,
    daySpan: daysBetweenInclusive(new Date(firstMs), now),
    activeDays: days.size
  };
}

export function countsByDay(memos: Memo[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const memo of memos) {
    const key = dayKeyOf(memo);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export interface HeatCell {
  key: string; // "2026-07-09"
  /** Inside the requested range (month, week, year…); padding cells are not. */
  inRange: boolean;
  count: number;
  /** 0..4 intensity bucket. */
  level: number;
  isToday: boolean;
  isFuture: boolean;
}

export interface HeatMonth {
  year: number;
  month: number; // 0-based
  /** Weeks of 7 cells, Monday first. */
  weeks: HeatCell[][];
}

export function levelFor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

/**
 * The owner's own scale: the most a day can hold at levels 1, 2 and 3
 * (strictly rising); anything above is level 4.
 */
export interface HeatScale {
  cuts: readonly [number, number, number];
}

/** Days of history a personal scale is read from, ending today. */
export const HEAT_SCALE_DAYS = 90;
/** Below this many written days the quartiles say little: the fixed steps hold. */
export const HEAT_SCALE_MIN_DAYS = 8;

/**
 * Quartiles of the non-zero daily counts over the last ~90 days, so a heavy
 * writer's ordinary day isn't always the darkest green and a light one's
 * busy day still stands out. Null (use levelFor's fixed steps) until there
 * are enough written days to read a pattern from.
 */
export function heatScale(byDay: Map<string, number>, now = new Date()): HeatScale | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const last = dateKey(today);
  const first = dateKey(addDays(today, -(HEAT_SCALE_DAYS - 1)));
  const counts: number[] = [];
  for (const [key, count] of byDay) {
    if (count > 0 && key >= first && key <= last) counts.push(count);
  }
  if (counts.length < HEAT_SCALE_MIN_DAYS) return null;
  counts.sort((a, b) => a - b);
  // Nearest-rank quartiles; each cut at least one above the last, so every
  // level keeps a range of its own when most days hold the same count.
  const rank = (share: number) => counts[Math.max(0, Math.ceil(share * counts.length) - 1)];
  const q1 = Math.max(1, rank(0.25));
  const q2 = Math.max(q1 + 1, rank(0.5));
  const q3 = Math.max(q2 + 1, rank(0.75));
  return { cuts: [q1, q2, q3] };
}

/** levelFor on a personal scale; the fixed steps without one. */
export function levelOnScale(count: number, scale: HeatScale | null | undefined): number {
  if (!scale) return levelFor(count);
  if (count <= 0) return 0;
  const [q1, q2, q3] = scale.cuts;
  if (count <= q1) return 1;
  if (count <= q2) return 2;
  if (count <= q3) return 3;
  return 4;
}

/**
 * Which bars of a series keep their value label when there is no room for
 * all of them: every local maximum, counting only the first bar of a plateau
 * so two labelled bars are never neighbours. Zero bars never qualify.
 */
export function localMaxima(values: number[]): boolean[] {
  return values.map((value, index) => {
    if (value <= 0) return false;
    const left = index > 0 ? values[index - 1] : -1;
    const right = index < values.length - 1 ? values[index + 1] : -1;
    return value > left && value >= right;
  });
}

export interface StreakInfo {
  /** Longest run of consecutive active days, ever. */
  longest: number;
  /** Run ending today (or yesterday, if today has no memo yet). */
  current: number;
}

export interface DayRun {
  length: number;
  /** First and last day keys of the run; null when there are no days. */
  start: string | null;
  end: string | null;
}

/**
 * The longest run of consecutive days among `keys` (any order). On a tie the
 * later run wins: the recent one is the one a reader remembers.
 */
export function longestRun(keys: Iterable<string>): DayRun {
  // Keys share one format, so lexicographic order is date order; parsing them
  // lands on UTC midnights, which keeps day differences exact.
  const sorted = [...keys].sort();
  if (sorted.length === 0) return { length: 0, start: null, end: null };
  let best: DayRun = { length: 1, start: sorted[0], end: sorted[0] };
  let runStart = sorted[0];
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / 86_400_000;
    if (gap === 1) run += 1;
    else {
      run = 1;
      runStart = sorted[i];
    }
    if (run >= best.length) best = { length: run, start: runStart, end: sorted[i] };
  }
  return best;
}

export function computeStreaks(byDay: Map<string, number>, now = new Date()): StreakInfo {
  if (byDay.size === 0) return { longest: 0, current: 0 };
  const longest = longestRun(byDay.keys()).length;
  let current = 0;
  let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!byDay.has(dateKey(cursor))) cursor = addDays(cursor, -1);
  while (byDay.has(dateKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { longest, current };
}

/**
 * Monday-first weeks of day cells covering [start, end] plus the leading /
 * trailing padding needed to complete the first and last weeks. The shared
 * shape behind the sidebar heatmap's week / month / year views and the
 * stats modal's mini calendars. `scale` (heatScale) sets the levels; left
 * out, they take levelFor's fixed steps.
 */
export function buildHeatWeeks(start: Date, end: Date, byDay: Map<string, number>, now = new Date(), scale?: HeatScale | null): HeatCell[][] {
  const startMs = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const endMs = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  const todayKey = dateKey(now);
  const nowMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const weeks: HeatCell[][] = [];
  let cursor = startOfWeek(start);
  while (cursor.getTime() <= endMs) {
    const week: HeatCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const key = dateKey(cursor);
      const count = byDay.get(key) ?? 0;
      const ms = cursor.getTime();
      week.push({
        key,
        inRange: ms >= startMs && ms <= endMs,
        count,
        level: levelOnScale(count, scale),
        isToday: key === todayKey,
        isFuture: ms > nowMs
      });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function buildHeatMonth(year: number, month: number, byDay: Map<string, number>, now = new Date()): HeatMonth {
  return { year, month, weeks: buildHeatWeeks(new Date(year, month, 1), new Date(year, month + 1, 0), byDay, now) };
}
