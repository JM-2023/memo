import { ChevronDown, Cpu, Download, Inbox, KeyRound, Languages, LogOut, Moon, Monitor, NotebookPen, Sparkles, Sun, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useI18n } from "../lib/i18n";
import { dayKeyOf, periodStats, totalStats, type PeriodKind } from "../lib/stats";
import type { TagNode } from "../lib/tags";
import type { Memo } from "../lib/types";
import type { ThemeChoice } from "../lib/theme";
import { Heatmap } from "./Heatmap";
import { Menu } from "./Menu";
import { RollingText } from "./RollingText";
import { SwapText } from "./SwapText";
import { TagTree } from "./TagTree";
import { useTip } from "./Tip";

interface SidebarProps {
  memos: Memo[];
  tagTree: TagNode[];
  uniqueTagCount: number;
  countsByDay: Map<string, number>;
  activeTag: string | null;
  activeDay: string | null;
  filtersActive: boolean;
  view: "memos" | "trash" | "review";
  trashCount: number;
  theme: ThemeChoice;
  pinnedTags: Map<string, string>;
  onPickTag: (path: string | null) => void;
  onPinTag: (path: string, pinned: boolean) => void;
  onRenameTag: (path: string) => void;
  onRemoveTag: (path: string) => void;
  onPickDay: (key: string | null) => void;
  onShowAll: () => void;
  onOpenTrash: () => void;
  onOpenReview: () => void;
  onOpenReviewSettings: () => void;
  onOpenModelSettings: () => void;
  onOpenStats: () => void;
  onCycleTheme: () => void;
  onChangePasscode: () => void;
  onExportData: () => void;
  onImportData: () => void;
  onLogout: () => void;
  /** Mobile drawer state; supplied by the shell so Escape can dismiss it. */
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
}

const PERIODS: { kind: PeriodKind; en: string; zh: string }[] = [
  { kind: "week", en: "Week", zh: "周" },
  { kind: "month", en: "Month", zh: "月" },
  { kind: "year", en: "Year", zh: "年" }
];

const THEME_LABELS: Record<ThemeChoice, readonly [en: string, zh: string]> = {
  system: ["System Theme", "跟随系统"],
  light: ["Light Theme", "浅色模式"],
  dark: ["Dark Theme", "深色模式"]
};

