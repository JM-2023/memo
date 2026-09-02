import { Bookmark, BookmarkPlus, Check, Image, Link2, ListFilter, ListTodo, Tags, X, type LucideIcon } from "lucide-react";
import { addDays, dateKey } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import type { SavedFilter } from "../lib/savedFilters";
import type { FacetKey, FeedFilters } from "../lib/search";
import { Menu } from "./Menu";
import { useTip } from "./Tip";

/** One row per structured facet — shared with App's breadcrumb chips so the
    panel rows and the chips always speak the same labels. */
export const FACET_ROWS: { key: FacetKey; icon: LucideIcon; en: string; zh: string }[] = [
  { key: "noTags", icon: Tags, en: "No tags", zh: "无标签" },
  { key: "hasImage", icon: Image, en: "With images", zh: "含图片" },
  { key: "hasLink", icon: Link2, en: "With links", zh: "含链接" },
  { key: "hasOpenTask", icon: ListTodo, en: "With open tasks", zh: "含未完成任务" }
];

interface RangePreset {
  key: string;
  en: string;
  zh: string;
  from: string;
  to: string;
}

/** The notebook's usual asks, one tap each; all end today (local days). */
function rangePresets(now = new Date()): RangePreset[] {
  const to = dateKey(now);
  return [
    { key: "week", en: "Last 7 days", zh: "最近 7 天", from: dateKey(addDays(now, -6)), to },
    { key: "month30", en: "Last 30 days", zh: "最近 30 天", from: dateKey(addDays(now, -29)), to },
    { key: "month", en: "This month", zh: "本月", from: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)), to },
    { key: "year", en: "This year", zh: "今年", from: dateKey(new Date(now.getFullYear(), 0, 1)), to }
  ];
}

interface SearchFilterProps {
  filters: FeedFilters;
  saved: SavedFilter[];
  /** Saved preset matching the live feed state exactly, if any. */
  activeSavedId: string | null;
  /** True while anything (search, tag, day, filters) is worth saving. */
  canSave: boolean;
  disabled: boolean;
  /** The tag lens, if any: "No tags" can only ever be empty inside one. */
  activeTag?: string | null;
  /** Bump to open the panel from outside (a chip's edit half). */
  openRequest?: number;
  onToggleFacet: (key: FacetKey) => void;
  onDateChange: (patch: Partial<Pick<FeedFilters, "dateFrom" | "dateTo">>) => void;
  /** A whole range at once (quick-range chips): one morph, not two edits. */
  onPresetRange?: (from: string, to: string) => void;
  onClearDates: () => void;
  onApplySaved: (item: SavedFilter) => void;
  onDeleteSaved: (item: SavedFilter) => void;
  onSaveCurrent: () => void;
}

/**
 * The searchbox's companion: a funnel button opening a small panel with the
 * structured filters (facet toggles, date range) and saved presets. Facet
 * and date edits apply live — the panel stays open so several filters can be
 * stacked in one visit; applying a preset or saving closes it, since both
 * hand the stage back to the feed.
 */
