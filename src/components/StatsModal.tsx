import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { dateKey, formatDayLabel, formatMonthYear, formatYear, weekdayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { buildHeatMonth, computeStreaks, countsByDay, totalStats, wordCountOf, type HeatMonth } from "../lib/stats";
import { tagsOf } from "../lib/tags";
import type { Memo } from "../lib/types";
import { RollingText } from "./RollingText";
import { SwapText } from "./SwapText";
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

/* Local-midnight parse: `new Date("2026-03-05")` lands on UTC midnight, which
   shifts a day backwards in negative-offset timezones. */
function parseDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
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
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }), [locale]);

  // Top tags of the selected year — the one categorical stat in the modal.
  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const memo of memos) {
      if (new Date(memo.createdAt).getFullYear() !== year) continue;
      for (const tag of tagsOf(memo)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  }, [memos, year]);
  const tagMax = topTags[0]?.[1] ?? 1;

  const busiestDay = useMemo(() => {
    let best: { key: string; count: number } | null = null;
    for (const [key, dayCount] of byDay) {
      if (!best || dayCount > best.count || (dayCount === best.count && key > best.key)) best = { key, count: dayCount };
    }
    return best;
  }, [byDay]);

  // Rounded to one decimal; the trailing .0 is dropped so integers stay short.
  const perActiveDay = yearData.activeDays > 0 ? Math.round((yearData.memoCount / yearData.activeDays) * 10) / 10 : 0;

  const facts: { label: string; value: number; suffix?: string; wide?: boolean }[] = [
    { label: tr("Total memos", "总笔记"), value: totals.memoCount },
    { label: tr("Total characters", "总字数"), value: allWords },
    { label: tr("Images", "图片"), value: allImages },
    { label: tr("Tags", "标签"), value: uniqueTagCount },
    { label: tr("Days recorded", "记录天数"), value: totals.daySpan },
    { label: tr("Active days", "活跃天数"), value: totals.activeDays },
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
          {/* Hierarchy: one hero figure, its supporting figures in a muted
              line, then progressively quieter sections — no two tiers share
              a treatment, and nothing wears a card frame. */}
          <section className="stats-section stats-hero">
            <div className="stats-hero-main">
              <span className="stats-hero-value">
                <RollingText value={yearData.memoCount} />
              </span>
              <span className="stats-hero-unit">{tr(yearData.memoCount === 1 ? "memo" : "memos", "条笔记")}</span>
            </div>
            <div className="stats-hero-figs">
              <span className="stats-fig">
                {tr("", "活跃 ")}
                <RollingText value={yearData.activeDays} />
                {tr(yearData.activeDays === 1 ? " active day" : " active days", " 天")}
              </span>
              <span className="stats-fig">
                {tr("", "日均 ")}
                <RollingText value={perActiveDay} text={String(perActiveDay)} />
                {tr(" per active day", " 条")}
              </span>
              <span className="stats-fig">
                <RollingText value={yearData.words} />
                {tr(" characters", " 字")}
              </span>
              <span className="stats-fig">
                <RollingText value={yearData.imageCount} />
                {tr(yearData.imageCount === 1 ? " image" : " images", " 张图片")}
              </span>
            </div>
          </section>

          <section className="stats-section" style={{ animationDelay: "0.06s" }}>
            <h3 className="stats-section-title">{tr("Daily activity", "每日活跃")}</h3>
            <div className="months-grid">
              {yearData.months.map(({ month, count: memoCount, heat }) => (
                <div key={month} className="mini-month">
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
          </section>

          <section className="stats-section" style={{ animationDelay: "0.12s" }}>
            <h3 className="stats-section-title">{tr("Memos by month", "每月笔记")}</h3>
            <BarChart
              values={yearData.months.map(({ count }) => count)}
              max={yearData.monthMax}
              labels={yearData.months.map(({ month }) => monthFormatter.format(new Date(year, month, 1)))}
              tips={yearData.months.map(({ month }) => formatMonthYear(year, month, locale))}
            />
          </section>

          <section className="stats-section stats-chart-row" style={{ animationDelay: "0.18s" }}>
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
          </section>

          {topTags.length > 0 ? (
            <section className="stats-section" style={{ animationDelay: "0.24s" }}>
              <h3 className="stats-section-title">{tr("Top tags", "常用标签")}</h3>
              <div className="stats-tags">
                {/* Rows keyed by rank: switching years keeps the five slots,
                    so names crossfade, bars glide and counts roll in place. */}
                {topTags.map(([name, tagCount], index) => (
                  <div key={index} className="stats-tag-row">
                    <SwapText id={name} className="stats-tag-swap">
                      <span className="stats-tag-name">#{name}</span>
                    </SwapText>
                    <span className="stats-tag-track">
                      <span className="stats-tag-fill" style={{ width: `${(tagCount / tagMax) * 100}%` }} />
                    </span>
                    <span className="stats-tag-count">
                      <RollingText value={tagCount} />
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="stats-section" style={{ animationDelay: topTags.length > 0 ? "0.3s" : "0.24s" }}>
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
  );
}
