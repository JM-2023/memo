import { ArrowDownWideNarrow, Check, Loader2, Menu as MenuIcon, NotebookPen, Search, Trash2, X } from "lucide-react";
import { memo as reactMemo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
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
  exportData,
  getAuthStatus,
  importData,
  login,
  logout,
  pinTag,
  purgeMemo,
  removeTag,
  renameTag,
  restoreMemo,
  setupPassword,
  syncSince,
  trashMemo,
  updateMemo,
  type BackupPayload
} from "./lib/api";
import { adoptCacheKey, clearSnapshot, mergeMemoDelta, mergeTagDelta, openSnapshot, peekSnapshotCursor, saveSnapshot } from "./lib/cache";
import { dateKey, formatDayLabel } from "./lib/dates";
import { useI18n } from "./lib/i18n";
import { countsByDay, dayKeyOf } from "./lib/stats";
import { buildTagTree, isValidTagPath, tagMatches, tagsOf } from "./lib/tags";
import { applyTheme, loadTheme, nextTheme, type ThemeChoice } from "./lib/theme";
import type { LightboxItem, Memo, NewImagePayload, SortKey, TagMeta } from "./lib/types";
import { useSync } from "./lib/useSync";
import { withViewTransition } from "./lib/viewTransition";

type Phase = "checking" | "login" | "ready";
type View = "memos" | "trash";

