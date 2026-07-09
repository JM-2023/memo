import { ArrowDownWideNarrow, Check, Loader2, Menu as MenuIcon, NotebookPen, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChangePasscode } from "./components/ChangePasscode";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Crumbs } from "./components/Crumbs";
import { Editor } from "./components/Editor";
import { Lightbox } from "./components/Lightbox";
import { LoginScreen } from "./components/LoginScreen";
import { MemoCard } from "./components/MemoCard";
import { Menu } from "./components/Menu";
import { PromptDialog } from "./components/PromptDialog";
import { Sidebar } from "./components/Sidebar";
import { StatsModal } from "./components/StatsModal";
import { useTip } from "./components/Tip";
import {
  AuthRequiredError,
  bootstrap,
  createMemo,
  emptyTrash,
  getAuthStatus,
  login,
  logout,
  pinTag,
  purgeMemo,
  removeTag,
  renameTag,
  restoreMemo,
  setupPassword,
  trashMemo,
  updateMemo
} from "./lib/api";
import { dateKeyOf, formatDayLabel } from "./lib/dates";
import { useI18n } from "./lib/i18n";
import { countsByDay } from "./lib/stats";
import { buildTagTree, extractTags, isValidTagPath, tagMatches } from "./lib/tags";
import { applyTheme, loadTheme, nextTheme, type ThemeChoice } from "./lib/theme";
import type { LightboxItem, Memo, NewImagePayload, SortKey, TagMeta } from "./lib/types";
import { useSync } from "./lib/useSync";

type Phase = "checking" | "login" | "ready";
type View = "memos" | "trash";

interface ToastState {
  id: number;
  text: string;
  tone: "info" | "error";
}

const SORT_KEYS: SortKey[] = ["created-desc", "created-asc", "updated-desc", "updated-asc"];

