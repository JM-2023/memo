import { Bookmark, BookmarkPlus, Check, Image, Link2, ListFilter, ListTodo, Tags, X, type LucideIcon } from "lucide-react";
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

interface SearchFilterProps {
  filters: FeedFilters;
  saved: SavedFilter[];
  /** Saved preset matching the live feed state exactly, if any. */
  activeSavedId: string | null;
  /** True while anything (search, tag, day, filters) is worth saving. */
  canSave: boolean;
  disabled: boolean;
  onToggleFacet: (key: FacetKey) => void;
  onDateChange: (patch: Partial<Pick<FeedFilters, "dateFrom" | "dateTo">>) => void;
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

  return (
    <Menu
      kind="panel"
      align="right"
      className="filter-root"
      panelClassName="filter-panel"
      panelLabel={tr("Search filters", "搜索筛选")}
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
            return (
              <button
                key={row.key}
                type="button"
                aria-pressed={active}
                className={active ? "is-selected" : ""}
                onClick={() => props.onToggleFacet(row.key)}
              >
                <RowIcon size={16} aria-hidden="true" />
                {tr(row.en, row.zh)}
                {active ? <Check size={15} className="menu-check" aria-hidden="true" /> : null}
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