interface ToastState {
  id: number;
  text: string;
  tone: "info" | "error";
  /** Plays the exit animation before the node unmounts. */
  leaving?: boolean;
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

interface MemoSlotProps {
  /** Per-memo view-transition-name; undefined past the morph budget. */
  vtName: string | undefined;
  entering: boolean;
  delay: number;
  children: ReactNode;
}

/**
 * Feed slot that locks its entrance decision at mount: slots mounted by a
 * filter swap skip the rise-in (the view transition owns that motion), while
 * organic mounts — initial load, a freshly created memo — cascade in. The
 * per-memo view-transition-name is what lets a filter change glide shared
 * cards to their new positions instead of replaying an entrance; identical
 * result lists therefore produce no motion at all.
 */
function MemoSlot({ vtName, entering, delay, children }: MemoSlotProps) {
  const [intro] = useState(() => (entering ? { animationDelay: `${delay}s` } : null));
  return (
    <div className={`memo-slot${intro ? "" : " no-enter"}`} style={{ ...intro, viewTransitionName: vtName }}>
      {children}
    </div>
  );
}

/** How many feed rows render before the scroll sentinel asks for more. */
const FEED_PAGE = 80;

/** Stable per-App action surface — what keeps FeedItem memoization honest. */
interface FeedHandlers {
  startEdit: (id: string) => void;
  cancelEdit: () => void;
  saveEdit: (memo: Memo, data: { content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  togglePin: (memo: Memo) => void;
  copy: (memo: Memo) => void;
  trash: (memo: Memo) => void;
  restore: (memo: Memo) => void;
  purge: (memo: Memo) => void;
  pickTag: (path: string) => void;
  openImage: (items: LightboxItem[], index: number) => void;
}

interface FeedItemProps {
  memo: Memo;
  variant: "normal" | "trash";
  knownTags: string[];
  editing: boolean;
  savingEdit: boolean;
  vtName: string | undefined;
  /** Read once at mount; a stable getter keeps the memo comparison clean. */
  getEntering: () => boolean;
  delay: number;
  handlers: FeedHandlers;
}

/**
 * One memoized feed row. With `handlers` and `knownTags` held stable by App,
 * unrelated state changes (search keystrokes, toasts, dialogs, heartbeat
 * syncs) skip the entire feed — only rows whose memo or flags changed
 * re-render. `delay`/`getEntering` are mount-time-only inputs and are
 * deliberately left out of the equality check.
 */
const FeedItem = reactMemo(
  function FeedItem({ memo, variant, knownTags, editing, savingEdit, vtName, getEntering, delay, handlers }: FeedItemProps) {
    return (
      <MemoSlot vtName={vtName} entering={getEntering()} delay={delay}>
        <MemoCard
          memo={memo}
          variant={variant}
          knownTags={knownTags}
          editing={editing}
          savingEdit={savingEdit}
          onStartEdit={() => handlers.startEdit(memo.id)}
          onCancelEdit={handlers.cancelEdit}
          onSaveEdit={(data) => handlers.saveEdit(memo, data)}
          onTogglePin={() => handlers.togglePin(memo)}
          onCopy={() => handlers.copy(memo)}
          onDelete={() => handlers.trash(memo)}
          onRestore={() => handlers.restore(memo)}
          onPurge={() => handlers.purge(memo)}
          onPickTag={handlers.pickTag}
          onOpenImage={handlers.openImage}
        />
      </MemoSlot>
    );
  },
  (prev, next) =>
    prev.memo === next.memo &&
    prev.variant === next.variant &&
    prev.knownTags === next.knownTags &&
    prev.editing === next.editing &&
    prev.savingEdit === next.savingEdit &&
    prev.vtName === next.vtName &&
    prev.handlers === next.handlers
);

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
  const [renameTagTarget, setRenameTagTarget] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  // Two-step Empty Trash: first click arms the button, second click fires.
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  // Parsed backup file waiting for the user's go-ahead.
  const [importTarget, setImportTarget] = useState<{ payload: BackupPayload; memoCount: number; imageCount: number } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

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
    toastTimer.current = window.setTimeout(() => {
      setToast((current) => (current ? { ...current, leaving: true } : current));
      toastTimer.current = window.setTimeout(() => setToast(null), 280);
    }, 2400);
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

  const applySyncChanges = useCallback(
    (changed: Memo[], purged: string[], tags: TagMeta[]) => {
      if (changed.length > 0 || purged.length > 0) upsertMemos(changed, purged);
      applyTagMeta(tags);
    },
    [upsertMemos, applyTagMeta]
  );

  const dropToLogin = useCallback(() => {
    setPhase("login");
    setMemos([]);
    showToast(tr("Your session expired. Enter your passcode again.", "登录已过期，请重新输入密码"), "error");
  }, [showToast, tr]);

  const { setCursor, getCursor, runSync, notifyPeers } = useSync({
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
      // Warm start: with a sealed local snapshot, one incremental sync
      // replaces the full-notebook bootstrap — startup traffic stays
      // constant-size no matter how large the notebook grows. Auth errors
      // propagate to the caller exactly like the bootstrap path's.
      let entered = false;
      const cachedCursor = await peekSnapshotCursor();
      if (cachedCursor !== null) {
        const delta = await syncSince(cachedCursor);
        adoptCacheKey(delta.cacheKey);
        const snapshot = await openSnapshot();
        if (snapshot) {
          setMemos(mergeMemoDelta(snapshot.memos, delta.memos, delta.purged));
          const tags = mergeTagDelta(snapshot.tags, delta.tags);
          setPinnedTags(new Map(tags.filter((tag) => tag.pinnedAt).map((tag) => [tag.path, tag.pinnedAt as string])));
          setCursor(delta.cursor);
          entered = true;
        }
        // Unreadable snapshot (rotated key, stale format) → cold path below.
      }
      if (!entered) {
        const data = await bootstrap();
        adoptCacheKey(data.cacheKey);
        setMemos(data.memos);
        setPinnedTags(new Map(data.tags.filter((tag) => tag.pinnedAt).map((tag) => [tag.path, tag.pinnedAt as string])));
        setCursor(data.cursor);
      }
      setPhase("ready");
      if (withReveal) {
        setReveal(true);
        window.setTimeout(() => setReveal(false), 900);
      }
    },
    [setCursor]
  );

  // Persist the working set (sealed) once changes settle.
  useEffect(() => {
    if (phase !== "ready") return;
    const timer = window.setTimeout(() => {
      const tags: TagMeta[] = [...pinnedTags].map(([path, pinnedAt]) => ({ path, pinnedAt, seq: 0 }));
      void saveSnapshot({ cursor: getCursor(), memos, tags });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [phase, memos, pinnedTags, getCursor]);

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
    for (const memo of activeMemos) for (const tag of tagsOf(memo)) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, locale));
  }, [activeMemos, locale]);
  const byDay = useMemo(() => countsByDay(activeMemos), [activeMemos]);

  const trimmedQuery = query.trim().toLowerCase();
  // Filtering follows the keystroke at deferred priority: the input never
  // waits for a big feed to re-render.
  const deferredQuery = useDeferredValue(trimmedQuery);
  const filtersActive = activeTag !== null || activeDay !== null || trimmedQuery.length > 0;

