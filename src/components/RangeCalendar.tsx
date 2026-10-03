import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { addDays, dateKey, formatDayLabel, formatMonthYear, startOfWeek } from "../lib/dates";
import { useI18n } from "../lib/i18n";

interface RangeCalendarProps {
  from: string | null;
  to: string | null;
  /** Earliest day with a memo: earlier days are idle and ‹ stops at its month. */
  minDay?: string | null;
  /** First tap: a start with an open end ("since"). */
  onStart: (day: string) => void;
  /** Second tap: the whole range at once, ordered. */
  onRange: (from: string, to: string) => void;
}

function keyToDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * The filter panel's date range, picked on a month grid in the app's own
 * language instead of two native date fields (whose mm/dd/yyyy mask ignored
 * the app's language and whose chrome matched nothing around it). Two taps:
 * the first sets the start and filters "since" right away, the second closes
 * the range — tapped before the start, the two simply swap. While the end is
 * pending the hovered day previews the span. Monday-first like the heatmap;
 * days after today are idle, since no memo can live there — and so are days
 * before the first memo, so ‹ never pages into empty years.
 *
 * One cell is tabbable (roving tabindex): arrows step a day / a week, Page
 * keys a month, so the grid is one stop in the panel's tab order, not 42.
 */
export function RangeCalendar({ from, to, minDay = null, onStart, onRange }: RangeCalendarProps) {
  const { locale, tr } = useI18n();
  const today = dateKey(new Date());
  const [pickingEnd, setPickingEnd] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(() => to ?? from ?? today);
  const focusDate = keyToDate(focusKey);
  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const gridRef = useRef<HTMLDivElement>(null);

  // Pending only while there is a start to close: a Clear elsewhere in the
  // panel drops the start, and the next tap must begin afresh.
  const awaitingEnd = pickingEnd && from !== null;
  const fullDay = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }), [locale]);

  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    const monday = startOfWeek(new Date(2024, 0, 1));
    return Array.from({ length: 7 }, (_, index) => format.format(addDays(monday, index)));
  }, [locale]);

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const start = startOfWeek(first);
    const last = new Date(year, month + 1, 0);
    const span = Math.ceil(((last.getTime() - start.getTime()) / 86_400_000 + 1) / 7) * 7;
    return Array.from({ length: span }, (_, index) => {
      const date = addDays(start, index);
      return { key: dateKey(date), day: date.getDate(), inMonth: date.getMonth() === month };
    });
  }, [year, month]);

  // The span on screen: the committed range, or start → hovered day while
  // the end is still being chosen.
  const previewEnd = awaitingEnd && hover ? hover : to;
  const [lo, hi] = from && previewEnd ? (from <= previewEnd ? [from, previewEnd] : [previewEnd, from]) : [from, from];

  function moveFocus(next: string) {
    const clamped = next > today ? today : minDay !== null && next < minDay ? minDay : next;
    setFocusKey(clamped);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${clamped}"]`)?.focus());
  }

  function shiftMonth(delta: number) {
    const target = new Date(year, month + delta, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    const next = dateKey(new Date(target.getFullYear(), target.getMonth(), Math.min(focusDate.getDate(), lastDay)));
    // Keep the roving stop on a live cell when the first memo's month opens.
    setFocusKey(minDay !== null && next < minDay ? minDay : next);
  }

  function pick(day: string) {
    if (!awaitingEnd || !from) {
      setPickingEnd(true);
      onStart(day);
      return;
    }
    setPickingEnd(false);
    setHover(null);
    if (day < from) onRange(day, from);
    else onRange(from, day);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in steps) {
      event.preventDefault();
      moveFocus(dateKey(addDays(focusDate, steps[event.key])));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const target = new Date(year, month + (event.key === "PageUp" ? -1 : 1), 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      moveFocus(dateKey(new Date(target.getFullYear(), target.getMonth(), Math.min(focusDate.getDate(), lastDay))));
    }
  }

  const atCurrentMonth = year === keyToDate(today).getFullYear() && month === keyToDate(today).getMonth();
  const atFirstMonth = minDay !== null && dateKey(new Date(year, month, 0)) < minDay;
  const startLabel = from ? formatDayLabel(from, locale) : tr("Start", "开始");
  const endLabel = to ? formatDayLabel(to, locale) : awaitingEnd ? tr("Pick an end", "选择结束日") : tr("Today", "今天");

  return (
    <div className="range-cal">
      <div className="range-cal-summary" aria-live="polite">
        <span className={from ? "is-set" : ""}>{startLabel}</span>
        <span className="range-cal-dash" aria-hidden="true">
          –
        </span>
        <span className={to ? "is-set" : awaitingEnd ? "is-pending" : ""}>{endLabel}</span>
      </div>
      <div className="range-cal-head">
        <button
          type="button"
          className="range-cal-nav"
          aria-label={tr("Previous month", "上个月")}
          disabled={atFirstMonth}
          onClick={() => shiftMonth(-1)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="range-cal-month">{formatMonthYear(year, month, locale)}</span>
        <button
          type="button"
          className="range-cal-nav"
          aria-label={tr("Next month", "下个月")}
          disabled={atCurrentMonth}
          onClick={() => shiftMonth(1)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={gridRef}
        className="range-cal-grid"
        role="group"
        aria-label={tr("Date range", "日期范围")}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setHover(null)}
      >
        {weekdays.map((label, index) => (
          <span key={`w${index}`} className="range-cal-weekday" aria-hidden="true">
            {label}
          </span>
        ))}
        {cells.map((cell) => {
          const idle = cell.key > today || (minDay !== null && cell.key < minDay);
          const inSpan = lo !== null && hi !== null && cell.key >= lo && cell.key <= hi;
          const isEdge = cell.key === lo || cell.key === hi;
          const classes = [
            "range-cal-day",
            cell.inMonth ? "" : "is-outside",
            inSpan ? "in-span" : "",
            cell.key === lo ? "is-lo" : "",
            cell.key === hi ? "is-hi" : "",
            isEdge ? "is-edge" : "",
            cell.key === today ? "is-today" : ""
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={cell.key}
              type="button"
              data-day={cell.key}
              className={classes}
              disabled={idle}
              tabIndex={cell.key === focusKey ? 0 : -1}
              aria-pressed={isEdge && from !== null}
              aria-label={fullDay.format(keyToDate(cell.key))}
              onFocus={() => setFocusKey(cell.key)}
              onPointerEnter={() => setHover(cell.key)}
              onClick={() => pick(cell.key)}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
