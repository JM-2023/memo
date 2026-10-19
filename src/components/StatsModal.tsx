import { ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useModalA11y } from "../hooks/useModalA11y";
import { useCloseSignal, useOverlayExit } from "../hooks/useOverlayExit";
import { dateFormat, daysBetweenInclusive, formatDayLabel, formatMonthYear, formatYear, weekdayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { EASE_OUT, T_SLOW } from "../lib/motion";
import { buildHeatWeeks, computeStreaks, countsByDay, localMaxima, longestRun, totalStats, wordCountOf, type DayRun, type HeatCell } from "../lib/stats";
import { recallStatsPlace, rememberStatsPlace, type StatsDrilldown } from "../lib/statsDrilldown";
import { tagsOf } from "../lib/tags";
import type { Memo } from "../lib/types";
import { RollingText } from "./RollingText";
import { DATA_TIP_DELAY, useTip, withFocus, type TipContent } from "./Tip";

interface StatsModalProps {
  memos: Memo[];
  uniqueTagCount: number;
  onClose: () => void;
  onDrilldown: (filter: StatsDrilldown) => void;
  /** Bumped by the owner to close the panel the way its own ✕ does (Back). */
  closeSignal?: number;
}

function weekdayNames(locale: string, width: "long" | "short"): string[] {
  const formatter = dateFormat(locale, { weekday: width });
  const monday = new Date(2026, 0, 5);
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 0, monday.getDate() + index)));
}

function formatHour(hour: number, locale: string): string {
  return dateFormat(locale, { hour: "numeric" }).format(new Date(2026, 0, 5, hour));
}

function formatHourRange(hour: number, locale: string): string {
  return `${formatHour(hour, locale)} – ${formatHour(hour + 1, locale)}`;
}

/* Local-midnight parse: `new Date("2026-03-05")` lands on UTC midnight, which
   shifts a day backwards in negative-offset timezones. */
function parseDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function argMax(values: number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[best]) best = index;
  return best;
}

/**
 * A mark a touch has picked. A finger has no hover to read a day, bar or dot
 * by, and every one of them drills out of the panel, so on touch the first
 * tap picks the mark — ring, pinned tip, a "Show n memos" pill in its
 * section's head — and the second tap (or the pill) drills.
 */
interface StatsPick {
  key: string;
  count: number;
  /** What the mark stands for, in words: "Mar 5, 2026", "Monday · 9 AM – 10 AM". */
  place: string;
  tip: TipContent;
  drill: () => void;
}

type PickSection = "days" | "months" | "rhythm";
type PickPress = (event: ReactMouseEvent<HTMLElement>, pick: StatsPick) => void;

