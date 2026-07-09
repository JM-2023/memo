/** Local-timezone date key, e.g. "2026-07-09". All grouping uses local days. */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dateKeyOf(iso: string): string {
  return dateKey(new Date(iso));
}

function localDateOfKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatTime(iso: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(iso));
}

export function formatDayLabel(key: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(localDateOfKey(key));
}

/** A localized weekday for a local date key, parsed part-wise to prevent UTC day drift. */
export function weekdayLabel(key: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(localDateOfKey(key));
}

/** `month` is zero-based, matching `Date#getMonth()`. */
export function formatMonthYear(year: number, month: number, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(year, month, 1));
}

export function formatYear(year: number, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric" }).format(new Date(year, 0, 1));
}

/** Monday-based start of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Whole local days between two dates (a ≤ b), inclusive of both endpoints. */
export function daysBetweenInclusive(a: Date, b: Date): number {
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000)) + 1;
}
