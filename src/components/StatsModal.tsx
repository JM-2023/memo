import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { dateKey, formatDayLabel, formatMonthYear, formatYear, weekdayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { buildHeatMonth, computeStreaks, countsByDay, totalStats, wordCountOf, type HeatMonth } from "../lib/stats";
import type { Memo } from "../lib/types";
import { RollingText } from "./RollingText";
import { useTip } from "./Tip";

interface StatsModalProps {
  memos: Memo[];
  uniqueTagCount: number;
  onClose: () => void;
}

interface BarChartProps {
  values: number[];
  max: number;
  labels: string[];
  tips: string[];
}

/** Baseline-anchored bars that rise in with a slight stagger. Info-only. */
function BarChart({ values, max, labels, tips }: BarChartProps) {
  const { count } = useI18n();
  const tip = useTip();
  return (
    <div className="bar-chart">
      <div className="stats-bars">
        {values.map((value, index) => (
          <div
            key={index}
            className="stats-bar-col"
            role="img"
            tabIndex={0}
            aria-label={`${tips[index]}, ${count(value, "memo")}`}
            onMouseEnter={(event) => tip.show(event.currentTarget, { strong: count(value, "memo"), text: tips[index] })}
            onMouseLeave={tip.hide}
            onFocus={(event) => tip.show(event.currentTarget, { strong: count(value, "memo"), text: tips[index] })}
            onBlur={tip.hide}
          >
            <span
              className={`stats-bar${value > 0 ? "" : " is-zero"}`}
              style={{ height: value > 0 ? `${(value / max) * 100}%` : "4px", animationDelay: `${index * 0.025}s` }}
            />
          </div>
        ))}
      </div>
      <div className="stats-bar-labels">
        {labels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function weekdayNames(locale: string, width: "long" | "narrow"): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: width });
  const monday = new Date(2026, 0, 5);
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 0, monday.getDate() + index)));
}

function formatHour(hour: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2026, 0, 5, hour));
}

function formatHourRange(hour: number, locale: string): string {
  return `${formatHour(hour, locale)} – ${formatHour(hour + 1, locale)}`;
}

interface YearData {
  memoCount: number;
  words: number;
  activeDays: number;
  imageCount: number;
  months: { month: number; count: number; heat: HeatMonth }[];
  monthMax: number;
  weekdayCounts: number[];
  weekdayMax: number;
  hourCounts: number[];
  hourMax: number;
}

function buildYearData(memos: Memo[], byDay: Map<string, number>, year: number, now: Date): YearData {
  const monthCounts = Array.from({ length: 12 }, () => 0);
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  const hourCounts = Array.from({ length: 24 }, () => 0);
  const days = new Set<string>();
  let words = 0;
  let imageCount = 0;
  let memoCount = 0;

  for (const memo of memos) {
    const created = new Date(memo.createdAt);
    if (created.getFullYear() !== year) continue;
    memoCount += 1;
    words += wordCountOf(memo);
    imageCount += memo.images.length;
    monthCounts[created.getMonth()] += 1;
    weekdayCounts[(created.getDay() + 6) % 7] += 1;
    hourCounts[created.getHours()] += 1;
    days.add(dateKey(created));
  }

  return {
    memoCount,
    words,
    activeDays: days.size,
    imageCount,
    months: monthCounts.map((count, month) => ({ month, count, heat: buildHeatMonth(year, month, byDay, now) })),
    monthMax: Math.max(1, ...monthCounts),
    weekdayCounts,
    weekdayMax: Math.max(1, ...weekdayCounts),
    hourCounts,
    hourMax: Math.max(1, ...hourCounts)
  };
}

/**
 * Deep-dive statistics: a year of mini heatmaps plus distribution charts,
 * all derived client-side from the already-loaded memos. Opens from the
 * sidebar stat tiles.
 */