/** A press that came from a finger — or a pen on a device whose pointer is coarse. */
function touchLike(pointerType: string | null): boolean {
  if (pointerType === "touch") return true;
  return pointerType === "pen" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

interface BarChartProps {
  label: string;
  values: number[];
  labels: string[];
  tips: string[];
  /**
   * A second series drawn as a tick across each column — the previous year.
   * Always passed, so the ticks fade instead of popping when a year has no
   * predecessor to compare with.
   */
  compare: { name: string; values: number[]; shown: boolean };
  /** Columns still ahead (the rest of this year): a dashed baseline, not a zero. */
  future?: boolean[];
  onPick: (index: number) => void;
  /** The touch pick in this chart, by key. */
  picked: string | null;
  onPress: PickPress;
}

/**
 * Baseline-anchored bars that rise in with a slight stagger and drill down.
 * Each bar prints its count above itself, so the figures read without a
 * pointer. When a chart is too narrow for every label to have its own room
 * (measured, not guessed), only the local peaks keep theirs, plus the hovered
 * or focused bar; the tip still carries the full sentence.
 */
function BarChart({ label, values, labels, tips, compare, future = [], onPick, picked, onPress }: BarChartProps) {
  const { count, formatNumber, tr } = useI18n();
  const tip = useTip();
  const max = Math.max(1, ...values, ...(compare.shown ? compare.values : []));
  const notYet = tr("Not yet", "还没到");
  const nameOf = (index: number) =>
    `${tips[index]}: ${future[index] ? notYet : count(values[index], "memo")}${compare.shown ? `, ${compare.name}: ${count(compare.values[index], "memo")}` : ""}`;
  const tipOf = (index: number): TipContent => ({
    strong: future[index] ? notYet : count(values[index], "memo"),
    text: compare.shown ? `${tips[index]} · ${compare.name} ${formatNumber(compare.values[index] ?? 0)}` : tips[index]
  });
  const summary = `${label}. ${values.map((_, index) => nameOf(index)).join("; ")}`;
  const density = values.length >= 20 ? " is-dense" : values.length >= 10 ? " is-medium" : "";
  const peaks = localMaxima(values);
  const barsRef = useRef<HTMLDivElement>(null);
  const [sparse, setSparse] = useState(false);
  const signature = values.join(",");

  useLayoutEffect(() => {
    const bars = barsRef.current;
    if (!bars) return;
    const measure = () => {
      const columns = bars.children;
      // The grid gives every column the same width and gap, so the first two
      // columns' offsets give the pitch.
      const pitch = columns.length > 1 ? (columns[1] as HTMLElement).offsetLeft - (columns[0] as HTMLElement).offsetLeft : 0;
      let widest = 0;
      bars.querySelectorAll<HTMLElement>(".stats-bar-value").forEach((value) => {
        widest = Math.max(widest, value.offsetWidth);
      });
      // Neighbouring labels keep a 4px gutter. Before layout (pitch 0, as in
      // tests) every label shows.
      setSparse(pitch > 0 && widest + 4 > pitch);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(bars);
    return () => observer?.disconnect();
    // Label widths follow the values (and the locale); chart width is observed.
  }, [signature, formatNumber]);

  return (
    <div className={`bar-chart${density}${compare.shown ? " has-compare" : ""}`} role="group" aria-label={summary}>
      <div ref={barsRef} className={`stats-bars${sparse ? " is-sparse" : ""}`}>
        {values.map((value, index) => {
          // Year switches resize the bars in a left-to-right ripple.
          const ripple = `${Math.min(index, 11) * 0.014}s`;
          const before = compare.values[index] ?? 0;
          const key = `bar:${index}`;
          // A month still to come has no stub: an empty past month drew the
          // same 4px as one that hasn't happened.
          const shape = future[index] ? " is-future" : value > 0 ? "" : " is-zero";
          return (
            <button
              key={index}
              type="button"
              className={`stats-bar-col${picked === key ? " is-picked" : ""}`}
              disabled={value === 0}
              aria-label={nameOf(index)}
              onClick={(event) => onPress(event, { key, count: value, place: tips[index], tip: tipOf(index), drill: () => onPick(index) })}
              {...tip.bind(tipOf(index), { delay: DATA_TIP_DELAY })}
            >
              <span
                className={`stats-bar${shape}`}
                style={{ height: future[index] ? 0 : value > 0 ? `${(value / max) * 100}%` : "4px", animationDelay: `${Math.min(index, 11) * 0.008}s`, "--bar-d": ripple } as CSSProperties}
              />
              <span className={`stats-bar-mark${before > 0 ? "" : " is-zero"}`} style={{ "--m": before / max, "--bar-d": ripple } as CSSProperties} aria-hidden="true" />
              {/* A sibling of the bar, not its child, so it can sit over last
                  year's tick. Hidden from assistive tech: the button's name
                  carries the count. */}
              <span className={`stats-bar-value${peaks[index] ? " is-peak" : ""}`} style={{ "--v": value / max, "--bar-d": ripple } as CSSProperties} aria-hidden="true">
                {value > 0 ? formatNumber(value) : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="stats-bar-labels" aria-hidden="true">
        {labels.map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </div>
    </div>
  );
}

/** Weeks in the strip: a Monday-first year spans 53 week columns (54 only for a leap year that starts on a Sunday). */
const STRIP_WEEKS = 53;

interface YearStripProps {
  year: number;
  weeks: HeatCell[][];
  monthCounts: number[];
  onPickDay: (key: string) => void;
  onPickMonth: (month: number) => void;
  picked: string | null;
  onPress: PickPress;
}

/**
 * The year as one strip: a column per week, a row per weekday, Monday on
 * top. Cells are keyed by grid position, so switching years recolours them in
 * place, in a left-to-right sweep. Month names above the strip drill into
 * their month; days with memos drill into their day. On a phone the strip
 * keeps legible cells and scrolls sideways, opening on today.
 */
function YearStrip({ year, weeks, monthCounts, onPickDay, onPickMonth, picked, onPress }: YearStripProps) {
  const { count, locale, tr } = useI18n();
  const tip = useTip();
  const columns = Math.max(STRIP_WEEKS, weeks.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef(false);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focused, setFocused] = useState<string | null>(null);
  const shortDays = useMemo(() => weekdayNames(locale, "short"), [locale]);
  const monthFormatter = useMemo(() => dateFormat(locale, { month: "short" }), [locale]);
  const dayFormatter = useMemo(() => dateFormat(locale, { year: "numeric", month: "short", day: "numeric" }), [locale]);

  // Weeks run in date order and each is Monday→Sunday, so walking them
  // column by column lists the days in date order.
  const activeDays = useMemo(() => weeks.flat().filter((cell) => cell.inRange && !cell.isFuture && cell.count > 0).map((cell) => cell.key), [weeks]);
  const roving = focused && activeDays.includes(focused) ? focused : (activeDays[activeDays.length - 1] ?? null);
  const monthStarts = useMemo(() => {
    const starts: number[] = [];
    weeks.forEach((week, column) => {
      for (const cell of week) if (cell.inRange && cell.key.endsWith("-01")) starts[Number(cell.key.slice(5, 7)) - 1] = column;
    });
    return starts;
  }, [weeks]);

  useLayoutEffect(() => {
    // Only a strip wider than its box scrolls: open on today (current year)
    // or January (past years). The first placement is instant, later ones
    // (year switches) glide.
    const box = scrollRef.current;
    if (!box) return;
    const first = !placedRef.current;
    placedRef.current = true;
    if (box.scrollWidth <= box.clientWidth + 1) return;
    const today = box.querySelector<HTMLElement>(".year-cell.is-today");
    const left = today ? today.offsetLeft + today.offsetWidth + 32 - box.clientWidth : 0;
    box.scrollTo({ left: Math.max(0, left), behavior: first ? "auto" : "smooth" });
  }, [year]);

  function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>, key: string) {
    const current = activeDays.indexOf(key);
    if (current < 0) return;
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = activeDays.length - 1;
    // Down the column is the next day, as the strip reads; only days with
    // memos are stops.
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "ArrowDown") next = Math.min(activeDays.length - 1, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // A week back or on: the nearest day with memos to that date, on that
      // side of this one.
      const forward = event.key === "ArrowRight";
      const goal = parseDayKey(key).getTime() + (forward ? 7 : -7) * 86_400_000;
      let bestDistance = Infinity;
      for (let index = forward ? current + 1 : current - 1; index >= 0 && index < activeDays.length; index += forward ? 1 : -1) {
        const distance = Math.abs(parseDayKey(activeDays[index]).getTime() - goal);
        // Ties go to the day further along: the step should feel like a step.
        if (distance > bestDistance) break;
        next = index;
        bestDistance = distance;
      }
    } else return;
    event.preventDefault();
    const target = activeDays[next];
    setFocused(target);
    dayRefs.current.get(target)?.focus({ preventScroll: false });
  }

  return (
    <div ref={scrollRef} className="year-strip-scroll">
      <div className="year-strip" style={{ "--weeks": columns } as CSSProperties}>
        <div className="year-strip-months">
          <span className="year-strip-corner" aria-hidden="true" />
          {monthCounts.map((memoCount, month) => {
            const start = monthStarts[month] ?? 0;
            const end = monthStarts[month + 1] ?? columns;
            const name = formatMonthYear(year, month, locale);
            return (
              <button
                key={month}
                type="button"
                className="year-strip-month"
                style={{ gridColumn: `${start + 2} / ${end + 2}` }}
                disabled={memoCount === 0}
                aria-label={tr(`Show ${count(memoCount, "memo")} from ${name}`, `查看 ${name}的 ${count(memoCount, "memo")}`)}
                onClick={() => onPickMonth(month)}
                {...tip.bind({ strong: count(memoCount, "memo"), text: name }, { delay: DATA_TIP_DELAY })}
              >
                {monthFormatter.format(new Date(year, month, 1))}
              </button>
            );
          })}
        </div>
        <div className="year-strip-grid">
          {shortDays.map((name, index) => (
            <span key={`d${index}`} className="year-strip-day" aria-hidden="true">
              {index % 2 === 0 && index < 6 ? name : null}
            </span>
          ))}
          {Array.from({ length: columns }, (_, column) =>
            Array.from({ length: 7 }, (_, row) => {
              const cell = weeks[column]?.[row];
              const sweep = { "--w": column } as CSSProperties;
              if (cell && cell.inRange && !cell.isFuture && cell.count > 0) {
                const day = dayFormatter.format(parseDayKey(cell.key));
                const key = `day:${cell.key}`;
                const content: TipContent = { strong: count(cell.count, "memo"), text: `${formatDayLabel(cell.key, locale)} ${weekdayLabel(cell.key, locale)}` };
                return (
                  <button
                    key={`${column}-${row}`}
                    ref={(element) => {
                      if (element) dayRefs.current.set(cell.key, element);
                      else dayRefs.current.delete(cell.key);
                    }}
                    type="button"
                    className={`year-cell level-${cell.level}${cell.isToday ? " is-today" : ""}${picked === key ? " is-picked" : ""}`}
                    style={sweep}
                    aria-label={tr(`Show ${count(cell.count, "memo")} from ${day}`, `查看 ${day}的 ${count(cell.count, "memo")}`)}
                    tabIndex={cell.key === roving ? 0 : -1}
                    {...withFocus(tip.bind(content, { delay: DATA_TIP_DELAY }), () => setFocused(cell.key))}
                    onKeyDown={(event) => moveFocus(event, cell.key)}
                    onClick={(event) => onPress(event, { key, count: cell.count, place: day, tip: content, drill: () => onPickDay(cell.key) })}
                  />
                );
              }
              // Every slot stays a (disabled) button, so a day that gains or
              // loses memos across years recolours instead of remounting.
              const kind = !cell || !cell.inRange ? " is-void" : cell.isFuture ? " is-future" : ` level-0${cell.isToday ? " is-today" : ""}`;
              return <button key={`${column}-${row}`} type="button" className={`year-cell${kind}`} style={sweep} disabled tabIndex={-1} aria-hidden="true" />;
            })
          )}
        </div>
      </div>
    </div>
  );
}

interface RhythmChartProps {
  /** Memos per [weekday (Monday first)][hour]. */
  slots: number[][];
  weekdayCounts: number[];
  hourCounts: number[];
  onPickWeekday: (weekday: number) => void;
  onPickHour: (hour: number) => void;
  onPickSlot: (weekday: number, hour: number) => void;
  picked: string | null;
  onPress: PickPress;
}

/** Arrow-key stops in the rhythm grid, by [row, column] in reading order. */
function stepRhythm(stops: [number, number][], from: number, key: string): number | null {
  const [row, column] = stops[from];
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return stops.length - 1;
    case "ArrowLeft":
      return Math.max(0, from - 1);
    case "ArrowRight":
      return Math.min(stops.length - 1, from + 1);
    case "ArrowUp":
    case "ArrowDown": {
      // The nearest stop by hour in the closest weekday row that has one.
      const step = key === "ArrowDown" ? 1 : -1;
      for (let target = row + step; target >= 0 && target < 7; target += step) {
        let best = -1;
        stops.forEach(([r, c], index) => {
          if (r === target && (best < 0 || Math.abs(c - column) < Math.abs(stops[best][1] - column))) best = index;
        });
        if (best >= 0) return best;
      }
      return from;
    }
    default:
      return null;
  }
}

/**
 * When the writing happens: a weekday × hour punch card. A dot's area
 * follows its count; the weekday totals sit at the right of their rows and
 * the hour totals under their columns, each drilling into its slice. Dots
 * re-size in a diagonal ripple when the year changes.
 */
function RhythmChart({ slots, weekdayCounts, hourCounts, onPickWeekday, onPickHour, onPickSlot, picked, onPress }: RhythmChartProps) {
  const { count, locale, tr } = useI18n();
  const tip = useTip();
  const shortDays = useMemo(() => weekdayNames(locale, "short"), [locale]);
  const longDays = useMemo(() => weekdayNames(locale, "long"), [locale]);
  const slotMax = Math.max(1, ...slots.flat());
  const weekdayMax = Math.max(1, ...weekdayCounts);
  const hourMax = Math.max(1, ...hourCounts);
  const stops = useMemo(() => {
    const list: [number, number][] = [];
    slots.forEach((row, r) => row.forEach((value, c) => value > 0 && list.push([r, c])));
    return list;
  }, [slots]);
  const [focused, setFocused] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const rovingIndex = Math.max(0, stops.findIndex(([r, c]) => `${r}-${c}` === focused));
  const scrollRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef(false);
  const firstHour = hourCounts.findIndex((value) => value > 0);

  useLayoutEffect(() => {
    // Where the grid must scroll (a phone), open on the first hour anything
    // was written rather than on empty small hours.
    const box = scrollRef.current;
    if (!box) return;
    const first = !placedRef.current;
    placedRef.current = true;
    if (box.scrollWidth <= box.clientWidth + 1) return;
    const hour = box.querySelectorAll<HTMLElement>(".rhythm-hour")[Math.max(0, firstHour)];
    const day = box.querySelector<HTMLElement>(".rhythm-day");
    const left = hour && day ? hour.offsetLeft - day.offsetWidth - 8 : 0;
    box.scrollTo({ left: Math.max(0, left), behavior: first ? "auto" : "smooth" });
  }, [firstHour]);

  function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>, r: number, c: number) {
    const from = stops.findIndex(([sr, sc]) => sr === r && sc === c);
    if (from < 0) return;
    const next = stepRhythm(stops, from, event.key);
    if (next === null) return;
    event.preventDefault();
    const [nr, nc] = stops[next];
    setFocused(`${nr}-${nc}`);
    cellRefs.current.get(`${nr}-${nc}`)?.focus({ preventScroll: true });
  }

  return (
    <div ref={scrollRef} className="rhythm-scroll">
      <div className="rhythm">
        <div className="rhythm-grid" role="group" aria-label={tr("Memos by weekday and hour", "按星期和时段的笔记")}>
          {slots.map((row, r) => (
            <div key={r} className="rhythm-row">
              <span className="rhythm-day" aria-hidden="true">
                {shortDays[r]}
              </span>
              {row.map((value, c) => {
                const key = `${r}-${c}`;
                const style = { "--s": value > 0 ? 0.3 + 0.7 * Math.sqrt(value / slotMax) : 0, "--d": `${c * 7 + r * 16}ms` } as CSSProperties;
                if (value === 0) {
                  return (
                    <button key={c} type="button" className="rhythm-cell is-zero" disabled tabIndex={-1} aria-hidden="true">
                      <span className="rhythm-dot" style={style} />
                    </button>
                  );
                }
                const slot = `${longDays[r]} · ${formatHourRange(c, locale)}`;
                const content: TipContent = { strong: count(value, "memo"), text: slot };
                return (
                  <button
                    key={c}
                    ref={(element) => {
                      if (element) cellRefs.current.set(key, element);
                      else cellRefs.current.delete(key);
                    }}
                    type="button"
                    className={`rhythm-cell${picked === `slot:${key}` ? " is-picked" : ""}`}
                    aria-label={`${slot}: ${count(value, "memo")}`}
                    tabIndex={stops[rovingIndex]?.[0] === r && stops[rovingIndex]?.[1] === c ? 0 : -1}
                    {...withFocus(tip.bind(content, { delay: DATA_TIP_DELAY }), () => setFocused(key))}
                    onKeyDown={(event) => moveFocus(event, r, c)}
                    onClick={(event) => onPress(event, { key: `slot:${key}`, count: value, place: slot, tip: content, drill: () => onPickSlot(r, c) })}
                  >
                    <span className="rhythm-dot" style={style} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="rhythm-side" role="group" aria-label={tr("Distribution by weekday", "星期分布")}>
          {weekdayCounts.map((value, weekday) => (
            <button
              key={weekday}
              type="button"
              className="rhythm-total"
              disabled={value === 0}
              aria-label={`${longDays[weekday]}: ${count(value, "memo")}`}
              onClick={() => onPickWeekday(weekday)}
              {...tip.bind({ strong: count(value, "memo"), text: longDays[weekday] }, { delay: DATA_TIP_DELAY })}
            >
              <span className="rhythm-total-track">
                <span className="rhythm-total-fill" style={{ "--f": value / weekdayMax, "--d": `${weekday * 16}ms` } as CSSProperties} />
              </span>
              <span className="rhythm-total-count">
                <RollingText value={value} />
              </span>
            </button>
          ))}
        </div>
        <div className="rhythm-foot" role="group" aria-label={tr("Distribution by time", "时段分布")}>
          <span className="rhythm-corner" aria-hidden="true" />
          {hourCounts.map((value, hour) => (
            <button
              key={hour}
              type="button"
              className={`rhythm-hour${picked === `hour:${hour}` ? " is-picked" : ""}`}
              disabled={value === 0}
              aria-label={`${formatHourRange(hour, locale)}: ${count(value, "memo")}`}
              onClick={(event) =>
                onPress(event, {
                  key: `hour:${hour}`,
                  count: value,
                  place: formatHourRange(hour, locale),
                  tip: { strong: count(value, "memo"), text: formatHourRange(hour, locale) },
                  drill: () => onPickHour(hour)
                })
              }
              {...tip.bind({ strong: count(value, "memo"), text: formatHourRange(hour, locale) }, { delay: DATA_TIP_DELAY })}
            >
              <span className="rhythm-hour-bar" style={{ "--f": value / hourMax, "--d": `${hour * 7}ms` } as CSSProperties} />
            </button>
          ))}
          <span className="rhythm-corner" aria-hidden="true" />
          {hourCounts.map((_, hour) => (
            <span key={hour} className="rhythm-hour-label" aria-hidden="true">
              {hour % 3 === 0 ? formatHour(hour, locale) : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

interface LeavingTag {
  name: string;
  count: number;
  pct: number;
  top: number;
  serial: number;
}

const TAG_GLIDE: KeyframeAnimationOptions = { duration: T_SLOW, easing: EASE_OUT };

/**
 * Ranked tag bars keyed by tag name. Switching years FLIP-glides surviving
 * rows to their new rank, sinks dropped rows out in place, raises newcomers
 * in, and tweens the list height — a re-ranking reads as rows trading places
 * instead of five fixed slots teleporting their contents.
 */
function TagRows({ tags, total, emptyLabel, onPick }: { tags: [string, number][]; total: number; emptyLabel: string; onPick: (tag: string) => void }) {
  const { count, formatNumber, tr } = useI18n();
  const max = tags[0]?.[1] ?? 1;
  const boxRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(new Map<string, HTMLButtonElement>());
  const flipsRef = useRef(new Map<string, Animation>());
  const boxAnimRef = useRef<Animation | null>(null);
  const lastRef = useRef<[string, number][] | null>(null);
  const snapRef = useRef<{ tops: Map<string, number>; height: number } | null>(null);
  const enteringRef = useRef(new Set<string>());
  const serialRef = useRef(0);
  const [leaving, setLeaving] = useState<LeavingTag[]>([]);

  const last = lastRef.current;
  if (last !== null && last.map(([name]) => name).join("\0") !== tags.map(([name]) => name).join("\0")) {
    // Render-phase snapshot: the DOM still shows the outgoing ranking, so
    // capture where each row visually sits (mid-flight transforms included)
    // and how tall the list currently is.
    const tops = new Map<string, number>();
    for (const [name, el] of rowsRef.current) {
      if (el.isConnected) tops.set(name, el.getBoundingClientRect().top);
    }
    snapRef.current = { tops, height: boxRef.current?.offsetHeight ?? 0 };
    serialRef.current += 1;
    const names = new Set(tags.map(([name]) => name));
    const lastMax = last[0]?.[1] ?? 1;
    const gone: LeavingTag[] = last
      .filter(([name]) => !names.has(name))
      .map(([name, count]) => ({
        name,
        count,
        pct: (count / lastMax) * 100,
        top: rowsRef.current.get(name)?.offsetTop ?? 0,
        serial: serialRef.current
      }));
    enteringRef.current = new Set(tags.filter(([name]) => !last.some(([lastName]) => lastName === name)).map(([name]) => name));
    // Keep older ghosts that are still fading, unless their tag re-entered.
    setLeaving((current) => [...current.filter((ghost) => !names.has(ghost.name) && !gone.some((g) => g.name === ghost.name)), ...gone]);
  }
  lastRef.current = tags;

  useLayoutEffect(() => {
    const snap = snapRef.current;
    snapRef.current = null;
    if (!snap || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [name, el] of rowsRef.current) {
      const from = snap.tops.get(name);
      if (from === undefined || !el.isConnected) continue;
      // Cancel before measuring: a mid-flight FLIP transform would otherwise
      // pollute the target rect. Nothing paints between cancel and animate.
      flipsRef.current.get(name)?.cancel();
      const delta = from - el.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) continue;
      flipsRef.current.set(name, el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], TAG_GLIDE));
    }
    // Tween the list height so the ledger below glides instead of jumping;
    // clip while it runs so ghost rows can't spill over the next section.
    const box = boxRef.current;
    if (!box) return;
    boxAnimRef.current?.cancel();
    const to = box.offsetHeight;
    if (Math.abs(to - snap.height) < 1) return;
    box.style.overflow = "clip";
    const anim = box.animate([{ height: `${snap.height}px` }, { height: `${to}px` }], TAG_GLIDE);
    anim.onfinish = anim.oncancel = () => {
      box.style.overflow = "";
    };
    boxAnimRef.current = anim;
  });

  // The share of the year's memos that carry the tag — the figure a ranking
  // alone can't say.
  const share = (tagCount: number) => (total > 0 ? `${Math.round((tagCount / total) * 100)}%` : "");

  return (
    <div ref={boxRef} className="stats-tags">
      {tags.map(([name, tagCount], index) => (
        <button
          key={name}
          type="button"
          ref={(el) => {
            if (el) rowsRef.current.set(name, el);
            else rowsRef.current.delete(name);
          }}
          className={`stats-tag-row${enteringRef.current.has(name) ? " is-entering" : ""}`}
          style={enteringRef.current.has(name) ? { animationDelay: `${index * 0.02}s` } : undefined}
          aria-label={tr(`Show ${count(tagCount, "memo")} tagged ${name}`, `查看带有 #${name} 的 ${count(tagCount, "memo")}`)}
          onClick={() => onPick(name)}
        >
          <span className="stats-tag-rank" aria-hidden="true">
            {index + 1}
          </span>
          <span className="stats-tag-main">
            <span className="stats-tag-line">
              <span className="stats-tag-name">#{name}</span>
              <span className="stats-tag-count">
                <RollingText value={tagCount} />
                <span className="stats-tag-share">{share(tagCount)}</span>
              </span>
            </span>
            <span className="stats-tag-track">
              <span className="stats-tag-fill" style={{ width: `${(tagCount / max) * 100}%` }} />
            </span>
          </span>
        </button>
      ))}
      {tags.length === 0 ? <p className="stats-tags-empty">{emptyLabel}</p> : null}
      {leaving.map((ghost) => (
        <div
          key={`ghost-${ghost.serial}-${ghost.name}`}
          className="stats-tag-row is-leaving"
          style={{ top: ghost.top }}
          aria-hidden="true"
          onAnimationEnd={() => setLeaving((current) => current.filter((item) => item !== ghost))}
        >
          <span className="stats-tag-rank" />
          <span className="stats-tag-main">
            <span className="stats-tag-line">
              <span className="stats-tag-name">#{ghost.name}</span>
              <span className="stats-tag-count">{formatNumber(ghost.count)}</span>
            </span>
            <span className="stats-tag-track">
              <span className="stats-tag-fill" style={{ width: `${ghost.pct}%` }} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

interface YearData {
  memoCount: number;
  words: number;
  activeDays: number;
  imageCount: number;
  /** Memos with at least one image. */
  imageMemos: number;
  weeks: HeatCell[][];
  monthCounts: number[];
  weekdayCounts: number[];
  hourCounts: number[];
  /** [weekday (Monday first)][hour]. */
  slots: number[][];
  /** The year's longest run of consecutive days with memos. */
  run: DayRun;
}

function buildYearData(memos: Memo[], byDay: Map<string, number>, year: number, now: Date): YearData {
  const monthCounts = Array.from({ length: 12 }, () => 0);
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  const hourCounts = Array.from({ length: 24 }, () => 0);
  const slots = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let words = 0;
  let imageCount = 0;
  let imageMemos = 0;
  let memoCount = 0;

  for (const memo of memos) {
    const created = new Date(memo.createdAt);
    if (created.getFullYear() !== year) continue;
    const weekday = (created.getDay() + 6) % 7;
    memoCount += 1;
    words += wordCountOf(memo);
    imageCount += memo.images.length;
    if (memo.images.length > 0) imageMemos += 1;
    monthCounts[created.getMonth()] += 1;
    weekdayCounts[weekday] += 1;
    hourCounts[created.getHours()] += 1;
    slots[weekday][created.getHours()] += 1;
  }

  const prefix = `${year}-`;
  const yearDays = [...byDay.keys()].filter((key) => key.startsWith(prefix));
  return {
    memoCount,
    words,
    activeDays: yearDays.length,
    imageCount,
    imageMemos,
    weeks: buildHeatWeeks(new Date(year, 0, 1), new Date(year, 11, 31), byDay, now),
    monthCounts,
    weekdayCounts,
    hourCounts,
    slots,
    run: longestRun(yearDays)
  };
}

/** Memos per month of `year`, and how many were written by `cutoff`. */
function monthTally(memos: Memo[], year: number, cutoff: number): { months: number[]; total: number; byCutoff: number } {
  const months = Array.from({ length: 12 }, () => 0);
  let total = 0;
  let byCutoff = 0;
  for (const memo of memos) {
    const created = new Date(memo.createdAt);
    if (created.getFullYear() !== year) continue;
    months[created.getMonth()] += 1;
    total += 1;
    if (created.getTime() <= cutoff) byCutoff += 1;
  }
  return { months, total, byCutoff };
}

/**
 * Deep-dive statistics for one year — its headline figures against the year
 * before, the year as a day strip, its months, its writing rhythm and its
 * tags — then the all-time ledger. Everything is derived client-side from
 * the loaded memos and drills into the feed. Opens from the sidebar figures.
 */
export function StatsModal({ memos, uniqueTagCount, onClose, onDrilldown, closeSignal = 0 }: StatsModalProps) {
  const { count, formatNumber, locale, tr } = useI18n();
  const tip = useTip();
  const now = useMemo(() => new Date(), []);
  const maxYear = now.getFullYear();
  const minYear = useMemo(() => {
    let min = maxYear;
    for (const memo of memos) {
      min = Math.min(min, new Date(memo.createdAt).getFullYear());
    }
    return min;
  }, [memos, maxYear]);

  // The panel opens where it was left this session — the year it showed and
  // how far down it was read — so a drill and a way back is a round trip.
  const [year, setYear] = useState(() => {
    const remembered = recallStatsPlace()?.year;
    return remembered === undefined ? maxYear : Math.min(maxYear, Math.max(minYear, remembered));
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const drilldownRef = useRef(onDrilldown);
  closeRef.current = onClose;
  drilldownRef.current = onDrilldown;

  const [picked, setPicked] = useState<(StatsPick & { section: PickSection }) | null>(null);
  const pickAnchorRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  /** The pointer behind the press a click is about to finish, if any (none: the keyboard). */
  const pressTypeRef = useRef<string | null>(null);

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: pressEscape, initialFocusRef: closeButtonRef });
  const exit = useOverlayExit(overlayRef);
  const closing = exit.closing;
  const backdrop = useBackdropDismiss(requestClose);
  // Back closes the panel with its own exit (see Lightbox's closeSignal).
  useCloseSignal(closeSignal, requestClose);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const scrollTop = recallStatsPlace()?.scrollTop ?? 0;
    if (body && scrollTop > 0) body.scrollTop = scrollTop;
  }, []);

  function leave(callback: () => void) {
    if (exit.closingRef.current) return;
    tip.hide();
    rememberStatsPlace({ year, scrollTop: bodyRef.current?.scrollTop ?? 0 });
    exit.leave(callback);
  }

  function requestClose() {
    leave(() => closeRef.current());
  }

  /** Escape lets go of a touch pick first, then closes. */
  function pressEscape() {
    if (picked) {
      setPicked(null);
      tip.hide();
      return;
    }
    requestClose();
  }

  function requestDrilldown(filter: StatsDrilldown) {
    leave(() => drilldownRef.current(filter));
  }

  /**
   * A mark's activation. A mouse or the keyboard drills at once, as ever. A
   * finger's first tap picks the mark instead, pinning its tip above it; a
   * second tap on it drills.
   */
  function pressIn(section: PickSection): PickPress {
    return (event, pick) => {
      const touch = touchLike(pressTypeRef.current);
      pressTypeRef.current = null;
      if (!touch || picked?.key === pick.key) {
        pick.drill();
        return;
      }
      pickAnchorRef.current = event.currentTarget;
      setPicked({ ...pick, section });
      tip.show(event.currentTarget, pick.tip, { delay: 0 });
    };
  }

  // A pick lasts until the body scrolls or a press lands anywhere but the
  // mark or its pill.
  useEffect(() => {
    if (!picked) return;
    const body = bodyRef.current;
    const clear = () => setPicked(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (pickAnchorRef.current?.contains(target) || pillRef.current?.contains(target))) return;
      clear();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    body?.addEventListener("scroll", clear, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      body?.removeEventListener("scroll", clear);
    };
  }, [picked]);

  /** The picked mark's way in, in its section's head where the key or note sits. */
  function pickPill(section: PickSection) {
    if (!picked || picked.section !== section) return null;
    const pick = picked;
    return (
      <button
        ref={pillRef}
        type="button"
        className="stats-pick-pill"
        aria-label={tr(`Show ${count(pick.count, "memo")} from ${pick.place}`, `查看 ${pick.place}的 ${count(pick.count, "memo")}`)}
        onClick={() => pick.drill()}
      >
        {tr(`Show ${count(pick.count, "memo")}`, `查看 ${formatNumber(pick.count)} 条`)}
        <span aria-hidden="true"> ›</span>
      </button>
    );
  }

  const byDay = useMemo(() => countsByDay(memos), [memos]);
  const yearData = useMemo(() => buildYearData(memos, byDay, year, now), [memos, byDay, year, now]);
  // The year before, for the comparison: in full for a past year; for the
  // current one, up to this date a year ago, so a part year meets a part year.
  const before = useMemo(() => {
    const cutoff = year === maxYear ? new Date(year - 1, now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime() : Infinity;
    return monthTally(memos, year - 1, cutoff);
  }, [memos, year, maxYear, now]);

  const totals = useMemo(() => totalStats(memos, now), [memos, now]);
  const streaks = useMemo(() => computeStreaks(byDay, now), [byDay, now]);
  const allWords = useMemo(() => memos.reduce((sum, memo) => sum + wordCountOf(memo), 0), [memos]);
  const allImages = useMemo(() => memos.reduce((sum, memo) => sum + memo.images.length, 0), [memos]);
  const longDays = useMemo(() => weekdayNames(locale, "long"), [locale]);
  const monthFormatter = useMemo(() => dateFormat(locale, { month: "short" }), [locale]);
  const dayFormatter = useMemo(() => dateFormat(locale, { year: "numeric", month: "short", day: "numeric" }), [locale]);
  const spanFormatter = useMemo(() => dateFormat(locale, { month: "short", day: "numeric" }), [locale]);

  // Top tags of the selected year — the one categorical stat in the panel.
  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const memo of memos) {
      if (new Date(memo.createdAt).getFullYear() !== year) continue;
      for (const tag of tagsOf(memo)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  }, [memos, year]);

  const busiestDay = useMemo(() => {
    let best: { key: string; count: number } | null = null;
    for (const [key, dayCount] of byDay) {
      if (!best || dayCount > best.count || (dayCount === best.count && key > best.key)) best = { key, count: dayCount };
    }
    return best;
  }, [byDay]);

  // ---- The year's headline, said in words first. ----
  const { memoCount, activeDays, words, imageCount, imageMemos, run } = yearData;
  // Rounded to one decimal; the trailing .0 is dropped so integers stay short.
  const perActiveDay = activeDays > 0 ? Math.round((memoCount / activeDays) * 10) / 10 : 0;
  const lastYear = year - 1;
  // Against the year before, in words: the figure already says "memos".
  // Null when there is nothing to compare: an empty first year says only
  // that nothing is written yet (the pace line below).
  let delta: string | null;
  if (before.total > 0) {
    const gap = memoCount - before.byCutoff;
    const amount = formatNumber(Math.abs(gap));
    if (year === maxYear && before.byCutoff === 0) {
      // Last year began later than today's date: "87 more than this time
      // last year" is true but says nothing, and "level" at 0 and 0 less.
      delta = tr("Nothing by this date last year", "去年此时还没有笔记");
    } else if (year === maxYear) {
      delta =
        gap > 0
          ? tr(`${amount} more than this time last year`, `比去年同期多 ${amount} 条`)
          : gap < 0
            ? tr(`${amount} fewer than this time last year`, `比去年同期少 ${amount} 条`)
            : tr("Level with this time last year", "与去年同期持平");
    } else {
      delta =
        gap > 0
          ? tr(`${amount} more than ${lastYear}`, `比 ${lastYear} 年多 ${amount} 条`)
          : gap < 0
            ? tr(`${amount} fewer than ${lastYear}`, `比 ${lastYear} 年少 ${amount} 条`)
            : tr(`Level with ${lastYear}`, `与 ${lastYear} 年持平`);
    }
  } else {
    delta =
      lastYear >= minYear
        ? tr(`Nothing written in ${lastYear}`, `${lastYear} 年没有笔记`)
        : memoCount > 0
          ? tr("Your first year of memos", "记录的第一年")
          : null;
  }
  const pace = memoCount > 0 ? tr(`${formatNumber(perActiveDay)} per active day`, `活跃日均 ${formatNumber(perActiveDay)} 条`) : tr("Nothing written this year", "这一年还没有笔记");

  const elapsed = year === maxYear ? daysBetweenInclusive(new Date(year, 0, 1), now) : daysBetweenInclusive(new Date(year, 0, 1), new Date(year, 11, 31));
  const coverage = activeDays > 0 ? Math.max(1, Math.round((activeDays / elapsed) * 100)) : 0;
  const runSpan =
    run.start && run.end ? (run.start === run.end ? spanFormatter.format(parseDayKey(run.start)) : spanFormatter.formatRange(parseDayKey(run.start), parseDayKey(run.end))) : "";
  const kpis: { label: string; value: number; unit?: string; sub: string }[] = [
    {
      label: tr("Active days", "活跃天数"),
      value: activeDays,
      sub: activeDays > 0 ? (year === maxYear ? tr(`${coverage}% of days so far`, `占今年已过天数 ${coverage}%`) : tr(`${coverage}% of the year`, `占全年 ${coverage}%`)) : ""
    },
    { label: tr("Longest streak", "最长连击"), value: run.length, unit: tr(run.length === 1 ? " day" : " days", " 天"), sub: runSpan },
    {
      label: tr("Characters", "字数"),
      value: words,
      sub: memoCount > 0 ? tr(`${formatNumber(Math.round(words / memoCount))} per memo`, `平均每条 ${formatNumber(Math.round(words / memoCount))} 字`) : ""
    },
    {
      label: tr("Images", "图片"),
      value: imageCount,
      sub: imageMemos > 0 ? tr(`in ${count(imageMemos, "memo")}`, `来自 ${count(imageMemos, "memo")}`) : ""
    }
  ];

  const peakWeekday = argMax(yearData.weekdayCounts);
  const peakHour = argMax(yearData.hourCounts);
  const rhythmNote =
    memoCount > 0
      ? tr(
          `Most often on ${longDays[peakWeekday]}, ${formatHourRange(peakHour, locale)}`,
          `最常在${longDays[peakWeekday]} · ${formatHourRange(peakHour, locale)}`
        )
      : "";

  const facts: { label: string; value: number; suffix?: string; wide?: boolean }[] = [
    { label: tr("Total memos", "总笔记"), value: totals.memoCount },
    { label: tr("Total characters", "总字数"), value: allWords },
    { label: tr("Images", "图片"), value: allImages },
    { label: tr("Tags", "标签"), value: uniqueTagCount },
    { label: tr("Active days", "活跃天数"), value: totals.activeDays },
    // The calendar span since the first memo — a duration, so it wears its unit.
    { label: tr("Since first memo", "距首条笔记"), value: totals.daySpan, suffix: tr(totals.daySpan === 1 ? " day" : " days", " 天") },
    { label: tr("Longest streak", "最长连击"), value: streaks.longest, suffix: tr(streaks.longest === 1 ? " day" : " days", " 天") },
    { label: tr("Current streak", "当前连击"), value: streaks.current, suffix: tr(streaks.current === 1 ? " day" : " days", " 天") }
  ];
  if (busiestDay) {
    facts.push({
      label: tr("Busiest day", "单日最多"),
      value: busiestDay.count,
      suffix: `${tr(busiestDay.count === 1 ? " memo · " : " memos · ", " 条 · ")}${dayFormatter.format(parseDayKey(busiestDay.key))}`,
      // Long value (count + date), so it closes the ledger on its own line.
      wide: true
    });
  }

  return (
    <div
      ref={overlayRef}
      className={`overlay stats-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Detailed statistics", "详细统计")}
      tabIndex={-1}
      {...backdrop}
    >
      <div
        className="stats-modal"
        onClick={(event) => event.stopPropagation()}
        onPointerDownCapture={(event) => {
          pressTypeRef.current = event.pointerType;
        }}
        onKeyDownCapture={() => {
          pressTypeRef.current = null;
        }}
      >
        <header className="stats-head">
          <h2>{tr("Statistics", "统计")}</h2>
          <div className="stats-year-nav">
            <button
              type="button"
              className="icon-button"
              onClick={() => setYear((value) => value - 1)}
              disabled={closing || year <= minYear}
              aria-label={tr("Previous year", "上一年")}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span className="stats-year">
              {/* Keyed by locale: zh appends 年, which must not roll against digits. */}
              <RollingText key={locale} value={year} text={formatYear(year, locale)} />
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => setYear((value) => value + 1)}
              disabled={closing || year >= maxYear}
              aria-label={tr("Next year", "下一年")}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button stats-close" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div ref={bodyRef} className="stats-body scroll-edges">
          {/* Tier 1: the year's figure in display type with its comparison
              in words, beside four supporting figures on hairlines. */}
          <section className="stats-section stats-overview">
            <div className="stats-hero">
              <button
                type="button"
                className="stats-hero-main"
                disabled={memoCount === 0}
                aria-label={tr(`Show ${count(memoCount, "memo")} from ${year}`, `查看 ${year} 年的 ${count(memoCount, "memo")}`)}
                onClick={() => requestDrilldown({ kind: "year", year })}
              >
                <span className="stats-hero-value">
                  <RollingText value={memoCount} />
                </span>
                <span className="stats-hero-unit">{tr(memoCount === 1 ? "memo" : "memos", "条笔记")}</span>
                {memoCount > 0 ? <ChevronRight size={19} className="stats-drill-cue" aria-hidden="true" /> : null}
              </button>
              <p className="stats-hero-note">
                {delta ? (
                  <span key={delta} className="stats-swap">
                    {delta}
                  </span>
                ) : null}
                <span key={pace} className="stats-swap">
                  {pace}
                </span>
              </p>
            </div>
            <dl className="stats-kpis">
              {kpis.map((kpi) => (
                <div key={kpi.label} className="stats-kpi">
                  <dt className="stats-kpi-label">{kpi.label}</dt>
                  <dd className="stats-kpi-value">
                    <RollingText value={kpi.value} />
                    {kpi.unit ? <span className="stats-kpi-unit">{kpi.unit}</span> : null}
                  </dd>
                  <dd className="stats-kpi-sub">
                    <span key={kpi.sub} className="stats-swap">
                      {kpi.sub || " "}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="stats-section" style={{ animationDelay: "0.03s" }}>
            <div className="stats-section-head">
              <h3 className="stats-section-title">{tr("Daily activity", "每日活跃")}</h3>
              {/* The scale, built from the strip's own cell classes so it
                  recolours with them. The swatches are decoration; a screen
                  reader gets the sentence instead. A touch pick's pill takes
                  its place while a day is picked. */}
              {pickPill("days") ?? (
                <div className="heat-legend">
                  <span className="heat-legend-sr">
                    {tr("Shade shows memos per day, from 1 to 5 or more.", "颜色深浅表示每天的笔记数，从 1 条到 5 条或更多。")}
                  </span>
                  <span aria-hidden="true">{tr("Less", "少")}</span>
                  <span className="heat-legend-cells" aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((level) => (
                      <span key={level} className={`year-cell level-${level}`} />
                    ))}
                  </span>
                  <span aria-hidden="true">{tr("More", "多")}</span>
                </div>
              )}
            </div>
            <YearStrip
              year={year}
              weeks={yearData.weeks}
              monthCounts={yearData.monthCounts}
              onPickDay={(day) => requestDrilldown({ kind: "day", day })}
              onPickMonth={(month) => requestDrilldown({ kind: "month", year, month })}
              picked={picked?.section === "days" ? picked.key : null}
              onPress={pressIn("days")}
            />
          </section>

          <section className="stats-section" style={{ animationDelay: "0.06s" }}>
            <div className="stats-section-head">
              <h3 className="stats-section-title">{tr("Memos by month", "每月笔记")}</h3>
              {pickPill("months") ?? (
                <div className={`stats-series-key${before.total > 0 ? "" : " is-hidden"}`} aria-hidden="true">
                  <span className="stats-series">
                    <span className="stats-series-bar" />
                    {year}
                  </span>
                  <span className="stats-series">
                    <span className="stats-series-tick" />
                    {lastYear}
                  </span>
                </div>
              )}
            </div>
            <BarChart
              label={tr("Memos by month", "每月笔记")}
              values={yearData.monthCounts}
              labels={yearData.monthCounts.map((_, month) => monthFormatter.format(new Date(year, month, 1)))}
              tips={yearData.monthCounts.map((_, month) => formatMonthYear(year, month, locale))}
              compare={{ name: formatYear(lastYear, locale), values: before.months, shown: before.total > 0 }}
              future={yearData.monthCounts.map((monthCount, month) => year === maxYear && month > now.getMonth() && monthCount === 0)}
              onPick={(month) => requestDrilldown({ kind: "month", year, month })}
              picked={picked?.section === "months" ? picked.key : null}
              onPress={pressIn("months")}
            />
          </section>

          <section className="stats-section" style={{ animationDelay: "0.09s" }}>
            <div className="stats-section-head">
              <h3 className="stats-section-title">{tr("Writing rhythm", "写作节奏")}</h3>
              {pickPill("rhythm") ?? (
                <p className="stats-section-note">
                  <span key={rhythmNote} className="stats-swap">
                    {rhythmNote}
                  </span>
                </p>
              )}
            </div>
            <RhythmChart
              slots={yearData.slots}
              weekdayCounts={yearData.weekdayCounts}
              hourCounts={yearData.hourCounts}
              onPickWeekday={(weekday) => requestDrilldown({ kind: "weekday", year, weekday })}
              onPickHour={(hour) => requestDrilldown({ kind: "hour", year, hour })}
              onPickSlot={(weekday, hour) => requestDrilldown({ kind: "slot", year, weekday, hour })}
              picked={picked?.section === "rhythm" ? picked.key : null}
              onPress={pressIn("rhythm")}
            />
          </section>

          <div className={`stats-pair${uniqueTagCount > 0 ? "" : " is-single"}`}>
            {uniqueTagCount > 0 ? (
              <section className="stats-section" style={{ animationDelay: "0.12s" }}>
                <h3 className="stats-section-title">{tr("Top tags", "常用标签")}</h3>
                {/* Kept mounted across tagless years (the empty note takes the
                    rows' place), so the section never pops in or out. */}
                <TagRows
                  tags={topTags}
                  total={memoCount}
                  emptyLabel={tr("No tags this year", "这一年还没有用过标签")}
                  onPick={(tag) => requestDrilldown({ kind: "tag", year, tag })}
                />
              </section>
            ) : null}

            <section className="stats-section" style={{ animationDelay: "0.12s" }}>
              <h3 className="stats-section-title">{tr("All time", "全部时间")}</h3>
              <div className="stats-facts">
                {facts.map((fact) => (
                  <div key={fact.label} className={`stats-fact${fact.wide ? " is-wide" : ""}`}>
                    <span className="stats-fact-label">{fact.label}</span>
                    <span className="stats-fact-value">
                      <RollingText value={fact.value} />
                      {fact.suffix ? <span className="stats-fact-sub">{fact.suffix}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
