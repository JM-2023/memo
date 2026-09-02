import {
  Brain,
  Calendar,
  CalendarRange,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CloudOff,
  Home,
  ListChecks,
  Loader2,
  Menu as MenuIcon,
  NotebookPen,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Trash2,
  WifiOff,
  X
} from "lucide-react";
import { memo as reactMemo, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChangePasscode } from "./components/ChangePasscode";
import { BulkTagDialog } from "./components/BulkTagDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Crumbs } from "./components/Crumbs";
import { Editor } from "./components/Editor";
import { FilterChip } from "./components/FilterChip";
import { Lightbox } from "./components/Lightbox";
import { LoginScreen } from "./components/LoginScreen";
import { MemoCard } from "./components/MemoCard";
import { Menu } from "./components/Menu";
import { PromptDialog } from "./components/PromptDialog";
import { ModelSettingsModal } from "./components/ModelSettingsModal";
import { ReviewSettingsModal } from "./components/ReviewSettingsModal";
import { RollingText } from "./components/RollingText";
import { ScrollTopButton } from "./components/ScrollTopButton";
import { FACET_ROWS, SearchFilter } from "./components/SearchFilter";
import { Sidebar } from "./components/Sidebar";
import { ShareDialog } from "./components/ShareDialog";
import { StatsModal } from "./components/StatsModal";
import { SwapText } from "./components/SwapText";
import { useModalA11y } from "./hooks/useModalA11y";
import { useSemanticSearch } from "./hooks/useSemanticSearch";
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
import { adoptCacheKey, invalidateSnapshot, openSnapshot, readSealedSnapshot, saveSnapshot } from "./lib/cache";
import { dateKey, formatDayLabel } from "./lib/dates";
import { advanceFeedWindow, feedWindowCap, filterPreservingId, type FeedWindow } from "./lib/feedSafety";
import { useI18n } from "./lib/i18n";
import { clearLocalDeviceData } from "./lib/logoutCleanup";
import { splitTaskLine } from "./lib/markdown";
import { memoMatchesSubmittedDraft } from "./lib/memoRecovery";
import {
  buildReviewDay,
  clearReviewDay,
  DEFAULT_REVIEW_SETTINGS,
  loadReviewDay,
  loadReviewSettings,
  persistReviewDay,
  persistReviewSettings,
  reviewDayValid,
  type ReviewDay,
  type ReviewSettings
} from "./lib/review";
import {
  SAVED_FILTERS_LIMIT,
  loadSavedFilters,
  persistSavedFilters,
  removeSavedFiltersForTag,
  renameSavedFilterTags,
  type SavedFilter
} from "./lib/savedFilters";
import {
  EMPTY_FILTERS,
  facetsOf,
  filtersEqual,
  hasActiveFilters,
  hybridSearchScore,
  memoMatchesFilters,
  memoMatchesQuery,
  memoMatchesSearchScope,
  parseSearchQuery,
  queryIsEmpty,
  type FacetKey,
  type FeedFilters
} from "./lib/search";
import { selectionWithinVisibleIds } from "./lib/selection";
import { countsByDay, dayKeyOf } from "./lib/stats";
import { feedQueryForStatsDrilldown, memoMatchesStatsDrilldown, statsDrilldownLabel, type StatsDrilldown } from "./lib/statsDrilldown";
import { applySyncDelta, createSyncState, memosOf, purgedOf, tagsOfState, type PurgedMemo } from "./lib/syncState";
import { appendTagToContent, buildTagTree, inheritTagContext, isValidTagPath, tagMatches, tagRenamePathsOverlap, tagsOf } from "./lib/tags";
import { applyTaskFlips, freshestTaskMemo, type TaskFlipQueue } from "./lib/taskFlips";
import { applyTheme, loadTheme, type ThemeChoice } from "./lib/theme";
import type { LightboxItem, Memo, NewImagePayload, SortKey, TagMeta } from "./lib/types";
import { useSync } from "./lib/useSync";
import { tuneFeedTransitionNames, withViewTransition } from "./lib/viewTransition";

type Phase = "checking" | "error" | "login" | "ready";
type View = "memos" | "trash" | "review";

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastState {
  id: number;
  text: string;
  tone: "info" | "error";
  /** One verb the toast offers — Undo, mostly. Runs once, then dismisses. */
  action?: ToastAction;
  /** Plays the exit animation before the node unmounts. */
  leaving?: boolean;
}

interface ToastOptions {
  action?: ToastAction;
  /** Overrides the length-derived stay, in ms. */
  duration?: number;
}

/** Toasts up at once; past this the oldest steps off. */
const TOAST_LIMIT = 3;
const TOAST_LEAVE_MS = 170;

/**
 * How long a toast stays: a reading pace for its length, with floors for an
 * error (it has to be read, not glimpsed) and for anything offering an
 * action (the hand needs time to reach it). Hovering or focusing the stack
 * holds every toast where it is.
 */
function toastDuration(text: string, tone: "info" | "error", hasAction: boolean): number {
  const reading = 2_600 + Math.max(0, text.length - 32) * 40;
  const floor = hasAction ? 6_000 : tone === "error" ? 5_000 : 0;
  return Math.min(10_000, Math.max(floor, reading));
}

interface ToastStackProps {
  toasts: ToastState[];
  dismissLabel: string;
  onDismiss: (id: number) => void;
  onPause: () => void;
  onResume: () => void;
}

/**
 * The toasts, newest at the bottom so a toast already up never moves when
 * another lands. An error is an alert (assertive) and carries a mark; every
 * other toast is a status. Text and weight say what happened — the tone is
 * carried by the mark and the hairline, not by recolouring the sentence.
 */
