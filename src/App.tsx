import { Calendar, CalendarRange, Check, ChevronDown, ChevronRight, Home, ListChecks, Loader2, Menu as MenuIcon, NotebookPen, Search, Trash2, X } from "lucide-react";
import { memo as reactMemo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChangePasscode } from "./components/ChangePasscode";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Crumbs } from "./components/Crumbs";
import { Editor } from "./components/Editor";
import { FilterChip } from "./components/FilterChip";
import { Lightbox } from "./components/Lightbox";
import { LoginScreen } from "./components/LoginScreen";
import { MemoCard } from "./components/MemoCard";
import { Menu } from "./components/Menu";
import { PromptDialog } from "./components/PromptDialog";
import { RollingText } from "./components/RollingText";
import { ScrollTopButton } from "./components/ScrollTopButton";
import { FACET_ROWS, SearchFilter } from "./components/SearchFilter";
import { Sidebar } from "./components/Sidebar";
import { StatsModal } from "./components/StatsModal";
import { SwapText } from "./components/SwapText";
import { useModalA11y } from "./hooks/useModalA11y";
import {
  AuthRequiredError,
  ApiError,
  bootstrap,
  createMemo,
  emptyTrash,
  exportData,
  getAuthStatus,
  importDataInChunks,
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
import { adoptCacheKey, forgetCacheKey, invalidateSnapshot, openSnapshot, readSealedSnapshot, saveSnapshot } from "./lib/cache";
import { dateKey, formatDayLabel } from "./lib/dates";
import { advanceFeedWindow, feedWindowCap, filterPreservingId, type FeedWindow } from "./lib/feedSafety";
import { useI18n } from "./lib/i18n";
import { memoMatchesSubmittedDraft } from "./lib/memoRecovery";
import { SAVED_FILTERS_LIMIT, loadSavedFilters, persistSavedFilters, type SavedFilter } from "./lib/savedFilters";
import {
  EMPTY_FILTERS,
  filtersEqual,
  hasActiveFilters,
  memoMatchesFilters,
  memoMatchesQuery,
  parseSearchQuery,
  queryIsEmpty,
  type FacetKey,
  type FeedFilters
} from "./lib/search";
import { selectionWithinVisibleIds } from "./lib/selection";
import { countsByDay, dayKeyOf } from "./lib/stats";
import { applySyncDelta, createSyncState, memosOf, purgedOf, tagsOfState, type PurgedMemo } from "./lib/syncState";
import { buildTagTree, isValidTagPath, tagMatches, tagRenamePathsOverlap, tagsOf } from "./lib/tags";
import { applyTheme, loadTheme, nextTheme, type ThemeChoice } from "./lib/theme";
import type { LightboxItem, Memo, NewImagePayload, SortKey, TagMeta } from "./lib/types";
import { useSync } from "./lib/useSync";
import { withViewTransition } from "./lib/viewTransition";

type Phase = "checking" | "error" | "login" | "ready";
type View = "memos" | "trash";

interface ToastState {
  id: number;
  text: string;
  tone: "info" | "error";
  /** Plays the exit animation before the node unmounts. */
  leaving?: boolean;
}

const SORT_KEYS: SortKey[] = ["created-desc", "created-asc", "updated-desc", "updated-asc"];
const EMPTY_TAGS: string[] = [];

async function mapSettledWithLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

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
  saveEdit: (memo: Memo, data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  acceptEditConflict: (id: string) => void;
  togglePin: (memo: Memo) => void;
  copy: (memo: Memo) => void;
  trash: (memo: Memo) => void;
  restore: (memo: Memo) => void;
  purge: (memo: Memo) => void;
  pickTag: (path: string) => void;
  openImage: (items: LightboxItem[], index: number) => void;
  toggleSelect: (memo: Memo) => void;
}

interface FeedItemProps {
  memo: Memo;
  variant: "normal" | "trash";
  knownTags: string[];
  editing: boolean;
  savingEdit: boolean;
  editConflict: boolean;
  selecting: boolean;
  selected: boolean;
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
  function FeedItem({ memo, variant, knownTags, editing, savingEdit, editConflict, selecting, selected, vtName, getEntering, delay, handlers }: FeedItemProps) {
    return (
      <MemoSlot vtName={vtName} entering={getEntering()} delay={delay}>
        <MemoCard
          memo={memo}
          variant={variant}
          knownTags={knownTags}
          editing={editing}
          savingEdit={savingEdit}
          editConflict={editConflict}
          selecting={selecting}
          selected={selected}
          onToggleSelect={() => handlers.toggleSelect(memo)}
          onStartEdit={() => handlers.startEdit(memo.id)}
          onCancelEdit={handlers.cancelEdit}
          onSaveEdit={(data) => handlers.saveEdit(memo, data)}
          onAcceptEditConflict={() => handlers.acceptEditConflict(memo.id)}
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
    prev.editConflict === next.editConflict &&
    prev.selecting === next.selecting &&
    prev.selected === next.selected &&
    prev.vtName === next.vtName &&
    prev.handlers === next.handlers
);

export default function App() {
  const { count, errorMessage, language, locale, tr } = useI18n();
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
  const [syncState, setSyncState] = useState(() => createSyncState());
  // Cursor paired with the rendered state for cache persistence. The network
  // cursor may advance just before React commits a delta; stamping that newer
  // cursor onto the previous render could make a warm start skip the delta.
  const [snapshotCursor, setSnapshotCursor] = useState(0);
  const [snapshotSyncEpoch, setSnapshotSyncEpoch] = useState("");
  const syncStateRef = useRef(syncState);
  syncStateRef.current = syncState;
  // Invalidates results from requests that started under an older session.
  // This matters when a delayed mutation resolves after logout + re-login:
  // its response must never be merged into the newly bootstrapped notebook.
  const sessionEpochRef = useRef(0);
  const skipNextSnapshotSaveRef = useRef(false);
  const memos = useMemo(() => memosOf(syncState), [syncState.memos]);
  const pinnedTags = useMemo(
    () => new Map([...syncState.tags.values()].filter((tag) => tag.pinnedAt).map((tag) => [tag.path, tag.pinnedAt as string])),
    [syncState.tags]
  );
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);

  const [view, setView] = useState<View>("memos");
  const [sortKey, setSortKey] = useState<SortKey>(loadSortKey);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<FeedFilters>(EMPTY_FILTERS);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(loadSavedFilters);
  // Names the current filter combination via PromptDialog.
  const [savingFilter, setSavingFilter] = useState(false);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const editingBaseSeqRef = useRef<number | null>(null);
  const [editConflictId, setEditConflictId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Multi-select mode: entered from the location dropdown, exits via 取消 /
  // Escape / view switches / a fully successful batch delete.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Two-step batch delete, mirroring Empty Trash: arm, then fire.
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const confirmBatchDeleteRef = useRef(false);
  confirmBatchDeleteRef.current = confirmBatchDelete;
  const [batchBusy, setBatchBusy] = useState(false);
  const [renameTagTarget, setRenameTagTarget] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  // Two-step Empty Trash: first click arms the button, second click fires.
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  // While the delete request is in flight the pill must hold its armed look
  // (blur/timeout disarms would snap it back to "Empty Trash" mid-flight),
  // so the disarm paths and re-fires check this ref.
  const emptyTrashBusyRef = useRef(false);
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
  const bootAttemptRef = useRef(0);
  const drawerCloseTimerRef = useRef(0);
  const drawerCallbackFrameRef = useRef(0);
  const drawerAfterCloseRef = useRef<Array<() => void>>([]);
  const logoutBusyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;

  const showToast = useCallback((text: string, tone: "info" | "error" = "info") => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, tone });
    toastTimer.current = window.setTimeout(() => {
      setToast((current) => (current ? { ...current, leaving: true } : current));
      toastTimer.current = window.setTimeout(() => setToast(null), 170);
    }, 2400);
  }, []);

  const resetSessionUi = useCallback(() => {
    window.clearTimeout(drawerCloseTimerRef.current);
    window.cancelAnimationFrame(drawerCallbackFrameRef.current);
    drawerAfterCloseRef.current = [];
    emptyTrashBusyRef.current = false;
    confirmBatchDeleteRef.current = false;
    editingBaseSeqRef.current = null;
    skipNextSnapshotSaveRef.current = false;

    setSyncState(createSyncState());
    setSnapshotCursor(0);
    setSnapshotSyncEpoch("");
    setActiveTag(null);
    setActiveDay(null);
    setQuery("");
    setSearchOpen(false);
    setFilters(EMPTY_FILTERS);
    setSavingFilter(false);
    setView("memos");
    setCreating(false);
    setEditingId(null);
    setEditConflictId(null);
    setSavingEdit(false);
    setSelectMode(false);
    setSelected(new Set());
    setConfirmBatchDelete(false);
    setBatchBusy(false);
    setRenameTagTarget(null);
    setDialogBusy(false);
    setConfirmEmptyTrash(false);
    setImportTarget(null);
    setLightbox(null);
    setStatsOpen(false);
    setChangingPasscode(false);
    setDrawerOpen(false);
    setDrawerClosing(false);
    setReveal(false);
  }, []);

  const drawerRef = useModalA11y<HTMLElement>({
    enabled: drawerOpen,
    onEscape: () => closeDrawer(),
    allowOutsideSelector: "[role='menu']",
    isolateExemptSelector: ".drawer-backdrop"
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("memo-sort", sortKey);
  }, [sortKey]);

  useEffect(() => {
    persistSavedFilters(savedFilters);
  }, [savedFilters]);

  const applySyncChanges = useCallback((changed: readonly Memo[], purged: readonly PurgedMemo[], tags: readonly TagMeta[], cursor?: number) => {
    setSyncState((current) => applySyncDelta(current, { memos: changed, purged, tags }));
    if (cursor !== undefined) setSnapshotCursor((current) => Math.max(current, cursor));
  }, []);

  const dropToLogin = useCallback(() => {
    sessionEpochRef.current += 1;
    forgetCacheKey();
    resetSessionUi();
    setPhase("login");
    showToast(tr("Your session expired. Enter your passcode again.", "登录已过期，请重新输入密码"), "error");
  }, [resetSessionUi, showToast, tr]);

  const handlePeerLogout = useCallback(() => {
    sessionEpochRef.current += 1;
    void invalidateSnapshot();
    forgetCacheKey();
    resetSessionUi();
    setPhase("login");
    showToast(tr("Another tab logged out. Enter your passcode again.", "另一个标签页已退出，请重新输入密码"), "error");
  }, [resetSessionUi, showToast, tr]);

  const handleServerReset = useCallback(() => {
    sessionEpochRef.current += 1;
    void invalidateSnapshot().finally(() => window.location.reload());
  }, []);

  const { setCursor, setSyncEpoch, runSync, notifyPeers, notifyLogout } = useSync({
    // Changing the passcode rotates session_generation and the cookie. Abort
    // old-cookie heartbeats during that window so a legitimate success cannot
    // be followed by a stale 401 that drops every tab back to the gate.
    enabled: phase === "ready" && !changingPasscode,
    applyChanges: applySyncChanges,
    onAuthLost: dropToLogin,
    onPeerLogout: handlePeerLogout,
    onServerReset: handleServerReset
  });

  /** Apply a mutation response locally, then reconcile cursor + sibling tabs. */
  const commitMutation = useCallback(
    (delta: { memos?: Memo[]; purged?: PurgedMemo[]; tags?: TagMeta[] }) => {
      applySyncChanges(delta.memos ?? [], delta.purged ?? [], delta.tags ?? []);
      void runSync();
      notifyPeers();
    },
    [applySyncChanges, runSync, notifyPeers]
  );

  const enterApp = useCallback(
    async (withReveal: boolean) => {
      // Warm start: with a sealed local snapshot, one incremental sync
      // replaces the full-notebook bootstrap — startup traffic stays
      // constant-size no matter how large the notebook grows. Auth errors
      // propagate to the caller exactly like the bootstrap path's.
      let entered = false;
      skipNextSnapshotSaveRef.current = false;
      const sealed = await readSealedSnapshot();
      if (sealed) {
        let delta = await syncSince(sealed.cursor, { includeCacheKey: true });
        adoptCacheKey(delta.cacheKey);
        const snapshot = await openSnapshot(sealed);
        // The server epoch catches a replaced database even when its new
        // numeric counter has already grown past this sleeping client.
        if (snapshot && delta.syncEpoch === snapshot.syncEpoch && delta.cursor >= sealed.cursor) {
          const warmSyncEpoch = snapshot.syncEpoch;
          let warmValid = true;
          let nextState = createSyncState(snapshot.memos, snapshot.tags, snapshot.purged);
          let warmChanged = delta.memos.length > 0 || delta.purged.length > 0 || delta.tags.length > 0;
          nextState = applySyncDelta(nextState, delta);
          let cursor = delta.cursor;
          while (delta.hasMore) {
            const previous = cursor;
            delta = await syncSince(cursor);
            adoptCacheKey(delta.cacheKey);
            if (delta.syncEpoch !== warmSyncEpoch) {
              warmValid = false;
              break;
            }
            warmChanged ||= delta.memos.length > 0 || delta.purged.length > 0 || delta.tags.length > 0;
            nextState = applySyncDelta(nextState, delta);
            cursor = delta.cursor;
            if (cursor <= previous) throw new Error("Sync page did not advance its cursor");
          }
          if (warmValid) {
            setSyncState(nextState);
            setSnapshotCursor(cursor);
            setSnapshotSyncEpoch(warmSyncEpoch);
            setCursor(cursor);
            setSyncEpoch(warmSyncEpoch);
            // The sealed record is already the exact working set when the warm
            // delta is empty. Avoid immediately re-encrypting the same notebook.
            skipNextSnapshotSaveRef.current = !warmChanged;
            entered = true;
          }
        }
        if (!entered) {
          // Corrupt ciphertext, a rotated cache key, or a lower server cursor
          // / different server epoch means this record belongs to unusable
          // history. Clear it before cold bootstrap.
          await invalidateSnapshot();
        }
      }
      if (!entered) {
        let page = await bootstrap();
        adoptCacheKey(page.cacheKey);
        const snapshotCursor = page.cursor;
        const bootstrapSyncEpoch = page.syncEpoch;
        let nextState = createSyncState(page.memos, page.tags);
        let after = page.nextAfter;
        while (page.hasMore) {
          if (after === undefined || after === null) throw new Error("Bootstrap page is missing its continuation cursor");
          const previous = after;
          page = await bootstrap(after, snapshotCursor);
          if (page.syncEpoch !== bootstrapSyncEpoch) throw new Error("Database history changed during bootstrap");
          adoptCacheKey(page.cacheKey);
          nextState = applySyncDelta(nextState, { memos: page.memos, tags: page.tags });
          after = page.nextAfter;
          if (page.hasMore && (after === undefined || after === null || after === previous)) {
            throw new Error("Bootstrap page did not advance its continuation cursor");
          }
        }
        setSyncState(nextState);
        setSnapshotCursor(snapshotCursor);
        setSnapshotSyncEpoch(bootstrapSyncEpoch);
        setCursor(snapshotCursor);
        setSyncEpoch(bootstrapSyncEpoch);
      }
      setBootError(null);
      setPhase("ready");
      if (withReveal) {
        setReveal(true);
        window.setTimeout(() => setReveal(false), 350);
      }
    },
    [setCursor, setSyncEpoch]
  );

  // Persist the working set (sealed) once changes settle.
  useEffect(() => {
    if (phase !== "ready" || !snapshotSyncEpoch) return;
    if (skipNextSnapshotSaveRef.current) {
      skipNextSnapshotSaveRef.current = false;
      return;
    }
    let idleId = 0;
    let fallbackId = 0;
    const save = () => {
      void saveSnapshot({
        cursor: snapshotCursor,
        syncEpoch: snapshotSyncEpoch,
        memos,
        tags: tagsOfState(syncState),
        purged: purgedOf(syncState)
      });
    };
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(save, { timeout: 3_000 });
      } else {
        fallbackId = window.setTimeout(save, 0);
      }
    }, 600);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(fallbackId);
      if (idleId) window.cancelIdleCallback(idleId);
    };
  }, [phase, snapshotCursor, snapshotSyncEpoch, syncState, memos]);

  const runInitialBoot = useCallback(async () => {
    const attempt = ++bootAttemptRef.current;
    setBootError(null);
    setPhase("checking");

    let status: Awaited<ReturnType<typeof getAuthStatus>>;
    try {
      status = await getAuthStatus();
    } catch (cause) {
      if (attempt !== bootAttemptRef.current) return;
      setBootError(errorMessageRef.current(cause, "Couldn’t connect to the server", "无法连接服务器"));
      setPhase("error");
      return;
    }

    if (attempt !== bootAttemptRef.current) return;
    setNeedsSetup(status.needsSetup);
    if (status.needsSetup) {
      setPhase("login");
      return;
    }

    try {
      await enterApp(false);
    } catch (cause) {
      if (attempt !== bootAttemptRef.current) return;
      if (cause instanceof AuthRequiredError) {
        setPhase("login");
      } else {
        setBootError(errorMessageRef.current(cause, "Couldn’t load your memos", "加载失败"));
        setPhase("error");
      }
    }
  }, [enterApp]);

  useEffect(() => {
    void runInitialBoot();
    return () => {
      bootAttemptRef.current += 1;
    };
  }, [runInitialBoot]);

  /** Session-expiry aware wrapper: any 401 mid-use drops back to the gate. */
  const guard = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      const epoch = sessionEpochRef.current;
      try {
        const result = await action();
        return epoch === sessionEpochRef.current ? result : undefined;
      } catch (cause) {
        if (epoch !== sessionEpochRef.current) return undefined;
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

  useEffect(() => {
    if (!activeTag) return;
    const stillExists = activeMemos.some((memo) => tagsOf(memo).some((tag) => tagMatches(tag, activeTag)));
    if (!stillExists) setActiveTag(null);
  }, [activeTag, activeMemos]);

  useEffect(() => {
    if (!editingId) {
      editingBaseSeqRef.current = null;
      setEditConflictId(null);
      return;
    }
    const current = syncState.memos.get(editingId);
    if (!current || current.deletedAt) {
      setEditingId(null);
      setEditConflictId(null);
      showToast(tr("This memo was removed elsewhere, so editing was closed.", "这条笔记已在别处删除，编辑已关闭"), "error");
      return;
    }
    const baseSeq = editingBaseSeqRef.current;
    if (baseSeq !== null && current.seq > baseSeq) setEditConflictId(editingId);
  }, [editingId, syncState.memos, showToast, tr]);

  const trimmedQuery = query.trim().toLowerCase();
  // Filtering follows the keystroke at deferred priority: the input never
  // waits for a big feed to re-render.
  const deferredQuery = useDeferredValue(trimmedQuery);
  // Keywords AND together; "quoted" runs must match as whole phrases.
  const parsedQuery = useMemo(() => parseSearchQuery(deferredQuery), [deferredQuery]);
  const structuredFiltersOn = hasActiveFilters(filters);
  const filtersActive = activeTag !== null || activeDay !== null || trimmedQuery.length > 0 || structuredFiltersOn;

  const visibleMemos = useMemo(() => {
    let list = activeMemos;
    if (activeTag) {
      list = filterPreservingId(list, editingId, (memo) => tagsOf(memo).some((tag) => tagMatches(tag, activeTag)));
    }
    if (activeDay) {
      list = filterPreservingId(list, editingId, (memo) => dayKeyOf(memo) === activeDay);
    }
    if (hasActiveFilters(filters)) {
      list = filterPreservingId(list, editingId, (memo) => memoMatchesFilters(memo, filters));
    }
    if (!queryIsEmpty(parsedQuery)) {
      list = filterPreservingId(list, editingId, (memo) => memoMatchesQuery(memo, parsedQuery));
    }
    const compare = SORT_COMPARATORS[sortKey];
    return [...list].sort((a, b) => {
      if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
      return compare(a, b);
    });
  }, [activeMemos, activeTag, activeDay, filters, parsedQuery, editingId, sortKey]);

  const feedMemos = view === "trash" ? trashedMemos : visibleMemos;
  const visibleFeedIds = useMemo(() => feedMemos.map((memo) => memo.id), [feedMemos]);
  const visibleSelected = useMemo(() => selectionWithinVisibleIds(selected, visibleFeedIds), [selected, visibleFeedIds]);

  // The feed renders in pages: the first FEED_PAGE rows immediately, more as
  // the sentinel scrolls near. Keeps first paint and filter swaps flat no
  // matter how many memos exist.
  // Object identity is the generation token: revisiting an earlier query must
  // still start a fresh window rather than reviving that query's old cap.
  const feedWindowKey = useMemo(
    () => ({}),
    [view, activeTag, activeDay, deferredQuery, filters, sortKey]
  );
  const [renderWindow, setRenderWindow] = useState<FeedWindow<object>>({ key: {}, cap: FEED_PAGE });
  // Resolve a stale generation synchronously during render. An effect would
  // reconcile the previous, potentially huge window once before shrinking it.
  const renderCap = feedWindowCap(renderWindow, feedWindowKey, FEED_PAGE);
  const renderedFeedMemos = useMemo(() => {
    const rendered = feedMemos.slice(0, renderCap);
    if (!editingId || rendered.some((memo) => memo.id === editingId)) return rendered;
    const editingMemo = feedMemos.find((memo) => memo.id === editingId);
    return editingMemo ? [...rendered, editingMemo] : rendered;
  }, [feedMemos, renderCap, editingId]);
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
          setRenderWindow((current) => advanceFeedWindow(current, feedWindowKey, FEED_PAGE));
        }
      },
      { rootMargin: "1200px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [feedWindowKey, hasMoreFeed, renderCap]);

  function closeDrawer(afterClose?: () => void) {
    if (!drawerOpen) {
      afterClose?.();
      return;
    }
    if (afterClose) drawerAfterCloseRef.current.push(afterClose);
    if (drawerClosing) return;
    setDrawerClosing(true);
    window.clearTimeout(drawerCloseTimerRef.current);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 170;
    drawerCloseTimerRef.current = window.setTimeout(() => {
      setDrawerOpen(false);
      setDrawerClosing(false);
      if (drawerAfterCloseRef.current.length > 0) {
        window.cancelAnimationFrame(drawerCallbackFrameRef.current);
        drawerCallbackFrameRef.current = window.requestAnimationFrame(() => {
          const callbacks = drawerAfterCloseRef.current.splice(0);
          for (const callback of callbacks) callback();
        });
      }
    }, delay);
  }

  useEffect(
    () => () => {
      window.clearTimeout(drawerCloseTimerRef.current);
      window.cancelAnimationFrame(drawerCallbackFrameRef.current);
      drawerAfterCloseRef.current = [];
    },
    []
  );

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
            setRenderWindow((current) => ({ ...current, cap: FEED_PAGE }));
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

  const blockNavigationWhileEditing = useCallback(() => {
    if (!editingId) return false;
    showToast(tr("Save or cancel the open edit before changing views.", "请先保存或取消当前编辑，再切换视图"), "error");
    return true;
  }, [editingId, showToast, tr]);

  const pickTag = useCallback(
    (path: string | null) => {
      if (blockNavigationWhileEditing()) return;
      if (view === "memos" && activeTag === path) {
        return;
      }
      changeFeed(() => {
        setActiveTag(path);
        setView("memos");
      });
    },
    [view, activeTag, changeFeed, blockNavigationWhileEditing]
  );

  const pickDay = useCallback(
    (key: string | null) => {
      if (blockNavigationWhileEditing()) return;
      if (view === "memos" && activeDay === key) {
        return;
      }
      changeFeed(() => {
        setActiveDay(key);
        setView("memos");
      });
    },
    [view, activeDay, changeFeed, blockNavigationWhileEditing]
  );

  const showAll = useCallback(() => {
    if (blockNavigationWhileEditing()) return;
    if (view === "memos" && activeTag === null && activeDay === null && query.length === 0 && !hasActiveFilters(filters)) {
      return;
    }
    changeFeed(() => {
      setActiveTag(null);
      setActiveDay(null);
      setQuery("");
      setFilters(EMPTY_FILTERS);
      setView("memos");
    });
  }, [view, activeTag, activeDay, query, filters, changeFeed, blockNavigationWhileEditing]);

  /** Facet on/off is a discrete choice — it rides the same feed morph as a
      tag or sort change, whether it comes from the panel or a chip's ×. */
  const toggleFacet = useCallback(
    (key: FacetKey) => {
      if (blockNavigationWhileEditing()) return;
      changeFeed(() => setFilters((current) => ({ ...current, [key]: !current[key] })));
    },
    [changeFeed, blockNavigationWhileEditing]
  );

  // Date edits arrive segment-by-segment from the native inputs — update in
  // place like search keystrokes instead of morphing per keypress.
  const patchDateRange = useCallback(
    (patch: Partial<Pick<FeedFilters, "dateFrom" | "dateTo">>) => {
      if (blockNavigationWhileEditing()) return;
      setFilters((current) => ({ ...current, ...patch }));
    },
    [blockNavigationWhileEditing]
  );

  const clearDateRange = useCallback(() => {
    if (blockNavigationWhileEditing()) return;
    changeFeed(() => setFilters((current) => ({ ...current, dateFrom: null, dateTo: null })));
  }, [changeFeed, blockNavigationWhileEditing]);

  /** A preset restores the whole feed context in one morph. */
  const applySavedFilter = useCallback(
    (item: SavedFilter) => {
      if (blockNavigationWhileEditing()) return;
      changeFeed(() => {
        setView("memos");
        setActiveTag(item.tag);
        setActiveDay(item.day);
        setQuery(item.query);
        setFilters(item.filters);
      });
    },
    [changeFeed, blockNavigationWhileEditing]
  );

  const deleteSavedFilter = useCallback(
    (item: SavedFilter) => {
      setSavedFilters((current) => current.filter((entry) => entry.id !== item.id));
      showToast(tr("Saved filter removed", "已删除保存的筛选"));
    },
    [showToast, tr]
  );

  function handleSaveFilterConfirmed(name: string) {
    const snapshot = { name, query: query.trim(), tag: activeTag, day: activeDay, filters };
    setSavedFilters((current) => {
      const existing = current.find((entry) => entry.name === name);
      if (existing) return current.map((entry) => (entry.id === existing.id ? { ...snapshot, id: existing.id } : entry));
      return [...current, { ...snapshot, id: crypto.randomUUID() }];
    });
    setSavingFilter(false);
    showToast(tr("Filter saved", "筛选已保存"));
  }

  // The preset whose snapshot equals the live feed state — its row gets the
  // check mark, mirroring the sort menu's radio language.
  const activeSavedId = useMemo(() => {
    const match = savedFilters.find(
      (item) =>
        item.tag === activeTag &&
        item.day === activeDay &&
        item.query.trim().toLowerCase() === trimmedQuery &&
        filtersEqual(item.filters, filters)
    );
    return match?.id ?? null;
  }, [savedFilters, activeTag, activeDay, trimmedQuery, filters]);

  // Breadcrumb chip text for the date range; reversed ends still read as the
  // span between them (the predicate normalizes the same way).
  const rangeChipLabel = useMemo(() => {
    const { dateFrom, dateTo } = filters;
    if (dateFrom !== null && dateTo !== null) {
      const [lo, hi] = dateFrom <= dateTo ? [dateFrom, dateTo] : [dateTo, dateFrom];
      return lo === hi ? formatDayLabel(lo, locale) : `${formatDayLabel(lo, locale)} – ${formatDayLabel(hi, locale)}`;
    }
    if (dateFrom !== null) return tr(`From ${formatDayLabel(dateFrom, locale)}`, `${formatDayLabel(dateFrom, locale)} 起`);
    if (dateTo !== null) return tr(`Until ${formatDayLabel(dateTo, locale)}`, `${formatDayLabel(dateTo, locale)} 止`);
    return null;
  }, [filters, locale, tr]);

  // Filter-chip entrance choreography, Crumbs-style: chips new this commit
  // cascade in behind the pill on a short capped ripple, while chips already in the trail sit
  // still. The identity list is by lens ("day", "range", facet keys) — the
  // day chip keeps its identity across repicks, so changing days morphs the
  // label in place instead of replaying an entrance. The previous list
  // updates in a layout effect, after the render that compared against it.
  const chipKeys = useMemo(() => {
    if (view !== "memos" || selectMode) return [];
    const keys: string[] = [];
    if (activeDay) keys.push("day");
    if (rangeChipLabel) keys.push("range");
    for (const row of FACET_ROWS) if (filters[row.key]) keys.push(row.key);
    return keys;
  }, [view, selectMode, activeDay, rangeChipLabel, filters]);
  const prevChipsRef = useRef<string[]>([]);
  const prevChips = prevChipsRef.current;
  useLayoutEffect(() => {
    prevChipsRef.current = chipKeys;
  }, [chipKeys]);
  let newChipCount = 0;
  const chipDelay = (key: string) => (prevChips.includes(key) ? undefined : `${Math.min(newChipCount++, 3) * 0.02}s`);

  const openTrash = useCallback(() => {
    if (blockNavigationWhileEditing()) return;
    if (view === "trash") return;
    changeFeed(() => {
      setView("trash");
      // Same flush: the "已选 N 条" pill hands topbar-action to the Empty
      // Trash pill inside one morph instead of two competing transitions.
      setSelectMode(false);
      setSelected(new Set());
      setConfirmBatchDelete(false);
    });
  }, [view, changeFeed, blockNavigationWhileEditing]);

  /**
   * Select mode swaps the whole breadcrumb row for the selection toolbar; a
   * view transition carries the swap — the fused location pill morphs into
   * the "已选 N 条" counter (they share view-transition-name: topbar-action)
   * while the card checkboxes pop in via their own CSS transitions.
   */
  const enterSelectMode = useCallback(() => {
    if (blockNavigationWhileEditing()) return;
    withViewTransition(() =>
      flushSync(() => {
        setSelectMode(true);
        setSelected(new Set());
        setConfirmBatchDelete(false);
      })
    );
  }, [blockNavigationWhileEditing]);

  const exitSelectMode = useCallback(() => {
    withViewTransition(() =>
      flushSync(() => {
        setSelectMode(false);
        setSelected(new Set());
        setConfirmBatchDelete(false);
      })
    );
  }, []);

  /**
   * Selection changes are instant setState — a view transition per card tap
   * would throttle rapid toggling. The one exception: while the delete pill
   * is armed, any selection change disarms it, and THAT label/width change
   * deserves the same morph arming got.
   */
  const mutateSelection = useCallback((apply: () => void) => {
    if (confirmBatchDeleteRef.current) {
      withViewTransition(() =>
        flushSync(() => {
          setConfirmBatchDelete(false);
          apply();
        })
      );
    } else {
      apply();
    }
  }, []);

  const toggleSelect = useCallback(
    (memo: Memo) => {
      mutateSelection(() =>
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(memo.id)) next.delete(memo.id);
          else next.add(memo.id);
          return next;
        })
      );
    },
    [mutateSelection]
  );

  async function handleLogin(pin: string) {
    sessionEpochRef.current += 1;
    await login(pin);
    try {
      await enterApp(true);
    } catch (cause) {
      if (cause instanceof AuthRequiredError) throw cause;
      setBootError(errorMessage(cause, "Couldn’t load your memos", "加载失败"));
      setPhase("error");
    }
  }

  async function handleSetup(pin: string) {
    sessionEpochRef.current += 1;
    await setupPassword(pin);
    setNeedsSetup(false);
    try {
      await enterApp(true);
    } catch (cause) {
      if (cause instanceof AuthRequiredError) throw cause;
      setBootError(errorMessage(cause, "Couldn’t load your memos", "加载失败"));
      setPhase("error");
    }
  }

  async function handleLogout() {
    if (logoutBusyRef.current) return;
    logoutBusyRef.current = true;
    try {
      const result = await logout();
      if (!result.ok) throw new ApiError("LOGOUT_FAILED", 500, "The server did not confirm logout");
    } catch (cause) {
      if (!(cause instanceof AuthRequiredError)) {
        showToast(tr("Logout wasn’t confirmed. Your session remains open.", "退出未得到服务器确认，当前登录仍然有效"), "error");
        return;
      }
    } finally {
      logoutBusyRef.current = false;
    }

    sessionEpochRef.current += 1;
    notifyLogout();
    forgetCacheKey();
    resetSessionUi();
    setPhase("login");
    try {
      await invalidateSnapshot();
    } catch {
      // The authenticated server session is already closed. A stale encrypted
      // local snapshot cannot be opened after forgetCacheKey().
    }
  }

  async function handleCreate(data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }): Promise<boolean> {
    setCreating(true);
    try {
      const result = await guard(() => createMemo(data.clientId, data.content, data.newImages));
      if (!result) return false;
      let saved = result.memo;
      if (result.idempotent) {
        // The first create committed but its response was lost. Apply any edits
        // made to the still-open draft as a version-checked update instead of
        // clearing them or creating a duplicate memo.
        const draftImageIds = new Set(data.newImages.map((image) => image.id));
        const storedImageIds = new Set(saved.images.map((image) => image.id));
        const resumed = await guard(() =>
          updateMemo(saved.id, {
            expectedSeq: saved.seq,
            content: data.content,
            addImages: data.newImages.filter((image) => !storedImageIds.has(image.id)),
            removeImageIds: saved.images.filter((image) => !draftImageIds.has(image.id)).map((image) => image.id)
          })
        );
        if (!resumed?.memo) return false;
        saved = resumed.memo;
      }
      commitMutation({ memos: [saved] });
      for (const image of data.newImages) URL.revokeObjectURL(image.previewUrl);
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "VERSION_CONFLICT") {
        if (cause.current) {
          if (memoMatchesSubmittedDraft(cause.current, data.content, data.newImages.map((image) => image.id))) {
            // The recovery update itself committed but its response was lost.
            // The desired server value is authoritative success; clearing this
            // draft avoids rotating the id and creating a duplicate memo.
            commitMutation({ memos: [cause.current] });
            for (const image of data.newImages) URL.revokeObjectURL(image.previewUrl);
            return true;
          }
          applySyncChanges([cause.current], [], []);
        }
        void runSync();
        throw cause;
      }
      throw cause;
    } finally {
      setCreating(false);
    }
  }

  function reconcileVersionConflict(cause: unknown, preserveDraft = false): boolean {
    if (!(cause instanceof ApiError) || cause.code !== "VERSION_CONFLICT") return false;
    if (cause.current) applySyncChanges([cause.current], [], []);
    void runSync();
    if (preserveDraft && editingId) setEditConflictId(editingId);
    showToast(
      preserveDraft
        ? tr("A newer version arrived. Your draft is safe; review it before saving again.", "远端已有新版本，草稿已保留；请确认后再次保存")
        : tr("This memo changed elsewhere. The latest version is now shown.", "这条笔记已在别处更新，已显示最新版本"),
      "error"
    );
    return true;
  }

  async function handleSaveEdit(memo: Memo, data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }): Promise<boolean> {
    setSavingEdit(true);
    try {
      const result = await guard(() =>
        updateMemo(memo.id, {
          expectedSeq: editingBaseSeqRef.current ?? memo.seq,
          content: data.content,
          addImages: data.newImages,
          removeImageIds: data.removeImageIds
        })
      );
      if (!result?.memo) return false;
      commitMutation({ memos: [result.memo] });
      setEditingId(null);
      setEditConflictId(null);
      editingBaseSeqRef.current = null;
      showToast(tr("Saved", "已保存"));
      return true;
    } catch (cause) {
      if (reconcileVersionConflict(cause, true)) return false;
      throw cause;
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleTogglePin(memo: Memo) {
    try {
      const result = await guard(() => updateMemo(memo.id, { expectedSeq: memo.seq, pinned: !memo.pinnedAt }));
      if (!result) return;
      const nextMemo = result.memo ?? (result.memoPatch ? { ...memo, ...result.memoPatch } : null);
      if (!nextMemo) return;
      // Pinning reorders the feed — let the card glide to its new slot.
      withViewTransition(() => flushSync(() => applySyncChanges([nextMemo], [], [])));
      void runSync();
      notifyPeers();
      showToast(nextMemo.pinnedAt ? tr("Pinned", "已置顶") : tr("Unpinned", "已取消置顶"));
    } catch (cause) {
      if (reconcileVersionConflict(cause)) return;
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
    (changed: Memo[], purged: PurgedMemo[]) => {
      withViewTransition(() => flushSync(() => applySyncChanges(changed, purged, [])));
      void runSync();
      notifyPeers();
    },
    [applySyncChanges, runSync, notifyPeers]
  );

  async function handleTrash(memo: Memo) {
    try {
      const result = await guard(() => trashMemo(memo.id, memo.seq));
      if (!result) return;
      applyRemoval([result.memo], []);
      showToast(tr("Moved to Trash", "已移入回收站"));
    } catch (cause) {
      if (reconcileVersionConflict(cause)) return;
      showToast(errorMessage(cause, "Couldn’t delete the memo", "删除失败"), "error");
    }
  }

  async function handleRestore(memo: Memo) {
    try {
      const result = await guard(() => restoreMemo(memo.id, memo.seq));
      if (!result) return;
      applyRemoval([result.memo], []);
      showToast(tr("Restored", "已恢复"));
    } catch (cause) {
      if (reconcileVersionConflict(cause)) return;
      showToast(errorMessage(cause, "Couldn’t restore the memo", "恢复失败"), "error");
    }
  }

  async function handlePurge(memo: Memo) {
    try {
      const result = await guard(() => purgeMemo(memo.id, memo.seq));
      if (!result) return;
      applyRemoval([], result.purged);
      showToast(tr("Permanently deleted", "已彻底删除"));
    } catch (cause) {
      if (reconcileVersionConflict(cause)) return;
      showToast(errorMessage(cause, "Couldn’t delete the memo", "删除失败"), "error");
    }
  }

  async function handleEmptyTrash() {
    if (emptyTrashBusyRef.current) return;
    emptyTrashBusyRef.current = true;
    try {
      const result = await guard(() => emptyTrash());
      if (!result) {
        setConfirmEmptyTrash(false);
        return;
      }
      // Disarm inside the same transition that clears the cards: the red
      // confirm pill holds through the request and leaves in one morph,
      // never snapping back to a bare "Empty Trash" first.
      withViewTransition(() =>
        flushSync(() => {
          setConfirmEmptyTrash(false);
          applySyncChanges([], result.purged, []);
        })
      );
      void runSync();
      notifyPeers();
      showToast(tr("Trash emptied", "回收站已清空"));
    } catch (cause) {
      setEmptyTrashArm(false);
      showToast(errorMessage(cause, "Couldn’t empty Trash", "清空失败"), "error");
    } finally {
      emptyTrashBusyRef.current = false;
    }
  }

  /**
   * Batch delete rides the same removal choreography as a single delete: one
   * view transition in which every selected card recedes while the survivors
   * (and the selection toolbar collapsing back into the breadcrumb) glide.
   */
  async function handleBatchTrash() {
    const targets = [...visibleSelected]
      .map((id) => syncStateRef.current.memos.get(id))
      .filter((memo): memo is Memo => Boolean(memo && !memo.deletedAt));
    if (targets.length === 0 || batchBusy) return;
    const sessionEpoch = sessionEpochRef.current;
    setBatchBusy(true);
    try {
      const results = await mapSettledWithLimit(targets, 4, (memo) => trashMemo(memo.id, memo.seq));
      if (sessionEpoch !== sessionEpochRef.current) return;
      const changed: Memo[] = [];
      const failedIds: string[] = [];
      let authLost = false;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") changed.push(result.value.memo);
        else {
          failedIds.push(targets[index].id);
          if (result.reason instanceof AuthRequiredError) authLost = true;
          else reconcileVersionConflict(result.reason);
        }
      });
      if (authLost) {
        dropToLogin();
        return;
      }
      if (changed.length > 0) {
        withViewTransition(() =>
          flushSync(() => {
            applySyncChanges(changed, [], []);
            if (failedIds.length === 0) {
              // Job done — leave select mode in the same breath.
              setSelectMode(false);
              setSelected(new Set());
            } else {
              // Keep only the failures selected so a retry is one tap away.
              setSelected(new Set(failedIds));
            }
          })
        );
        void runSync();
        notifyPeers();
      }
      if (failedIds.length > 0) {
        showToast(tr(`Couldn’t delete ${count(failedIds.length, "memo")}`, `有 ${count(failedIds.length, "memo")} 删除失败`), "error");
      } else {
        showToast(tr(`Moved ${count(changed.length, "memo")} to Trash`, `已将 ${count(changed.length, "memo")} 移入回收站`));
      }
    } finally {
      setBatchBusy(false);
    }
  }

  // Latest closures behind one stable identity — FeedItem's memoization
  // survives every App re-render. (The handle* function declarations below
  // are hoisted, so assigning here each render is safe.)
  const feedActionsRef = useRef({
    startEdit: (id: string) => {
      const currentEditing = editingIdRef.current;
      if (currentEditing && currentEditing !== id) {
        showToast(tr("Save or cancel the open edit before editing another memo.", "请先保存或取消当前编辑，再编辑其他笔记"), "error");
        return;
      }
      editingBaseSeqRef.current = syncStateRef.current.memos.get(id)?.seq ?? null;
      setEditConflictId(null);
      setEditingId(id);
    },
    saveEdit: handleSaveEdit,
    togglePin: handleTogglePin,
    copy: handleCopy,
    trash: handleTrash,
    restore: handleRestore,
    purge: handlePurge,
    acceptEditConflict: (id: string) => {
      const current = syncStateRef.current.memos.get(id);
      if (!current || current.deletedAt) return;
      editingBaseSeqRef.current = current.seq;
      setEditConflictId(null);
      showToast(tr("Your draft is still here. Saving now will use the latest version as its base.", "草稿仍在；再次保存将以最新版本为基线"));
    },
    pickTag,
    toggleSelect
  });
  feedActionsRef.current = {
    startEdit: (id: string) => {
      const currentEditing = editingIdRef.current;
      if (currentEditing && currentEditing !== id) {
        showToast(tr("Save or cancel the open edit before editing another memo.", "请先保存或取消当前编辑，再编辑其他笔记"), "error");
        return;
      }
      editingBaseSeqRef.current = syncStateRef.current.memos.get(id)?.seq ?? null;
      setEditConflictId(null);
      setEditingId(id);
    },
    saveEdit: handleSaveEdit,
    togglePin: handleTogglePin,
    copy: handleCopy,
    trash: handleTrash,
    restore: handleRestore,
    purge: handlePurge,
    acceptEditConflict: (id: string) => {
      const current = syncStateRef.current.memos.get(id);
      if (!current || current.deletedAt) return;
      editingBaseSeqRef.current = current.seq;
      setEditConflictId(null);
      showToast(tr("Your draft is still here. Saving now will use the latest version as its base.", "草稿仍在；再次保存将以最新版本为基线"));
    },
    pickTag,
    toggleSelect
  };
  const getEntering = useCallback(() => !enterSuppressRef.current, []);
  const feedHandlers = useMemo<FeedHandlers>(
    () => ({
      startEdit: (id) => feedActionsRef.current.startEdit(id),
      cancelEdit: () => {
        editingBaseSeqRef.current = null;
        setEditConflictId(null);
        setEditingId(null);
      },
      saveEdit: (memo, data) => feedActionsRef.current.saveEdit(memo, data),
      acceptEditConflict: (id) => feedActionsRef.current.acceptEditConflict(id),
      togglePin: (memo) => void feedActionsRef.current.togglePin(memo),
      copy: (memo) => void feedActionsRef.current.copy(memo),
      trash: (memo) => void feedActionsRef.current.trash(memo),
      restore: (memo) => void feedActionsRef.current.restore(memo),
      purge: (memo) => void feedActionsRef.current.purge(memo),
      pickTag: (path) => feedActionsRef.current.pickTag(path),
      openImage: (items, index) => setLightbox({ items, index }),
      toggleSelect: (memo) => feedActionsRef.current.toggleSelect(memo)
    }),
    []
  );

  /**
   * Arming/disarming Empty Trash swaps the pill's label (and width) — run it
   * through a view transition so the pill morphs instead of snapping. Blur
   * and view-switch disarms stay plain setState: they race other transitions.
   */
  const setEmptyTrashArm = useCallback((value: boolean) => {
    withViewTransition(() => flushSync(() => setConfirmEmptyTrash(value)));
  }, []);
  // A primed Empty Trash button disarms on its own if the second click
  // never lands (but not while the delete request is in flight).
  useEffect(() => {
    if (!confirmEmptyTrash) return;
    const timer = window.setTimeout(() => {
      if (!emptyTrashBusyRef.current) setEmptyTrashArm(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [confirmEmptyTrash, setEmptyTrashArm]);
  useEffect(() => {
    if (view !== "trash") setConfirmEmptyTrash(false);
  }, [view]);

  /** Batch-delete arming: same pill-morph language as Empty Trash. */
  const setBatchDeleteArm = useCallback((value: boolean) => {
    withViewTransition(() => flushSync(() => setConfirmBatchDelete(value)));
  }, []);
  useEffect(() => {
    if (!confirmBatchDelete) return;
    const timer = window.setTimeout(() => setBatchDeleteArm(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmBatchDelete, setBatchDeleteArm]);

  // Escape backs out of select mode (view switches already clear it inside
  // their own transitions; this is the keyboard path).
  useEffect(() => {
    if (!selectMode) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") exitSelectMode();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelectMode]);

  // A filter change can hide a selected memo. Prune against the rendered feed
  // so a later batch action can never affect a card the user can no longer see.
  useEffect(() => {
    if (!selectMode) return;
    setSelected((current) => selectionWithinVisibleIds(current, visibleFeedIds));
    setConfirmBatchDelete(false);
  }, [selectMode, visibleFeedIds]);

  async function handlePinTag(path: string, pinned: boolean) {
    try {
      const result = await guard(() => pinTag(path, pinned));
      if (!result) return;
      applySyncChanges([], [], [result.tag]);
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
    if (tagRenamePathsOverlap(from, to)) {
      showToast(tr("A tag cannot be renamed to its own parent or child path.", "标签不能重命名到自身的上级或下级路径"), "error");
      return;
    }
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
      void runSync();
      notifyPeers();
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
      void runSync();
      notifyPeers();
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
      const result = await guard(() => importDataInChunks(payload));
      if (!result) return;
      setImportTarget(null);
      // The imported rows carry fresh seqs, so one incremental sync pulls
      // them in (and sibling tabs hear about it too).
      await runSync();
      notifyPeers();
      if (result.imported > 0) {
        const imageLabel = `${result.images} image${result.images === 1 ? "" : "s"}`;
        const skippedLabel = result.skipped > 0 ? `; skipped ${count(result.skipped, "memo")} that already existed` : "";
        const skippedZh = result.skipped > 0 ? `；跳过 ${result.skipped} 条已存在的笔记` : "";
        showToast(
          tr(
            `Imported ${count(result.imported, "memo")} with ${imageLabel}${skippedLabel}`,
            `已导入 ${count(result.imported, "memo")}，包含 ${result.images} 张图片${skippedZh}`
          )
        );
      } else if (result.skipped > 0) {
        showToast(
          tr(
            `Nothing new — skipped ${count(result.skipped, "memo")} that already existed`,
            `没有新内容，已跳过 ${result.skipped} 条已存在的笔记`
          )
        );
      } else {
        showToast(tr("Import completed; there were no new memos", "导入完成，没有新的笔记"));
      }
    } catch (cause) {
      // Earlier chunks may already be committed; reconcile them and let a
      // retry safely skip their stable ids.
      void runSync();
      notifyPeers();
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

  if (phase === "error") {
    return (
      <section className="splash" role="alert" aria-label={tr("Startup failed", "启动失败") }>
        <div className="splash-logo">
          <NotebookPen size={26} aria-hidden="true" />
        </div>
        <p>{bootError ?? tr("Couldn’t load your memos", "加载失败")}</p>
        <button type="button" className="ghost-button" onClick={() => void runInitialBoot()}>
          {tr("Retry", "重试")}
        </button>
      </section>
    );
  }

  if (phase === "login") {
    return (
      <>
        <LoginScreen needsSetup={needsSetup} onLogin={handleLogin} onSetup={handleSetup} />
        {toast ? (
          <div key={toast.id} className={`toast${toast.tone === "error" ? " is-error" : ""}${toast.leaving ? " is-leaving" : ""}`} role="status">
            {toast.text}
          </div>
        ) : null}
      </>
    );
  }

  const visibleSelectedCount = visibleSelected.size;
  const allVisibleSelected = feedMemos.length > 0 && visibleSelectedCount === feedMemos.length;

  function toggleSelectAll() {
    mutateSelection(() => {
      if (allVisibleSelected) setSelected(new Set());
      else setSelected(new Set(visibleFeedIds));
    });
  }

  function handleBatchDeleteClick() {
    if (batchBusy) return;
    if (!confirmBatchDelete) {
      if (visibleSelectedCount > 0) setBatchDeleteArm(true);
      return;
    }
    setConfirmBatchDelete(false);
    void handleBatchTrash();
  }

  return (
    <div className={`app-shell${reveal ? " first-reveal" : ""}`}>
      <aside
        ref={drawerRef}
        id="app-sidebar"
        className={`sidebar${drawerOpen ? " is-open" : ""}${drawerClosing ? " is-closing" : ""}`}
        tabIndex={-1}
      >
        <Sidebar
          memos={activeMemos}
          tagTree={tagTree}
          uniqueTagCount={uniqueTagCount}
          countsByDay={byDay}
          activeTag={activeTag}
          activeDay={activeDay}
          filtersActive={filtersActive}
          view={view}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => closeDrawer()}
          trashCount={trashedMemos.length}
          theme={theme}
          pinnedTags={pinnedTags}
          onPinTag={(path, pinned) => void handlePinTag(path, pinned)}
          onRenameTag={(path) => closeDrawer(() => setRenameTagTarget(path))}
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
          onOpenStats={() => closeDrawer(() => setStatsOpen(true))}
          onCycleTheme={() => setTheme((value) => nextTheme(value))}
          onChangePasscode={() => {
            closeDrawer(() => {
              sessionEpochRef.current += 1;
              setChangingPasscode(true);
            });
          }}
          onExportData={() => closeDrawer(() => void handleExport())}
          onImportData={() => closeDrawer(() => importFileRef.current?.click())}
          onLogout={() => void handleLogout()}
        />
      </aside>
      {drawerOpen ? <div className={`drawer-backdrop${drawerClosing ? " is-closing" : ""}`} onClick={() => closeDrawer()} /> : null}

      <main className="main-column">
        <div className="topbar">
          <button
            type="button"
            className="icon-button drawer-toggle"
            onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
            aria-label={drawerOpen ? tr("Close sidebar", "关闭侧栏") : tr("Open sidebar", "打开侧栏")}
            aria-controls="app-sidebar"
            aria-expanded={drawerOpen}
          >
            <MenuIcon size={18} aria-hidden="true" />
          </button>
          <div className="breadcrumb">
            {view === "trash" ? (
              // Trash reuses the tag-drilldown breadcrumb language: ⌂ / 回收站,
              // same cascade-in, ⌂ steps back out to All memos.
              <nav className="crumbs" aria-label={tr("Location", "当前位置")}>
                <button type="button" className="crumb crumb-home" onClick={showAll} aria-label={tr("All memos", "全部笔记")} style={{ animationDelay: "0s" }}>
                  <Home size={15} aria-hidden="true" />
                </button>
                <ChevronRight size={13} className="crumb-sep" aria-hidden="true" style={{ animationDelay: "0.015s" }} />
                <span className="crumb crumb-trash is-current" aria-current="page" style={{ animationDelay: "0.035s" }}>
                  <Trash2 size={13} aria-hidden="true" />
                  {tr("Trash", "回收站")}
                </span>
              </nav>
            ) : selectMode ? (
              // Multi-select toolbar. The count pill inherits the fused
              // pill's view-transition-name, so entering the mode morphs the
              // location label into the live counter; the sibling pills
              // cascade in with the breadcrumb language.
              <div className="select-bar">
                <span className="select-count" aria-live="polite">
                  {language === "zh-CN" ? (
                    <>
                      已选 <RollingText value={visibleSelectedCount} className="select-count-num" /> 条
                    </>
                  ) : (
                    <>
                      <RollingText value={visibleSelectedCount} className="select-count-num" /> selected
                    </>
                  )}
                </span>
                <button type="button" className="select-pill" disabled={feedMemos.length === 0} onClick={toggleSelectAll}>
                  <SwapText id={allVisibleSelected ? "clear" : "all"}>
                    {allVisibleSelected ? tr("Clear", "清除") : tr("Select all", "全选")}
                  </SwapText>
                </button>
                <button
                  type="button"
                  className={`select-delete${confirmBatchDelete ? " is-confirm" : ""}`}
                  disabled={visibleSelectedCount === 0 || batchBusy}
                  aria-label={
                    confirmBatchDelete
                      ? tr(`Delete ${count(visibleSelectedCount, "memo")}?`, `删除 ${count(visibleSelectedCount, "memo")}？`)
                      : tr("Delete selected memos", "删除所选笔记")
                  }
                  onClick={handleBatchDeleteClick}
                  onBlur={() => setConfirmBatchDelete(false)}
                >
                  {batchBusy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                  <span>
                    {batchBusy
                      ? tr("Deleting…", "删除中…")
                      : confirmBatchDelete
                        ? tr(`Delete ${count(visibleSelectedCount, "memo")}?`, `删除 ${count(visibleSelectedCount, "memo")}？`)
                        : tr("Delete", "删除")}
                  </span>
                </button>
                <button type="button" className="select-pill select-exit" onClick={exitSelectMode}>
                  {tr("Cancel", "取消")}
                </button>
              </div>
            ) : (
              // The location trail. Its last stop — "全部笔记" at the root, the
              // current tag inside one — IS the dropdown trigger: label and
              // caret fused into one pill that the topbar-action transition
              // glides between breadcrumb layouts.
              <Crumbs path={activeTag} onHome={showAll} onPick={(path) => pickTag(path)}>
                <Menu
                  align="left"
                  portal
                  className="loc-menu"
                  panelClassName="loc-panel"
                  trigger={(open) => (
                    <button
                      type="button"
                      className={`loc-trigger${open ? " is-open" : ""}${activeTag ? "" : " is-root"}`}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      aria-label={tr("View options: sort and select", "视图选项：排序与多选")}
                    >
                      <span className="loc-label">{activeTag ? activeTag.split("/").at(-1) : tr("All memos", "全部笔记")}</span>
                      <ChevronDown size={14} className="loc-caret" aria-hidden="true" />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <span className="action-menu__title" role="presentation">
                        {tr("Sort by", "排序方式")}
                      </span>
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
                      <span className="action-menu__sep" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          close();
                          enterSelectMode();
                        }}
                      >
                        <ListChecks size={16} aria-hidden="true" />
                        {tr("Select memos", "多选笔记")}
                      </button>
                    </>
                  )}
                </Menu>
              </Crumbs>
            )}
            {view === "trash" && trashedMemos.length > 0 ? (
              // Empty Trash lives in the same slot as Sort (and shares its
              // view-transition-name), so swapping views morphs one pill into
              // the other.
              <button
                type="button"
                className={`trash-empty-button${confirmEmptyTrash ? " is-confirm" : ""}`}
                aria-label={
                  confirmEmptyTrash
                    ? tr(`Delete ${count(trashedMemos.length, "memo")} forever?`, `彻底删除 ${count(trashedMemos.length, "memo")}？`)
                    : tr("Empty Trash", "清空回收站")
                }
                onClick={() => {
                  if (!confirmEmptyTrash) {
                    setEmptyTrashArm(true);
                    return;
                  }
                  void handleEmptyTrash();
                }}
                onBlur={() => {
                  if (!emptyTrashBusyRef.current) setConfirmEmptyTrash(false);
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>
                  {confirmEmptyTrash
                    ? tr(`Delete ${count(trashedMemos.length, "memo")} forever?`, `彻底删除 ${count(trashedMemos.length, "memo")}？`)
                    : tr("Empty Trash", "清空回收站")}
                </span>
              </button>
            ) : null}
            {view === "memos" && !selectMode ? (
              // Active-lens chips — the trail's refinement clause: the
              // breadcrumb says WHERE, the chips say THROUGH WHAT. Each is
              // the compact echo of its source control (heatmap day, panel
              // facet row: same icon, same label) and a single remove
              // button. Unique view-transition-names give each one a glide
              // when the breadcrumb resizes, an in-place morph when its
              // label changes, and a crumb-style fold-back on removal.
              <>
                {activeDay ? (
                  <FilterChip
                    icon={Calendar}
                    label={formatDayLabel(activeDay, locale)}
                    clearLabel={tr(`Clear date filter: ${formatDayLabel(activeDay, locale)}`, `清除日期筛选：${formatDayLabel(activeDay, locale)}`)}
                    transitionName="day-filter-chip"
                    delay={chipDelay("day")}
                    onClear={() => pickDay(null)}
                  />
                ) : null}
                {rangeChipLabel ? (
                  <FilterChip
                    icon={CalendarRange}
                    label={rangeChipLabel}
                    clearLabel={tr(`Clear date range: ${rangeChipLabel}`, `清除日期范围：${rangeChipLabel}`)}
                    transitionName="range-filter-chip"
                    delay={chipDelay("range")}
                    onClear={clearDateRange}
                  />
                ) : null}
                {FACET_ROWS.filter((row) => filters[row.key]).map((row) => (
                  <FilterChip
                    key={row.key}
                    icon={row.icon}
                    label={tr(row.en, row.zh)}
                    clearLabel={tr(`Clear “${row.en}” filter`, `清除「${row.zh}」筛选`)}
                    transitionName={`facet-chip-${row.key}`}
                    delay={chipDelay(row.key)}
                    onClear={() => toggleFacet(row.key)}
                  />
                ))}
              </>
            ) : null}
          </div>
          {view === "memos" ? (
            <div className="search-tools">
              <div className={`searchbox${searchOpen || query ? " is-open" : ""}`}>
                <Search size={15} className="searchbox-icon" aria-hidden="true" />
                <input
                  ref={searchRef}
                  value={query}
                  placeholder={tr("Search memos", "搜索笔记")}
                  title={tr("Space separates keywords; “quotes” match an exact phrase", "空格分隔多个关键词；“引号”匹配完整短语")}
                  disabled={editingId !== null}
                  onChange={(event) => setQuery(event.target.value)}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setSearchOpen(false)}
                />
                {query ? (
                  <button
                    type="button"
                    className="searchbox-clear"
                    aria-label={tr("Clear search", "清空搜索")}
                    disabled={editingId !== null}
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
              <SearchFilter
                filters={filters}
                saved={savedFilters}
                activeSavedId={activeSavedId}
                canSave={filtersActive}
                disabled={editingId !== null}
                onToggleFacet={toggleFacet}
                onDateChange={patchDateRange}
                onClearDates={clearDateRange}
                onApplySaved={applySavedFilter}
                onDeleteSaved={deleteSavedFilter}
                onSaveCurrent={() => setSavingFilter(true)}
              />
            </div>
          ) : null}
        </div>

        <div className="composer" hidden={view !== "memos"}>
          <Editor mode="create" knownTags={knownTags} busy={creating} onSubmit={handleCreate} />
        </div>

        <section
          className={`memo-feed${selectMode && view === "memos" ? " is-select" : ""}`}
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
            renderedFeedMemos.map((memo, index) => (
              <FeedItem
                key={memo.id}
                memo={memo}
                variant={view === "trash" ? "trash" : "normal"}
                knownTags={editingId === memo.id ? knownTags : EMPTY_TAGS}
                editing={editingId === memo.id}
                savingEdit={editingId === memo.id && savingEdit}
                editConflict={editingId === memo.id && editConflictId === memo.id}
                selecting={selectMode && view === "memos"}
                selected={selectMode && selected.has(memo.id)}
                vtName={index < 32 ? `memo-${memo.id}` : undefined}
                getEntering={getEntering}
                delay={Math.min(index, 6) * 0.008}
                handlers={feedHandlers}
              />
            ))
          )}
          {hasMoreFeed ? <div ref={feedSentinelRef} className="feed-sentinel" aria-hidden="true" /> : null}
        </section>

        <ScrollTopButton />
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
          onCancel={() => {
            if (!dialogBusy) setImportTarget(null);
          }}
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
            if (renameTagTarget && tagRenamePathsOverlap(renameTagTarget, value)) {
              return tr("Choose a path outside this tag’s own parent/child tree", "请选择该标签上下级路径之外的位置");
            }
            if (!isValidTagPath(value)) return tr("Use letters, numbers, -, _, or ·, with / between levels", "可用中英文、数字、-、_、·，用 / 分层");
            return null;
          }}
          hint={(value) =>
            knownTags.includes(value)
              ? tr(`#${value} already exists. Renaming will merge the tags.`, `#${value} 已存在，重命名后两个标签会合并`)
              : null
          }
          onCancel={() => {
            if (!dialogBusy) setRenameTagTarget(null);
          }}
          onConfirm={(value) => void handleRenameTagConfirmed(value)}
        />
      ) : null}
      {savingFilter ? (
        <PromptDialog
          title={tr("Save current filters", "保存当前筛选")}
          body={tr(
            "Keeps this combination of search, tag, date and filters one tap away.",
            "把当前的搜索词、标签、日期与筛选组合保存下来，之后一键套用。"
          )}
          initialValue=""
          placeholder={tr("Filter name", "筛选名称")}
          confirmLabel={tr("Save", "保存")}
          validate={(value) => {
            if (value.length > 40) return tr("Use a shorter name (40 characters max)", "名称最长 40 个字符");
            if (savedFilters.length >= SAVED_FILTERS_LIMIT && !savedFilters.some((item) => item.name === value)) {
              return tr(`You can keep up to ${SAVED_FILTERS_LIMIT} saved filters`, `最多保存 ${SAVED_FILTERS_LIMIT} 个筛选`);
            }
            return null;
          }}
          hint={(value) =>
            savedFilters.some((item) => item.name === value)
              ? tr("A filter with this name exists and will be replaced.", "同名筛选已存在，保存后将覆盖")
              : null
          }
          onCancel={() => setSavingFilter(false)}
          onConfirm={handleSaveFilterConfirmed}
        />
      ) : null}
      {changingPasscode ? (
        <ChangePasscode
          onClose={() => setChangingPasscode(false)}
          onAuthLost={dropToLogin}
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
