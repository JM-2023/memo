import { dateKey, formatMonthYear, formatYear } from "./dates";
import { tagsOf } from "./tags";
import type { Memo } from "./types";

/**
 * Month is zero-based. Weekday is Monday-first (Monday = 0, Sunday = 6).
 * Every distribution drilldown carries the selected stats year so it matches
 * the year-scoped charts in StatsModal.
 */
export type StatsDrilldown =
  | { kind: "year"; year: number }
  | { kind: "month"; year: number; month: number }
  | { kind: "day"; day: string }
  | { kind: "weekday"; year: number; weekday: number }
  | { kind: "hour"; year: number; hour: number }
  | { kind: "tag"; year: number; tag: string };

/**
 * Stats entry clears the search synchronously, while useDeferredValue may
 * still expose the previous feed query for one render. A live drilldown uses
 * the immediate query instead: stale pre-drilldown text disappears at once,
 * and any search typed inside the smaller stats subset participates at once.
 */
export function feedQueryForStatsDrilldown(drilldown: StatsDrilldown | null, immediateQuery: string, deferredQuery: string): string {
  return drilldown ? immediateQuery : deferredQuery;
}

/** Match the local-time buckets used by StatsModal's selected-year charts. */
export function memoMatchesStatsDrilldown(memo: Memo, drilldown: StatsDrilldown): boolean {
  const created = new Date(memo.createdAt);
  if (!Number.isFinite(created.getTime())) return false;
  if (drilldown.kind === "day") return dateKey(created) === drilldown.day;
  if (created.getFullYear() !== drilldown.year) return false;

  switch (drilldown.kind) {
    case "year":
      return true;
    case "month":
      return created.getMonth() === drilldown.month;
    case "weekday":
      return (created.getDay() + 6) % 7 === drilldown.weekday;
    case "hour":
      return created.getHours() === drilldown.hour;
    case "tag":
      // Top Tags counts complete extracted paths, not hierarchical ancestors.
      return tagsOf(memo).includes(drilldown.tag);
  }
}

function formatWeekday(weekday: number, locale: string): string {
  const monday = new Date(2026, 0, 5);
  return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(2026, 0, monday.getDate() + weekday));
}

function formatHour(hour: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2026, 0, 5, hour));
}

function formatHourRange(hour: number, locale: string): string {
  return `${formatHour(hour, locale)} – ${formatHour(hour + 1, locale)}`;
}

function formatYearContext(value: string, year: number, locale: string): string {
  const yearLabel = formatYear(year, locale);
  return locale.toLowerCase().startsWith("zh") ? `${yearLabel} · ${value}` : `${value} · ${yearLabel}`;
}

function formatFullDay(day: string, locale: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(year, month - 1, date));
}

/** Compact feed/filter label in the same English or Chinese locale as MEMO. */
export function statsDrilldownLabel(drilldown: StatsDrilldown, locale = "en-US"): string {
  switch (drilldown.kind) {
    case "year":
      return formatYear(drilldown.year, locale);
    case "month":
      return formatMonthYear(drilldown.year, drilldown.month, locale);
    case "day":
      return formatFullDay(drilldown.day, locale);
    case "weekday":
      return formatYearContext(formatWeekday(drilldown.weekday, locale), drilldown.year, locale);
    case "hour":
      return formatYearContext(formatHourRange(drilldown.hour, locale), drilldown.year, locale);
    case "tag":
      return formatYearContext(`#${drilldown.tag}`, drilldown.year, locale);
  }
}