function ToastStack({ toasts, dismissLabel, onDismiss, onPause, onResume }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" onPointerEnter={onPause} onPointerLeave={onResume} onFocus={onPause} onBlur={onResume}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast${toast.tone === "error" ? " is-error" : ""}${toast.leaving ? " is-leaving" : ""}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "error" ? <CircleAlert size={15} className="toast-mark" aria-hidden="true" /> : null}
          <span className="toast-text">{toast.text}</span>
          {toast.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                toast.action?.run();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          {toast.action || toast.tone === "error" ? (
            <button type="button" className="toast-dismiss" aria-label={dismissLabel} onClick={() => onDismiss(toast.id)}>
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

interface PendingBatchTag {
  /** Which entry point armed it — the selection toolbar or one card's menu. */
  scope: "selection" | "memo";
  tag: string;
  changed: Memo[];
  refreshed: Memo[];
  retryIds: string[];
  failedCount: number;
  firstFailure: string | null;
  alreadyTagged: number;
  targetCount: number;
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
 *
 * The entrance is unhooked once it finishes: a slot that kept `animation:
 * rise-in` replays the whole entrance whenever React moves the node while
 * reordering kept rows (insertBefore restarts CSS animations), stacking a
 * second entrance on top of the view transition's glide.
 *
 * data-vt mirrors the view-transition-name so changeFeed can restore the
 * inline name it strips from far-from-viewport slots before a swap: React
 * bails out of re-rendering unchanged slots, so the stripped style would
 * otherwise leak into the new state's capture.
 */
function MemoSlot({ vtName, entering, delay, children }: MemoSlotProps) {
  const [intro] = useState(() => (entering ? { animationDelay: `${delay}s` } : null));
  const [entered, setEntered] = useState(false);
  return (
    <div
      className={`memo-slot${intro && !entered ? "" : " no-enter"}`}
      style={{ ...intro, viewTransitionName: vtName }}
      data-vt={vtName}
      onAnimationEnd={
        intro && !entered
          ? (event) => {
              if (event.target === event.currentTarget && event.animationName === "rise-in") setEntered(true);
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

/** How many feed rows render before the scroll sentinel asks for more. */
const FEED_PAGE = 80;

/** At or under this many rows the feed renders every card for real instead
 * of letting content-visibility hold unvisited slots at their estimated
 * height. A small list — a tag with a handful of memos — must report its
 * true height: placeholder estimates run about double a typical text card,
 * so a 16-memo tag promised five screens of scroll and delivered three,
 * with the difference materializing away under the reader. Rendering a
 * couple dozen cards outright costs nothing; the skip optimization exists
 * for hundred-row feeds, which stay above this line. */
const SMALL_FEED = 24;

/** Stable per-App action surface — what keeps FeedItem memoization honest. */
interface FeedHandlers {
  startEdit: (id: string) => void;
  cancelEdit: () => void;
  saveEdit: (memo: Memo, data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  acceptEditConflict: (id: string) => void;
  togglePin: (memo: Memo) => void;
  addTag: (memo: Memo) => void;
  copy: (memo: Memo) => void;
  share: (memo: Memo) => void;
  trash: (memo: Memo) => void;
  restore: (memo: Memo) => void;
  purge: (memo: Memo) => void;
  pickTag: (path: string) => void;
  openImage: (items: LightboxItem[], index: number) => void;
  toggleSelect: (memo: Memo) => void;
  toggleTask: (memo: Memo, lineKey: number, checked: boolean) => void;
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
  /** This memo's optimistic checkbox states (in-flight toggles), if any. */
  taskFlips: ReadonlyMap<number, boolean> | undefined;
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
  function FeedItem({ memo, variant, knownTags, editing, savingEdit, editConflict, selecting, selected, taskFlips, vtName, getEntering, delay, handlers }: FeedItemProps) {
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
          pendingTaskFlips={taskFlips}
          onToggleSelect={() => handlers.toggleSelect(memo)}
          onStartEdit={() => handlers.startEdit(memo.id)}
          onCancelEdit={handlers.cancelEdit}
          onSaveEdit={(data) => handlers.saveEdit(memo, data)}
          onAcceptEditConflict={() => handlers.acceptEditConflict(memo.id)}
          onTogglePin={() => handlers.togglePin(memo)}
          onAddTag={() => handlers.addTag(memo)}
          onCopy={() => handlers.copy(memo)}
          onShare={() => handlers.share(memo)}
          onDelete={() => handlers.trash(memo)}
          onRestore={() => handlers.restore(memo)}
          onPurge={() => handlers.purge(memo)}
          onPickTag={handlers.pickTag}
          onOpenImage={handlers.openImage}
          onToggleTask={(lineKey, checked) => handlers.toggleTask(memo, lineKey, checked)}
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
    prev.taskFlips === next.taskFlips &&
    prev.vtName === next.vtName &&
    prev.handlers === next.handlers
);

export default function App() {
  const { count, errorMessage, language, locale, setLanguage, tr } = useI18n();
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
  // The preference key sits under the memo: prefix, so an ordinary logout
  // resets it along with the other workspace furniture.
  const [semanticOn, setSemanticOn] = useState(() => {
    try {
      return localStorage.getItem("memo:semantic-search") === "1";
    } catch {
      return false;
    }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<FeedFilters>(EMPTY_FILTERS);
  const [statsDrilldown, setStatsDrilldown] = useState<StatsDrilldown | null>(null);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(loadSavedFilters);
  // Names the current filter combination via PromptDialog.
  const [savingFilter, setSavingFilter] = useState(false);

  // Daily review: settings and the day's frozen batch are workspace
  // furniture (localStorage, like the sort key) — see lib/review.ts. The
  // batch is drawn lazily, on the first visit to the review view of a local
  // day, never ahead of time and never on the server.
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings>(loadReviewSettings);
  const [reviewDay, setReviewDay] = useState<ReviewDay | null>(loadReviewDay);
  const [reviewSettingsOpen, setReviewSettingsOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  // Non-zero when the Brain button opened the panel to show unfinished work:
  // the panel washes its progress block and scrolls it into view. Reset on
  // close so a plain menu open stays quiet.
  const [modelSettingsAttend, setModelSettingsAttend] = useState(0);
  // Remembers that the settings panel was opened by a failed first Brain
  // toggle. Once download + self-test succeeds, honour that original click
  // and begin indexing without asking for a second click.
  const [enableSemanticWhenReady, setEnableSemanticWhenReady] = useState(false);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const editingBaseSeqRef = useRef<number | null>(null);
  const [editConflictId, setEditConflictId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Feed checkbox toggles: an ephemeral optimistic layer (memoId → lineKey →
  // desired checked state) that only skins the rendered box. syncState stays
  // the server truth throughout, so snapshots and sync never persist a guess;
  // a failed request clears the layer and the box snaps back.
  const [pendingTaskFlips, setPendingTaskFlips] = useState<ReadonlyMap<string, ReadonlyMap<number, boolean>>>(() => new Map());
  // Per-memo serial queue: flips arriving while a request is in flight are
  // batched into the next one, computed against the then-latest seq/content —
  // rapid ticking never races itself into a version conflict.
  const taskFlipQueueRef = useRef(new Map<string, TaskFlipQueue>());

  const stampTaskFlip = useCallback((memoId: string, lineKey: number, checked: boolean) => {
    setPendingTaskFlips((current) => {
      const memoFlips = new Map(current.get(memoId));
      memoFlips.set(lineKey, checked);
      // Untouched memos keep their inner-map identity — FeedItem memoization
      // re-renders only the card whose pending layer actually changed.
      const next = new Map(current);
      next.set(memoId, memoFlips);
      return next;
    });
  }, []);

  /**
   * Drop the pending flips `content` now satisfies — or that lost their task
   * line to a concurrent edit. null content (memo gone/trashed/failed
   * request) clears the memo's whole layer, snapping boxes back to truth.
   */
  const settleTaskFlips = useCallback((memoId: string, content: string | null) => {
    setPendingTaskFlips((current) => {
      const memoFlips = current.get(memoId);
      if (!memoFlips) return current;
      let survivors: Map<number, boolean> | null = null;
      if (content !== null) {
        const lines = content.split("\n");
        for (const [lineKey, checked] of memoFlips) {
          const parts = lineKey < lines.length ? splitTaskLine(lines[lineKey]) : null;
          if (parts && parts.checked !== checked) (survivors ??= new Map()).set(lineKey, checked);
        }
      }
      if (survivors && survivors.size === memoFlips.size) return current;
      const next = new Map(current);
      if (survivors) next.set(memoId, survivors);
      else next.delete(memoId);
      return next;
    });
  }, []);
  // Multi-select mode: entered from the location dropdown, exits via 取消 /
  // Escape / view switches / a fully successful batch delete.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const restoreLocationFocusRef = useRef(false);
  // Two-step batch delete, mirroring Empty Trash: arm, then fire.
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const confirmBatchDeleteRef = useRef(false);
  confirmBatchDeleteRef.current = confirmBatchDelete;
  const [batchBusy, setBatchBusy] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  // The same sheet aimed at one card, opened from its ⋯ menu. Held by id so a
  // sync that edits or deletes the memo mid-flight is reflected, not stale.
  const [tagMemoId, setTagMemoId] = useState<string | null>(null);
  const pendingBatchTagRef = useRef<PendingBatchTag | null>(null);
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
  // Memo being shared as an image card; holds a snapshot until dismissed.
  const [shareMemo, setShareMemo] = useState<Memo | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [changingPasscode, setChangingPasscode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const [reveal, setReveal] = useState(false);
  // The panel a lens chip reopens; bumping the counter opens it.
  const [filterOpenRequest, setFilterOpenRequest] = useState(0);

  // Per-toast clocks. A paused entry (pointer or focus on the stack) keeps
  // only its remaining time; resuming re-arms from there.
  const toastTimersRef = useRef(new Map<number, { timer: number; expiresAt: number; remaining: number }>());
  const toastSeqRef = useRef(0);
  const toastsPausedRef = useRef(false);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  // The selection-pruned notice replaces itself rather than stacking up
  // while a search is being typed.
  const selectionNoticeRef = useRef(0);
  const bootAttemptRef = useRef(0);
  const drawerCloseTimerRef = useRef(0);
  const drawerCallbackFrameRef = useRef(0);
  const drawerAfterCloseRef = useRef<Array<() => void>>([]);
  const logoutBusyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;

  const dismissToast = useCallback((id: number) => {
    const entry = toastTimersRef.current.get(id);
    if (entry) window.clearTimeout(entry.timer);
    toastTimersRef.current.delete(id);
    setToasts((current) => (current.some((toast) => toast.id === id && !toast.leaving) ? current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)) : current));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), TOAST_LEAVE_MS);
  }, []);

  const armToast = useCallback(
    (id: number, ms: number) => {
      const timer = window.setTimeout(() => dismissToast(id), ms);
      toastTimersRef.current.set(id, { timer, expiresAt: Date.now() + ms, remaining: ms });
    },
    [dismissToast]
  );

  const showToast = useCallback(
    (text: string, tone: "info" | "error" = "info", options: ToastOptions = {}) => {
      const id = ++toastSeqRef.current;
      const duration = options.duration ?? toastDuration(text, tone, Boolean(options.action));
      // Newest last: a toast already up never moves when another lands.
      // Past the cap the oldest steps off first.
      const live = toastsRef.current.filter((toast) => !toast.leaving);
      for (const stale of live.slice(0, Math.max(0, live.length + 1 - TOAST_LIMIT))) dismissToast(stale.id);
      setToasts((current) => [...current, { id, text, tone, action: options.action }]);
      if (toastsPausedRef.current) toastTimersRef.current.set(id, { timer: 0, expiresAt: 0, remaining: duration });
      else armToast(id, duration);
      return id;
    },
    [armToast, dismissToast]
  );

  const pauseToasts = useCallback(() => {
    if (toastsPausedRef.current) return;
    toastsPausedRef.current = true;
    const now = Date.now();
    for (const [id, entry] of toastTimersRef.current) {
      if (entry.timer) window.clearTimeout(entry.timer);
      // Leaving the stack always grants a beat to finish reading.
      const remaining = entry.timer ? Math.max(800, entry.expiresAt - now) : entry.remaining;
      toastTimersRef.current.set(id, { timer: 0, expiresAt: 0, remaining });
    }
  }, []);

  const resumeToasts = useCallback(() => {
    if (!toastsPausedRef.current) return;
    toastsPausedRef.current = false;
    for (const [id, entry] of toastTimersRef.current) if (!entry.timer) armToast(id, entry.remaining);
  }, [armToast]);

  const clearToasts = useCallback(() => {
    for (const entry of toastTimersRef.current.values()) window.clearTimeout(entry.timer);
    toastTimersRef.current.clear();
    toastsPausedRef.current = false;
    selectionNoticeRef.current = 0;
    setToasts([]);
  }, []);

  const resetSessionUi = useCallback(() => {
    clearToasts();
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
    setSemanticOn(false);
    setSearchOpen(false);
    setFilters(EMPTY_FILTERS);
    setStatsDrilldown(null);
    setSavingFilter(false);
    setView("memos");
    setCreating(false);
    setEditingId(null);
    setEditConflictId(null);
    setSavingEdit(false);
    setPendingTaskFlips(new Map());
    taskFlipQueueRef.current.clear();
    setSelectMode(false);
    setSelected(new Set());
    setConfirmBatchDelete(false);
    setBatchBusy(false);
    setBulkTagOpen(false);
    setTagMemoId(null);
    pendingBatchTagRef.current = null;
    setRenameTagTarget(null);
    setDialogBusy(false);
    setConfirmEmptyTrash(false);
    setImportTarget(null);
    setLightbox(null);
    setShareMemo(null);
    setStatsOpen(false);
    setReviewSettingsOpen(false);
    setModelSettingsOpen(false);
    setModelSettingsAttend(0);
    setEnableSemanticWhenReady(false);
    setChangingPasscode(false);
    setDrawerOpen(false);
    setDrawerClosing(false);
    setFilterOpenRequest(0);
    setReveal(false);
  }, [clearToasts]);

  const resetLocalWorkspaceState = useCallback(() => {
    setTheme("system");
    setLanguage("en");
    setSortKey("created-desc");
    setSavedFilters([]);
    setReviewSettings(DEFAULT_REVIEW_SETTINGS);
    setReviewDay(null);
  }, [setLanguage]);

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
    if (phase !== "ready") return;
    localStorage.setItem("memo-sort", sortKey);
  }, [phase, sortKey]);

  useEffect(() => {
    if (phase !== "ready") return;
    persistSavedFilters(savedFilters);
  }, [phase, savedFilters]);

  const applySyncChanges = useCallback((changed: readonly Memo[], purged: readonly PurgedMemo[], tags: readonly TagMeta[], cursor?: number) => {
    setSyncState((current) => applySyncDelta(current, { memos: changed, purged, tags }));
    if (cursor !== undefined) setSnapshotCursor((current) => Math.max(current, cursor));
  }, []);

  const dropToLogin = useCallback(() => {
    sessionEpochRef.current += 1;
    void clearLocalDeviceData();
    resetSessionUi();
    resetLocalWorkspaceState();
    setPhase("login");
    showToast(tr("Your session has expired. Enter your passcode again.", "登录已过期，请重新输入密码"), "error");
  }, [resetLocalWorkspaceState, resetSessionUi, showToast, tr]);

  const handlePeerLogout = useCallback(() => {
    sessionEpochRef.current += 1;
    void clearLocalDeviceData();
    resetSessionUi();
    resetLocalWorkspaceState();
    setPhase("login");
    showToast(tr("Another tab logged out. Enter your passcode again.", "另一个标签页已退出，请重新输入密码"), "error");
  }, [resetLocalWorkspaceState, resetSessionUi, showToast, tr]);

  const handleServerReset = useCallback(() => {
    sessionEpochRef.current += 1;
    void invalidateSnapshot().finally(() => window.location.reload());
  }, []);

  const { setCursor, setSyncEpoch, runSync, notifyPeers, notifyLogout, status: syncStatus, retryNow: retrySync } = useSync({
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
      showToast(tr("This memo was deleted elsewhere. Editing was closed.", "这条笔记已在别处删除，编辑已关闭"), "error");
      return;
    }
    const baseSeq = editingBaseSeqRef.current;
    if (baseSeq !== null && current.seq > baseSeq) setEditConflictId(editingId);
  }, [editingId, syncState.memos, showToast, tr]);

  // A sync delta can satisfy (or orphan) a pending checkbox flip — the same
  // box ticked from another tab, or its task line edited away. Re-settle the
  // optimistic layer against the fresh truth; settle is an idempotent prune,
  // so keying on the memos map alone is enough.
  useEffect(() => {
    if (pendingTaskFlips.size === 0) return;
    for (const memoId of pendingTaskFlips.keys()) {
      const current = syncState.memos.get(memoId);
      settleTaskFlips(memoId, current && !current.deletedAt ? current.content : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-settle only when truth moves
  }, [syncState.memos, settleTaskFlips]);

  const trimmedQuery = query.trim().toLowerCase();
  // Filtering follows the keystroke at deferred priority: the input never
  // waits for a big feed to re-render.
  const deferredQuery = useDeferredValue(trimmedQuery);
  // Controls that set the search text outright — the clear ×, a saved preset,
  // going home — are not typing, and the deferral actively breaks them: they
  // run inside a view transition, whose callback must leave the DOM in its
  // final state, and a deferred query lands one render too late for that. The
  // swap glided the tag and the chips into place while the query's share of
  // the change popped in afterwards. Marking the value they set opts that one
  // value out of the deferral; typing (which clears the mark) never does.
  const queryLeapRef = useRef<string | null>(null);
  const feedQuery = feedQueryForStatsDrilldown(
    statsDrilldown,
    trimmedQuery,
    queryLeapRef.current === trimmedQuery ? trimmedQuery : deferredQuery
  );
  // Keywords AND together; "quoted" runs must match as whole phrases.
  const parsedQuery = useMemo(() => parseSearchQuery(feedQuery), [feedQuery]);
  const structuredFiltersOn = hasActiveFilters(filters);
  const filtersActive = activeTag !== null || activeDay !== null || statsDrilldown !== null || trimmedQuery.length > 0 || structuredFiltersOn;

  // Tag, day, stats, and structured filters are one intersection shared by
  // both retrieval paths. Keeping this corpus explicit prevents semantic
  // scoring from doing work outside the current view (and makes Tag + Filter
  // combinations behave exactly like ordinary keyword search).
  const semanticScopeActive = activeTag !== null || activeDay !== null || statsDrilldown !== null || structuredFiltersOn;
  const searchScopeMemos = useMemo(() => {
    if (!semanticScopeActive) return activeMemos;
    return filterPreservingId(activeMemos, editingId, (memo) =>
      memoMatchesSearchScope(memo, { activeTag, activeDay, statsDrilldown, filters })
    );
  }, [activeMemos, activeTag, activeDay, statsDrilldown, filters, editingId, semanticScopeActive]);
  const semanticScopeIds = useMemo(
    () => (semanticScopeActive ? new Set(searchScopeMemos.map((memo) => memo.id)) : null),
    [searchScopeMemos, semanticScopeActive]
  );

  /**
   * How a landed ranking reaches the feed. The single biggest reorder in the
   * app — every card can move at once, and rows sharing no keyword with the
   * query join the list — used to be the one feed reorder that cut instead of
   * moving: arrivals played their entrance while everything the reader was
   * already looking at teleported. It reads as a filter change, so it moves
   * like one (swapFeed, wired in below: the swap needs state declared after
   * this call, and a ranking can only land long after the first render).
   */
  const publishSemanticRef = useRef<(commit: () => void) => void>((commit) => commit());
  const publishSemanticResults = useCallback((commit: () => void) => publishSemanticRef.current(commit), []);

  // Semantic ranking rides the same search box. Keyword/phrase matching stays
  // active as the high-confidence tier; semantic results add related memos.
  // Trash and review keep plain search, so the hook sees their query as empty.
  // Activation also waits for phase "ready": the sealed index only opens with
  // the cache key adopted from the first authenticated response, and starting
  // earlier misreads "not decryptable yet" as "no index", throwing away the
  // persisted vectors and re-embedding the whole notebook on every refresh.
  const semantic = useSemanticSearch(
    semanticOn && phase === "ready",
    activeMemos,
    view === "memos" ? feedQuery : "",
    semanticScopeIds,
    publishSemanticResults
  );
  // Gated on the switch as well as the hook's own state: the hook drops its
  // results from an effect, a commit later than the click that flipped the
  // switch, and the swap animating that click has to see the keyword-only
  // list it is switching back to.
  const semanticResults = semanticOn && view === "memos" ? semantic.results : null;
  const semanticBusy = semantic.status === "preparing" || semantic.status === "indexing" || semantic.queryProgress !== null;
  // This query's ranking is still on its way. The keyword tier answers within
  // the keystroke, meaning answers a beat later, so a feed with nothing in it
  // yet is "still looking" — saying "no matching memos" there makes the app
  // contradict itself half a second later on every search whose answer is
  // semantic. Only for a live index: with no vectors to rank, or the model
  // still loading, the keyword answer is the whole answer.
  const semanticPending =
    semanticOn &&
    view === "memos" &&
    semanticResults === null &&
    !queryIsEmpty(parsedQuery) &&
    semantic.indexedMemos > 0 &&
    (semantic.status === "ready" || semantic.status === "indexing");
  useEffect(() => {
    try {
      if (semanticOn) localStorage.setItem("memo:semantic-search", "1");
      else localStorage.removeItem("memo:semantic-search");
    } catch {
      // Preference persistence is best-effort.
    }
  }, [semanticOn]);
  // Toggling semantic search on a device without the model routes straight
  // to the download dialog instead of leaving a silently dead switch.
  useEffect(() => {
    if (semantic.status !== "model-missing") return;
    setSemanticOn(false);
    setEnableSemanticWhenReady(true);
    setModelSettingsOpen(true);
  }, [semantic.status]);

  // The live feed lenses, for async work that lands later (checkbox toggle
  // batches read this at commit time instead of a render-stale capture).
  const feedContextRef = useRef({ view, filters, statsDrilldown, sortKey, parsedQuery });
  feedContextRef.current = { view, filters, statsDrilldown, sortKey, parsedQuery };

  const visibleMemos = useMemo(() => {
    let list = searchScopeMemos;
    if (semanticResults) {
      // Hybrid retrieval is a union: an exact keyword/phrase match can never
      // disappear behind the semantic threshold, and meaning adds results
      // that share no literal text. The keyword tier stays first; semantic
      // score ranks within it and then ranks semantic-only matches.
      const hybridScores = new Map<string, number>();
      list = filterPreservingId(list, editingId, (memo) => {
        const score = hybridSearchScore(memoMatchesQuery(memo, parsedQuery), semanticResults.get(memo.id));
        if (score === null) return false;
        hybridScores.set(memo.id, score);
        return true;
      });
      const compare = SORT_COMPARATORS[sortKey];
      return [...list].sort((a, b) => {
        const scoreDelta = (hybridScores.get(b.id) ?? -1) - (hybridScores.get(a.id) ?? -1);
        if (scoreDelta !== 0) return scoreDelta;
        if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
        return compare(a, b);
      });
    }
    if (!queryIsEmpty(parsedQuery)) {
      list = filterPreservingId(list, editingId, (memo) => memoMatchesQuery(memo, parsedQuery));
    }
    const compare = SORT_COMPARATORS[sortKey];
    return [...list].sort((a, b) => {
      if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
      return compare(a, b);
    });
  }, [searchScopeMemos, parsedQuery, semanticResults, editingId, sortKey]);

  // The day's frozen batch, resolved against live truth: edits show through
  // (ids point at whatever the memo says now), deletions drop out, and the
  // draw order itself never reshuffles mid-day.
  const reviewMemos = useMemo(() => {
    if (!reviewDay) return [];
    const list: Memo[] = [];
    for (const id of reviewDay.ids) {
      const memo = syncState.memos.get(id);
      if (memo && !memo.deletedAt) list.push(memo);
    }
    return list;
  }, [reviewDay, syncState.memos]);

  const feedMemos = view === "trash" ? trashedMemos : view === "review" ? reviewMemos : visibleMemos;
  const visibleFeedIds = useMemo(() => feedMemos.map((memo) => memo.id), [feedMemos]);
  const visibleSelected = useMemo(() => selectionWithinVisibleIds(selected, visibleFeedIds), [selected, visibleFeedIds]);
  // Resolved every render, so a sync that deletes the memo closes its sheet.
  const tagMemoMatch = tagMemoId ? syncState.memos.get(tagMemoId) : null;
  const tagMemo = tagMemoMatch && !tagMemoMatch.deletedAt ? tagMemoMatch : null;

  // The feed renders in pages: the first FEED_PAGE rows immediately, more as
  // the sentinel scrolls near. Keeps first paint and filter swaps flat no
  // matter how many memos exist.
  // Object identity is the generation token: revisiting an earlier query must
  // still start a fresh window rather than reviving that query's old cap.
  // The lenses are what open a new list — semantic search by being switched
  // on or off, NOT by re-ranking. Keying on the ranked map itself made every
  // re-rank a new generation, and a re-rank needs no reason of its own: an
  // edit anywhere reconciles the index, which re-runs the query and hands
  // back an identically ordered but freshly built map. A reader 200 rows into
  // their results watched the feed truncate to one page under them and the
  // browser clamp their scroll into whatever was left.
  const feedQueryKey = feedQuery;
  const feedWindowKey = useMemo(() => ({}), [view, activeTag, activeDay, statsDrilldown, feedQueryKey, filters, sortKey, semanticOn]);
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

  // Typing opens a new result list, and a new list starts at the top — the
  // same rule every other lens follows through changeFeed. Search reached the
  // feed straight from the input instead (a view transition per keystroke
  // would be worse than no transition at all), so it was the one lens that
  // left the reader's old offset in place: the shorter document clamped it,
  // and they landed partway down results they had never scrolled through.
  // Before paint, so the new list is never painted at the stale offset first.
  const feedQueryScrollRef = useRef(feedQueryKey);
  useLayoutEffect(() => {
    if (feedQueryScrollRef.current === feedQueryKey) return;
    feedQueryScrollRef.current = feedQueryKey;
    window.scrollTo(0, 0);
  }, [feedQueryKey]);

  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMoreFeed) return;
    const node = feedSentinelRef.current;
    if (!node) return;
    // Re-created after every cap bump so a still-visible sentinel re-fires.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          // The appended page is pure lookahead (the sentinel fires ~1200px
          // early), so it renders as a transition: clicks and keystrokes
          // interrupt the 80-row reconcile instead of waiting behind it.
          startTransition(() => setRenderWindow((current) => advanceFeedWindow(current, feedWindowKey, FEED_PAGE)));
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
   * Feed reorders run inside a view transition: shared cards glide to their
   * new positions, departures fade back, arrivals rise. Skipped while the
   * mobile drawer is open (its own closing animation would get
   * double-captured). Which cards morph is decided on both sides by
   * tuneFeedTransitionNames.
   *
   * `rewind` separates the two kinds of reorder. A new result list (a filter,
   * a tag, the sort key) starts over: back to page one, back to the top, and
   * the transition masks the scroll reset. A re-ranking of the list the reader
   * is already in (semantic scores landing) keeps both their page and their
   * place — collapsing the window under them would drop them somewhere else
   * entirely.
   */
  const swapFeed = useCallback(
    (apply: () => void, { rewind }: { rewind: boolean }) => {
      const update = () => {
        enterSuppressRef.current = true;
        try {
          flushSync(() => {
            if (rewind) setRenderWindow((current) => ({ ...current, cap: FEED_PAGE }));
            apply();
          });
        } finally {
          enterSuppressRef.current = false;
        }
        tuneFeedTransitionNames(rewind ? 0 : window.scrollY);
        if (rewind) window.scrollTo(0, 0);
      };
      if (drawerOpen) update();
      else {
        tuneFeedTransitionNames(window.scrollY);
        withViewTransition(update);
      }
    },
    [drawerOpen]
  );

  const changeFeed = useCallback((apply: () => void) => swapFeed(apply, { rewind: true }), [swapFeed]);

  // The wiring promised above the useSemanticSearch call.
  publishSemanticRef.current = (commit) => swapFeed(commit, { rewind: false });

  /** Search text set by a control: lands with the swap that animates it. */
  const swapQuery = useCallback((next: string) => {
    queryLeapRef.current = next.trim().toLowerCase();
    setQuery(next);
  }, []);
  /** Search text set by the keyboard: stays on the deferred path. */
  const typeQuery = useCallback((next: string) => {
    queryLeapRef.current = null;
    setQuery(next);
  }, []);

  /**
   * The lenses — tag, day, search, facets, sort, presets — change freely
   * while a memo is being edited: the feed keeps the editing row mounted
   * through every swap (filterPreservingId, renderedFeedMemos), so nothing is
   * lost. Only the views that would unmount the editor — Trash, Daily review,
   * select mode — wait for it, and they say so as a note, not an error: the
   * open editor is where the reader's attention goes back.
   */
  const holdForOpenEdit = useCallback(
    (destinationEn: string, destinationZh: string) => {
      if (!editingId) return false;
      showToast(tr(`Save or cancel the memo you’re editing, then ${destinationEn}.`, `先保存或取消正在编辑的笔记，再${destinationZh}`));
      const area = document.querySelector<HTMLTextAreaElement>(".editor-edit textarea");
      if (area) {
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        area.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
        area.focus({ preventScroll: true });
      }
      return true;
    },
    [editingId, showToast, tr]
  );

  const pickTag = useCallback(
    (path: string | null) => {
      if (view === "memos" && activeTag === path) {
        return;
      }
      changeFeed(() => {
        setActiveTag(path);
        setStatsDrilldown(null);
        setView("memos");
        // Inside a tag every memo carries it, so "No tags" would only ever
        // answer with an empty feed; the chip folds away with the move.
        if (path) setFilters((current) => (current.noTags ? { ...current, noTags: false } : current));
      });
    },
    [view, activeTag, changeFeed]
  );

  const pickDay = useCallback(
    (key: string | null) => {
      if (view === "memos" && activeDay === key) {
        return;
      }
      changeFeed(() => {
        setActiveDay(key);
        setStatsDrilldown(null);
        setView("memos");
      });
    },
    [view, activeDay, changeFeed]
  );

  const showAll = useCallback(() => {
    if (view === "memos" && activeTag === null && activeDay === null && statsDrilldown === null && query.length === 0 && !hasActiveFilters(filters)) {
      return;
    }
    changeFeed(() => {
      setActiveTag(null);
      setActiveDay(null);
      setStatsDrilldown(null);
      swapQuery("");
      setFilters(EMPTY_FILTERS);
      // A selection belongs to the view it was made in.
      if (view !== "memos") {
        setSelectMode(false);
        setSelected(new Set());
        setConfirmBatchDelete(false);
      }
      setView("memos");
    });
  }, [view, activeTag, activeDay, statsDrilldown, query, filters, changeFeed, swapQuery]);

  /** Facet on/off is a discrete choice — it rides the same feed morph as a
      tag or sort change, whether it comes from the panel or a chip's ×. */
  const toggleFacet = useCallback(
    (key: FacetKey) => {
      changeFeed(() => setFilters((current) => ({ ...current, [key]: !current[key] })));
    },
    [changeFeed]
  );

  // Date edits arrive segment-by-segment from the native inputs — update in
  // place like search keystrokes instead of morphing per keypress.
  const patchDateRange = useCallback((patch: Partial<Pick<FeedFilters, "dateFrom" | "dateTo">>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  /** A quick range lands whole, so it morphs like a facet does. */
  const applyPresetRange = useCallback(
    (from: string, to: string) => {
      changeFeed(() => setFilters((current) => ({ ...current, dateFrom: from, dateTo: to })));
    },
    [changeFeed]
  );

  const clearDateRange = useCallback(() => {
    changeFeed(() => setFilters((current) => ({ ...current, dateFrom: null, dateTo: null })));
  }, [changeFeed]);

  const clearStatsDrilldown = useCallback(() => {
    changeFeed(() => setStatsDrilldown(null));
  }, [changeFeed]);

  const openStatsDrilldown = useCallback(
    (drilldown: StatsDrilldown) => {
      changeFeed(() => {
        setStatsOpen(false);
        setStatsDrilldown(drilldown);
        setActiveTag(null);
        setActiveDay(null);
        swapQuery("");
        setFilters(EMPTY_FILTERS);
        setView("memos");
        setSelectMode(false);
        setSelected(new Set());
        setConfirmBatchDelete(false);
      });
    },
    [changeFeed, swapQuery]
  );

  /** A preset restores the whole feed context in one morph. */
  const applySavedFilter = useCallback(
    (item: SavedFilter) => {
      changeFeed(() => {
        setView("memos");
        setActiveTag(item.tag);
        setActiveDay(item.day);
        setStatsDrilldown(null);
        swapQuery(item.query);
        setFilters(item.filters);
      });
    },
    [changeFeed, swapQuery]
  );

  const deleteSavedFilter = useCallback(
    (item: SavedFilter) => {
      setSavedFilters((current) => current.filter((entry) => entry.id !== item.id));
      showToast(tr(`Deleted “${item.name}”`, `已删除「${item.name}」`), "info", {
        action: {
          label: tr("Undo", "撤销"),
          run: () => setSavedFilters((current) => (current.some((entry) => entry.id === item.id) ? current : [...current, item]))
        }
      });
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
    showToast(tr(`Saved “${name}”`, `已保存「${name}」`));
  }

  // The preset whose snapshot equals the live feed state — its row gets the
  // check mark, mirroring the sort menu's radio language.
  const activeSavedId = useMemo(() => {
    if (statsDrilldown) return null;
    const match = savedFilters.find(
      (item) =>
        item.tag === activeTag &&
        item.day === activeDay &&
        item.query.trim().toLowerCase() === trimmedQuery &&
        filtersEqual(item.filters, filters)
    );
    return match?.id ?? null;
  }, [savedFilters, activeTag, activeDay, statsDrilldown, trimmedQuery, filters]);

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
  const statsChipLabel = useMemo(() => (statsDrilldown ? statsDrilldownLabel(statsDrilldown, locale) : null), [statsDrilldown, locale]);

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
    if (statsChipLabel) keys.push("stats");
    if (rangeChipLabel) keys.push("range");
    for (const row of FACET_ROWS) if (filters[row.key]) keys.push(row.key);
    return keys;
  }, [view, selectMode, activeDay, statsChipLabel, rangeChipLabel, filters]);
  const prevChipsRef = useRef<string[]>([]);
  const prevChips = prevChipsRef.current;
  useLayoutEffect(() => {
    prevChipsRef.current = chipKeys;
  }, [chipKeys]);
  let newChipCount = 0;
  const chipDelay = (key: string) => (prevChips.includes(key) ? undefined : `${Math.min(newChipCount++, 3) * 0.02}s`);

  const openTrash = useCallback(() => {
    if (view === "trash") return;
    if (holdForOpenEdit("open Trash", "打开回收站")) return;
    changeFeed(() => {
      setView("trash");
      setStatsDrilldown(null);
      // Same flush: the "已选 N 条" pill hands topbar-action to the Empty
      // Trash pill inside one morph instead of two competing transitions.
      setSelectMode(false);
      setSelected(new Set());
      setConfirmBatchDelete(false);
    });
  }, [view, changeFeed, holdForOpenEdit]);

  /**
   * Opening 每日回顾 is what draws the batch: the first visit of a local day
   * freezes today's picks (in state and localStorage) and every later visit
   * replays them. Setting the batch inside the same flush as the view switch
   * lets the view transition carry cards shared with the previous feed to
   * their new positions instead of replaying entrances.
   */
  const openReview = useCallback(() => {
    if (view !== "review" && holdForOpenEdit("open Daily review", "打开每日回顾")) return;
    let next = reviewDay;
    if (!reviewDayValid(next, reviewSettings)) {
      next = buildReviewDay(activeMemos, reviewSettings);
      persistReviewDay(next);
    }
    // Re-clicking the nav item on a still-valid day is a no-op; on a rolled-
    // over day it deals the new batch in place.
    if (view === "review" && next === reviewDay) return;
    changeFeed(() => {
      if (next !== reviewDay) setReviewDay(next);
      setView("review");
      setStatsDrilldown(null);
      setSelectMode(false);
      setSelected(new Set());
      setConfirmBatchDelete(false);
    });
  }, [view, reviewDay, reviewSettings, activeMemos, changeFeed, holdForOpenEdit]);

  // Crossing midnight while the review view sits open: returning focus (or
  // visibility) re-checks the frozen batch and deals the new day in a morph.
  useEffect(() => {
    if (phase !== "ready" || view !== "review") return;
    function refresh() {
      if (document.visibilityState === "hidden") return;
      if (reviewDayValid(reviewDay, reviewSettings)) return;
      const next = buildReviewDay(memosOf(syncStateRef.current), reviewSettings);
      persistReviewDay(next);
      withViewTransition(() => flushSync(() => setReviewDay(next)));
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [phase, view, reviewDay, reviewSettings]);

  function handleSaveReviewSettings(next: ReviewSettings) {
    setReviewSettings(next);
    persistReviewSettings(next);
    setReviewSettingsOpen(false);
    showToast(tr("Saved review settings", "已保存回顾设置"));
    if (reviewDayValid(reviewDay, next)) return;
    if (view === "review") {
      // Redraw immediately — after the dialog's exit has painted, so the
      // feed's morph to the new batch reads as its own beat.
      const nextDay = buildReviewDay(activeMemos, next);
      persistReviewDay(nextDay);
      window.requestAnimationFrame(() => withViewTransition(() => flushSync(() => setReviewDay(nextDay))));
    } else {
      // Invalidate; the next visit draws under the new settings.
      clearReviewDay();
      setReviewDay(null);
    }
  }

  /**
   * Select mode swaps the whole breadcrumb row for the selection toolbar; a
   * view transition carries the swap — the fused location pill morphs into
   * the "已选 N 条" counter (they share view-transition-name: topbar-action)
   * while the card checkboxes pop in via their own CSS transitions.
   */
  const enterSelectMode = useCallback(() => {
    if (holdForOpenEdit("select memos", "多选笔记")) return;
    withViewTransition(() =>
      flushSync(() => {
        setSelectMode(true);
        setSelected(new Set());
        setConfirmBatchDelete(false);
        setBulkTagOpen(false);
        setTagMemoId(null);
        pendingBatchTagRef.current = null;
      })
    );
  }, [holdForOpenEdit]);

  const exitSelectMode = useCallback(() => {
    withViewTransition(() =>
      flushSync(() => {
        setSelectMode(false);
        setSelected(new Set());
        setConfirmBatchDelete(false);
        setBulkTagOpen(false);
        setTagMemoId(null);
        pendingBatchTagRef.current = null;
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
    const localCleanup = clearLocalDeviceData();
    resetSessionUi();
    resetLocalWorkspaceState();
    setPhase("login");
    await localCleanup;
  }

  async function handleCreate(data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }): Promise<boolean> {
    const content = activeTag ? inheritTagContext(data.content, activeTag) : data.content;
    setCreating(true);
    try {
      const result = await guard(() => createMemo(data.clientId, content, data.newImages));
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
            content,
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
          if (memoMatchesSubmittedDraft(cause.current, content, data.newImages.map((image) => image.id))) {
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
        ? tr("A newer version arrived. Your draft is safe — review it before saving again.", "远端已有新版本，草稿已保留，请确认后再次保存")
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
      const saved = result.memo;
      // The lenses may have moved on while the memo was open (they are free
      // to now): a memo the current view no longer shows recedes in the
      // feed's own removal choreography rather than vanishing under the
      // reader when the editor closes.
      const leavesView =
        view === "memos" && !(memoMatchesSearchScope(saved, { activeTag, activeDay, statsDrilldown, filters }) && memoMatchesQuery(saved, parsedQuery));
      const land = () => {
        applySyncChanges([saved], [], []);
        setEditingId(null);
        setEditConflictId(null);
        editingBaseSeqRef.current = null;
      };
      if (leavesView) withViewTransition(() => flushSync(land));
      else land();
      void runSync();
      notifyPeers();
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
      showToast(errorMessage(cause, "Couldn’t update the memo.", "更新笔记失败"), "error");
    }
  }

  /**
   * Feed checkbox click. The box flips optimistically (pending layer) while
   * the flip queues behind the memo's in-flight batch, if any; each batch is
   * one content edit through the normal updateMemo path, so it bumps
   * updatedAt/seq — the toggle counts as an Edit everywhere an edit does
   * (menu meta, Edited sorts, sync, version checks).
   */
  function handleToggleTask(memo: Memo, lineKey: number, checked: boolean) {
    // The open editor owns that memo's content; its draft would just
    // conflict with the flip. (The card shows the editor then anyway.)
    if (editingIdRef.current === memo.id) return;
    stampTaskFlip(memo.id, lineKey, checked);
    let queue = taskFlipQueueRef.current.get(memo.id);
    if (!queue) {
      queue = { running: false, flips: [], base: memo };
      taskFlipQueueRef.current.set(memo.id, queue);
    } else {
      queue.base = freshestTaskMemo(queue.base, memo);
    }
    queue.flips.push({ lineKey, checked });
    if (!queue.running) void drainTaskFlips(memo.id, queue);
  }

  async function drainTaskFlips(memoId: string, queue: TaskFlipQueue) {
    queue.running = true;
    try {
      while (queue.flips.length > 0) {
        const batch = queue.flips.splice(0);
        const synced = syncStateRef.current.memos.get(memoId);
        if (!synced) {
          settleTaskFlips(memoId, null);
          return;
        }
        const current = freshestTaskMemo(queue.base, synced);
        queue.base = current;
        if (current.deletedAt) {
          settleTaskFlips(memoId, null);
          return;
        }
        // Stale flips (the line stopped being a task) drop silently; the
        // settle below clears their pending marks.
        const nextContent = applyTaskFlips(current.content, batch);
        if (nextContent === current.content) {
          // Net-zero batch (e.g. tick + untick before the drain ran), or a
          // concurrent edit already landed the requested state.
          settleTaskFlips(memoId, current.content);
          continue;
        }
        const result = await guard(() => updateMemo(memoId, { expectedSeq: current.seq, content: nextContent }));
        if (!result?.memo) {
          settleTaskFlips(memoId, null);
          return;
        }
        // Set this before touching React state: another queued batch can now
        // continue from the response's seq/content in this microtask.
        queue.base = freshestTaskMemo(queue.base, result.memo);
        commitTaskBatch(result.memo);
      }
    } catch (cause) {
      queue.flips.length = 0;
      settleTaskFlips(memoId, null);
      if (!reconcileVersionConflict(cause)) {
        showToast(errorMessage(cause, "Couldn’t update the task.", "任务状态更新失败"), "error");
      }
    } finally {
      queue.running = false;
    }
  }

  /**
   * Land one toggle batch. The feed glides (view transition) when the edit
   * moves the card — Edited sorts reorder on the updatedAt bump, and ticking
   * a memo's last open task drops it out of the open-task filter — and lands
   * in place otherwise, leaving the motion to the checkbox's own transition.
   */
  function commitTaskBatch(nextMemo: Memo) {
    const { view: liveView, filters: liveFilters, statsDrilldown: liveStatsDrilldown, sortKey: liveSortKey, parsedQuery: liveQuery } = feedContextRef.current;
    const leavesTaskFilter = liveFilters.hasOpenTask && !facetsOf(nextMemo).hasOpenTask;
    const stillMatches =
      memoMatchesFilters(nextMemo, liveFilters) &&
      memoMatchesQuery(nextMemo, liveQuery) &&
      (!liveStatsDrilldown || memoMatchesStatsDrilldown(nextMemo, liveStatsDrilldown));
    const animate = liveView === "memos" && (liveSortKey.startsWith("updated") || !stillMatches);
    const apply = () => {
      applySyncChanges([nextMemo], [], []);
      settleTaskFlips(nextMemo.id, nextMemo.content);
    };
    if (animate) withViewTransition(() => flushSync(apply));
    else apply();
    void runSync();
    notifyPeers();
    if (liveView === "memos" && leavesTaskFilter) {
      showToast(tr("All tasks done — this memo left the “With open tasks” filter", "任务已全部完成，已移出「含未完成任务」筛选"));
    }
  }

  async function handleCopy(memo: Memo) {
    try {
      await navigator.clipboard.writeText(memo.content);
      showToast(tr("Copied to clipboard", "已复制到剪贴板"));
    } catch {
      showToast(tr("Couldn’t copy to clipboard.", "复制到剪贴板失败"), "error");
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
      showToast(errorMessage(cause, "Couldn’t delete the memo.", "删除笔记失败"), "error");
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
      showToast(errorMessage(cause, "Couldn’t restore the memo.", "恢复笔记失败"), "error");
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
      showToast(errorMessage(cause, "Couldn’t delete the memo.", "删除笔记失败"), "error");
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
      showToast(tr("Emptied Trash", "已清空回收站"));
    } catch (cause) {
      setEmptyTrashArm(false);
      showToast(errorMessage(cause, "Couldn’t empty Trash.", "清空回收站失败"), "error");
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
        showToast(tr(`Couldn’t delete ${count(failedIds.length, "memo")}.`, `有 ${count(failedIds.length, "memo")}删除失败`), "error");
      } else {
        showToast(tr(`Moved ${count(changed.length, "memo")} to Trash`, `已将 ${count(changed.length, "memo")}移入回收站`));
      }
    } finally {
      setBatchBusy(false);
    }
  }

  /** One card's ⋯ menu aims the tag sheet at that memo alone. */
  function openMemoTagDialog(memo: Memo) {
    if (memo.deletedAt) return;
    pendingBatchTagRef.current = null;
    setBulkTagOpen(false);
    setTagMemoId(memo.id);
  }

  function selectionTagTargets(): Memo[] {
    return [...visibleSelected]
      .map((id) => syncStateRef.current.memos.get(id))
      .filter((memo): memo is Memo => Boolean(memo && !memo.deletedAt));
  }

  function memoTagTargets(): Memo[] {
    const memo = tagMemoId ? syncStateRef.current.memos.get(tagMemoId) : null;
    return memo && !memo.deletedAt ? [memo] : [];
  }

  const prepareBatchTag = (tag: string) => prepareTagApply(selectionTagTargets(), tag, "selection");
  const prepareMemoTag = (tag: string) => prepareTagApply(memoTagTargets(), tag, "memo");

  /**
   * Resolve the server work while the tag sheet stays present. The visual
   * commit is deliberately deferred: BulkTagDialog exits first, then
   * finishTagApply lets changed cards and the selection toolbar morph together.
   */
  async function prepareTagApply(targets: Memo[], tag: string, scope: PendingBatchTag["scope"]): Promise<boolean> {
    if (targets.length === 0 || pendingBatchTagRef.current) return false;

    const pendingTargets = targets.filter((memo) => !tagsOf(memo).includes(tag));
    const sessionEpoch = sessionEpochRef.current;
    try {
      const results = await mapSettledWithLimit(pendingTargets, 4, (memo) =>
        updateMemo(memo.id, { expectedSeq: memo.seq, content: appendTagToContent(memo.content, tag) })
      );
      if (sessionEpoch !== sessionEpochRef.current) return false;

      const changed: Memo[] = [];
      const refreshed: Memo[] = [];
      const retryIds: string[] = [];
      let failedCount = 0;
      let firstFailure: string | null = null;
      let authLost = false;
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value.memo) {
          changed.push(result.value.memo);
          return;
        }
        const target = pendingTargets[index];
        if (result.status === "fulfilled") {
          failedCount += 1;
          retryIds.push(target.id);
          firstFailure ??= tr("The server did not return the updated memo.", "服务器未返回更新后的笔记");
          return;
        }
        if (result.reason instanceof AuthRequiredError) {
          authLost = true;
          return;
        }
        if (result.reason instanceof ApiError && result.reason.code === "VERSION_CONFLICT" && result.reason.current) {
          const current = result.reason.current;
          // A concurrent tab may have completed this exact operation first.
          // Treat that server truth as idempotent success instead of asking
          // the user to retry an already-applied tag.
          if (!current.deletedAt && tagsOf(current).includes(tag)) {
            changed.push(current);
            return;
          }
          refreshed.push(current);
          failedCount += 1;
          if (!current.deletedAt) retryIds.push(current.id);
          firstFailure ??= errorMessage(result.reason);
          return;
        }
        failedCount += 1;
        retryIds.push(target.id);
        firstFailure ??= errorMessage(result.reason, "Couldn’t update a selected memo.", "无法更新其中一条所选笔记");
      });
      if (authLost) {
        dropToLogin();
        return false;
      }

      // Even an all-failed batch has a settled result: close the sheet and
      // retain precisely those failures so retrying is one action away.
      pendingBatchTagRef.current = {
        scope,
        tag,
        changed,
        refreshed,
        retryIds,
        failedCount,
        firstFailure,
        alreadyTagged: targets.length - pendingTargets.length,
        targetCount: targets.length
      };
      return true;
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t add the tag.", "添加标签失败"), "error");
      return false;
    }
  }

  function closeTagDialogs() {
    setBulkTagOpen(false);
    setTagMemoId(null);
  }

  function finishTagApply() {
    const result = pendingBatchTagRef.current;
    pendingBatchTagRef.current = null;
    if (!result) {
      closeTagDialogs();
      return;
    }

    const fromSelection = result.scope === "selection";
    if (fromSelection && result.retryIds.length === 0) restoreLocationFocusRef.current = true;
    withViewTransition(() =>
      flushSync(() => {
        closeTagDialogs();
        if (result.changed.length > 0 || result.refreshed.length > 0) {
          applySyncChanges([...result.refreshed, ...result.changed], [], []);
        }
        if (!fromSelection) return;
        if (result.retryIds.length === 0) {
          setSelectMode(false);
          setSelected(new Set());
        } else {
          setSelected(new Set(result.retryIds));
        }
        setConfirmBatchDelete(false);
      })
    );

    if (result.changed.length > 0 || result.refreshed.length > 0 || result.failedCount > 0) {
      void runSync();
    }
    if (result.changed.length > 0) {
      notifyPeers();
    }
    if (!fromSelection) {
      // One memo, so the batch counters collapse to a single outcome.
      if (result.failedCount > 0) {
        showToast(result.firstFailure ?? tr("Couldn’t add the tag.", "添加标签失败"), "error");
      } else if (result.alreadyTagged === result.targetCount) {
        showToast(tr(`This memo already has #${result.tag}`, `这条笔记已有 #${result.tag}`));
      } else {
        showToast(tr(`Added #${result.tag}`, `已添加 #${result.tag}`));
      }
      return;
    }

    if (result.failedCount > 0) {
      const successful = result.targetCount - result.failedCount;
      const detail = result.firstFailure ? ` ${result.firstFailure}` : "";
      const detailZh = result.firstFailure ? `，${result.firstFailure}` : "";
      showToast(
        tr(
          `Added #${result.tag} to ${successful} of ${count(result.targetCount, "memo")}.${detail}`,
          `已为 ${result.targetCount} 条笔记中的 ${successful} 条添加 #${result.tag}${detailZh}`
        ),
        "error"
      );
    } else if (result.alreadyTagged === result.targetCount) {
      showToast(tr(`All selected memos already have #${result.tag}`, `所选笔记都已有 #${result.tag}`));
    } else {
      showToast(tr(`Added #${result.tag} to ${count(result.changed.length, "memo")}`, `已为 ${count(result.changed.length, "memo")}添加 #${result.tag}`));
    }
  }

  // Latest closures behind one stable identity — FeedItem's memoization
  // survives every App re-render. (The handle* function declarations below
  // are hoisted, so assigning here each render is safe.)
  const feedActionsRef = useRef({
    startEdit: (id: string) => {
      const currentEditing = editingIdRef.current;
      if (currentEditing && currentEditing !== id) {
        showToast(tr("Save or cancel the open edit before editing another memo.", "请先保存或取消当前编辑，再编辑其他笔记"));
        return;
      }
      editingBaseSeqRef.current = syncStateRef.current.memos.get(id)?.seq ?? null;
      setEditConflictId(null);
      setEditingId(id);
    },
    saveEdit: handleSaveEdit,
    togglePin: handleTogglePin,
    addTag: openMemoTagDialog,
    copy: handleCopy,
    trash: handleTrash,
    restore: handleRestore,
    purge: handlePurge,
    toggleTask: handleToggleTask,
    acceptEditConflict: (id: string) => {
      const current = syncStateRef.current.memos.get(id);
      if (!current || current.deletedAt) return;
      editingBaseSeqRef.current = current.seq;
      setEditConflictId(null);
      showToast(tr("Your draft is still here. Saving now will use the latest version as its base.", "草稿仍在，再次保存将以最新版本为基线"));
    },
    pickTag,
    toggleSelect
  });
  feedActionsRef.current = {
    startEdit: (id: string) => {
      const currentEditing = editingIdRef.current;
      if (currentEditing && currentEditing !== id) {
        showToast(tr("Save or cancel the open edit before editing another memo.", "请先保存或取消当前编辑，再编辑其他笔记"));
        return;
      }
      editingBaseSeqRef.current = syncStateRef.current.memos.get(id)?.seq ?? null;
      setEditConflictId(null);
      setEditingId(id);
    },
    saveEdit: handleSaveEdit,
    togglePin: handleTogglePin,
    addTag: openMemoTagDialog,
    copy: handleCopy,
    trash: handleTrash,
    restore: handleRestore,
    purge: handlePurge,
    toggleTask: handleToggleTask,
    acceptEditConflict: (id: string) => {
      const current = syncStateRef.current.memos.get(id);
      if (!current || current.deletedAt) return;
      editingBaseSeqRef.current = current.seq;
      setEditConflictId(null);
      showToast(tr("Your draft is still here. Saving now will use the latest version as its base.", "草稿仍在，再次保存将以最新版本为基线"));
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
      addTag: (memo) => feedActionsRef.current.addTag(memo),
      copy: (memo) => void feedActionsRef.current.copy(memo),
      share: (memo) => setShareMemo(memo),
      trash: (memo) => void feedActionsRef.current.trash(memo),
      restore: (memo) => void feedActionsRef.current.restore(memo),
      purge: (memo) => void feedActionsRef.current.purge(memo),
      pickTag: (path) => feedActionsRef.current.pickTag(path),
      openImage: (items, index) => setLightbox({ items, index }),
      toggleSelect: (memo) => feedActionsRef.current.toggleSelect(memo),
      toggleTask: (memo, lineKey, checked) => feedActionsRef.current.toggleTask(memo, lineKey, checked)
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
    const next = selectionWithinVisibleIds(selected, visibleFeedIds);
    const unchanged = next.size === selected.size && [...next].every((id) => selected.has(id));
    if (!unchanged) setSelected(next);
    // A sync can delete or filter away every failed retry target. Do not
    // strand the toolbar in an inert "0 selected" state.
    if (selected.size > 0 && next.size === 0) {
      restoreLocationFocusRef.current = true;
      setSelectMode(false);
    }
    setConfirmBatchDelete(false);
  }, [selectMode, selected, visibleFeedIds]);

  useLayoutEffect(() => {
    if (selectMode || !restoreLocationFocusRef.current) return;
    restoreLocationFocusRef.current = false;
    document.querySelector<HTMLButtonElement>(".loc-trigger")?.focus({ preventScroll: true });
  }, [selectMode]);

  async function handlePinTag(path: string, pinned: boolean) {
    try {
      const result = await guard(() => pinTag(path, pinned));
      if (!result) return;
      applySyncChanges([], [], [result.tag]);
      void runSync();
      notifyPeers();
      showToast(pinned ? tr(`Pinned #${path}`, `已置顶 #${path}`) : tr(`Unpinned #${path}`, `已取消置顶 #${path}`));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t complete the action.", "操作失败"), "error");
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
      setSavedFilters((current) => renameSavedFilterTags(current, from, to));
      setStatsDrilldown((current) =>
        current?.kind === "tag" && tagMatches(current.tag, from) ? { ...current, tag: to + current.tag.slice(from.length) } : current
      );
      void runSync();
      notifyPeers();
      showToast(tr(`Renamed #${from} to #${to} in ${count(result.updated, "memo")}`, `已将 #${from} 重命名为 #${to}，更新了 ${count(result.updated, "memo")}`));
    } catch (cause) {
      void runSync();
      notifyPeers();
      showToast(errorMessage(cause, "Couldn’t rename the tag.", "重命名标签失败"), "error");
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
          setSavedFilters((current) => removeSavedFiltersForTag(current, path));
          setStatsDrilldown((current) => (current?.kind === "tag" && tagMatches(current.tag, path) ? null : current));
        })
      );
      void runSync();
      notifyPeers();
      showToast(tr(`Removed #${path} from ${count(result.updated, "memo")}`, `已从 ${count(result.updated, "memo")}中移除 #${path}`));
    } catch (cause) {
      void runSync();
      notifyPeers();
      showToast(errorMessage(cause, "Couldn’t remove the tag.", "移除标签失败"), "error");
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
      showToast(tr("Exported your backup", "已导出备份"));
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t export the backup.", "导出备份失败"), "error");
    }
  }

  async function handleImportFile(file: File) {
    try {
      const payload = JSON.parse(await file.text()) as BackupPayload;
      if (!payload || payload.format !== "memo-backup" || payload.version !== 1 || !Array.isArray(payload.memos)) {
        showToast(tr("This isn’t a memo backup file.", "这不是有效的备份文件"), "error");
        return;
      }
      const imageCount = payload.memos.reduce((sum, memo) => sum + (Array.isArray(memo.images) ? memo.images.length : 0), 0);
      setImportTarget({ payload, memoCount: payload.memos.length, imageCount });
    } catch {
      showToast(tr("Couldn’t read the backup file.", "无法读取备份文件"), "error");
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
        const skippedLabel = result.skipped > 0 ? ` — skipped ${result.skipped} that already existed` : "";
        const skippedZh = result.skipped > 0 ? `，跳过 ${result.skipped} 条已存在的笔记` : "";
        showToast(
          tr(
            `Imported ${count(result.imported, "memo")} with ${count(result.images, "image")}${skippedLabel}`,
            `已导入 ${count(result.imported, "memo")}和 ${count(result.images, "image")}${skippedZh}`
          )
        );
      } else if (result.skipped > 0) {
        showToast(
          tr(
            `Nothing new to import — ${count(result.skipped, "memo")} already existed`,
            `没有可导入的新内容，${result.skipped} 条笔记已存在`
          )
        );
      } else {
        showToast(tr("Import complete — no new memos", "导入完成，没有新的笔记"));
      }
    } catch (cause) {
      // Earlier chunks may already be committed; reconcile them and let a
      // retry safely skip their stable ids.
      void runSync();
      notifyPeers();
      showToast(errorMessage(cause, "Couldn’t import the backup.", "导入备份失败"), "error");
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
        <ToastStack toasts={toasts} dismissLabel={tr("Dismiss", "关闭")} onDismiss={dismissToast} onPause={pauseToasts} onResume={resumeToasts} />
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
          onOpenReview={() => {
            openReview();
            closeDrawer();
          }}
          onOpenReviewSettings={() => closeDrawer(() => setReviewSettingsOpen(true))}
          onOpenModelSettings={() =>
            closeDrawer(() => {
              setEnableSemanticWhenReady(false);
              setModelSettingsOpen(true);
            })
          }
          onOpenStats={() => closeDrawer(() => setStatsOpen(true))}
          onSetTheme={setTheme}
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
            ) : view === "review" ? (
              // Daily review borrows the Trash breadcrumb language: ⌂ / ✦
              // 每日回顾, same cascade-in, ⌂ steps back out to All memos.
              <nav className="crumbs" aria-label={tr("Location", "当前位置")}>
                <button type="button" className="crumb crumb-home" onClick={showAll} aria-label={tr("All memos", "全部笔记")} style={{ animationDelay: "0s" }}>
                  <Home size={15} aria-hidden="true" />
                </button>
                <ChevronRight size={13} className="crumb-sep" aria-hidden="true" style={{ animationDelay: "0.015s" }} />
                <span className="crumb crumb-review is-current" aria-current="page" style={{ animationDelay: "0.035s" }}>
                  <Sparkles size={13} aria-hidden="true" />
                  {tr("Daily review", "每日回顾")}
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
                <button
                  type="button"
                  className="select-pill select-all"
                  disabled={feedMemos.length === 0}
                  aria-label={allVisibleSelected ? tr("Clear selection", "清除选择") : tr("Select all memos", "全选笔记")}
                  onClick={toggleSelectAll}
                >
                  <ListChecks size={14} className="select-all-icon" aria-hidden="true" />
                  <span className="select-all-label">
                    <SwapText id={allVisibleSelected ? "clear" : "all"}>
                      {allVisibleSelected ? tr("Clear", "清除") : tr("Select all", "全选")}
                    </SwapText>
                  </span>
                </button>
                <button
                  type="button"
                  className="select-pill select-tag"
                  disabled={visibleSelectedCount === 0 || batchBusy}
                  aria-haspopup="dialog"
                  aria-label={tr("Add a tag to selected memos", "为所选笔记添加标签")}
                  onClick={() => {
                    setConfirmBatchDelete(false);
                    pendingBatchTagRef.current = null;
                    setBulkTagOpen(true);
                  }}
                >
                  <Tags size={14} aria-hidden="true" />
                  <span>{tr("Add tag", "加标签")}</span>
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
                <button type="button" className="select-pill select-exit" onClick={exitSelectMode} aria-label={tr("Cancel selection", "取消多选")}>
                  <X size={14} className="select-exit-icon" aria-hidden="true" />
                  <span className="select-exit-label">{tr("Cancel", "取消")}</span>
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
            {view === "review" ? (
              // The review view's counterpart of Empty Trash: same slot, same
              // topbar-action morph, neutral tint (it opens a dialog).
              <button
                type="button"
                className="review-config-button"
                aria-haspopup="dialog"
                onClick={() => setReviewSettingsOpen(true)}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>{tr("Review settings", "回顾设置")}</span>
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
                {statsChipLabel ? (
                  <FilterChip
                    icon={ChartNoAxesColumn}
                    label={statsChipLabel}
                    clearLabel={tr(`Clear statistics filter: ${statsChipLabel}`, `清除统计筛选：${statsChipLabel}`)}
                    transitionName="stats-filter-chip"
                    delay={chipDelay("stats")}
                    onClear={clearStatsDrilldown}
                  />
                ) : null}
                {rangeChipLabel ? (
                  <FilterChip
                    icon={CalendarRange}
                    label={rangeChipLabel}
                    clearLabel={tr(`Clear date range: ${rangeChipLabel}`, `清除日期范围：${rangeChipLabel}`)}
                    editLabel={tr(`Edit date range: ${rangeChipLabel}`, `编辑日期范围：${rangeChipLabel}`)}
                    transitionName="range-filter-chip"
                    delay={chipDelay("range")}
                    onClear={clearDateRange}
                    onEdit={() => setFilterOpenRequest((n) => n + 1)}
                  />
                ) : null}
                {FACET_ROWS.filter((row) => filters[row.key]).map((row) => (
                  <FilterChip
                    key={row.key}
                    icon={row.icon}
                    label={tr(row.en, row.zh)}
                    clearLabel={tr(`Clear “${row.en}” filter`, `清除「${row.zh}」筛选`)}
                    editLabel={tr(`Edit filters: “${row.en}”`, `编辑筛选：「${row.zh}」`)}
                    transitionName={`facet-chip-${row.key}`}
                    delay={chipDelay(row.key)}
                    onClear={() => toggleFacet(row.key)}
                    onEdit={() => setFilterOpenRequest((n) => n + 1)}
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
                  onChange={(event) => typeQuery(event.target.value)}
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
                      // The same restoration the home pill performs, so it
                      // reads the same: one click, the full list glides back.
                      changeFeed(() => swapQuery(""));
                      searchRef.current?.focus();
                    }}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className={`icon-button semantic-toggle${semanticOn ? " is-active" : ""}`}
                aria-pressed={semanticOn}
                aria-label={tr("Semantic Search", "语义搜索")}
                title={
                  semantic.status === "error"
                    ? tr("Semantic search stopped — open details", "语义搜索已停止——打开详情")
                    : semantic.status === "indexing"
                      ? tr(
                          `Semantic search — indexing${semantic.progress ? ` ${semantic.progress.done}/${semantic.progress.total}` : "…"}; keyword search remains available`,
                          `语义搜索——索引中${semantic.progress ? ` ${semantic.progress.done}/${semantic.progress.total}` : "…"}；关键词搜索仍可用`
                        )
                      : semantic.queryProgress
                        ? tr("Semantic Search Is Working — Open Progress", "语义搜索正在工作——打开进度")
                        : semantic.status === "preparing"
                          ? tr("Semantic Model Is Loading — Open Progress", "语义模型正在加载——打开进度")
                          : semanticOn
                            ? tr(
                                "Semantic search is on — keyword matches stay first and related memos are added",
                                "语义搜索已开启——关键词命中优先，并补充意思相关的笔记"
                              )
                            : tr("Semantic search — find memos by meaning", "语义搜索——按意思找笔记")
                }
                onClick={() => {
                  if (semantic.status === "error") {
                    setModelSettingsOpen(true);
                    return;
                  }
                  // While work is unfinished the Brain is a monitor, not a
                  // switch: it opens the panel and marks the progress block.
                  if (semanticBusy) {
                    setModelSettingsAttend((count) => count + 1);
                    setModelSettingsOpen(true);
                    return;
                  }
                  // Switching the lens off drops every semantic-only row and
                  // re-sorts what stays, all in this commit, so it moves like
                  // a filter change. Switching it on changes nothing yet —
                  // the ranking lands later and animates its own arrival.
                  if (semanticOn) changeFeed(() => setSemanticOn(false));
                  else setSemanticOn(true);
                }}
              >
                <Brain size={17} aria-hidden="true" />
                {semanticBusy ? (
                  <Loader2 size={9} className="semantic-toggle-progress spin" aria-hidden="true" />
                ) : null}
              </button>
              <SearchFilter
                filters={filters}
                saved={savedFilters}
                activeSavedId={activeSavedId}
                canSave={filtersActive && statsDrilldown === null}
                disabled={false}
                activeTag={activeTag}
                openRequest={filterOpenRequest}
                onToggleFacet={toggleFacet}
                onDateChange={patchDateRange}
                onPresetRange={applyPresetRange}
                onClearDates={clearDateRange}
                onApplySaved={applySavedFilter}
                onDeleteSaved={deleteSavedFilter}
                onSaveCurrent={() => setSavingFilter(true)}
              />
            </div>
          ) : null}
        </div>

        {!syncStatus.online || syncStatus.degraded ? (
          // The link to the server, said in words when it matters: offline,
          // or pulls failing while online. Until it clears, the feed is the
          // last good sync — which is still the whole notebook.
          <div className="sync-notice" role="status">
            {syncStatus.online ? <CloudOff size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
            <span className="sync-notice-text">
              {syncStatus.online
                ? tr("Can’t reach the server · showing your last synced memos", "无法连接服务器 · 显示上次同步的笔记")
                : tr("Offline · showing your last synced memos", "离线 · 显示上次同步的笔记")}
            </span>
            {syncStatus.online ? (
              <button type="button" className="sync-notice-retry" onClick={retrySync}>
                {tr("Retry", "重试")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="composer" hidden={view !== "memos"}>
          <Editor mode="create" knownTags={knownTags} contextTag={activeTag} busy={creating} onSubmit={handleCreate} />
        </div>

        <section
          className={`memo-feed${selectMode && view === "memos" ? " is-select" : ""}${renderedFeedMemos.length <= SMALL_FEED ? " is-small" : ""}`}
          aria-label={view === "trash" ? tr("Trash", "回收站") : view === "review" ? tr("Daily review", "每日回顾") : tr("Memo list", "笔记列表")}
        >
          {view === "review" && reviewDay && feedMemos.length > 0 ? (
            // The day's masthead: date and batch size, fixed all day. Its own
            // view-transition-name keeps it steady while a settings change
            // morphs the cards beneath it.
            <div className="review-banner">
              <Sparkles size={14} aria-hidden="true" />
              <span>
                {formatDayLabel(reviewDay.day, locale)}
                {tr(` · ${count(feedMemos.length, "memo")} to revisit`, ` · 回顾 ${count(feedMemos.length, "memo")}`)}
              </span>
            </div>
          ) : null}
          {feedMemos.length === 0 ? (
            <div className="feed-empty">
              {view === "trash" ? (
                <>
                  <p className="feed-empty-title">{tr("Trash is empty", "回收站是空的")}</p>
                  <p>{tr("Deleted memos appear here before you restore or permanently delete them.", "删除的笔记会先到这里，可以恢复或彻底删除")}</p>
                </>
              ) : view === "review" ? (
                <>
                  <p className="feed-empty-title">{tr("Nothing to review today", "今天没有可回顾的笔记")}</p>
                  <p>{tr("Widen the scope or time range to draw more memos.", "试试放宽回顾范围或时间范围")}</p>
                  <button type="button" className="ghost-button feed-empty-action" onClick={() => setReviewSettingsOpen(true)}>
                    <SlidersHorizontal size={15} aria-hidden="true" />
                    {tr("Review settings", "回顾设置")}
                  </button>
                </>
              ) : semanticPending ? (
                <>
                  <p className="feed-empty-title">{tr("Searching by meaning…", "正在按意思搜索…")}</p>
                  <p>{tr("No memo uses those words. Looking for ones that mean the same thing.", "没有笔记用到这些词，正在找意思相近的")}</p>
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
                taskFlips={pendingTaskFlips.get(memo.id)}
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
      {shareMemo ? <ShareDialog memo={shareMemo} onToast={showToast} onClose={() => setShareMemo(null)} /> : null}
      {statsOpen ? (
        <StatsModal memos={activeMemos} uniqueTagCount={uniqueTagCount} onClose={() => setStatsOpen(false)} onDrilldown={openStatsDrilldown} />
      ) : null}
      {bulkTagOpen ? (
        <BulkTagDialog
          selectedCount={visibleSelectedCount}
          knownTags={knownTags}
          onApply={prepareBatchTag}
          onDismiss={() => {
            pendingBatchTagRef.current = null;
            setBulkTagOpen(false);
          }}
          onApplied={finishTagApply}
        />
      ) : null}
      {tagMemo ? (
        <BulkTagDialog
          scope="memo"
          selectedCount={1}
          knownTags={knownTags}
          ownedTags={tagsOf(tagMemo)}
          onApply={prepareMemoTag}
          onDismiss={() => {
            pendingBatchTagRef.current = null;
            setTagMemoId(null);
          }}
          onApplied={finishTagApply}
        />
      ) : null}
      {reviewSettingsOpen ? (
        <ReviewSettingsModal
          settings={reviewSettings}
          memos={activeMemos}
          knownTags={knownTags}
          onSave={handleSaveReviewSettings}
          onClose={() => setReviewSettingsOpen(false)}
        />
      ) : null}
      {modelSettingsOpen ? (
        <ModelSettingsModal
          onClose={() => {
            setModelSettingsOpen(false);
            setModelSettingsAttend(0);
            setEnableSemanticWhenReady(false);
          }}
          onModelReady={() => {
            if (!enableSemanticWhenReady) return;
            setEnableSemanticWhenReady(false);
            setSemanticOn(true);
          }}
          onModelCleared={() => {
            setEnableSemanticWhenReady(false);
            setSemanticOn(false);
          }}
          onSemanticRetry={semantic.retry}
          onSemanticReindex={semantic.rebuild}
          semanticStatus={semantic.status}
          semanticProgress={semantic.progress}
          semanticQueryProgress={semantic.queryProgress}
          semanticError={semantic.error}
          semanticIndexedMemos={semantic.indexedMemos}
          semanticRebuilding={semantic.rebuilding}
          semanticQuery={view === "memos" ? feedQuery : ""}
          attend={modelSettingsAttend}
        />
      ) : null}
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
            showToast(tr("Updated your passcode", "已更新密码"));
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} dismissLabel={tr("Dismiss", "关闭")} onDismiss={dismissToast} onPause={pauseToasts} onResume={resumeToasts} />
    </div>
  );
}
