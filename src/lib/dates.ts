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

/** One formatter per locale and shape: every card stamps its time through
    here and the heatmap labels hundreds of cells per render, and building an
    Intl.DateTimeFormat costs far more than formatting with one. */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
};

const TIME_OPTIONS_THIS_YEAR: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
};

/** The full stamp, year included — for a time read out of context (a shared image). */
export function formatTime(iso: string, locale = "en-US"): string {
  return dateFormat(locale, TIME_OPTIONS).format(new Date(iso));
}

/**
 * A feed card's stamp: within the current year the year goes without saying
 * ("Aug 17, 09:12" / "8月17日 09:12"); any other year keeps it in full.
 */
export function formatCardTime(iso: string, locale = "en-US", now: Date = new Date()): string {
  const date = new Date(iso);
  return dateFormat(locale, date.getFullYear() === now.getFullYear() ? TIME_OPTIONS_THIS_YEAR : TIME_OPTIONS).format(date);
}

export function formatDayLabel(key: string, locale = "en-US"): string {
  return dateFormat(locale, { month: "short", day: "numeric" }).format(localDateOfKey(key));
}

/** A localized weekday for a local date key, parsed part-wise to prevent UTC day drift. */
export function weekdayLabel(key: string, locale = "en-US"): string {
  return dateFormat(locale, { weekday: "short" }).format(localDateOfKey(key));
}

/** `month` is zero-based, matching `Date#getMonth()`. */
export function formatMonthYear(year: number, month: number, locale = "en-US"): string {
  return dateFormat(locale, { year: "numeric", month: "long" }).format(new Date(year, month, 1));
}

export function formatYear(year: number, locale = "en-US"): string {
  return dateFormat(locale, { year: "numeric" }).format(new Date(year, 0, 1));
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
