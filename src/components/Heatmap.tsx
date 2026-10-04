import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { addDays, dateFormat, dateKey, formatDayLabel, startOfWeek, weekdayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { buildHeatWeeks, type HeatCell, type PeriodKind } from "../lib/stats";
import { RollingCount } from "./RollingText";
import { SwapText } from "./SwapText";
import { DATA_TIP_DELAY, useTip, withFocus } from "./Tip";

interface HeatmapProps {
  countsByDay: Map<string, number>;
  /** Earliest local day holding a memo; navigation stops at its period. */
  minDay: string | null;
  activeDay: string | null;
  /** The sidebar's This week / This month / This year selection. */
  period: PeriodKind;
  onPickDay: (key: string | null) => void;
}

const PREV_LABEL: Record<PeriodKind, readonly [en: string, zh: string]> = {
  week: ["Previous week", "上一周"],
  month: ["Previous month", "上一月"],
  year: ["Previous year", "上一年"]
};
const NEXT_LABEL: Record<PeriodKind, readonly [en: string, zh: string]> = {
  week: ["Next week", "下一周"],
  month: ["Next month", "下一月"],
  year: ["Next year", "下一年"]
};
const HOME_LABEL: Record<PeriodKind, readonly [en: string, zh: string]> = {
  week: ["Return to this week", "回到本周"],
  month: ["Return to this month", "回到本月"],
  year: ["Return to this year", "回到今年"]
};

function rangeOf(period: PeriodKind, offset: number, now: Date): { start: Date; end: Date } {
  if (period === "week") {
    const start = addDays(startOfWeek(now), offset * 7);
    return { start, end: addDays(start, 6) };
  }
  if (period === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth() + offset, 1),
      end: new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)
    };
  }
  return { start: new Date(now.getFullYear() + offset, 0, 1), end: new Date(now.getFullYear() + offset, 11, 31) };
}

/**
 * A day-granularity clock for calendar semantics. The timeout handles an open
 * foreground tab; focus/visibility refreshes cover sleeping or throttled tabs
 * and local timezone changes before the old timeout gets a chance to fire.
 */
