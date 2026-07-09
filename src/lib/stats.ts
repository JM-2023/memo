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

export function periodStats(memos: Memo[], kind: PeriodKind, now = new Date()): PeriodStats {
  let start: Date;
  if (kind === "week") {
    start = startOfWeek(now);
  } else if (kind === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    start = new Date(now.getFullYear(), 0, 1);
  }
  const startMs = start.getTime();
  let memoCount = 0;
  let wordSum = 0;
  for (const memo of memos) {
    const created = new Date(memo.createdAt).getTime();
    if (created >= startMs) {
      memoCount += 1;
      wordSum += wordCountOf(memo);
    }
  }
  return { memoCount, wordSum };
}

export interface TotalStats {
  memoCount: number;
  /** Days since the first memo, inclusive — flomo's "天". 0 when empty. */
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

export interface StreakInfo {
  /** Longest run of consecutive active days, ever. */
  longest: number;
  /** Run ending today (or yesterday, if today has no memo yet). */
  current: number;
}

export function computeStreaks(byDay: Map<string, number>, now = new Date()): StreakInfo {
  if (byDay.size === 0) return { longest: 0, current: 0 };
  // Keys share one format, so lexicographic order is date order; parsing them
  // lands on UTC midnights, which keeps day differences exact.
  const keys = [...byDay.keys()].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < keys.length; i += 1) {
    const gap = (new Date(keys[i]).getTime() - new Date(keys[i - 1]).getTime()) / 86_400_000;
    run = gap === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
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
 * stats modal's mini calendars.
 */
export function buildHeatWeeks(start: Date, end: Date, byDay: Map<string, number>, now = new Date()): HeatCell[][] {
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
        level: levelFor(count),
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