  const visibleMemos = useMemo(() => {
    let list = activeMemos;
    if (activeTag) {
      list = list.filter((memo) => tagsOf(memo).some((tag) => tagMatches(tag, activeTag)));
    }
    if (activeDay) {
      list = list.filter((memo) => dayKeyOf(memo) === activeDay);
    }
    if (deferredQuery) {
      list = list.filter((memo) => memo.content.toLowerCase().includes(deferredQuery));
    }
    const compare = SORT_COMPARATORS[sortKey];
    return [...list].sort((a, b) => {
      if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
      return compare(a, b);
    });
  }, [activeMemos, activeTag, activeDay, deferredQuery, sortKey]);

  const feedMemos = view === "trash" ? trashedMemos : visibleMemos;

  // The feed renders in pages: the first FEED_PAGE rows immediately, more as
  // the sentinel scrolls near. Keeps first paint and filter swaps flat no
  // matter how many memos exist.
  const [renderCap, setRenderCap] = useState(FEED_PAGE);
  useEffect(() => {
    setRenderCap(FEED_PAGE);
  }, [deferredQuery]);
  const hasMoreFeed = feedMemos.length > renderCap;
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMoreFeed) return;
    const node = feedSentinelRef.current;
    if (!node) return;
    // Re-created after every cap bump so a still-visible sentinel re-fires.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRenderCap((cap) => cap + FEED_PAGE);
        }
      },
      { rootMargin: "1200px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreFeed, renderCap]);

  function closeDrawer() {
    if (!drawerOpen) return;
    setDrawerClosing(true);
    window.setTimeout(() => {
      setDrawerOpen(false);
      setDrawerClosing(false);
    }, 240);
  }

  // While true, slots mounting in the current (flushed) render skip their
  // entrance animation — the view transition owns the motion instead.
  const enterSuppressRef = useRef(false);

  /**
   * Feed filter changes run inside a view transition: shared cards glide to
   * their new positions, departures/arrivals fade, and the scroll reset is
   * masked by the transition. Skipped while the mobile drawer is open (its
   * own closing animation would get double-captured).
   */
  const changeFeed = useCallback(
    (apply: () => void) => {
      const update = () => {
        enterSuppressRef.current = true;
        try {
          flushSync(() => {
            setRenderCap(FEED_PAGE);
            apply();
          });
        } finally {
          enterSuppressRef.current = false;
        }
        window.scrollTo(0, 0);
      };
      if (drawerOpen) update();
      else withViewTransition(update);
    },
    [drawerOpen]
  );

  const pickTag = useCallback(
    (path: string | null) => {
      if (view === "memos" && activeTag === path) {
        setEditingId(null);
        return;
      }
      changeFeed(() => {
        setActiveTag(path);
        setView("memos");
        setEditingId(null);
      });
    },
    [view, activeTag, changeFeed]
  );

  const pickDay = useCallback(
    (key: string | null) => {
      if (view === "memos" && activeDay === key) {
        setEditingId(null);
        return;
      }
      changeFeed(() => {
        setActiveDay(key);
        setView("memos");
        setEditingId(null);
      });
    },
    [view, activeDay, changeFeed]
  );

  const showAll = useCallback(() => {
    if (view === "memos" && activeTag === null && activeDay === null && query.length === 0) {
      setEditingId(null);
      return;
    }
    changeFeed(() => {
      setActiveTag(null);
      setActiveDay(null);
      setQuery("");
      setView("memos");
      setEditingId(null);
    });
  }, [view, activeTag, activeDay, query, changeFeed]);

  const openTrash = useCallback(() => {
    if (view === "trash") return;
    changeFeed(() => {
      setView("trash");
      setEditingId(null);
    });
  }, [view, changeFeed]);

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
    // Explicit logout means "leave nothing behind on this device". (A mere
    // session expiry keeps the snapshot — it is sealed without a session.)
    void clearSnapshot();
    setMemos([]);
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
      // Pinning reorders the feed — let the card glide to its new slot.
      withViewTransition(() => flushSync(() => upsertMemos([result.memo], [])));
      void runSync();
      notifyPeers();
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

  /**
   * Removals ride the same view-transition system as filter swaps and
   * pinning: the departing card cross-fades away while the surviving cards
   * (and the feed gap) glide to their final positions on the compositor.
   * No height-collapse hand-off, so there is nothing to snap at the end.
   */
  const applyRemoval = useCallback(
    (changed: Memo[], purged: string[]) => {
      withViewTransition(() => flushSync(() => upsertMemos(changed, purged)));
      void runSync();
      notifyPeers();
    },
    [upsertMemos, runSync, notifyPeers]
  );

  async function handleTrash(memo: Memo) {
    try {
      const result = await guard(() => trashMemo(memo.id));
      if (!result) return;
      applyRemoval([result.memo], []);
      showToast(tr("Moved to Trash", "已移入回收站"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t delete the memo", "删除失败"), "error");
    }
  }

  async function handleRestore(memo: Memo) {
    try {
      const result = await guard(() => restoreMemo(memo.id));
      if (!result) return;
      applyRemoval([result.memo], []);
      showToast(tr("Restored", "已恢复"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t restore the memo", "恢复失败"), "error");
    }
  }

  async function handlePurge(memo: Memo) {
    try {
      const result = await guard(() => purgeMemo(memo.id));
      if (!result) return;
      applyRemoval([], [memo.id]);
      showToast(tr("Permanently deleted", "已彻底删除"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t delete the memo", "删除失败"), "error");
    }
  }

  async function handleEmptyTrash() {
    try {
      const result = await guard(() => emptyTrash());
      if (!result) return;
      applyRemoval([], result.purgedIds);
      showToast(tr("Trash emptied", "回收站已清空"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t empty Trash", "清空失败"), "error");
    }
  }

  // Latest closures behind one stable identity — FeedItem's memoization
  // survives every App re-render. (The handle* function declarations below
  // are hoisted, so assigning here each render is safe.)
  const feedActionsRef = useRef({
    saveEdit: handleSaveEdit,
    togglePin: handleTogglePin,
    copy: handleCopy,
    trash: handleTrash,
    restore: handleRestore,
    purge: handlePurge,
    pickTag
  });
  feedActionsRef.current = {
    saveEdit: handleSaveEdit,
    togglePin: handleTogglePin,
    copy: handleCopy,
    trash: handleTrash,
    restore: handleRestore,
    purge: handlePurge,
    pickTag
  };
  const getEntering = useCallback(() => !enterSuppressRef.current, []);
  const feedHandlers = useMemo<FeedHandlers>(
    () => ({
      startEdit: (id) => setEditingId(id),
      cancelEdit: () => setEditingId(null),
      saveEdit: (memo, data) => feedActionsRef.current.saveEdit(memo, data),
      togglePin: (memo) => void feedActionsRef.current.togglePin(memo),
      copy: (memo) => void feedActionsRef.current.copy(memo),
      trash: (memo) => void feedActionsRef.current.trash(memo),
      restore: (memo) => void feedActionsRef.current.restore(memo),
      purge: (memo) => void feedActionsRef.current.purge(memo),
      pickTag: (path) => feedActionsRef.current.pickTag(path),
      openImage: (items, index) => setLightbox({ items, index })
    }),
    []
  );

  // A primed Empty Trash button disarms on its own if the second click
  // never lands.
  useEffect(() => {
    if (!confirmEmptyTrash) return;
    const timer = window.setTimeout(() => setConfirmEmptyTrash(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmEmptyTrash]);
  useEffect(() => {
    if (view !== "trash") setConfirmEmptyTrash(false);
  }, [view]);

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

  async function handleRemoveTag(path: string) {
    try {
      const result = await guard(() => removeTag(path));
      if (!result) return;
      // One view transition covers the whole blast radius: the tag row leaves
      // the sidebar (its siblings FLIP up), memo bodies cross-fade to their
      // tagless text, and a matching feed filter resets.
      withViewTransition(() =>
        flushSync(() => {
          applySyncChanges(result.memos, [], result.tags);
          if (activeTag && tagMatches(activeTag, path)) {
            setActiveTag(null);
          }
        })
      );
      void runSync();
      notifyPeers();
      showToast(tr(`Tag removed; updated ${count(result.updated, "memo")}`, `已移除标签，更新了 ${count(result.updated, "memo")}`));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t remove the tag", "移除失败"), "error");
    }
  }

  async function handleExport() {
    try {
      const blob = await guard(() => exportData());
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `memo-backup-${dateKey(new Date())}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast(tr("Backup exported", "备份已导出"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t export your data", "导出失败"), "error");
    }
  }

  async function handleImportFile(file: File) {
    try {
      const payload = JSON.parse(await file.text()) as BackupPayload;
      if (!payload || payload.format !== "memo-backup" || payload.version !== 1 || !Array.isArray(payload.memos)) {
        showToast(tr("This isn’t a memo backup file", "这不是有效的备份文件"), "error");
        return;
      }
      const imageCount = payload.memos.reduce((sum, memo) => sum + (Array.isArray(memo.images) ? memo.images.length : 0), 0);
      setImportTarget({ payload, memoCount: payload.memos.length, imageCount });
    } catch {
      showToast(tr("Couldn’t read the backup file", "无法读取备份文件"), "error");
    }
  }

  async function handleImportConfirmed() {
    if (!importTarget) return;
    const { payload } = importTarget;
    setDialogBusy(true);
    try {
      const result = await guard(() => importData(payload));
      if (!result) return;
      setImportTarget(null);
      // The imported rows carry fresh seqs, so one incremental sync pulls
      // them in (and sibling tabs hear about it too).
      await runSync();
      notifyPeers();
      showToast(
        result.imported > 0
          ? tr(`Imported ${count(result.imported, "memo")}`, `已导入 ${count(result.imported, "memo")}`)
          : tr("Nothing new — every memo already exists", "没有新内容，笔记都已存在")
      );
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t import the backup", "导入失败"), "error");
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
          onRemoveTag={(path) => void handleRemoveTag(path)}
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
          onExportData={() => void handleExport()}
          onImportData={() => importFileRef.current?.click()}
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
              <Crumbs path={activeTag} onHome={showAll} onPick={(path) => pickTag(path)} />
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
                          close();
                          if (option.key !== sortKey) changeFeed(() => setSortKey(option.key));
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
              <button
                type="button"
                className={`trash-empty-button${confirmEmptyTrash ? " is-confirm" : ""}`}
                onClick={() => {
                  if (!confirmEmptyTrash) {
                    setConfirmEmptyTrash(true);
                    return;
                  }
                  setConfirmEmptyTrash(false);
                  void handleEmptyTrash();
                }}
                onBlur={() => setConfirmEmptyTrash(false)}
              >
                <Trash2 size={14} aria-hidden="true" />
                {confirmEmptyTrash
                  ? tr(`Delete ${count(trashedMemos.length, "memo")} forever?`, `彻底删除 ${count(trashedMemos.length, "memo")}？`)
                  : tr("Empty Trash", "清空回收站")}
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

        <section className="memo-feed" aria-label={view === "trash" ? tr("Trash", "回收站") : tr("Memo list", "笔记列表")}>
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
            feedMemos.slice(0, renderCap).map((memo, index) => (
              <FeedItem
                key={memo.id}
                memo={memo}
                variant={view === "trash" ? "trash" : "normal"}
                knownTags={knownTags}
                editing={editingId === memo.id}
                savingEdit={editingId === memo.id && savingEdit}
                vtName={index < 32 ? `memo-${memo.id}` : undefined}
                getEntering={getEntering}
                delay={Math.min(index, 12) * 0.045}
                handlers={feedHandlers}
              />
            ))
          )}
          {hasMoreFeed ? <div ref={feedSentinelRef} className="feed-sentinel" aria-hidden="true" /> : null}
        </section>
      </main>

      {lightbox ? <Lightbox items={lightbox.items} index={lightbox.index} onClose={() => setLightbox(null)} /> : null}
      {statsOpen ? <StatsModal memos={activeMemos} uniqueTagCount={uniqueTagCount} onClose={() => setStatsOpen(false)} /> : null}
      <input
        ref={importFileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleImportFile(file);
        }}
      />
      {importTarget ? (
        <ConfirmDialog
          title={tr("Import this backup?", "导入这份备份？")}
          body={tr(
            `It contains ${count(importTarget.memoCount, "memo")} and ${importTarget.imageCount} image${importTarget.imageCount === 1 ? "" : "s"}. Memos that already exist are skipped; nothing is overwritten.`,
            `备份包含 ${count(importTarget.memoCount, "memo")}、${importTarget.imageCount} 张图片。已存在的笔记会自动跳过，不会覆盖任何内容。`
          )}
          confirmLabel={tr("Import", "导入")}
          busyLabel={tr("Importing…", "导入中…")}
          busy={dialogBusy}
          onCancel={() => setImportTarget(null)}
          onConfirm={() => void handleImportConfirmed()}
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
        <div key={toast.id} className={`toast${toast.tone === "error" ? " is-error" : ""}${toast.leaving ? " is-leaving" : ""}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