export function SearchFilter(props: SearchFilterProps) {
  const { tr } = useI18n();
  const tip = useTip();
  const { filters } = props;
  const rangeOn = filters.dateFrom !== null || filters.dateTo !== null;
  const isActive = rangeOn || FACET_ROWS.some((row) => filters[row.key]);
  const showSaved = props.saved.length > 0 || props.canSave;
  const activeTag = props.activeTag ?? null;
  const presets = rangePresets();

  return (
    <Menu
      kind="panel"
      align="right"
      className="filter-root"
      panelClassName="filter-panel"
      panelLabel={tr("Search filters", "搜索筛选")}
      openSignal={props.openRequest}
      trigger={(open) => (
        <button
          type="button"
          className={`icon-button filter-toggle${open ? " is-open" : ""}${isActive ? " is-active" : ""}`}
          disabled={props.disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={tr("Filter memos", "筛选笔记")}
          onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Filter memos", "筛选笔记") })}
          onMouseLeave={tip.hide}
        >
          <ListFilter size={17} aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <>
          <span className="action-menu__title" role="presentation">
            {tr("Filter by", "筛选条件")}
          </span>
          {FACET_ROWS.map((row) => {
            const RowIcon = row.icon;
            const active = filters[row.key];
            // Inside a tag every memo carries that tag, so "No tags" could
            // only ever answer with an empty feed: the row stays, idle, and
            // says why.
            const idle = row.key === "noTags" && activeTag !== null;
            return (
              <button
                key={row.key}
                type="button"
                aria-pressed={active}
                disabled={idle}
                className={active ? "is-selected" : ""}
                onClick={() => props.onToggleFacet(row.key)}
              >
                <RowIcon size={16} aria-hidden="true" />
                {tr(row.en, row.zh)}
                {idle ? (
                  <span className="filter-row-note">{tr(`not inside #${activeTag}`, `#${activeTag} 内不可用`)}</span>
                ) : active ? (
                  <Check size={15} className="menu-check" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
          <span className="action-menu__sep" />
          <span className="action-menu__title filter-title-row" role="presentation">
            {tr("Date range", "日期范围")}
            {rangeOn ? (
              <button type="button" className="filter-mini-clear" onClick={props.onClearDates}>
                {tr("Clear", "清除")}
              </button>
            ) : null}
          </span>
          {props.onPresetRange ? (
            <div className="filter-presets" role="group" aria-label={tr("Quick ranges", "快捷范围")}>
              {presets.map((preset) => {
                const picked = filters.dateFrom === preset.from && filters.dateTo === preset.to;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    className={`filter-preset${picked ? " is-active" : ""}`}
                    aria-pressed={picked}
                    onClick={() => (picked ? props.onClearDates() : props.onPresetRange?.(preset.from, preset.to))}
                  >
                    {tr(preset.en, preset.zh)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="filter-dates">
            <input
              type="date"
              value={filters.dateFrom ?? ""}
              max={filters.dateTo ?? undefined}
              aria-label={tr("Start date", "开始日期")}
              onChange={(event) => props.onDateChange({ dateFrom: event.target.value || null })}
            />
            <span className="filter-dates-sep" aria-hidden="true">
              –
            </span>
            <input
              type="date"
              value={filters.dateTo ?? ""}
              min={filters.dateFrom ?? undefined}
              aria-label={tr("End date", "结束日期")}
              onChange={(event) => props.onDateChange({ dateTo: event.target.value || null })}
            />
          </div>
          {showSaved ? (
            <>
              <span className="action-menu__sep" />
              <span className="action-menu__title" role="presentation">
                {tr("Saved filters", "保存的筛选")}
              </span>
              {props.saved.map((item) => (
                <div key={item.id} className="saved-row">
                  <button
                    type="button"
                    aria-pressed={item.id === props.activeSavedId}
                    className={item.id === props.activeSavedId ? "is-selected" : ""}
                    onClick={() => {
                      close();
                      props.onApplySaved(item);
                    }}
                  >
                    <Bookmark size={16} aria-hidden="true" />
                    <span className="saved-name">{item.name}</span>
                    {item.id === props.activeSavedId ? <Check size={15} className="menu-check" aria-hidden="true" /> : null}
                  </button>
                  <button
                    type="button"
                    className="saved-delete"
                    aria-label={tr(`Delete saved filter “${item.name}”`, `删除筛选「${item.name}」`)}
                    onClick={() => props.onDeleteSaved(item)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {props.canSave ? (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    props.onSaveCurrent();
                  }}
                >
                  <BookmarkPlus size={16} aria-hidden="true" />
                  {tr("Save current filters", "保存当前筛选")}
                </button>
              ) : null}
            </>
          ) : null}
          <span className="action-menu__sep" />
          <span className="filter-hint" role="presentation">
            {tr("Space separates keywords (all must match); “quotes” match an exact phrase.", "空格分隔多个关键词（须全部命中）；“引号”匹配完整短语。")}
          </span>
        </>
      )}
    </Menu>
  );
}
