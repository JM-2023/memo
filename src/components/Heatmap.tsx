import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDayLabel, weekdayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { buildHeatMonth } from "../lib/stats";
import { useTip } from "./Tip";

interface HeatmapProps {
  countsByDay: Map<string, number>;
  /** "YYYY-MM" of the earliest memo; navigation stops there. */
  minMonth: string | null;
  activeDay: string | null;
  onPickDay: (key: string | null) => void;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * GitHub-style per-month heat grid — week columns × Mon–Sun rows — scaled to
 * fill the sidebar. Cells stay square via aspect-ratio; the weekday labels
 * live in the grid's first column so they always align with the rows.
 * Clicking a day toggles a day filter on the memo feed; ‹ › pages months.
 * Day details ride the shared portal tooltip, so they can never be covered
 * by neighbouring cells.
 */
export function Heatmap({ countsByDay, minMonth, activeDay, onPickDay }: HeatmapProps) {
  const { count, locale, tr } = useI18n();
  const tip = useTip();
  const now = new Date();
  const [view, setView] = useState({ year: now.getFullYear(), month: now.getMonth() });
  // Drives the slide-in animation; the key encodes direction so re-renders
  // replay the correct one.
  const [transition, setTransition] = useState({ serial: 0, direction: 0 });

  const currentKey = monthKey(now.getFullYear(), now.getMonth());
  const viewKey = monthKey(view.year, view.month);
  const canForward = viewKey < currentKey;
  const canBack = minMonth !== null ? viewKey > minMonth : false;

  const heat = useMemo(() => buildHeatMonth(view.year, view.month, countsByDay, now), [view, countsByDay]); // eslint-disable-line react-hooks/exhaustive-deps
  const monthTotal = useMemo(() => heat.weeks.flat().reduce((sum, cell) => sum + (cell.inMonth ? cell.count : 0), 0), [heat]);
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(view.year, view.month, 1)),
    [locale, view.year, view.month]
  );
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    const monday = new Date(2026, 0, 5);
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 0, monday.getDate() + index)));
  }, [locale]);

  function shift(delta: number) {
    tip.hide();
    setView((value) => {
      const date = new Date(value.year, value.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
    setTransition((value) => ({ serial: value.serial + 1, direction: delta }));
  }

  return (
    <div className="heatmap">
      <div className="heatmap-head">
        <button
          type="button"
          className="icon-button heatmap-nav"
          onClick={() => shift(-1)}
          disabled={!canBack}
          aria-label={tr("Previous month", "上一月")}
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="heatmap-title"
          onClick={() => {
            if (viewKey === currentKey) return;
            tip.hide();
            setView({ year: now.getFullYear(), month: now.getMonth() });
            setTransition((value) => ({ serial: value.serial + 1, direction: viewKey < currentKey ? 1 : -1 }));
          }}
          onMouseEnter={(event) => {
            if (viewKey !== currentKey) tip.show(event.currentTarget, { text: tr("Return to this month", "回到本月") });
          }}
          onMouseLeave={tip.hide}
        >
          {monthLabel}
          <span className="heatmap-total">{count(monthTotal, "memo")}</span>
        </button>
        <button
          type="button"
          className="icon-button heatmap-nav"
          onClick={() => shift(1)}
          disabled={!canForward}
          aria-label={tr("Next month", "下一月")}
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>

      <div
        key={transition.serial}
        className={`heatmap-grid${transition.direction > 0 ? " slide-left" : transition.direction < 0 ? " slide-right" : ""}`}
        style={{ gridTemplateColumns: `14px repeat(${heat.weeks.length}, 1fr)` }}
      >
        {weekdayLabels.map((label, index) => (
          <span key={`${label}-${index}`} className="heat-weekday" aria-hidden="true">
            {label}
          </span>
        ))}
        {heat.weeks.map((week) =>
          week.map((cell) =>
            cell.inMonth && !cell.isFuture ? (
              <button
                key={cell.key}
                type="button"
                className={`heat-cell level-${cell.level}${cell.isToday ? " is-today" : ""}${activeDay === cell.key ? " is-active" : ""}`}
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
                onClick={() => onPickDay(activeDay === cell.key ? null : cell.key)}
              />
            ) : (
              <span key={cell.key} className={`heat-cell placeholder${cell.inMonth ? " future" : ""}`} aria-hidden="true" />
            )
          )
        )}
      </div>
    </div>
  );
}