function useLocalToday(): Date {
  const [today, setToday] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const stamp = (date: Date) => `${dateKey(date)}:${date.getTimezoneOffset()}`;
    const refresh = () => {
      window.clearTimeout(timer);
      const current = new Date();
      setToday((previous) => (stamp(previous) === stamp(current) ? previous : current));
      const nextMidnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      timer = window.setTimeout(refresh, Math.max(50, nextMidnight.getTime() - current.getTime() + 50));
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return today;
}

function keyToDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Which page of `period` holds `day`, counted from the one holding `now`. */
function offsetOf(period: PeriodKind, day: Date, now: Date): number {
  if (period === "week") return Math.round((startOfWeek(day).getTime() - startOfWeek(now).getTime()) / (7 * 86_400_000));
  if (period === "month") return (day.getFullYear() - now.getFullYear()) * 12 + day.getMonth() - now.getMonth();
  return day.getFullYear() - now.getFullYear();
}

/** The same place one page over: a week on, the same date a month or a year on (clamped to the month's end). */
function pageOver(period: PeriodKind, day: Date, delta: number): Date {
  if (period === "week") return addDays(day, delta * 7);
  const target = period === "month" ? new Date(day.getFullYear(), day.getMonth() + delta, 1) : new Date(day.getFullYear() + delta, day.getMonth(), 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(day.getDate(), lastDay));
}

function weekRangeLabel(start: Date, end: Date, locale: string): string {
  const formatter = dateFormat(locale, { month: "short", day: "numeric" });
  const withRange = formatter as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
  return withRange.formatRange ? withRange.formatRange(start, end) : `${formatter.format(start)} – ${formatter.format(end)}`;
}

/**
 * The sidebar heat graph. It follows the period selector above it and lies
 * horizontal in every mode:
 *   - week  — one row of seven day cells under a Mon–Sun header,
 *   - month — a wall-calendar: weekday columns, week rows,
 *   - year  — two stacked GitHub-style half-year bands (Jan–Jun / Jul–Dec),
 *     each with month marks on top. One 52-column band would leave ~4px
 *     cells in the sidebar; splitting doubles the cell size so the year
 *     view grows in height just like the month calendar does.
 * ‹ › page by one period; clicking the title returns to the current one.
 * Clicking a day toggles the feed's day filter. Day details ride the shared
 * portal tooltip so neighbouring cells can never cover them.
 */
function HeatmapView({ countsByDay, minDay, activeDay, period, onPickDay }: HeatmapProps) {
  const { count, locale, tr } = useI18n();
  const tip = useTip();
  const now = useLocalToday();
  const todayStamp = `${dateKey(now)}:${now.getTimezoneOffset()}`;
  // Paging within the selected period. Switching periods derives back to the
  // page holding the active day, else the current one (no effect needed —
  // `nav.period` going stale resets it).
  const pageOf = (day: string | null) => (day ? Math.min(0, offsetOf(period, keyToDate(day), now)) : 0);
  const [nav, setNav] = useState(() => ({ period, offset: pageOf(activeDay), direction: 0 }));
  // A day picked somewhere else — a saved filter, Back, a reload — that the
  // shown page doesn't hold brings its page in, sliding the way it lies.
  // Only a change of day does: paging away from it by hand stays put.
  const [seenDay, setSeenDay] = useState(activeDay);
  if (seenDay !== activeDay) {
    setSeenDay(activeDay);
    const shown = nav.period === period ? nav.offset : pageOf(seenDay);
    const target = pageOf(activeDay);
    if (activeDay && target !== shown) setNav({ period, offset: target, direction: Math.sign(target - shown) });
    // Otherwise the page on screen stays — clearing the day included.
    else if (nav.period !== period) setNav({ period, offset: shown, direction: 0 });
  }
  const offset = nav.period === period ? nav.offset : pageOf(activeDay);
  const direction = nav.period === period ? nav.direction : 0;

  const { start, end } = rangeOf(period, offset, now);
  const weeks = useMemo(() => buildHeatWeeks(start, end, countsByDay, now), [period, offset, countsByDay, todayStamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const navigableCells = useMemo(
    () =>
      weeks.flatMap((week, weekIndex) =>
        week.flatMap((cell, dayIndex) => (cell.inRange && !cell.isFuture ? [{ key: cell.key, weekIndex, dayIndex }] : []))
      ),
    [weeks]
  );
  const [focusedDay, setFocusedDay] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const navigableKeys = useMemo(() => new Set(navigableCells.map((cell) => cell.key)), [navigableCells]);
  const rovingDay =
    (focusedDay && navigableKeys.has(focusedDay) ? focusedDay : null) ??
    (activeDay && navigableKeys.has(activeDay) ? activeDay : null) ??
    navigableCells.find((cell) => weeks[cell.weekIndex][cell.dayIndex].isToday)?.key ??
    navigableCells[0]?.key ??
    null;

  const rangeTotal = useMemo(() => {
    let sum = 0;
    for (const week of weeks) for (const cell of week) if (cell.inRange) sum += cell.count;
    return sum;
  }, [weeks]);

  const canForward = offset < 0;
  const canBack = minDay !== null && dateKey(addDays(start, -1)) >= minDay;

  const title = useMemo(() => {
    if (period === "week") return weekRangeLabel(start, end, locale);
    if (period === "month") return dateFormat(locale, { year: "numeric", month: "long" }).format(start);
    return dateFormat(locale, { year: "numeric" }).format(start);
  }, [locale, period, offset, todayStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const weekdayLabels = useMemo(() => {
    const formatter = dateFormat(locale, { weekday: "narrow" });
    const monday = new Date(2026, 0, 5);
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 0, monday.getDate() + index)));
  }, [locale]);

  /** Year mode: the two half-year bands, split at the week holding July 1. */
  const yearBands = useMemo(() => {
    if (period !== "year") return null;
    const julyFirst = `${start.getFullYear()}-07-01`;
    let split = weeks.findIndex((week) => week.some((cell) => cell.inRange && cell.key === julyFirst));
    if (split <= 0) split = Math.ceil(weeks.length / 2);
    return [weeks.slice(0, split), weeks.slice(split)] as const;
  }, [weeks, period, start]);

  /** Which week column each month starts in (a band's top marks). */
  function monthMarksOf(band: HeatCell[][]): { week: number; label: string }[] {
    const formatter = dateFormat(locale, { month: "short" });
    const marks: { week: number; label: string }[] = [];
    band.forEach((week, index) => {
      const firstOfMonth = week.find((cell) => cell.inRange && cell.key.endsWith("-01"));
      if (firstOfMonth) {
        const [year, month] = firstOfMonth.key.split("-").map(Number);
        marks.push({ week: index, label: formatter.format(new Date(year, month - 1, 1)) });
      }
    });
    return marks;
  }

  function shift(delta: number) {
    tip.hide();
    setNav({ period, offset: offset + delta, direction: delta });
  }

  function goHome() {
    if (offset === 0) return;
    tip.hide();
    setNav({ period, offset: 0, direction: offset < 0 ? 1 : -1 });
  }

  const [homeEn, homeZh] = HOME_LABEL[period];

  // A key that walks off the page turns it: focus lands on the matching cell
  // of the page it opens, once that page has rendered.
  const pendingFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = pendingFocusRef.current;
    if (!key) return;
    pendingFocusRef.current = null;
    cellRefs.current.get(key)?.focus({ preventScroll: true });
  });

  /** Pages the ‹ › arrows could reach: the first memo's page through today's. */
  function canShowPage(page: number): boolean {
    return page <= 0 && (page === offset || (minDay !== null && page >= Math.min(0, offsetOf(period, keyToDate(minDay), now))));
  }

  /**
   * Arrows step a day (← →) or a week (↑ ↓) — on the year bands, a week
   * column (← →) or a day (↑ ↓) — and Page Up / Down a whole page, all by
   * date: a step off the page's edge turns the page, as the range calendar
   * does, instead of stopping dead. Days after today hold nothing; a page
   * key landing past today lands on today.
   */
  function moveCellFocus(event: ReactKeyboardEvent<HTMLButtonElement>, key: string) {
    if (!navigableKeys.has(key)) return;
    const todayKey = dateKey(now);
    let target: string | undefined;
    if (event.key === "Home") target = navigableCells[0]?.key;
    else if (event.key === "End") target = navigableCells.at(-1)?.key;
    else {
      const day = keyToDate(key);
      let next: Date;
      if (event.key === "PageUp" || event.key === "PageDown") {
        next = pageOver(period, day, event.key === "PageUp" ? -1 : 1);
        if (dateKey(next) > todayKey) next = now;
      } else {
        const steps: Record<string, number> =
          period === "year" ? { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (!(event.key in steps)) return;
        next = addDays(day, steps[event.key]);
      }
      const nextKey = dateKey(next);
      const page = offsetOf(period, next, now);
      if (nextKey <= todayKey && (navigableKeys.has(nextKey) || (page !== offset && canShowPage(page)))) target = nextKey;
    }
    event.preventDefault();
    if (!target || target === key) return;
    setFocusedDay(target);
    const page = offsetOf(period, keyToDate(target), now);
    if (page !== offset) {
      tip.hide();
      pendingFocusRef.current = target;
      setNav({ period, offset: page, direction: Math.sign(page - offset) });
      return;
    }
    cellRefs.current.get(target)?.focus({ preventScroll: true });
  }

  // ---- Grid transition machinery ----
  // The outgoing grid keeps rendering on an absolute layer that slides away
  // (opposite the incoming slide), and the viewport's height tweens between
  // the two grids' sizes so the sidebar below glides instead of jumping.
  const gridKey = `${period}:${offset}`;
  const [leaving, setLeaving] = useState<{ node: ReactNode; dir: number; serial: number } | null>(null);
  const lastGridRef = useRef<{ key: string; node: ReactNode; period: PeriodKind } | null>(null);
  const enterDirRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const leaveHeightRef = useRef<number | null>(null);
  const leaveSerialRef = useRef(0);

  const cellNode = (cell: HeatCell) =>
    cell.inRange && !cell.isFuture ? (
      <button
        key={cell.key}
        ref={(node) => {
          if (node) cellRefs.current.set(cell.key, node);
          else if (!cellRefs.current.get(cell.key)?.isConnected) cellRefs.current.delete(cell.key);
        }}
        type="button"
        className={`heat-cell level-${cell.level}${cell.isToday ? " is-today" : ""}${activeDay === cell.key ? " is-active" : ""}`}
        aria-label={tr(
          `${formatDayLabel(cell.key, locale)}, ${count(cell.count, "memo")}`,
          `${formatDayLabel(cell.key, locale)}，${count(cell.count, "memo")}`
        )}
        aria-pressed={activeDay === cell.key}
        tabIndex={cell.key === rovingDay ? 0 : -1}
        {...withFocus(
          tip.bind(
            {
              strong: count(cell.count, "memo"),
              text: `${formatDayLabel(cell.key, locale)} ${weekdayLabel(cell.key, locale)}`
            },
            // Cells are read by scanning, not crossed on the way elsewhere.
            { delay: DATA_TIP_DELAY }
          ),
          () => setFocusedDay(cell.key)
        )}
        onKeyDown={(event) => moveCellFocus(event, cell.key)}
        onClick={() => onPickDay(activeDay === cell.key ? null : cell.key)}
      />
    ) : (
      <span key={cell.key} className={`heat-cell placeholder${cell.inRange ? " future" : ""}`} aria-hidden="true" />
    );

  const gridNode =
    period === "year" && yearBands ? (
      <div className="heat-year">
        {yearBands.map((band, bandIndex) => {
          // Both bands share one column count so their cells match in size.
          const cols = Math.max(yearBands[0].length, yearBands[1].length);
          return (
            <div key={bandIndex} className="heat-band">
              <div className="heat-months" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }} aria-hidden="true">
                {monthMarksOf(band).map((mark) => (
                  <span key={mark.week} style={{ gridColumnStart: mark.week + 1 }}>
                    {mark.label}
                  </span>
                ))}
              </div>
              <div className="heatmap-grid is-year" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                {band.map((week) => week.map(cellNode))}
              </div>
            </div>
          );
        })}
      </div>
    ) : (
      <div className="heatmap-grid is-cal">
        {weekdayLabels.map((label, index) => (
          <span key={`${label}-${index}`} className="heat-colhead" aria-hidden="true">
            {label}
          </span>
        ))}
        {weeks.map((week) => week.map(cellNode))}
      </div>
    );

  const lastGrid = lastGridRef.current;
  if (lastGrid !== null && lastGrid.key !== gridKey) {
    // Paging slides sideways; period switches crossfade (dir 0). Height is
    // read during render, while the DOM still shows the outgoing grid.
    const dir = lastGrid.period === period ? direction : 0;
    leaveHeightRef.current = viewportRef.current?.getBoundingClientRect().height ?? null;
    leaveSerialRef.current += 1;
    enterDirRef.current = dir;
    setLeaving({ node: lastGrid.node, dir, serial: leaveSerialRef.current });
  }
  lastGridRef.current = { key: gridKey, node: gridNode, period };

  useLayoutEffect(() => {
    const el = viewportRef.current;
    const from = leaveHeightRef.current;
    leaveHeightRef.current = null;
    if (!el || from === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    const animation = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 220,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)"
    });
    // Render captures the current painted height before this cleanup runs.
    // Cancel before the next effect measures the new grid's natural height.
    return () => animation.cancel();
  }, [gridKey]);

  const enterDir = enterDirRef.current;
  const enterClass = enterDir === null ? "" : enterDir > 0 ? " slide-left" : enterDir < 0 ? " slide-right" : " heat-arrive";
  const swapDir = lastGrid !== null && lastGrid.period === period ? direction : 0;

  return (
    <div className="heatmap">
      <div className="heatmap-head">
        <button
          type="button"
          className="icon-button heatmap-nav"
          onClick={() => shift(-1)}
          disabled={!canBack}
          aria-label={tr(...PREV_LABEL[period])}
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        {/* On the current page there is nowhere to return to: the title says
            so (aria-disabled, no hover or press) rather than acting dead. */}
        <button
          type="button"
          className="heatmap-title"
          aria-disabled={offset === 0 ? true : undefined}
          onClick={goHome}
          {...tip.bind(() => (offset !== 0 ? { text: tr(homeEn, homeZh) } : null))}
        >
          <SwapText id={gridKey} dir={swapDir} tweenWidth={false} className="heatmap-title-swap">
            {title}
            {/* A memo added on this page rolls the count; a new page swaps
                it with the title. */}
            <span className="heatmap-total">
              <RollingCount value={rangeTotal} unit="memo" />
            </span>
          </SwapText>
        </button>
        <button
          type="button"
          className="icon-button heatmap-nav"
          onClick={() => shift(1)}
          disabled={!canForward}
          aria-label={tr(...NEXT_LABEL[period])}
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>

      <div ref={viewportRef} className="heat-viewport">
        <div key={gridKey} className={`heat-current${enterClass}`}>
          {gridNode}
        </div>
        {leaving ? (
          <div
            key={`leave-${leaving.serial}`}
            ref={(node) => node?.setAttribute("inert", "")}
            className={`heat-leaving${leaving.dir > 0 ? " leave-left" : leaving.dir < 0 ? " leave-right" : " leave-fade"}`}
            aria-hidden="true"
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setLeaving(null);
            }}
          >
            {leaving.node}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Memoized: a sidebar re-render that leaves these props alone skips the
    whole subtree. */
export const Heatmap = memo(HeatmapView);
