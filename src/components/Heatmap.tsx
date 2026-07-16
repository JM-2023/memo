import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { addDays, dateKey, formatDayLabel, startOfWeek, weekdayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { buildHeatWeeks, type HeatCell, type PeriodKind } from "../lib/stats";
import { SwapText } from "./SwapText";
import { useTip } from "./Tip";

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

function weekRangeLabel(start: Date, end: Date, locale: string): string {
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
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
export function Heatmap({ countsByDay, minDay, activeDay, period, onPickDay }: HeatmapProps) {
  const { count, locale, tr } = useI18n();
  const tip = useTip();
  const now = useLocalToday();
  const todayStamp = `${dateKey(now)}:${now.getTimezoneOffset()}`;
  // Paging within the selected period. Switching periods derives back to
  // offset 0 (no effect needed — `nav.period` going stale resets it).
  const [nav, setNav] = useState({ period, offset: 0, direction: 0 });
  const offset = nav.period === period ? nav.offset : 0;
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
    if (period === "month") return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(start);
    return new Intl.DateTimeFormat(locale, { year: "numeric" }).format(start);
  }, [locale, period, offset, todayStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
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
    const formatter = new Intl.DateTimeFormat(locale, { month: "short" });
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

  function moveCellFocus(event: ReactKeyboardEvent<HTMLButtonElement>, key: string) {
    const current = navigableCells.find((cell) => cell.key === key);
    if (!current) return;
    let target = current;
    if (event.key === "Home") target = navigableCells[0] ?? current;
    else if (event.key === "End") target = navigableCells.at(-1) ?? current;
    else {
      let weekIndex = current.weekIndex;
      let dayIndex = current.dayIndex;
      if (period === "year") {
        if (event.key === "ArrowLeft") weekIndex -= 1;
        else if (event.key === "ArrowRight") weekIndex += 1;
        else if (event.key === "ArrowUp") dayIndex -= 1;
        else if (event.key === "ArrowDown") dayIndex += 1;
        else return;
      } else {
        if (event.key === "ArrowLeft") dayIndex -= 1;
        else if (event.key === "ArrowRight") dayIndex += 1;
        else if (event.key === "ArrowUp") weekIndex -= 1;
        else if (event.key === "ArrowDown") weekIndex += 1;
        else return;
      }
      target = navigableCells.find((cell) => cell.weekIndex === weekIndex && cell.dayIndex === dayIndex) ?? current;
    }
    event.preventDefault();
    setFocusedDay(target.key);
    cellRefs.current.get(target.key)?.focus({ preventScroll: true });
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
        onFocus={() => setFocusedDay(cell.key)}
        onKeyDown={(event) => moveCellFocus(event, cell.key)}
        onMouseEnter={(event) =>
          tip.show(event.currentTarget, {
            strong: count(cell.count, "memo"),
            text: `${formatDayLabel(cell.key, locale)} ${weekdayLabel(cell.key, locale)}`
          })
        }
        onMouseLeave={tip.hide}
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
    leaveHeightRef.current = viewportRef.current?.offsetHeight ?? null;
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
    const to = el.offsetHeight;
    if (Math.abs(to - from) < 1) return;
    el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 220,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)"
    });
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
        <button
          type="button"
          className="heatmap-title"
          onClick={goHome}
          onMouseEnter={(event) => {
            if (offset !== 0) tip.show(event.currentTarget, { text: tr(homeEn, homeZh) });
          }}
          onMouseLeave={tip.hide}
        >
          <SwapText id={gridKey} dir={swapDir} className="heatmap-title-swap">
            {title}
            <span className="heatmap-total">{count(rangeTotal, "memo")}</span>
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