export function StatsModal({ memos, uniqueTagCount, onClose }: StatsModalProps) {
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

  const [year, setYear] = useState(maxYear);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function requestClose() {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => closeRef.current(), 240);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byDay = useMemo(() => countsByDay(memos), [memos]);
  const yearData = useMemo(() => buildYearData(memos, byDay, year, now), [memos, byDay, year, now]);
  const totals = useMemo(() => totalStats(memos, now), [memos, now]);
  const streaks = useMemo(() => computeStreaks(byDay, now), [byDay, now]);
  const allWords = useMemo(() => memos.reduce((sum, memo) => sum + wordCountOf(memo), 0), [memos]);
  const allImages = useMemo(() => memos.reduce((sum, memo) => sum + memo.images.length, 0), [memos]);
  const weekdaysFull = useMemo(() => weekdayNames(locale, "long"), [locale]);
  const weekdaysNarrow = useMemo(() => weekdayNames(locale, "narrow"), [locale]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);

  const yearTiles = [
    { label: tr("Memos", "笔记"), value: yearData.memoCount },
    { label: tr("Characters", "字数"), value: yearData.words },
    { label: tr("Active days", "活跃天数"), value: yearData.activeDays },
    { label: tr("Images", "图片"), value: yearData.imageCount }
  ];
  const allTiles = [
    { label: tr("Total memos", "总笔记"), value: totals.memoCount },
    { label: tr("Total characters", "总字数"), value: allWords },
    { label: tr("Days recorded", "记录天数"), value: totals.daySpan },
    { label: tr("Active days", "活跃天数"), value: totals.activeDays },
    { label: tr("Longest streak", "最长连击"), value: streaks.longest },
    { label: tr("Current streak", "当前连击"), value: streaks.current },
    { label: tr("Images", "图片"), value: allImages },
    { label: tr("Tags", "标签"), value: uniqueTagCount }
  ];

  return (
    <div
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Detailed statistics", "详细统计")}
      onClick={requestClose}
    >
      <div className="stats-modal" onClick={(event) => event.stopPropagation()}>
        <header className="stats-head">
          <h2>{tr("Statistics", "统计")}</h2>
          <div className="stats-year-nav">
            <button
              type="button"
              className="icon-button"
              onClick={() => setYear((value) => value - 1)}
              disabled={year <= minYear}
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
              disabled={year >= maxYear}
              aria-label={tr("Next year", "下一年")}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          <button type="button" className="icon-button stats-close" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="stats-body">
          <div className="stat-tiles">
            {yearTiles.map((tile, index) => (
              <div key={tile.label} className="stat-tile" style={{ animationDelay: `${index * 0.04}s` }}>
                <span className="stat-tile-value">
                  <RollingText value={tile.value} />
                </span>
                <span className="stat-tile-label">{tile.label}</span>
              </div>
            ))}
          </div>

          <h3 className="stats-section-title">{tr("Monthly heatmaps", "每月热力图")}</h3>
          <div className="months-grid">
            {yearData.months.map(({ month, count: memoCount, heat }) => (
              <div key={month} className="mini-month" style={{ animationDelay: `${month * 0.03}s` }}>
                <div className="mini-month-head">
                  <span className="mini-month-name">{monthFormatter.format(new Date(year, month, 1))}</span>
                  <span className="mini-month-count">
                    <RollingText value={memoCount} />
                  </span>
                </div>
                <div className="mini-grid">
                  {/* Cells keyed by grid position, not date — switching years
                      mutates them in place so the colours crossfade. */}
                  {heat.weeks.map((week, weekIndex) =>
                    week.map((cell, dayIndex) =>
                      cell.inRange && !cell.isFuture ? (
                        <span
                          key={`${weekIndex}-${dayIndex}`}
                          className={`mini-cell level-${cell.level}${cell.isToday ? " is-today" : ""}`}
                          role="img"
                          tabIndex={0}
                          aria-label={tr(
                            `${formatDayLabel(cell.key, locale)}, ${count(cell.count, "memo")}`,
                            `${formatDayLabel(cell.key, locale)}，${count(cell.count, "memo")}`
                          )}
                          onMouseEnter={(event) =>
                            tip.show(event.currentTarget, {
                              strong: count(cell.count, "memo"),
                              text: `${formatDayLabel(cell.key, locale)} ${weekdayLabel(cell.key, locale)}`
                            })
                          }
                          onMouseLeave={tip.hide}
                          onFocus={(event) =>
                            tip.show(event.currentTarget, {
                              strong: count(cell.count, "memo"),
                              text: `${formatDayLabel(cell.key, locale)} ${weekdayLabel(cell.key, locale)}`
                            })
                          }
                          onBlur={tip.hide}
                        />
                      ) : (
                        <span
                          key={`${weekIndex}-${dayIndex}`}
                          className={`mini-cell placeholder${cell.inRange ? " future" : ""}`}
                          aria-hidden="true"
                        />
                      )
                    )
                  )}
                </div>
              </div>
            ))}
          </div>

          <h3 className="stats-section-title">{tr("Memos by month", "每月笔记")}</h3>
          <BarChart
            values={yearData.months.map(({ count }) => count)}
            max={yearData.monthMax}
            labels={yearData.months.map(({ month }) => monthFormatter.format(new Date(year, month, 1)))}
            tips={yearData.months.map(({ month }) => formatMonthYear(year, month, locale))}
          />

          <div className="stats-chart-row">
            <div className="stats-chart">
              <h3 className="stats-section-title">{tr("Distribution by weekday", "星期分布")}</h3>
              <BarChart
                values={yearData.weekdayCounts}
                max={yearData.weekdayMax}
                labels={weekdaysNarrow}
                tips={weekdaysFull}
              />
            </div>
            <div className="stats-chart">
              <h3 className="stats-section-title">{tr("Distribution by time", "时段分布")}</h3>
              <BarChart
                values={yearData.hourCounts}
                max={yearData.hourMax}
                labels={yearData.hourCounts.map((_, index) => (index % 6 === 0 ? formatHour(index, locale) : ""))}
                tips={yearData.hourCounts.map((_, index) => formatHourRange(index, locale))}
              />
            </div>
          </div>

          <h3 className="stats-section-title">{tr("All time", "全部时间")}</h3>
          <div className="stat-tiles all-time">
            {allTiles.map((tile, index) => (
              <div key={tile.label} className="stat-tile" style={{ animationDelay: `${index * 0.03}s` }}>
                <span className="stat-tile-value">
                  <RollingText value={tile.value} />
                </span>
                <span className="stat-tile-label">{tile.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