export function Sidebar(props: SidebarProps) {
  const { memos, tagTree, uniqueTagCount, countsByDay, activeTag, activeDay, filtersActive, view, trashCount, theme } = props;
  const { language, setLanguage, tr, formatNumber, count } = useI18n();
  const tip = useTip();
  const [period, setPeriod] = useState<PeriodKind>("week");

  useEffect(() => {
    if (!props.drawerOpen || !props.onCloseDrawer) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      props.onCloseDrawer?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.drawerOpen, props.onCloseDrawer]);

  const totals = useMemo(() => totalStats(memos), [memos]);
  const stats = useMemo(() => periodStats(memos, period), [memos, period]);
  // Local-day key of the earliest memo (dayKeyOf, not an ISO slice — the
  // stored strings are UTC and would drift near month edges).
  const minDay = useMemo(() => {
    let min: string | null = null;
    for (const memo of memos) {
      const key = dayKeyOf(memo);
      if (min === null || key < min) min = key;
    }
    return min;
  }, [memos]);

  const periodIndex = PERIODS.findIndex((option) => option.kind === period);
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const [themeLabelEn, themeLabelZh] = THEME_LABELS[theme];

  function onPeriodKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % PERIODS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + PERIODS.length) % PERIODS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PERIODS.length - 1;
    else return;
    event.preventDefault();
    setPeriod(PERIODS[next].kind);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button[data-period]");
    buttons?.[next]?.focus({ preventScroll: true });
  }

  return (
    <div className="sidebar-inner">
      <header className="sidebar-head">
        <Menu
          align="left"
          panelClassName="settings-menu"
          trigger={(open) => (
            <button
              type="button"
              className={`user-button${open ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              <span className="user-logo" aria-hidden="true">
                <NotebookPen size={15} />
              </span>
              <span className="user-name">
                <SwapText id={language} className="locale-swap">
                  {tr("My MEMO", "我的 MEMO")}
                </SwapText>
              </span>
              <ChevronDown size={15} className="user-chevron" aria-hidden="true" />
            </button>
          )}
        >
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onCycleTheme();
                }}
              >
                <ThemeIcon size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr(themeLabelEn, themeLabelZh)}
                </SwapText>
              </button>
              <div className="action-menu__row" role="group" aria-label={tr("Language", "语言")}>
                <Languages size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Language", "语言")}
                </SwapText>
                <span className="lang-seg" data-lang={language}>
                  <span className="lang-seg-thumb" aria-hidden="true" />
                  <button
                    type="button"
                    lang="en"
                    role="menuitemradio"
                    className={language === "en" ? "is-active" : ""}
                    aria-checked={language === "en"}
                    aria-label={tr("English interface", "英文界面")}
                    onClick={() => setLanguage("en")}
                  >
                    EN
                  </button>
                  <button
                    type="button"
                    lang="zh-CN"
                    role="menuitemradio"
                    className={language === "zh-CN" ? "is-active" : ""}
                    aria-checked={language === "zh-CN"}
                    aria-label={tr("Simplified Chinese interface", "简体中文界面")}
                    onClick={() => setLanguage("zh-CN")}
                  >
                    中文
                  </button>
                </span>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  props.onOpenReviewSettings();
                }}
              >
                <Sparkles size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Daily Review Settings", "每日回顾设置")}
                </SwapText>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  props.onOpenModelSettings();
                }}
              >
                <Cpu size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Semantic Search", "语义搜索")}
                </SwapText>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  props.onChangePasscode();
                }}
              >
                <KeyRound size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Change Passcode", "修改密码")}
                </SwapText>
              </button>
              <span className="action-menu__sep" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  props.onExportData();
                }}
              >
                <Download size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Export Data", "导出数据")}
                </SwapText>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  props.onImportData();
                }}
              >
                <Upload size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Import Data", "导入数据")}
                </SwapText>
              </button>
              <span className="action-menu__sep" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  close();
                  props.onLogout();
                }}
              >
                <LogOut size={16} aria-hidden="true" />
                <SwapText id={language} className="locale-swap">
                  {tr("Log Out", "退出登录")}
                </SwapText>
              </button>
            </>
          )}
        </Menu>
      </header>

      <section className="stat-panel" aria-label={tr("Statistics", "统计")}>
        <div className="stat-row">
          <button
            type="button"
            className="stat-cell"
            onClick={props.onOpenStats}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("View detailed statistics", "查看详细统计") })}
            onMouseLeave={tip.hide}
          >
            <span className="stat-number">
              <RollingText value={totals.memoCount} />
            </span>
            <span className="stat-label">{tr("Memos", "笔记")}</span>
          </button>
          <button
            type="button"
            className="stat-cell"
            onClick={props.onOpenStats}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("View detailed statistics", "查看详细统计") })}
            onMouseLeave={tip.hide}
          >
            <span className="stat-number">
              <RollingText value={uniqueTagCount} />
            </span>
            <span className="stat-label">{tr("Tags", "标签")}</span>
          </button>
          <button
            type="button"
            className="stat-cell"
            onClick={props.onOpenStats}
            onMouseEnter={(event) =>
              tip.show(event.currentTarget, {
                strong: tr(
                  `${formatNumber(totals.activeDays)} active ${totals.activeDays === 1 ? "day" : "days"}`,
                  `${count(totals.activeDays, "day")}活跃`
                ),
                text: tr(`Recorded across ${count(totals.daySpan, "day")}`, `记录跨度 ${count(totals.daySpan, "day")}`)
              })
            }
            onMouseLeave={tip.hide}
          >
            <span className="stat-number">
              <RollingText value={totals.daySpan} />
            </span>
            <span className="stat-label">{tr("Days", "天")}</span>
          </button>
        </div>

        <div className="period-panel">
          <div className="period-seg" role="group" aria-label={tr("Statistics period", "统计范围")}>
            <span className="period-seg-thumb" style={{ transform: `translateX(${periodIndex * 100}%)` }} aria-hidden="true" />
            {PERIODS.map((option, index) => (
              <button
                key={option.kind}
                type="button"
                data-period={option.kind}
                aria-pressed={period === option.kind}
                tabIndex={period === option.kind ? 0 : -1}
                className={period === option.kind ? "is-active" : ""}
                onClick={() => setPeriod(option.kind)}
                onKeyDown={(event) => onPeriodKeyDown(event, index)}
              >
                {tr(option.en, option.zh)}
              </button>
            ))}
          </div>
          <div className="period-figures">
            <span>
              <strong>
                <RollingText value={stats.memoCount} />
              </strong>{" "}
              {/* Keyed by language: a locale switch swaps instantly like the
                  rest of the UI; only plural changes roll. */}
              <RollingText
                key={language}
                value={stats.memoCount}
                text={tr(stats.memoCount === 1 ? "memo" : "memos", "条笔记")}
                align="left"
              />
            </span>
            <span className="period-sep" aria-hidden="true" />
            <span>
              <strong>
                <RollingText value={stats.wordSum} />
              </strong>{" "}
              <RollingText
                key={language}
                value={stats.wordSum}
                text={tr(stats.wordSum === 1 ? "character" : "characters", "字")}
                align="left"
              />
            </span>
          </div>
        </div>

        <Heatmap countsByDay={countsByDay} minDay={minDay} activeDay={activeDay} period={period} onPickDay={props.onPickDay} />
      </section>

      <nav className="sidebar-nav">
        <button
          type="button"
          className={`nav-item${view === "memos" && !filtersActive ? " is-active" : ""}`}
          aria-current={view === "memos" && !filtersActive ? "page" : undefined}
          onClick={props.onShowAll}
        >
          <Inbox size={16} aria-hidden="true" />
          {tr("All memos", "全部笔记")}
          <span className="nav-count">
            <RollingText value={totals.memoCount} />
          </span>
        </button>
        <button
          type="button"
          className={`nav-item${view === "review" ? " is-active" : ""}`}
          aria-current={view === "review" ? "page" : undefined}
          onClick={props.onOpenReview}
        >
          <Sparkles size={16} aria-hidden="true" />
          {tr("Daily review", "每日回顾")}
        </button>
        <button
          type="button"
          className={`nav-item${view === "trash" ? " is-active" : ""}`}
          aria-current={view === "trash" ? "page" : undefined}
          onClick={props.onOpenTrash}
        >
          <Trash2 size={16} aria-hidden="true" />
          {tr("Trash", "回收站")}
          <span className="nav-count">
            <RollingText value={trashCount} />
          </span>
        </button>
      </nav>

      <TagTree
        tree={tagTree}
        activeTag={activeTag}
        pinnedTags={props.pinnedTags}
        onPickTag={props.onPickTag}
        onPinTag={props.onPinTag}
        onRenameTag={props.onRenameTag}
        onRemoveTag={props.onRemoveTag}
      />
    </div>
  );
}
