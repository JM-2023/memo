import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { addDays, dateKey, formatDayLabel, formatMonthYear, startOfWeek } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { SwapText } from "./SwapText";

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
 * pending the hovered (or keyboard-focused) day previews the span.
 * Monday-first like the heatmap; days after today are idle, since no memo
 * can live there — and so are days before the first memo, so ‹ never pages
 * into empty years.
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
  const clampDay = (key: string) => (key > today ? today : minDay !== null && key < minDay ? minDay : key);

  // A range set from outside the grid (a quick-range chip, a restored lens)
  // brings its month on screen, roving stop on its end. The grid's own taps
  // record what they asked for first, so a pick never yanks the page — not
  // even a second tap before the start, whose ordered end is the old start.
  const [seenRange, setSeenRange] = useState({ from, to });
  if (seenRange.from !== from || seenRange.to !== to) {
    setSeenRange({ from, to });
    const anchor = to ?? from;
    if (anchor !== null) setFocusKey(clampDay(anchor));
  }

  const focusDate = keyToDate(focusKey);
  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const gridRef = useRef<HTMLDivElement>(null);

  // Paging direction for the month label and the grid's slide: derived from
  // the month index, so every way of changing month (‹ ›, arrows, Page keys,
  // a preset) slides the same way the calendar moved.
  const monthIndex = year * 12 + month;
  const [shownMonth, setShownMonth] = useState({ index: monthIndex, dir: 0 });
  if (shownMonth.index !== monthIndex) setShownMonth({ index: monthIndex, dir: Math.sign(monthIndex - shownMonth.index) });
  const monthDir = shownMonth.index === monthIndex ? shownMonth.dir : Math.sign(monthIndex - shownMonth.index);
  // The slide restarts on the same element rather than remounting the days:
  // cells stay keyed by date, so a tap on a neighbouring month's day (which
  // turns the page as it takes focus) still lands its click.
  const daysRef = useRef<HTMLDivElement>(null);
  const slidMonthRef = useRef(monthIndex);
  useLayoutEffect(() => {
    const days = daysRef.current;
    if (!days || slidMonthRef.current === monthIndex) return;
    slidMonthRef.current = monthIndex;
    days.classList.remove("slide-left", "slide-right");
    if (monthDir === 0) return;
    void days.offsetWidth;
    days.classList.add(monthDir > 0 ? "slide-left" : "slide-right");
  }, [monthIndex, monthDir]);

  // Pending only while there is a start to close: a Clear elsewhere in the
  // panel drops the start, and the next tap must begin afresh.
  const awaitingEnd = pickingEnd && from !== null;
  const fullDay = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }), [locale]);

  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    const monday = startOfWeek(new Date(2024, 0, 1));
    return Array.from({ length: 7 }, (_, index) => format.format(addDays(monday, index)));
  }, [locale]);

  // Always six week rows, as the Stats calendar does: a month needing four or
  // five no longer shortens the panel (and shifts everything under it) as
  // the calendar pages.
  const cells = useMemo(() => {
    const start = startOfWeek(new Date(year, month, 1));
    return Array.from({ length: 42 }, (_, index) => {
      const date = addDays(start, index);
      return { key: dateKey(date), day: date.getDate(), inMonth: date.getMonth() === month };
    });
  }, [year, month]);

  // The span on screen: the committed range, or start → the day the end
  // would land on — under the pointer, else under keyboard focus.
  const previewEnd = awaitingEnd ? (hover ?? focusKey) : to;
  const [lo, hi] = from && previewEnd ? (from <= previewEnd ? [from, previewEnd] : [previewEnd, from]) : [from, from];

  function moveFocus(next: string) {
    const clamped = clampDay(next);
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
      setSeenRange({ from: day, to: null });
      onStart(day);
      return;
    }
    setPickingEnd(false);
    setHover(null);
    const [start, end] = day < from ? [day, from] : [from, day];
    setSeenRange({ from: start, to: end });
    onRange(start, end);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in steps) {
      event.preventDefault();
      // The latest input names the pending end: keys take over from a
      // pointer resting on the grid until it moves again.
      setHover(null);
      moveFocus(dateKey(addDays(focusDate, steps[event.key])));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      setHover(null);
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
        <span className="range-cal-month">
          <SwapText id={`${monthIndex}`} dir={monthDir} tweenWidth={false}>
            {formatMonthYear(year, month, locale)}
          </SwapText>
        </span>
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
        {/* The days page as one sheet, sliding the way the month moved (the
            heatmap's slide); the weekday header stays put above them. */}
        <div ref={daysRef} className="range-cal-days">
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
    </div>
  );
}