const SORT_COMPARATORS: Record<SortKey, (a: Memo, b: Memo) => number> = {
  "created-desc": (a, b) => b.createdAt.localeCompare(a.createdAt),
  "created-asc": (a, b) => a.createdAt.localeCompare(b.createdAt),
  "updated-desc": (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  "updated-asc": (a, b) => a.updatedAt.localeCompare(b.updatedAt)
};

function loadSortKey(): SortKey {
  const stored = localStorage.getItem("memo-sort");
  return SORT_KEYS.includes(stored as SortKey) ? (stored as SortKey) : "created-desc";
}

export default function App() {
  const { count, errorMessage, locale, tr } = useI18n();
  const tip = useTip();
  const sortOptions: { key: SortKey; label: string }[] = useMemo(
    () => [
      { key: "created-desc", label: tr("Created · Newest first", "创建时间 · 从新到旧") },
      { key: "created-asc", label: tr("Created · Oldest first", "创建时间 · 从旧到新") },
      { key: "updated-desc", label: tr("Edited · Newest first", "编辑时间 · 从新到旧") },
      { key: "updated-asc", label: tr("Edited · Oldest first", "编辑时间 · 从旧到新") }
    ],
    [tr]
  );
  const [phase, setPhase] = useState<Phase>("checking");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  // path → pinnedAt for pinned tags (server-side tag_meta, synced like memos).
  const [pinnedTags, setPinnedTags] = useState<Map<string, string>>(new Map());
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);

  const [view, setView] = useState<View>("memos");
  const [sortKey, setSortKey] = useState<SortKey>(loadSortKey);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [trashTarget, setTrashTarget] = useState<Memo | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<Memo | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [renameTagTarget, setRenameTagTarget] = useState<string | null>(null);
  const [removeTagTarget, setRemoveTagTarget] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  // id → what to do once the collapse animation ends: a Memo means "apply
  // this server state", null means "drop the memo entirely" (hard delete).
  const removalRef = useRef(new Map<string, Memo | null>());

  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [changingPasscode, setChangingPasscode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [reveal, setReveal] = useState(false);

  const toastTimer = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;

  const showToast = useCallback((text: string, tone: "info" | "error" = "info") => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("memo-sort", sortKey);
  }, [sortKey]);

  const upsertMemos = useCallback((changed: Memo[], purged: string[]) => {
    setMemos((list) => {
      const byId = new Map(list.map((memo) => [memo.id, memo]));
      for (const memo of changed) byId.set(memo.id, memo);
      for (const id of purged) byId.delete(id);
      return [...byId.values()];
    });
  }, []);

  /** Merge touched tag_meta rows; a NULL pinnedAt row erases the pin. */
  const applyTagMeta = useCallback((tags: TagMeta[]) => {
    if (tags.length === 0) return;
    setPinnedTags((current) => {
      const next = new Map(current);
      for (const tag of tags) {
        if (tag.pinnedAt) next.set(tag.path, tag.pinnedAt);
        else next.delete(tag.path);
      }
      return next;
    });
  }, []);

  /** Sync payloads must not yank cards that are mid-collapse — reroute those. */
  const applySyncChanges = useCallback(
    (changed: Memo[], purged: string[], tags: TagMeta[]) => {
      const direct: Memo[] = [];
      const drop: string[] = [];
      for (const memo of changed) {
        if (removalRef.current.has(memo.id)) {
          removalRef.current.set(memo.id, memo);
        } else {
          direct.push(memo);
        }
      }
      for (const id of purged) {
        if (removalRef.current.has(id)) {
          removalRef.current.set(id, null);
        } else {
          drop.push(id);
        }
      }
      if (direct.length > 0 || drop.length > 0) upsertMemos(direct, drop);
      applyTagMeta(tags);
    },
    [upsertMemos, applyTagMeta]
  );

  const dropToLogin = useCallback(() => {
    setPhase("login");
    setMemos([]);
    removalRef.current.clear();
    setRemovingIds(new Set());
    showToast(tr("Your session expired. Enter your passcode again.", "登录已过期，请重新输入密码"), "error");
  }, [showToast, tr]);

  const { setCursor, runSync, notifyPeers } = useSync({
    enabled: phase === "ready",
    applyChanges: applySyncChanges,
    onAuthLost: dropToLogin
  });

  /** Apply a mutation response locally, then reconcile cursor + sibling tabs. */
  const commitMutation = useCallback(
    (memo?: Memo) => {
      if (memo) upsertMemos([memo], []);
      void runSync();
      notifyPeers();
    },
    [upsertMemos, runSync, notifyPeers]
  );

  const enterApp = useCallback(
    async (withReveal: boolean) => {
      const data = await bootstrap();
      setMemos(data.memos);
      setPinnedTags(new Map(data.tags.filter((tag) => tag.pinnedAt).map((tag) => [tag.path, tag.pinnedAt as string])));
      setCursor(data.cursor);
      setPhase("ready");
      if (withReveal) {
        setReveal(true);
        window.setTimeout(() => setReveal(false), 900);
      }
    },
    [setCursor]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getAuthStatus();
        if (cancelled) return;
        setNeedsSetup(status.needsSetup);
        if (status.needsSetup) {
          setPhase("login");
          return;
        }
        try {
          await enterApp(false);
        } catch (cause) {
          if (cancelled) return;
          if (cause instanceof AuthRequiredError) {
            setPhase("login");
          } else {
            setBootError(errorMessageRef.current(cause, "Couldn’t load your memos", "加载失败"));
            setPhase("login");
          }
        }
      } catch (cause) {
        if (cancelled) return;
        setBootError(errorMessageRef.current(cause, "Couldn’t connect to the server", "无法连接服务器"));
        setPhase("login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enterApp]);

  /** Session-expiry aware wrapper: any 401 mid-use drops back to the gate. */
  const guard = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (cause) {
        if (cause instanceof AuthRequiredError) {
          dropToLogin();
          return undefined;
        }
        throw cause;
      }
    },
    [dropToLogin]
  );

  const activeMemos = useMemo(() => memos.filter((memo) => !memo.deletedAt), [memos]);
  const trashedMemos = useMemo(
    () => memos.filter((memo) => memo.deletedAt).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")),
    [memos]
  );

  const { tree: tagTree, uniqueTagCount } = useMemo(
    () => buildTagTree(activeMemos, pinnedTags, locale),
    [activeMemos, pinnedTags, locale]
  );
  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const memo of activeMemos) for (const tag of extractTags(memo.content)) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, locale));
  }, [activeMemos, locale]);
  const byDay = useMemo(() => countsByDay(activeMemos), [activeMemos]);

  const trimmedQuery = query.trim().toLowerCase();
  const filtersActive = activeTag !== null || activeDay !== null || trimmedQuery.length > 0;

  const visibleMemos = useMemo(() => {
    let list = activeMemos;
    if (activeTag) {
      list = list.filter((memo) => extractTags(memo.content).some((tag) => tagMatches(tag, activeTag)));
    }
    if (activeDay) {
      list = list.filter((memo) => dateKeyOf(memo.createdAt) === activeDay);
    }
    if (trimmedQuery) {
      list = list.filter((memo) => memo.content.toLowerCase().includes(trimmedQuery));
    }
    const compare = SORT_COMPARATORS[sortKey];
    return [...list].sort((a, b) => {
      if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
      return compare(a, b);
    });
  }, [activeMemos, activeTag, activeDay, trimmedQuery, sortKey]);

  const feedMemos = view === "trash" ? trashedMemos : visibleMemos;
  // Re-keying the feed on view/filter/sort changes replays the stagger entrance.
  const listKey = `${view}|${sortKey}|${activeTag ?? ""}|${activeDay ?? ""}|${trimmedQuery}`;

  function closeDrawer() {
    if (!drawerOpen) return;
    setDrawerClosing(true);
    window.setTimeout(() => {
      setDrawerOpen(false);
      setDrawerClosing(false);
    }, 240);
  }

  const pickTag = useCallback((path: string | null) => {
    setActiveTag(path);
    setView("memos");
    setEditingId(null);
  }, []);

  const pickDay = useCallback((key: string | null) => {
    setActiveDay(key);
    setView("memos");
    setEditingId(null);
  }, []);

  const showAll = useCallback(() => {
    setActiveTag(null);
    setActiveDay(null);
    setQuery("");
    setView("memos");
    setEditingId(null);
  }, []);

  const openTrash = useCallback(() => {
    setView("trash");
    setEditingId(null);
  }, []);

  async function handleLogin(pin: string) {
    await login(pin);
    await enterApp(true);
  }

  async function handleSetup(pin: string) {
    await setupPassword(pin);
    setNeedsSetup(false);
    await enterApp(true);
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Even a failed call clears the local session view.
    }
    setMemos([]);
    removalRef.current.clear();
    setRemovingIds(new Set());
    setActiveTag(null);
    setActiveDay(null);
    setQuery("");
    setView("memos");
    setPhase("login");
  }

  async function handleCreate(data: { content: string; newImages: NewImagePayload[]; removeImageIds: string[] }): Promise<boolean> {
    setCreating(true);
    try {
      const result = await guard(() => createMemo(data.content, data.newImages));
      if (!result) return false;
      commitMutation(result.memo);
      for (const image of data.newImages) URL.revokeObjectURL(image.previewUrl);
      return true;
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveEdit(memo: Memo, data: { content: string; newImages: NewImagePayload[]; removeImageIds: string[] }): Promise<boolean> {
    setSavingEdit(true);
    try {
      const result = await guard(() =>
        updateMemo(memo.id, { content: data.content, addImages: data.newImages, removeImageIds: data.removeImageIds })
      );
      if (!result) return false;
      commitMutation(result.memo);
      setEditingId(null);
      showToast(tr("Saved", "已保存"));
      return true;
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleTogglePin(memo: Memo) {
    try {
      const result = await guard(() => updateMemo(memo.id, { pinned: !memo.pinnedAt }));
      if (!result) return;
      commitMutation(result.memo);
      showToast(result.memo.pinnedAt ? tr("Pinned", "已置顶") : tr("Unpinned", "已取消置顶"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t update the memo", "更新失败"), "error");
    }
  }

  async function handleCopy(memo: Memo) {
    try {
      await navigator.clipboard.writeText(memo.content);
      showToast(tr("Content copied", "已复制内容"));
    } catch {
      showToast(tr("Couldn’t copy the content", "复制失败"), "error");
    }
  }

  /** Kick off the collapse animation; `after` runs once it finishes. */
  const beginRemoval = useCallback((id: string, after: Memo | null) => {
    removalRef.current.set(id, after);
    setRemovingIds((value) => new Set(value).add(id));
  }, []);

  const finishRemove = useCallback(
    (id: string) => {
      const after = removalRef.current.get(id);
      removalRef.current.delete(id);
      setRemovingIds((value) => {
        const next = new Set(value);
        next.delete(id);
        return next;
      });
      if (after) {
        upsertMemos([after], []);
      } else {
        upsertMemos([], [id]);
      }
    },
    [upsertMemos]
  );

  async function handleTrashConfirmed() {
    if (!trashTarget) return;
    const target = trashTarget;
    setDialogBusy(true);
    try {
      const result = await guard(() => trashMemo(target.id));
      if (!result) return;
      setTrashTarget(null);
      beginRemoval(target.id, result.memo);
      void runSync();
      notifyPeers();
      showToast(tr("Moved to Trash", "已移入回收站"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t delete the memo", "删除失败"), "error");
    } finally {
      setDialogBusy(false);
    }
  }

  async function handleRestore(memo: Memo) {
    try {
      const result = await guard(() => restoreMemo(memo.id));
      if (!result) return;
      beginRemoval(memo.id, result.memo);
      void runSync();
      notifyPeers();
      showToast(tr("Restored", "已恢复"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t restore the memo", "恢复失败"), "error");
    }
  }

  async function handlePurgeConfirmed() {
    if (!purgeTarget) return;
    const target = purgeTarget;
    setDialogBusy(true);
    try {
      const result = await guard(() => purgeMemo(target.id));
      if (!result) return;
      setPurgeTarget(null);
      beginRemoval(target.id, null);
      void runSync();
      notifyPeers();
      showToast(tr("Permanently deleted", "已彻底删除"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t delete the memo", "删除失败"), "error");
    } finally {
      setDialogBusy(false);
    }
  }

  async function handleEmptyTrashConfirmed() {
    setDialogBusy(true);
    try {
      const result = await guard(() => emptyTrash());
      if (!result) return;
      setEmptyTrashOpen(false);
      for (const id of result.purgedIds) beginRemoval(id, null);
      void runSync();
      notifyPeers();
      showToast(tr("Trash emptied", "回收站已清空"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t empty Trash", "清空失败"), "error");
    } finally {
      setDialogBusy(false);
    }
  }

  async function handlePinTag(path: string, pinned: boolean) {
    try {
      const result = await guard(() => pinTag(path, pinned));
      if (!result) return;
      applyTagMeta([result.tag]);
      void runSync();
      notifyPeers();
      showToast(pinned ? tr("Tag pinned", "标签已置顶") : tr("Tag unpinned", "已取消置顶"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t complete the action", "操作失败"), "error");
    }
  }

  async function handleRenameTagConfirmed(to: string) {
    if (!renameTagTarget) return;
    const from = renameTagTarget;
    setDialogBusy(true);
    try {
      const result = await guard(() => renameTag(from, to));
      if (!result) return;
      setRenameTagTarget(null);
      applySyncChanges(result.memos, [], result.tags);
      if (activeTag && tagMatches(activeTag, from)) {
        setActiveTag(to + activeTag.slice(from.length));
      }
      void runSync();
      notifyPeers();
      showToast(tr(`Renamed to #${to}; updated ${count(result.updated, "memo")}`, `已重命名为 #${to}，更新了 ${count(result.updated, "memo")}`));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t rename the tag", "重命名失败"), "error");
    } finally {
      setDialogBusy(false);
    }
  }

  async function handleRemoveTagConfirmed() {
    if (!removeTagTarget) return;
    const path = removeTagTarget;
    setDialogBusy(true);
    try {
      const result = await guard(() => removeTag(path));
      if (!result) return;
      setRemoveTagTarget(null);
      applySyncChanges(result.memos, [], result.tags);
      if (activeTag && tagMatches(activeTag, path)) {
        setActiveTag(null);
      }
      void runSync();
      notifyPeers();
      showToast(tr(`Tag removed; updated ${count(result.updated, "memo")}`, `已移除标签，更新了 ${count(result.updated, "memo")}`));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t remove the tag", "移除失败"), "error");
    } finally {
      setDialogBusy(false);
    }
  }

  if (phase === "checking") {
    return (
      <div className="splash" aria-label={tr("Loading", "加载中")}>
        <div className="splash-logo">
          <NotebookPen size={26} aria-hidden="true" />
        </div>
        <Loader2 size={20} className="spin splash-spinner" aria-hidden="true" />
      </div>
    );
  }

  if (phase === "login") {
    return (
      <>
        <LoginScreen needsSetup={needsSetup} onLogin={handleLogin} onSetup={handleSetup} />
        {bootError ? <div className="toast is-error">{bootError}</div> : null}
      </>
    );
  }

  const sortLabel = sortOptions.find((option) => option.key === sortKey)?.label ?? "";
  const removeTagCount = removeTagTarget
    ? memos.filter((memo) => extractTags(memo.content).some((tag) => tagMatches(tag, removeTagTarget))).length
    : 0;

  return (
    <div className={`app-shell${reveal ? " first-reveal" : ""}`}>
      <aside className={`sidebar${drawerOpen ? " is-open" : ""}${drawerClosing ? " is-closing" : ""}`}>
        <Sidebar
          memos={activeMemos}
          tagTree={tagTree}
          uniqueTagCount={uniqueTagCount}
          countsByDay={byDay}
          activeTag={activeTag}
          activeDay={activeDay}
          filtersActive={filtersActive}
          view={view}
          trashCount={trashedMemos.length}
          theme={theme}
          pinnedTags={pinnedTags}
          onPinTag={(path, pinned) => void handlePinTag(path, pinned)}
          onRenameTag={(path) => setRenameTagTarget(path)}
          onRemoveTag={(path) => setRemoveTagTarget(path)}
          onPickTag={(path) => {
            pickTag(path);
            closeDrawer();
          }}
          onPickDay={(key) => {
            pickDay(key);
            closeDrawer();
          }}
          onShowAll={() => {
            showAll();
            closeDrawer();
          }}
          onOpenTrash={() => {
            openTrash();
            closeDrawer();
          }}
          onOpenStats={() => {
            setStatsOpen(true);
            closeDrawer();
          }}
          onCycleTheme={() => setTheme((value) => nextTheme(value))}
          onChangePasscode={() => setChangingPasscode(true)}
          onLogout={() => void handleLogout()}
        />
      </aside>
      {drawerOpen ? <div className={`drawer-backdrop${drawerClosing ? " is-closing" : ""}`} onClick={closeDrawer} /> : null}

      <main className="main-column">
        <div className="topbar">
          <button
            type="button"
            className="icon-button drawer-toggle"
            onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
            aria-label={tr("Open sidebar", "打开侧栏")}
          >
            <MenuIcon size={18} aria-hidden="true" />
          </button>
          <div className="breadcrumb">
            {view === "memos" && activeTag ? (
              <Crumbs key={activeTag} path={activeTag} onHome={showAll} onPick={(path) => pickTag(path)} />
            ) : (
              <button type="button" className={`breadcrumb-root${filtersActive || view === "trash" ? "" : " is-current"}`} onClick={showAll}>
                {tr("All memos", "全部笔记")}
              </button>
            )}
            {view === "memos" ? (
              <Menu
                align="left"
                className="sort-menu"
                trigger={(open) => (
                  <button
                    type="button"
                    className={`sort-trigger${open ? " is-open" : ""}`}
                    aria-label={tr("Sort options", "排序方式")}
                    onMouseEnter={(event) => tip.show(event.currentTarget, { text: sortLabel })}
                    onMouseLeave={tip.hide}
                  >
                    <ArrowDownWideNarrow size={14} aria-hidden="true" />
                    <span>{tr("Sort", "排序")}</span>
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {sortOptions.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option.key === sortKey}
                        className={option.key === sortKey ? "is-selected" : ""}
                        onClick={() => {
                          setSortKey(option.key);
                          close();
                        }}
                      >
                        {option.label}
                        {option.key === sortKey ? <Check size={15} className="menu-check" aria-hidden="true" /> : null}
                      </button>
                    ))}
                  </>
                )}
              </Menu>
            ) : null}
            {view === "trash" ? (
              <span key="trash-chip" className="filter-chip is-trash">
                <Trash2 size={12} aria-hidden="true" />
                {tr("Trash", "回收站")}
                <button type="button" onClick={showAll} aria-label={tr("Exit Trash", "退出回收站")}>
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ) : null}
            {view === "memos" && activeDay ? (
              <span key={`day-${activeDay}`} className="filter-chip">
                {formatDayLabel(activeDay, locale)}
                <button type="button" onClick={() => pickDay(null)} aria-label={tr("Clear date filter", "清除日期筛选")}>
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ) : null}
          </div>
          {view === "trash" ? (
            trashedMemos.length > 0 ? (
              <button type="button" className="trash-empty-button" onClick={() => setEmptyTrashOpen(true)}>
                <Trash2 size={14} aria-hidden="true" />
                {tr("Empty Trash", "清空回收站")}
              </button>
            ) : null
          ) : (
            <div className={`searchbox${searchOpen || query ? " is-open" : ""}`}>
              <Search size={15} className="searchbox-icon" aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                placeholder={tr("Search memos", "搜索笔记")}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
              />
              {query ? (
                <button
                  type="button"
                  className="searchbox-clear"
                  aria-label={tr("Clear search", "清空搜索")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )}
        </div>

        {view === "memos" ? (
          <div className="composer">
            <Editor mode="create" knownTags={knownTags} busy={creating} onSubmit={handleCreate} />
          </div>
        ) : null}

        <section
          key={listKey}
          className="memo-feed"
          aria-label={view === "trash" ? tr("Trash", "回收站") : tr("Memo list", "笔记列表")}
        >
          {feedMemos.length === 0 ? (
            <div className="feed-empty">
              {view === "trash" ? (
                <>
                  <p className="feed-empty-title">{tr("Trash is empty", "回收站是空的")}</p>
                  <p>{tr("Deleted memos appear here before you restore or permanently delete them.", "删除的笔记会先到这里，可以恢复或彻底删除")}</p>
                </>
              ) : activeMemos.length === 0 ? (
                <>
                  <p className="feed-empty-title">{tr("👋 Capture your first thought", "👋 记下第一条想法吧")}</p>
                  <p>{tr("Write something above and organize it with #tags.", "在上面的输入框写点什么，用 #标签 整理它们")}</p>
                </>
              ) : (
                <>
                  <p className="feed-empty-title">{tr("No matching memos", "没有找到相关笔记")}</p>
                  <p>{tr("Try a different search or filter.", "换个筛选条件试试")}</p>
                </>
              )}
            </div>
          ) : (
            feedMemos.map((memo, index) => (
              <div key={memo.id} className="memo-slot" style={{ animationDelay: `${Math.min(index, 12) * 0.03}s` }}>
                <MemoCard
                  memo={memo}
                  variant={view === "trash" ? "trash" : "normal"}
                  knownTags={knownTags}
                  editing={editingId === memo.id}
                  savingEdit={savingEdit}
                  isRemoving={removingIds.has(memo.id)}
                  onStartEdit={() => setEditingId(memo.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={(data) => handleSaveEdit(memo, data)}
                  onTogglePin={() => void handleTogglePin(memo)}
                  onCopy={() => void handleCopy(memo)}
                  onRequestDelete={() => setTrashTarget(memo)}
                  onRestore={() => void handleRestore(memo)}
                  onRequestPurge={() => setPurgeTarget(memo)}
                  onPickTag={(path) => pickTag(path)}
                  onOpenImage={(items, index2) => setLightbox({ items, index: index2 })}
                  onRemoveComplete={() => finishRemove(memo.id)}
                />
              </div>
            ))
          )}
        </section>
      </main>

      {lightbox ? <Lightbox items={lightbox.items} index={lightbox.index} onClose={() => setLightbox(null)} /> : null}
      {statsOpen ? <StatsModal memos={activeMemos} uniqueTagCount={uniqueTagCount} onClose={() => setStatsOpen(false)} /> : null}
      {trashTarget ? (
        <ConfirmDialog
          title={tr("Delete this memo?", "删除这条笔记？")}
          body={tr(
            "It will move to Trash, where you can restore it. It disappears permanently only after permanent deletion.",
            "它会先移入回收站，可以随时恢复；在回收站中彻底删除后才会真正消失。"
          )}
          confirmLabel={tr("Move to Trash", "移入回收站")}
          busyLabel={tr("Deleting…", "删除中…")}
          busy={dialogBusy}
          onCancel={() => setTrashTarget(null)}
          onConfirm={() => void handleTrashConfirmed()}
        />
      ) : null}
      {purgeTarget ? (
        <ConfirmDialog
          title={tr("Permanently delete this memo?", "彻底删除这条笔记？")}
          body={tr(
            "The memo and its images will be permanently deleted and cannot be recovered.",
            "笔记和它的图片将被永久删除，无法恢复。"
          )}
          confirmLabel={tr("Delete permanently", "彻底删除")}
          busyLabel={tr("Deleting…", "删除中…")}
          busy={dialogBusy}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={() => void handlePurgeConfirmed()}
        />
      ) : null}
      {emptyTrashOpen ? (
        <ConfirmDialog
          title={tr("Empty Trash?", "清空回收站？")}
          body={tr(
            `This will permanently delete ${count(trashedMemos.length, "memo")} and their images. This cannot be undone.`,
            `将永久删除 ${count(trashedMemos.length, "memo")}及其图片，无法恢复。`
          )}
          confirmLabel={tr("Delete all", "全部删除")}
          busyLabel={tr("Emptying…", "清空中…")}
          busy={dialogBusy}
          onCancel={() => setEmptyTrashOpen(false)}
          onConfirm={() => void handleEmptyTrashConfirmed()}
        />
      ) : null}
      {renameTagTarget ? (
        <PromptDialog
          title={tr(`Rename tag #${renameTagTarget}`, `重命名标签 #${renameTagTarget}`)}
          body={tr(
            "This tag and all its child tags will be updated in every memo, including memos in Trash.",
            "所有笔记（含回收站）里的这个标签及其子标签都会同步更新。"
          )}
          initialValue={renameTagTarget}
          placeholder={tr("New name; use / for levels", "新名称，可用 / 分层")}
          confirmLabel={tr("Rename", "重命名")}
          busyLabel={tr("Renaming…", "重命名中…")}
          busy={dialogBusy}
          validate={(value) => {
            if (value === renameTagTarget) return tr("The new name is unchanged", "新旧名称相同");
            if (!isValidTagPath(value)) return tr("Use letters, numbers, -, _, or ·, with / between levels", "可用中英文、数字、-、_、·，用 / 分层");
            return null;
          }}
          hint={(value) =>
            knownTags.includes(value)
              ? tr(`#${value} already exists. Renaming will merge the tags.`, `#${value} 已存在，重命名后两个标签会合并`)
              : null
          }
          onCancel={() => setRenameTagTarget(null)}
          onConfirm={(value) => void handleRenameTagConfirmed(value)}
        />
      ) : null}
      {removeTagTarget ? (
        <ConfirmDialog
          title={tr(`Remove tag #${removeTagTarget}?`, `移除标签 #${removeTagTarget}？`)}
          body={tr(
            `This tag and its child tags will be removed from ${count(removeTagCount, "memo")}. ${removeTagCount === 1 ? "The memo will remain." : "The memos will remain."}`,
            `将从 ${count(removeTagCount, "memo")}的正文中删掉这个标签（含子标签），笔记本身保留。`
          )}
          confirmLabel={tr("Remove tag", "移除标签")}
          busyLabel={tr("Removing…", "移除中…")}
          busy={dialogBusy}
          onCancel={() => setRemoveTagTarget(null)}
          onConfirm={() => void handleRemoveTagConfirmed()}
        />
      ) : null}
      {changingPasscode ? (
        <ChangePasscode
          onClose={() => setChangingPasscode(false)}
          onDone={() => {
            setChangingPasscode(false);
            showToast(tr("Passcode updated", "密码已更新"));
          }}
        />
      ) : null}
      {toast ? (
        <div key={toast.id} className={`toast${toast.tone === "error" ? " is-error" : ""}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
