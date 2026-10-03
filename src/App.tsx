import {
  ArrowDownUp,
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
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Trash2,
  WifiOff,
  X
} from "lucide-react";
import { Component, lazy, memo as reactMemo, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChangePasscode } from "./components/ChangePasscode";
import { BulkTagDialog } from "./components/BulkTagDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Crumbs } from "./components/Crumbs";
import { Editor, type EditDraft, type EditorSubmission } from "./components/Editor";
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
import { SwapText } from "./components/SwapText";
import { useTip } from "./components/Tip";
import { useModalA11y } from "./hooks/useModalA11y";
import { useSearchHighlight } from "./hooks/useSearchHighlight";
import { useTopbarTuck } from "./hooks/useTopbarTuck";
import { useSemanticSearch } from "./hooks/useSemanticSearch";
import {
  AuthRequiredError,
  ApiError,
  batchMemos,
  bootstrap,
  createMemo,
  emptyTrash,
  exportData,
  getAuthStatus,
  importDataInChunks,
  isSessionRevoked,
  isTransientImportFailure,
  lastAuthLossWasRevocation,
  login,
  logout,
  pinTag,
  purgeMemo,
  removeTag,
  renameTag,
  restoreMemo,
  setupPassword,
  trashMemo,
  updateMemo,
  type BootstrapResponse,
  type MemoBatchFailure
} from "./lib/api";
import { BackupFormatError, inspectBackup, readBackupItems } from "./lib/backupFile";
import { startBoot, type BootStart } from "./lib/boot";
import { adoptCacheKey, forgetCacheKey, invalidateSnapshot, openSnapshot, saveSnapshot } from "./lib/cache";
import { dateKey, formatDayLabel } from "./lib/dates";
import { advanceFeedWindow, feedWindowCap, filterPreservingId, type FeedWindow } from "./lib/feedSafety";
import { useI18n } from "./lib/i18n";
import { pruneImageCache } from "./lib/imageCache";
import { announce, mountLiveRegions } from "./lib/liveAnnouncer";
import { clearLocalDeviceData } from "./lib/logoutCleanup";
import { splitTaskLine } from "./lib/markdown";
import { useModelDownloadPhase } from "./lib/modelDownload";
import { memoMatchesSubmittedDraft } from "./lib/memoRecovery";
import { captureFeedPlace, createNavStore, isRootLens, lensesEqual, navIdOf, restoreFeedPlace, ROOT_LENS, type NavLens, type NavPlace, type NavStore } from "./lib/navHistory";
import { applyOptimisticLayer, withOptimistic, withoutPatch, withPatch, type OptimisticLayer, type OptimisticPatch } from "./lib/optimisticMemos";
import {
  buildReviewDay,
  clearReviewDay,
  DEFAULT_REVIEW_SETTINGS,
  loadReviewDay,
  loadReviewSettings,
  persistReviewDay,
  persistReviewSettings,
  removeReviewSettingsTag,
  renameReviewSettingsTag,
  reviewDayValid,
  reviewFingerprint,
  SETTINGS_KEY as REVIEW_SETTINGS_KEY,
  type ReviewDay,
  type ReviewSettings
} from "./lib/review";
import {
  SAVED_FILTERS_LIMIT,
  STORAGE_KEY as SAVED_FILTERS_KEY,
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
import { searchNeedles } from "./lib/searchHighlight";
import { selectionWithinVisibleIds } from "./lib/selection";
import { countsByDay, dayKeyOf } from "./lib/stats";
import { feedQueryForStatsDrilldown, memoMatchesStatsDrilldown, statsDrilldownLabel, type StatsDrilldown } from "./lib/statsDrilldown";
import { useSnapshotWriterLease } from "./lib/snapshotWriter";
import { applySyncDelta, createSyncState, memosOf, purgedOf, tagsOfState, type PurgedMemo, type SyncState } from "./lib/syncState";
import { buildTagTree, inheritTagContext, isValidTagPath, tagMatches, tagRenamePathsOverlap, tagsOf } from "./lib/tags";
import { applyTaskFlips, freshestTaskMemo, type TaskFlipQueue } from "./lib/taskFlips";
import { applyTheme, loadTheme, type ThemeChoice } from "./lib/theme";
import type { LightboxItem, Memo, SortKey, TagMeta } from "./lib/types";
import { useSync } from "./lib/useSync";
import { withViewTransition } from "./lib/viewTransition";

type Phase = "checking" | "error" | "login" | "ready";

/** Cold-start pages still arriving after the first one rendered. */
interface BootstrapLoad {
  /** Memos at the frozen cursor, from the first page; null if unknown. */
  total: number | null;
  /** Pages keep failing; the next attempt resumes from the same cursor. */
  failed: boolean;
}

interface BootstrapJob {
  after: string;
  snapshot: number;
  syncEpoch: string;
  failures: number;
  timer: number;
  running: boolean;
}

/** Retries of a failed background page; the notice says so from the second miss. */
const BOOTSTRAP_RETRY_MAX_MS = 30_000;
const BOOTSTRAP_FAILED_AFTER = 2;

type View = "memos" | "trash" | "review";

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastState {
  id: number;
  text: string;
  /**
   * A count that keeps changing (a running export's progress). It is shown
   * after the text in tabular figures and kept out of the live region, so
   * the status is announced once instead of on every update.
   */
  detail?: string;
  tone: "info" | "error";
  /** One verb the toast offers — Undo, mostly. Runs once, then dismisses. */
  action?: ToastAction;
  /** Plays the exit animation before the node unmounts. */
  leaving?: boolean;
}

interface ToastOptions {
  action?: ToastAction;
  detail?: string;
  /** Overrides the length-derived stay, in ms. */
  duration?: number;
}

/** Toasts up at once; past this the oldest steps off. */
const TOAST_LIMIT = 3;
/** A progress toast stays until its work ends (the longest setTimeout delay). */
const STICKY_TOAST_MS = 2_147_483_647;
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
  /** Names the stack's landmark ("Notifications"). */
  regionLabel: string;
  onDismiss: (id: number) => void;
  onPause: () => void;
  onResume: () => void;
}

/**
 * The toasts, newest at the bottom so a toast already up never moves when
 * another lands. An error carries a mark; text and weight say what happened
 * — the tone is carried by the mark and the hairline, not by recolouring the
 * sentence. Screen readers hear each toast through the app's standing live
 * regions (showToast announces it), so the visible stack is a labelled
 * landmark rather than a live region inserted along with its text.
 *
 * The stack sits at the end of the page, a whole feed of Tab stops away from
 * where an Undo is wanted. F6 jumps to the newest action while one is up;
 * F6 or Escape inside the stack hands focus back to where it came from, as
 * does using one of its buttons.
 */
function ToastStack({ toasts, dismissLabel, regionLabel, onDismiss, onPause, onResume }: ToastStackProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  // Where focus stood before it entered the stack.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const hasAction = toasts.some((toast) => toast.action && !toast.leaving);

  function handBackFocus() {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected && !target.inert) target.focus({ preventScroll: true });
    else if (stackRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  useEffect(() => {
    if (!hasAction) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const stack = stackRef.current;
      // Under an open dialog the stack is inert; F6 stays the browser's.
      if (!stack || stack.inert || stack.closest("[inert]")) return;
      event.preventDefault();
      if (stack.contains(document.activeElement)) {
        handBackFocus();
        return;
      }
      const target = [...stack.querySelectorAll<HTMLElement>(".toast:not(.is-leaving) .toast-action")].at(-1);
      if (!target) return;
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      target.focus({ preventScroll: true });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasAction]);

  if (toasts.length === 0) return null;
  // A used button leaves with its toast; focus goes back before it does.
  const settle = (id: number) => {
    onDismiss(id);
    if (stackRef.current?.contains(document.activeElement)) handBackFocus();
  };
  return (
    <div
      ref={stackRef}
      className="toast-stack"
      role="region"
      aria-label={regionLabel}
      onPointerEnter={onPause}
      onPointerLeave={onResume}
      onFocus={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) returnFocusRef.current = from;
        onPause();
      }}
      onBlur={onResume}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        handBackFocus();
      }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-slot${toast.leaving ? " is-leaving" : ""}`}>
          <div className="toast-clip">
            <div className={`toast${toast.tone === "error" ? " is-error" : ""}${toast.leaving ? " is-leaving" : ""}`}>
              {toast.tone === "error" ? <CircleAlert size={15} className="toast-mark" aria-hidden="true" /> : null}
              <span className="toast-text">
                {toast.text}
                {toast.detail ? (
                  <span className="toast-detail" aria-hidden="true">
                    {" "}
                    {toast.detail}
                  </span>
                ) : null}
              </span>
              {toast.action ? (
                <button
                  type="button"
                  className="toast-action"
                  aria-keyshortcuts="F6"
                  onClick={() => {
                    toast.action?.run();
                    settle(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
              {toast.action || toast.tone === "error" ? (
                <button type="button" className="toast-dismiss" aria-label={dismissLabel} onClick={() => settle(toast.id)}>
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
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
  retryIds: string[];
  failedCount: number;
  firstFailure: string | null;
  alreadyTagged: number;
  targetCount: number;
}

const SORT_KEYS: SortKey[] = ["created-desc", "created-asc", "updated-desc", "updated-asc"];
const EMPTY_TAGS: string[] = [];

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
      style={intro ?? undefined}
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

/**
 * A removal unmounts the focused card — its ⋯ got focus back from the menu —
 * and would drop focus to <body>, sending a keyboard reader back to the top
 * of the page. Call before the change: the returned function, run once the
 * DOM holds the new state, moves focus to the next surviving card's ⋯ (else
 * the previous one's; else, for a keyboard reader, the composer; else the
 * location pill). A no-op when focus was not inside a card or survived the
 * change.
 */
function holdFeedFocus(): () => void {
  const active = document.activeElement;
  const slot = active instanceof HTMLElement ? active.closest<HTMLElement>(".memo-slot") : null;
  if (!active || !slot) return () => undefined;
  // A tap must not land in the composer and raise the on-screen keyboard.
  let keyboard = false;
  try {
    keyboard = active.matches(":focus-visible");
  } catch {
    keyboard = false;
  }
  const neighbours: Element[] = [];
  for (let next = slot.nextElementSibling; next; next = next.nextElementSibling) neighbours.push(next);
  for (let previous = slot.previousElementSibling; previous; previous = previous.previousElementSibling) neighbours.push(previous);
  return () => {
    if (active.isConnected && document.activeElement === active) return;
    const survivor = neighbours.find((element) => element.isConnected && element.classList.contains("memo-slot"));
    const target =
      survivor?.querySelector<HTMLElement>(".memo-menu-trigger:not([tabindex='-1'])") ??
      (keyboard ? document.querySelector<HTMLElement>(".composer:not([hidden]) textarea") : null) ??
      document.querySelector<HTMLElement>(".loc-trigger");
    target?.focus({ preventScroll: true });
  };
}

/** How many feed rows render before the scroll sentinel asks for more. */
const FEED_PAGE = 80;

/** Above this many memos a batch move to Trash asks once (naming the count)
 * before it runs; at or below it the toast's Undo is the safety net. */
const BATCH_TRASH_CONFIRM_AT = 20;

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
/* Dialogs opened on demand ship as their own chunks, fetched in idle time
   after start-up so opening one stays instant. */
const lazyLoaders = {
  share: () => import("./components/ShareDialog"),
  stats: () => import("./components/StatsModal"),
  review: () => import("./components/ReviewSettingsModal"),
  model: () => import("./components/ModelSettingsModal")
};
const ShareDialog = lazy(() => lazyLoaders.share().then((module) => ({ default: module.ShareDialog })));
const StatsModal = lazy(() => lazyLoaders.stats().then((module) => ({ default: module.StatsModal })));
const ReviewSettingsModal = lazy(() => lazyLoaders.review().then((module) => ({ default: module.ReviewSettingsModal })));
const ModelSettingsModal = lazy(() => lazyLoaders.model().then((module) => ({ default: module.ModelSettingsModal })));

function prefetchLazyDialogs(): () => void {
  const run = () => {
    for (const load of Object.values(lazyLoaders)) void load().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 5_000 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(run, 2_000);
  return () => window.clearTimeout(timer);
}

/** Suspense for one lazy dialog, plus a catch for a chunk that failed to
    load (offline, or a deploy replaced it): the dialog stays closed and
    onFail says so, instead of the error unmounting the app. */
class LazyDialog extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}

/** Stable wrappers around a ref of handlers: same identities for the life of
    the component, each call forwarding to the latest closure. */
function stableHandlers<T extends Record<string, (...args: never[]) => unknown>>(ref: { current: T }): T {
  const out: Record<string, (...args: unknown[]) => unknown> = {};
  for (const key of Object.keys(ref.current)) {
    out[key] = (...args) => (ref.current[key] as unknown as (...args: unknown[]) => unknown)(...args);
  }
  return out as unknown as T;
}

interface FeedHandlers {
  startEdit: (id: string) => void;
  cancelEdit: (draft: EditDraft | null) => void;
  saveEdit: (memo: Memo, data: EditorSubmission) => Promise<boolean>;
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
  /** Enter select mode from one card's ⋯ menu, that card already picked. */
  selectFrom: (memo: Memo) => void;
  toggleTask: (memo: Memo, lineKey: number, checked: boolean) => void;
  /** The open edit's text after each change, held in memory for a re-login. */
  editDraftChange: (memoId: string, content: string) => void;
}

interface FeedItemProps {
  memo: Memo;
  variant: "normal" | "trash";
  knownTags: string[];
  editing: boolean;
  savingEdit: boolean;
  editConflict: boolean;
  /** A discarded edit being reopened by its toast's Undo. */
  editDraft: EditDraft | null;
  selecting: boolean;
  selected: boolean;
  /** The view has a select mode (memos, Trash) — offers ⋯ › Select. */
  canSelect: boolean;
  /** This memo's optimistic checkbox states (in-flight toggles), if any. */
  taskFlips: ReadonlyMap<number, boolean> | undefined;
  /** Text a held edit resumes with after a re-login. */
  resumeContent: string | undefined;
  /** A pin / trash / restore of this memo is in flight. */
  busy: boolean;
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
  function FeedItem({ memo, variant, knownTags, editing, savingEdit, editConflict, editDraft, selecting, selected, canSelect, taskFlips, resumeContent, busy, vtName, getEntering, delay, handlers }: FeedItemProps) {
    return (
      <MemoSlot vtName={vtName} entering={getEntering()} delay={delay}>
        <MemoCard
          memo={memo}
          variant={variant}
          knownTags={knownTags}
          editing={editing}
          savingEdit={savingEdit}
          editConflict={editConflict}
          editDraft={editDraft}
          selecting={selecting}
          selected={selected}
          pendingTaskFlips={taskFlips}
          resumeContent={resumeContent}
          onEditDraftChange={editing ? (content) => handlers.editDraftChange(memo.id, content) : undefined}
          busy={busy}
          onToggleSelect={() => handlers.toggleSelect(memo)}
          onSelect={canSelect ? () => handlers.selectFrom(memo) : undefined}
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
    prev.editDraft === next.editDraft &&
    prev.selecting === next.selecting &&
    prev.selected === next.selected &&
    prev.canSelect === next.canSelect &&
    prev.taskFlips === next.taskFlips &&
    prev.resumeContent === next.resumeContent &&
    prev.busy === next.busy &&
    prev.vtName === next.vtName &&
    prev.handlers === next.handlers
);

export default function App() {
  const { count, errorMessage, formatNumber, language, locale, tr } = useI18n();
  const tip = useTip();
  // Live regions stand in the document before anything is said into them.
  useEffect(() => mountLiveRegions(), []);
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
  const [setupAllowed, setSetupAllowed] = useState(true);
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
  // The exact state a warm start opened from the sealed record: saving it
  // again would only re-encrypt what is already stored.
  const skipSnapshotSaveForRef = useRef<SyncState | null>(null);
  // A cold start renders its first page, then loads the rest in the
  // background; the snapshot is saved only once that working set is whole.
  const [bootstrapLoad, setBootstrapLoad] = useState<BootstrapLoad | null>(null);
  const bootstrapJobRef = useRef<BootstrapJob | null>(null);
  const stopBootstrapLoad = useCallback(() => {
    if (bootstrapJobRef.current) window.clearTimeout(bootstrapJobRef.current.timer);
    bootstrapJobRef.current = null;
    setBootstrapLoad(null);
  }, []);
  // Every memo in state came from a page or a newer sync; cap at the frozen
  // total so memos written meanwhile never count past it.
  const loadedMemoCount = bootstrapLoad?.total == null ? syncState.memos.size : Math.min(syncState.memos.size, bootstrapLoad.total);
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
  // What the search box shows while an IME is composing. The query itself
  // waits for the composed text: pinyin mid-composition ("chuang'bian") is
  // not what the reader is searching for, and filtering by it flashed an
  // empty feed (and embedded the pinyin) on every Chinese search.
  const [searchComposition, setSearchComposition] = useState<string | null>(null);
  const searchComposingRef = useRef(false);
  // Trash's own keyword search: never carried into the memos feed or back.
  const [trashQuery, setTrashQuery] = useState("");
  // A device preference like theme and language: it survives logout and
  // session expiry (the hook itself only runs in the ready phase).
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

  // Session history (lib/navHistory): the entry on screen, whether the next
  // lens change adds an entry (a discrete pick) or edits this one in place
  // (typing), and reading places waiting to be restored.
  const navStoreRef = useRef<NavStore | null>(null);
  navStoreRef.current ??= createNavStore();
  const navBootedRef = useRef(false);
  const currentNavIdRef = useRef<string | null>(null);
  const navIntentRef = useRef<"push" | "replace">("replace");
  const pendingPlaceRef = useRef<NavPlace | null>(null);
  const [placeTick, setPlaceTick] = useState(0);
  // Where the reader left All memos, for the ⌂ pill to return to.
  const rootPlaceRef = useRef<NavPlace | null>(null);

  // Daily review: settings and the day's frozen batch are workspace
  // furniture (localStorage, like the sort key) — see lib/review.ts. The
  // batch is drawn lazily, on the first visit to the review view of a local
  // day, never ahead of time and never on the server.
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings>(loadReviewSettings);
  const [reviewDay, setReviewDay] = useState<ReviewDay | null>(loadReviewDay);
  // A batch drawn while a cold start is still loading older pages comes from
  // a partial pool. It serves this visit but is never saved, and the first
  // visit after loading finishes draws the real one (and saves that), so the
  // same day + settings + notebook still deal the same batch on any device.
  const provisionalReviewRef = useRef<ReviewDay | null>(null);
  const drawReviewDay = useCallback((pool: readonly Memo[], settings: ReviewSettings): ReviewDay => {
    const next = buildReviewDay(pool, settings);
    if (bootstrapJobRef.current) {
      provisionalReviewRef.current = next;
    } else {
      provisionalReviewRef.current = null;
      persistReviewDay(next);
    }
    return next;
  }, []);
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
  // Unsent text survives a lost session within this page: the live editors
  // report into these refs, a drop to the gate holds a copy, and the next
  // sign-in seeds the remounted editors with it. Memory only, by design —
  // never written to Web Storage, IndexedDB or the server.
  const composerDraftRef = useRef("");
  const editDraftRef = useRef<{ memoId: string; content: string } | null>(null);
  const heldEditRef = useRef<{ memoId: string; content: string; baseSeq: number | null } | null>(null);
  // The held base waits here until the edit-conflict effect sees the resumed
  // editingId: that effect clears editingBaseSeqRef whenever no edit is open,
  // including in the very commit that hands the edit back.
  const resumedBaseRef = useRef<{ memoId: string; baseSeq: number | null } | null>(null);
  const [composerSeed, setComposerSeed] = useState("");
  const [editSeed, setEditSeed] = useState<{ memoId: string; content: string } | null>(null);
  // The last edit Esc / Cancel discarded, held in memory only (drafts are
  // never persisted) for the Undo on its toast; and the draft that Undo is
  // reopening, handed to the editor as it mounts.
  const discardedEditRef = useRef<{ memoId: string; draft: EditDraft; baseSeq: number | null } | null>(null);
  const [reopenedDraft, setReopenedDraft] = useState<{ memoId: string; draft: EditDraft } | null>(null);
  // Feed checkbox toggles: an ephemeral optimistic layer (memoId → lineKey →
  // desired checked state) that only skins the rendered box. syncState stays
  // the server truth throughout, so snapshots and sync never persist a guess;
  // a failed request clears the layer and the box snaps back.
  const [pendingTaskFlips, setPendingTaskFlips] = useState<ReadonlyMap<string, ReadonlyMap<number, boolean>>>(() => new Map());
  // Per-memo serial queue: flips arriving while a request is in flight are
  // batched into the next one, computed against the then-latest seq/content —
  // rapid ticking never races itself into a version conflict.
  const taskFlipQueueRef = useRef(new Map<string, TaskFlipQueue>());
  // Pin / trash / restore: the same idea as the checkbox layer, one level up.
  // The guessed pinnedAt/deletedAt shows at the click (see optimisticMemos);
  // the per-memo token both marks the request in flight — a second tap on
  // the same memo waits instead of racing into a false "changed elsewhere"
  // conflict — and lets a late view-transition callback know its guess has
  // already been settled.
  const [optimisticMemos, setOptimisticMemos] = useState<OptimisticLayer>(() => new Map());
  const memoActionTokensRef = useRef(new Map<string, object>());

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
  // Settled/total while a select-mode action spans several requests.
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  // The same sheet aimed at one card, opened from its ⋯ menu. Held by id so a
  // sync that edits or deletes the memo mid-flight is reflected, not stale.
  const [tagMemoId, setTagMemoId] = useState<string | null>(null);
  const pendingBatchTagRef = useRef<PendingBatchTag | null>(null);
  const [renameTagTarget, setRenameTagTarget] = useState<string | null>(null);
  // Share of the server's scan finished while a rename runs (0–1).
  const [renameProgress, setRenameProgress] = useState<number | null>(null);
  const tagRenameUndoRef = useRef<(from: string, to: string) => Promise<void>>(async () => undefined);
  const [dialogBusy, setDialogBusy] = useState(false);
  // Two-step Empty Trash: first click arms the button, second click fires.
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  // While the delete request is in flight the pill must hold its armed look
  // (blur/timeout disarms would snap it back to "Empty Trash" mid-flight),
  // so the disarm paths and re-fires check this ref.
  const emptyTrashBusyRef = useRef(false);
  // Backup file waiting for the user's go-ahead: only the File handle and its
  // counts are kept; the records are re-read from it as they are sent.
  const [importTarget, setImportTarget] = useState<{ file: File; memoCount: number; imageCount: number } | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; stopping: boolean } | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  // A running export: its Stop handle and the toast that shows its progress.
  const exportRef = useRef<{ controller: AbortController; toastId: number; text: string; detail?: string } | null>(null);

  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  // Memo being shared as an image card; holds a snapshot until dismissed.
  const [shareMemo, setShareMemo] = useState<Memo | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [changingPasscode, setChangingPasscode] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
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
  const topbarRef = useRef<HTMLDivElement>(null);
  useTopbarTuck(topbarRef, phase === "ready");
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
      setToasts((current) => [...current, { id, text, tone, action: options.action, detail: options.detail }]);
      if (toastsPausedRef.current) toastTimersRef.current.set(id, { timer: 0, expiresAt: 0, remaining: duration });
      else armToast(id, duration);
      // Spoken through the standing live regions; an action is announced
      // with the key that reaches it (see ToastStack).
      const label = options.action?.label;
      const sentence = text.replace(/[.。]$/, "");
      // "Exporting your backup…" already ends its sentence.
      const stop = sentence.endsWith("…") ? ["", ""] : [".", "。"];
      announce(
        label ? tr(`${sentence}${stop[0]} Press F6 to ${label.toLowerCase()}.`, `${sentence}${stop[1]}按 F6 ${label}。`) : text,
        tone === "error" ? "assertive" : "polite"
      );
      return id;
    },
    [armToast, dismissToast, tr]
  );

  /** Rewrite a toast's detail in place (a running export's count); one already gone stays gone. */
  const updateToastDetail = useCallback((id: number, detail: string) => {
    setToasts((current) => (current.some((toast) => toast.id === id && !toast.leaving) ? current.map((toast) => (toast.id === id ? { ...toast, detail } : toast)) : current));
  }, []);

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
    // Lens history is notebook-derived (tag paths, search words): it goes
    // with the session, and the entry on screen forgets its id. Older
    // same-document entries can't be removed; they stay inert (the login
    // screen doesn't listen) and resolve to All memos after the next login.
    navStoreRef.current?.clear();
    navBootedRef.current = false;
    currentNavIdRef.current = null;
    pendingPlaceRef.current = null;
    rootPlaceRef.current = null;
    try {
      window.history.replaceState(null, "");
    } catch {
      // History may be unavailable; the store is already empty.
    }
    window.clearTimeout(drawerCloseTimerRef.current);
    window.cancelAnimationFrame(drawerCallbackFrameRef.current);
    drawerAfterCloseRef.current = [];
    emptyTrashBusyRef.current = false;
    importAbortRef.current?.abort();
    exportRef.current?.controller.abort();
    confirmBatchDeleteRef.current = false;
    editingBaseSeqRef.current = null;
    resumedBaseRef.current = null;
    releaseDiscardedEdit();
    skipSnapshotSaveForRef.current = null;
    stopBootstrapLoad();

    setSyncState(createSyncState());
    setSnapshotCursor(0);
    setSnapshotSyncEpoch("");
    setActiveTag(null);
    setActiveDay(null);
    setQuery("");
    setSearchComposition(null);
    searchComposingRef.current = false;
    setTrashQuery("");
    setSearchOpen(false);
    setFilters(EMPTY_FILTERS);
    setStatsDrilldown(null);
    setSavingFilter(false);
    setView("memos");
    setCreating(false);
    setEditingId(null);
    setEditConflictId(null);
    setReopenedDraft(null);
    setSavingEdit(false);
    setPendingTaskFlips(new Map());
    taskFlipQueueRef.current.clear();
    setOptimisticMemos(new Map());
    memoActionTokensRef.current.clear();
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
    setImportProgress(null);
    setLightbox(null);
    setShareMemo(null);
    setStatsOpen(false);
    setReviewSettingsOpen(false);
    setModelSettingsOpen(false);
    setModelSettingsAttend(0);
    setEnableSemanticWhenReady(false);
    setChangingPasscode(false);
    setConfirmLogout(false);
    setDrawerOpen(false);
    setDrawerClosing(false);
    setFilterOpenRequest(0);
    setReveal(false);
  }, [clearToasts, stopBootstrapLoad]);

  /** Mirror clearLocalDeviceData in memory: theme, language and sort stay. */
  const resetLocalWorkspaceState = useCallback(() => {
    setSavedFilters([]);
    setReviewSettings(DEFAULT_REVIEW_SETTINGS);
    setReviewDay(null);
  }, []);

  /** Forget held or seeded drafts: the owner chose to leave, not lost the session. */
  const discardHeldDrafts = useCallback(() => {
    heldEditRef.current = null;
    setComposerSeed("");
    setEditSeed(null);
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
    if (phase !== "ready") return;
    localStorage.setItem("memo-sort", sortKey);
  }, [phase, sortKey]);

  useEffect(() => {
    if (phase !== "ready") return;
    persistSavedFilters(savedFilters);
  }, [phase, savedFilters]);

  // Presets and review settings stay per-device, but every open tab of this
  // device follows the latest write; otherwise a stale tab's next save would
  // overwrite the whole list with its old copy. (A same-value write fires no
  // storage event, so the persist effect above cannot echo back and forth.)
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key === SAVED_FILTERS_KEY) setSavedFilters(loadSavedFilters());
      if (event.key === null || event.key === REVIEW_SETTINGS_KEY) setReviewSettings(loadReviewSettings());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const applySyncChanges = useCallback((changed: readonly Memo[], purged: readonly PurgedMemo[], tags: readonly TagMeta[], cursor?: number) => {
    setSyncState((current) => applySyncDelta(current, { memos: changed, purged, tags }));
    if (cursor !== undefined) setSnapshotCursor((current) => Math.max(current, cursor));
  }, []);

  /**
   * The session ended under the owner. Plain expiry behaves like a cold start
   * behind a gate: only the snapshot key is forgotten, so the sealed snapshot,
   * semantic index, model and preferences wait for the next sign-in. Only a
   * revocation (passcode changed elsewhere) clears the device like a logout.
   * Either way the unsent composer text and an open edit are held in memory
   * and come back after sign-in.
   */
  const dropToLogin = useCallback(
    (revoked?: boolean) => {
      const wipe = revoked ?? lastAuthLossWasRevocation();
      sessionEpochRef.current += 1;
      const editing = editingIdRef.current;
      const editDraft = editDraftRef.current;
      heldEditRef.current =
        editing && editDraft?.memoId === editing ? { memoId: editing, content: editDraft.content, baseSeq: editingBaseSeqRef.current } : null;
      setComposerSeed(composerDraftRef.current);
      setEditSeed(null);
      if (wipe) {
        void clearLocalDeviceData();
        resetLocalWorkspaceState();
      } else {
        forgetCacheKey();
      }
      resetSessionUi();
      setPhase("login");
      showToast(
        wipe
          ? tr("Your passcode changed. Enter the new one to continue.", "密码已更改，请输入新密码继续")
          : tr("Your session has expired. Enter your passcode again.", "登录已过期，请重新输入密码"),
        "error"
      );
    },
    [resetLocalWorkspaceState, resetSessionUi, showToast, tr]
  );

  const handlePeerLogout = useCallback(() => {
    sessionEpochRef.current += 1;
    void clearLocalDeviceData();
    discardHeldDrafts();
    resetSessionUi();
    resetLocalWorkspaceState();
    setPhase("login");
    showToast(tr("Another tab logged out. Enter your passcode again.", "另一个标签页已退出，请重新输入密码"), "error");
  }, [discardHeldDrafts, resetLocalWorkspaceState, resetSessionUi, showToast, tr]);

  // Hand held drafts back once the notebook is on screen again: the composer
  // already mounted with its seed; an open edit resumes on its memo with its
  // original base, so a change made elsewhere meanwhile still shows the
  // conflict notice instead of being overwritten silently.
  useEffect(() => {
    if (phase !== "ready") return;
    setComposerSeed("");
    const held = heldEditRef.current;
    heldEditRef.current = null;
    if (!held) return;
    resumedBaseRef.current = { memoId: held.memoId, baseSeq: held.baseSeq };
    setEditSeed({ memoId: held.memoId, content: held.content });
    setEditingId(held.memoId);
  }, [phase]);

  // The seed belongs to that one resumed edit; a later edit starts from the memo.
  useEffect(() => {
    if (editSeed && editingId !== editSeed.memoId) setEditSeed(null);
  }, [editingId, editSeed]);

  const handleServerReset = useCallback(() => {
    sessionEpochRef.current += 1;
    void invalidateSnapshot().finally(() => window.location.reload());
  }, []);

  const { setCursor, setSyncEpoch, runSync, notifyPeers, notifyLogout, status: syncStatus, retryNow: retrySync } = useSync({
    // Changing the passcode rotates session_generation and the cookie. Abort
    // old-cookie heartbeats during that window so a legitimate success cannot
    // be followed by a stale 401 that drops every tab back to the gate.
    // Logout aborts them too: a sync answered after the logout response could
    // otherwise carry a renewed session cookie back into this browser.
    enabled: phase === "ready" && !changingPasscode && !loggingOut,
    applyChanges: applySyncChanges,
    onAuthLost: dropToLogin,
    onPeerLogout: handlePeerLogout,
    onServerReset: handleServerReset
  });

  // The link to the server, said in words when it matters (rendered above
  // the composer) and spoken once each time it changes.
  const syncNotice =
    phase !== "ready" || (syncStatus.online && !syncStatus.degraded)
      ? null
      : syncStatus.online
        ? tr("Can’t reach the server · showing your last synced memos", "无法连接服务器 · 显示上次同步的笔记")
        : tr("Offline · showing your last synced memos", "离线 · 显示上次同步的笔记");
  useEffect(() => {
    if (syncNotice) announce(syncNotice);
  }, [syncNotice]);
  // The cold-start loading line ticks per page, so it is not a live region;
  // only a stalled load is spoken.
  const bootstrapFailed = bootstrapLoad?.failed === true;
  useEffect(() => {
    if (bootstrapFailed) announce(tr("Couldn’t load the rest of your memos", "其余笔记载入失败"));
  }, [bootstrapFailed, tr]);

  /** Apply a mutation response locally, then reconcile cursor + sibling tabs. */
  const commitMutation = useCallback(
    (delta: { memos?: Memo[]; purged?: PurgedMemo[]; tags?: TagMeta[] }) => {
      applySyncChanges(delta.memos ?? [], delta.purged ?? [], delta.tags ?? []);
      void runSync();
      notifyPeers();
    },
    [applySyncChanges, runSync, notifyPeers]
  );

  // Stable callbacks below read these, so a language change (which renews
  // dropToLogin) never renews enterApp and re-runs the boot effect.
  const dropToLoginRef = useRef(dropToLogin);
  dropToLoginRef.current = dropToLogin;
  const pumpBootstrapRef = useRef<() => Promise<void>>(async () => undefined);
  // Background pages pause while the passcode changes, for the same reason
  // useSync does: a page sent with the old cookie can 401 after the rotation.
  const changingPasscodeRef = useRef(changingPasscode);
  changingPasscodeRef.current = changingPasscode;
  const passcodeChangesRef = useRef(0);

  /**
   * Load the remaining cold-start pages behind the rendered first page. Pages
   * share the frozen cursor, so they hold only rows at or below it, while sync
   * (already running from that cursor) supplies everything newer; merging is
   * seq-aware and tombstones block resurrection, so the order in which the
   * two streams land does not matter. A failed page is retried from the same
   * keyset cursor: nothing already loaded is fetched again.
   */
  const pumpBootstrap = useCallback(async () => {
    const job = bootstrapJobRef.current;
    if (!job || job.running || changingPasscodeRef.current) return;
    job.running = true;
    window.clearTimeout(job.timer);
    job.timer = 0;
    const epoch = sessionEpochRef.current;
    const passcodeChanges = passcodeChangesRef.current;
    const current = () => bootstrapJobRef.current === job && epoch === sessionEpochRef.current;
    try {
      while (current() && !changingPasscodeRef.current) {
        const page: BootstrapResponse = await bootstrap(job.after, job.snapshot);
        if (!current()) return;
        if (page.syncEpoch !== job.syncEpoch) {
          // The database was replaced mid-load; start over against the new one.
          bootstrapJobRef.current = null;
          handleServerReset();
          return;
        }
        const next = page.hasMore ? page.nextAfter : null;
        if (page.hasMore && (!next || next === job.after)) throw new Error("Bootstrap page did not advance its continuation cursor");
        job.failures = 0;
        setSyncState((state) => applySyncDelta(state, { memos: page.memos, tags: page.tags }));
        if (!next) {
          bootstrapJobRef.current = null;
          setBootstrapLoad(null);
          return;
        }
        job.after = next;
        setBootstrapLoad((load) => (load?.failed ? { ...load, failed: false } : load));
      }
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof AuthRequiredError) {
        dropToLoginRef.current();
        return;
      }
      job.failures += 1;
      if (job.failures >= BOOTSTRAP_FAILED_AFTER) setBootstrapLoad((load) => (load && !load.failed ? { ...load, failed: true } : load));
      const delay = Math.min(BOOTSTRAP_RETRY_MAX_MS, 1_000 * 2 ** Math.min(job.failures - 1, 5));
      job.timer = window.setTimeout(() => void pumpBootstrapRef.current(), delay);
    } finally {
      job.running = false;
      // A passcode change renews the session epoch, which parks a page still
      // in flight; once the change is over, carry on from the same cursor.
      // (While it lasts, the effect below resumes the pump when it ends.)
      if (passcodeChangesRef.current !== passcodeChanges && bootstrapJobRef.current === job && !changingPasscodeRef.current) {
        void pumpBootstrapRef.current();
      }
    }
  }, [handleServerReset]);
  pumpBootstrapRef.current = pumpBootstrap;

  /** The reader's own "try again" for a stalled cold load. */
  const retryBootstrap = useCallback(() => {
    void pumpBootstrapRef.current();
  }, []);

  useEffect(() => {
    if (phase === "ready" && !changingPasscode) void pumpBootstrapRef.current();
  }, [phase, changingPasscode]);

  useEffect(() => {
    if (!bootstrapLoad?.failed) return;
    window.addEventListener("online", retryBootstrap);
    return () => window.removeEventListener("online", retryBootstrap);
  }, [bootstrapLoad?.failed, retryBootstrap]);

  const enterApp = useCallback(
    async (withReveal: boolean, start?: Promise<BootStart>) => {
      // Warm start: with a sealed local snapshot, one incremental sync
      // replaces the full-notebook bootstrap — startup traffic stays
      // constant-size no matter how large the notebook grows. Auth errors
      // propagate to the caller exactly like the bootstrap path's.
      let entered = false;
      skipSnapshotSaveForRef.current = null;
      stopBootstrapLoad();
      const begun = await (start ?? startBoot());
      let firstPage = begun.kind === "cold" ? begun.firstPage : null;
      if (begun.kind === "warm") {
        const { sealed } = begun;
        const delta = await begun.firstSync;
        adoptCacheKey(delta.cacheKey);
        const snapshot = await openSnapshot(sealed);
        // The server epoch catches a replaced database even when its new
        // numeric counter has already grown past this sleeping client.
        if (snapshot && delta.syncEpoch === snapshot.syncEpoch && delta.cursor >= sealed.cursor) {
          const warmChanged = delta.memos.length > 0 || delta.purged.length > 0 || delta.tags.length > 0;
          const nextState = applySyncDelta(createSyncState(snapshot.memos, snapshot.tags, snapshot.purged), delta);
          // Render now. A long absence pages on through useSync from this
          // cursor, which also checks every page against this epoch.
          setSyncState(nextState);
          setSnapshotCursor(delta.cursor);
          setSnapshotSyncEpoch(snapshot.syncEpoch);
          setCursor(delta.cursor);
          setSyncEpoch(snapshot.syncEpoch);
          // The sealed record is already the exact working set when the warm
          // delta is empty. Avoid immediately re-encrypting the same notebook.
          skipSnapshotSaveForRef.current = warmChanged ? null : nextState;
          entered = true;
        } else {
          // Corrupt ciphertext, a rotated cache key, or a lower server cursor
          // / different server epoch means this record belongs to unusable
          // history. Clear it before cold bootstrap.
          await invalidateSnapshot();
          firstPage = bootstrap();
        }
      }
      if (!entered && firstPage) {
        // Cold start: the first page is the newest memos (plus every pinned
        // one), enough to render the top of the feed; the rest loads behind it.
        const page = await firstPage;
        adoptCacheKey(page.cacheKey);
        if (page.hasMore && !page.nextAfter) throw new Error("Bootstrap page is missing its continuation cursor");
        setSyncState(createSyncState(page.memos, page.tags));
        setSnapshotCursor(page.cursor);
        setSnapshotSyncEpoch(page.syncEpoch);
        setCursor(page.cursor);
        setSyncEpoch(page.syncEpoch);
        if (page.hasMore && page.nextAfter) {
          bootstrapJobRef.current = {
            after: page.nextAfter,
            snapshot: page.cursor,
            syncEpoch: page.syncEpoch,
            failures: 0,
            timer: 0,
            running: false
          };
          setBootstrapLoad({ total: typeof page.total === "number" ? page.total : null, failed: false });
        }
      }
      setBootError(null);
      setPhase("ready");
      if (withReveal) {
        setReveal(true);
        window.setTimeout(() => setReveal(false), 350);
      }
      void pumpBootstrapRef.current();
    },
    [setCursor, setSyncEpoch, stopBootstrapLoad]
  );

  // One tab persists the snapshot (see useSnapshotWriterLease); a cold start
  // joins only once its working set is whole.
  const snapshotWriter = useSnapshotWriterLease(phase === "ready" && !bootstrapLoad);

  // Persist the working set (sealed) once changes settle.
  useEffect(() => {
    if (phase !== "ready" || !snapshotSyncEpoch || bootstrapLoad || !snapshotWriter) return;
    if (skipSnapshotSaveForRef.current === syncState) return;
    skipSnapshotSaveForRef.current = null;
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
      // Sealed feed previews follow the snapshot: drop those whose memo is gone.
      void pruneImageCache(memos);
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
  }, [phase, snapshotCursor, snapshotSyncEpoch, syncState, memos, bootstrapLoad, snapshotWriter]);

  const runInitialBoot = useCallback(async () => {
    const attempt = ++bootAttemptRef.current;
    setBootError(null);
    setPhase("checking");

    // Status, the local snapshot read and the first sync or bootstrap page all
    // start together. A signed-in boot never waits on status: a successful
    // authenticated pull already proves setup is done. Status only decides
    // between setup and login once that pull comes back 401.
    const status = getAuthStatus();
    status.catch(() => undefined);
    try {
      await enterApp(false, startBoot());
    } catch (cause) {
      if (attempt !== bootAttemptRef.current) return;
      if (!(cause instanceof AuthRequiredError)) {
        setBootError(errorMessageRef.current(cause, "Couldn’t load your memos", "加载失败"));
        setPhase("error");
        return;
      }
      // A revoked cookie at boot is the lost-device case: wipe like mid-session.
      if (isSessionRevoked(cause)) {
        void clearLocalDeviceData();
        resetLocalWorkspaceState();
      }
      let statusNow: Awaited<typeof status>;
      try {
        statusNow = await status;
      } catch (statusCause) {
        if (attempt !== bootAttemptRef.current) return;
        setBootError(errorMessageRef.current(statusCause, "Couldn’t connect to the server", "无法连接服务器"));
        setPhase("error");
        return;
      }
      if (attempt !== bootAttemptRef.current) return;
      setNeedsSetup(statusNow.needsSetup);
      setSetupAllowed(statusNow.setupAllowed !== false);
      setPhase("login");
    }
  }, [enterApp, resetLocalWorkspaceState]);

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

  // What the reader sees: server truth with in-flight pin/trash/restore
  // guesses laid over it. (`memos` itself stays the truth that snapshots save.)
  const shownMemos = useMemo(() => applyOptimisticLayer(memos, optimisticMemos), [memos, optimisticMemos]);
  const activeMemos = useMemo(() => shownMemos.filter((memo) => !memo.deletedAt), [shownMemos]);
  // Server truth without the guesses. Anything that changes state or does
  // costly work off the active list (clearing a vanished tag filter, the
  // semantic index) reads this one, so a failed trash rolls back cleanly.
  const confirmedActiveMemos = useMemo(() => memos.filter((memo) => !memo.deletedAt), [memos]);
  const trashedMemos = useMemo(
    () => shownMemos.filter((memo) => memo.deletedAt).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")),
    [shownMemos]
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
  // The earliest local day with a memo: the range calendar's floor.
  const minDay = useMemo(() => {
    let min: string | null = null;
    for (const key of byDay.keys()) if (min === null || key < min) min = key;
    return min;
  }, [byDay]);

  useEffect(() => {
    // A tag's memos may simply not have loaded yet during a cold start.
    if (!activeTag || bootstrapLoad) return;
    const stillExists = confirmedActiveMemos.some((memo) => tagsOf(memo).some((tag) => tagMatches(tag, activeTag)));
    if (!stillExists) setActiveTag(null);
  }, [activeTag, confirmedActiveMemos, bootstrapLoad]);

  useEffect(() => {
    if (!editingId) {
      editingBaseSeqRef.current = null;
      setEditConflictId(null);
      setReopenedDraft(null);
      return;
    }
    const resumed = resumedBaseRef.current;
    if (resumed) {
      resumedBaseRef.current = null;
      if (resumed.memoId === editingId) editingBaseSeqRef.current = resumed.baseSeq;
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
  // Ranking only runs in the memos view: Trash has its own keyword-only
  // search and review none, so the hook sees their query as empty.
  // Activation also waits for phase "ready": the sealed index only opens with
  // the cache key adopted from the first authenticated response, and starting
  // earlier misreads "not decryptable yet" as "no index", throwing away the
  // persisted vectors and re-embedding the whole notebook on every refresh.
  // It also waits out a cold start's background pages: reconciling against
  // the partial set would prune (and save) the vectors of every memo not yet
  // loaded, then embed them all again as their pages arrive.
  const semantic = useSemanticSearch(
    semanticOn && phase === "ready" && !bootstrapLoad,
    confirmedActiveMemos,
    view === "memos" ? feedQuery : "",
    semanticScopeIds,
    publishSemanticResults
  );
  // Gated on the switch as well as the hook's own state: the hook drops its
  // results from an effect, a commit later than the click that flipped the
  // switch, and the swap animating that click has to see the keyword-only
  // list it is switching back to.
  const semanticResults = semanticOn && view === "memos" ? semantic.results : null;
  // The model download lives at app level (it outlives the settings panel),
  // so the Brain shows it as unfinished work too: closing the panel never
  // hides a running download.
  // Only the phase and the hook's busy bit reach App: the counters behind them
  // tick per batch and per slice, and only the settings panel shows them.
  const modelPhase = useModelDownloadPhase();
  const modelBusy = modelPhase === "downloading" || modelPhase === "activating";
  const semanticBusy = modelBusy || semantic.status === "preparing" || semantic.status === "indexing" || semantic.queryBusy;
  // Busy or stopped, the Brain opens the details panel rather than toggling.
  const semanticMonitor = semanticBusy || semantic.status === "error";
  // Its state in words for the button's accessible name — the counts stay
  // in the bubble and the panel.
  const semanticState =
    semantic.status === "error"
      ? tr("stopped", "已停止")
      : modelBusy
        ? modelPhase === "downloading"
          ? tr("downloading the model", "模型下载中")
          : tr("starting the model", "模型启动中")
        : semantic.status === "indexing"
          ? tr("indexing", "索引中")
          : semantic.queryBusy
            ? tr("working", "正在工作")
            : semantic.status === "preparing"
              ? tr("loading the model", "模型加载中")
              : null;
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
  // The lenses as of the latest render, for a toast action that runs later.
  const lensRef = useRef({ view, activeTag, activeDay, statsDrilldown, filters, parsedQuery });
  lensRef.current = { view, activeTag, activeDay, statsDrilldown, filters, parsedQuery };

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
      const stored = syncState.memos.get(id);
      const memo = stored ? withOptimistic(stored, optimisticMemos) : null;
      if (memo && !memo.deletedAt) list.push(memo);
    }
    return list;
  }, [reviewDay, syncState.memos, optimisticMemos]);

  // Trash search is keywords only — no semantic tier, no facets — over the
  // trashed memos alone, in their deletion order.
  const trashSearch = useDeferredValue(trashQuery.trim().toLowerCase());
  const trashFeedMemos = useMemo(() => {
    const parsed = parseSearchQuery(trashSearch);
    return queryIsEmpty(parsed) ? trashedMemos : trashedMemos.filter((memo) => memoMatchesQuery(memo, parsed));
  }, [trashedMemos, trashSearch]);

  const feedMemos = view === "trash" ? trashFeedMemos : view === "review" ? reviewMemos : visibleMemos;
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
  const feedQueryKey = view === "trash" ? `trash:${trashSearch}` : feedQuery;
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

  // Search feedback. The literal keyword hits are what get highlighted and
  // counted as found; with semantic search on, the rest of the list is what
  // meaning added. Memo text is lowercased once per snapshot (search.ts), so
  // a second pass over the result list costs little.
  const searching = view === "memos" && !queryIsEmpty(parsedQuery);
  const keywordHitIds = useMemo(() => {
    if (!searching) return null;
    const ids = new Set<string>();
    for (const memo of visibleMemos) if (memoMatchesQuery(memo, parsedQuery)) ids.add(memo.id);
    return ids;
  }, [searching, visibleMemos, parsedQuery]);
  const relatedCount = useMemo(
    () => (keywordHitIds && semanticResults ? visibleMemos.filter((memo) => !keywordHitIds.has(memo.id) && semanticResults.has(memo.id)).length : 0),
    [keywordHitIds, semanticResults, visibleMemos]
  );
  const searchNeedleList = useMemo(() => (searching ? searchNeedles(parsedQuery) : []), [searching, parsedQuery]);
  const feedRef = useRef<HTMLElement | null>(null);
  useSearchHighlight(feedRef, searchNeedleList, keywordHitIds);
  // A tag, day, stats bar or filter quietly narrows what the query searches;
  // the result line and the empty state say so instead of implying the whole
  // notebook was searched.
  const otherScopeOn = activeDay !== null || statsDrilldown !== null || structuredFiltersOn;
  const searchScopeText = !semanticScopeActive
    ? null
    : activeTag
      ? otherScopeOn
        ? tr(`in #${activeTag} with filters`, `在 #${activeTag} 的筛选范围内`)
        : tr(`in #${activeTag}`, `在 #${activeTag} 中`)
      : tr("within the current filters", "在当前筛选范围内");
  // Matches the scope hides, offered when the scoped search comes up empty.
  const outsideHitCount = useMemo(() => {
    if (!searching || !semanticScopeActive || feedMemos.length > 0) return 0;
    let total = 0;
    for (const memo of activeMemos) if (memoMatchesQuery(memo, parsedQuery)) total += 1;
    return total;
  }, [searching, semanticScopeActive, feedMemos.length, activeMemos, parsedQuery]);
  const foundCount = (keywordHitIds?.size ?? 0) + relatedCount;
  const searchSummary = !searching
    ? ""
    : `${
        searchScopeText
          ? tr(`Found ${count(foundCount, "memo")} ${searchScopeText}`, `${searchScopeText}找到 ${count(foundCount, "memo")}`)
          : tr(`Found ${count(foundCount, "memo")}`, `找到 ${count(foundCount, "memo")}`)
      }${relatedCount > 0 ? tr(` · ${relatedCount} related by meaning`, ` · 其中 ${relatedCount} 条意思相近`) : ""}`;
  const searchEmptyTitle = searchScopeText
    ? tr(`No matching memos ${searchScopeText}`, `${searchScopeText}没有找到相关笔记`)
    : tr("No matching memos", "没有找到相关笔记");
  // What the polite live region reads: the settled answer, not every
  // keystroke's (or the "still looking" state's) intermediate one.
  const searchSettled = searching && !semanticPending ? (feedMemos.length === 0 ? searchEmptyTitle : searchSummary) : "";
  const [searchAnnouncement, setSearchAnnouncement] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchAnnouncement(searchSettled), searchSettled ? 400 : 0);
    return () => window.clearTimeout(timer);
  }, [searchSettled]);
  const searchText = searchComposition ?? query;
  const searchPlaceholder = activeTag
    ? semanticOn
      ? tr(`Search #${activeTag} by meaning`, `在 #${activeTag} 中按意思搜索`)
      : tr(`Search in #${activeTag}`, `在 #${activeTag} 中搜索`)
    : semanticOn
      ? tr("Search by meaning", "按意思搜索")
      : tr("Search memos", "搜索笔记");
  const searchSyntaxHint = tr("Space separates keywords (all must match); “quotes” match an exact phrase.", "空格分隔多个关键词（须全部命中）；“引号”匹配完整短语。");

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
    (apply: () => void, { rewind, morph = true }: { rewind: boolean; morph?: boolean }) => {
      const update = (animated = false) => {
        enterSuppressRef.current = true;
        try {
          flushSync(() => {
            if (rewind) setRenderWindow((current) => ({ ...current, cap: FEED_PAGE }));
            apply();
          });
        } finally {
          enterSuppressRef.current = false;
          // The swap's lens change has been recorded (or there was none).
          navIntentRef.current = "replace";
        }
        // Capture the composer at its final opacity/position. Its named
        // snapshot plays the entrance; hidden -> visible also restarts the
        // ordinary CSS entrance, which would otherwise animate underneath it.
        if (animated) {
          document.querySelector(".composer")?.getAnimations().forEach((animation) => {
            if (animation instanceof CSSAnimation && animation.animationName === "rise-in") animation.finish();
          });
        }
        if (rewind) window.scrollTo(0, 0);
      };
      // `morph: false` is a swap the browser already animated (a Back swipe
      // with its own slide): playing the feed morph on top would show it twice.
      if (drawerOpen || !morph) update();
      else {
        withViewTransition(update);
      }
    },
    [drawerOpen]
  );

  const navLens = useMemo<NavLens>(
    () => ({ view, tag: activeTag, day: activeDay, drilldown: statsDrilldown, filters, query }),
    [view, activeTag, activeDay, statsDrilldown, filters, query]
  );
  const navLensRef = useRef(navLens);
  navLensRef.current = navLens;

  /** Measure the reading place before the feed changes under the reader. */
  const noteLeavingPlace = useCallback(() => {
    const place = captureFeedPlace(FEED_PAGE);
    const id = currentNavIdRef.current;
    if (id) navStoreRef.current?.setPlace(id, place);
    if (isRootLens(navLensRef.current)) rootPlaceRef.current = place;
  }, []);

  /** A discrete lens change: a new result list, and a new Back step. */
  const changeFeed = useCallback(
    (apply: () => void) => {
      noteLeavingPlace();
      swapFeed(() => {
        navIntentRef.current = "push";
        apply();
      }, { rewind: true });
    },
    [swapFeed, noteLeavingPlace]
  );

  /**
   * A lens the reader has been in before (Back/Forward, the ⌂ pill): the
   * same morph, but landing on the card they left rather than the top. The
   * restore itself runs in the layout effect below, once the list exists.
   */
  const returnToFeed = useCallback(
    (apply: () => void, place: NavPlace | null, intent: "push" | "replace", morph = true) => {
      swapFeed(
        () => {
          navIntentRef.current = intent;
          pendingPlaceRef.current = place;
          apply();
          setPlaceTick((tick) => tick + 1);
        },
        { rewind: place === null, morph }
      );
    },
    [swapFeed]
  );

  // Declared after the query-scroll effect above so a restored place wins
  // over its scroll-to-top. A place deep in the feed first widens the render
  // window (a synchronous re-render, still before paint) so its card exists.
  useLayoutEffect(() => {
    const place = pendingPlaceRef.current;
    if (!place) return;
    if (renderCap < place.cap && hasMoreFeed) {
      setRenderWindow({ key: feedWindowKey, cap: place.cap });
      return;
    }
    pendingPlaceRef.current = null;
    restoreFeedPlace(place);
  }, [placeTick, feedWindowKey, renderCap, hasMoreFeed]);

  // The wiring promised above the useSemanticSearch call.
  publishSemanticRef.current = (commit) => swapFeed(commit, { rewind: false });

  /** Search text set by a control: lands with the swap that animates it. */
  const swapQuery = useCallback((next: string) => {
    queryLeapRef.current = next.trim().toLowerCase();
    setSearchComposition(null);
    setQuery(next);
  }, []);
  /** Search text set by the keyboard: stays on the deferred path. */
  const typeQuery = useCallback(
    (next: string) => {
      queryLeapRef.current = null;
      setSearchComposition(null);
      // The keystroke that starts a search leaves the lens it was typed in:
      // one Back step per search (Back clears it again), and the place left
      // behind (All memos' too, for ⌂) is measured now. Later keystrokes
      // edit that entry in place.
      if (next.trim() !== "" && navLensRef.current.query.trim() === "") {
        noteLeavingPlace();
        navIntentRef.current = "push";
      }
      setQuery(next);
    },
    [noteLeavingPlace]
  );

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
        // One date lens at a time: a heatmap day replaces a date range
        // (their intersection was a second chip and, mostly, an empty feed).
        if (key) setFilters((current) => (current.dateFrom !== null || current.dateTo !== null ? { ...current, dateFrom: null, dateTo: null } : current));
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
    // Home is a lens the reader has been in: back to the card they left
    // All memos at, not to the top of a reset window.
    noteLeavingPlace();
    returnToFeed(
      () => {
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
      },
      rootPlaceRef.current,
      "push"
    );
  }, [view, activeTag, activeDay, statsDrilldown, query, filters, noteLeavingPlace, returnToFeed, swapQuery]);

  /**
   * Lifts just the lenses that hide one memo (a just-created one, from its
   * toast), then brings its card into view once the feed has re-rendered.
   */
  const revealIdRef = useRef<string | null>(null);
  const revealMemo = useCallback(
    (id: string) => {
      const memo = syncStateRef.current.memos.get(id);
      if (!memo || memo.deletedAt) return;
      const lens = lensRef.current;
      revealIdRef.current = id;
      // Past the rendered window (an oldest-first feed) there is no card to
      // bring in; don't leave a jump armed for whenever paging reaches it.
      window.setTimeout(() => {
        if (revealIdRef.current === id) revealIdRef.current = null;
      }, 1000);
      changeFeed(() => {
        if (!memoMatchesQuery(memo, lens.parsedQuery)) swapQuery("");
        const tag = lens.activeTag;
        if (tag && !tagsOf(memo).some((path) => tagMatches(path, tag))) setActiveTag(null);
        if (lens.activeDay && dayKeyOf(memo) !== lens.activeDay) setActiveDay(null);
        if (lens.statsDrilldown && !memoMatchesStatsDrilldown(memo, lens.statsDrilldown)) setStatsDrilldown(null);
        if (!memoMatchesFilters(memo, lens.filters)) setFilters(EMPTY_FILTERS);
        if (lens.view !== "memos") {
          setSelectMode(false);
          setSelected(new Set());
          setConfirmBatchDelete(false);
          setView("memos");
        }
      });
    },
    [changeFeed, swapQuery]
  );
  useEffect(() => {
    const id = revealIdRef.current;
    if (!id || !renderedFeedMemos.some((memo) => memo.id === id)) return;
    revealIdRef.current = null;
    // A frame later: the swap's own rewind to the top lands first.
    const frame = window.requestAnimationFrame(() => {
      const slot = Array.from(document.querySelectorAll<HTMLElement>(".memo-slot[data-vt]")).find((node) => node.dataset.vt === `memo-${id}`);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      slot?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renderedFeedMemos]);

  // A just-created memo the lenses keep can still land past the render
  // window (oldest first, a long feed): no card appears as the editor clears,
  // which reads as a failed send just like a lens hiding it. Checked once the
  // feed has taken the memo in; rendering up to it would mean rendering the
  // whole list, so the toast only says where it went.
  const createdPlacementRef = useRef<string | null>(null);
  useEffect(() => {
    const id = createdPlacementRef.current;
    if (!id) return;
    const index = feedMemos.findIndex((memo) => memo.id === id);
    if (index < 0) return;
    createdPlacementRef.current = null;
    if (!renderedFeedMemos.some((memo) => memo.id === id)) {
      showToast(tr("Saved the memo — it's further down this list", "已保存这条笔记，它在列表靠后的位置"));
    }
  }, [feedMemos, renderedFeedMemos, showToast, tr]);

  /** Widens a scoped search to the whole notebook, keeping the query. */
  const searchAllMemos = useCallback(() => {
    changeFeed(() => {
      setActiveTag(null);
      setActiveDay(null);
      setStatsDrilldown(null);
      setFilters(EMPTY_FILTERS);
    });
  }, [changeFeed]);

  /** Facet on/off is a discrete choice — it rides the same feed morph as a
      tag or sort change, whether it comes from the panel or a chip's ×. */
  const toggleFacet = useCallback(
    (key: FacetKey) => {
      changeFeed(() => setFilters((current) => ({ ...current, [key]: !current[key] })));
    },
    [changeFeed]
  );

  // The calendar's first tap (an open "since") updates in place rather than
  // morphing. Starting a range is a Back step; closing it (below) is not.
  const patchDateRange = useCallback(
    (patch: Partial<Pick<FeedFilters, "dateFrom" | "dateTo">>) => {
      const { filters: current } = navLensRef.current;
      if (current.dateFrom === null && current.dateTo === null) {
        noteLeavingPlace();
        navIntentRef.current = "push";
      }
      setFilters((value) => ({ ...value, ...patch }));
      // One date lens at a time: a range replaces a heatmap day.
      if (patch.dateFrom || patch.dateTo) setActiveDay(null);
    },
    [noteLeavingPlace]
  );

  /** A quick range lands whole, so it morphs like a facet does. */
  const applyPresetRange = useCallback(
    (from: string, to: string) => {
      // The calendar's second tap closes the open range its first tap made:
      // one pick, one Back step.
      const { filters: current } = navLensRef.current;
      const closing = current.dateFrom !== null && current.dateTo === null;
      changeFeed(() => {
        if (closing) navIntentRef.current = "replace";
        setFilters((value) => ({ ...value, dateFrom: from, dateTo: to }));
        setActiveDay(null);
      });
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
      // A preset aimed at a tag that is gone (renamed or removed on another
      // device) would be cleared by the missing-tag effect the moment it
      // applied — silently widening the lens to every memo. Say so instead.
      const tag = item.tag;
      if (tag && !knownTags.some((known) => tagMatches(known, tag))) {
        showToast(tr(`Couldn’t apply “${item.name}”: #${tag} no longer exists`, `无法应用「${item.name}」：#${tag} 已不存在`), "error");
        return;
      }
      changeFeed(() => {
        setView("memos");
        setActiveTag(item.tag);
        setActiveDay(item.day);
        setStatsDrilldown(null);
        swapQuery(item.query);
        setFilters(item.filters);
      });
    },
    [changeFeed, swapQuery, knownTags, showToast, tr]
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
      setTrashQuery("");
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
    const provisionalStale = next !== null && next === provisionalReviewRef.current && !bootstrapJobRef.current;
    if (!reviewDayValid(next, reviewSettings) || provisionalStale) {
      next = drawReviewDay(activeMemos, reviewSettings);
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
  }, [view, reviewDay, reviewSettings, activeMemos, changeFeed, holdForOpenEdit, drawReviewDay]);

  // Crossing midnight while the review view sits open: returning focus (or
  // visibility) re-checks the frozen batch and deals the new day in a morph.
  useEffect(() => {
    if (phase !== "ready" || view !== "review") return;
    function refresh() {
      if (document.visibilityState === "hidden") return;
      if (reviewDayValid(reviewDay, reviewSettings)) return;
      const next = drawReviewDay(memosOf(syncStateRef.current), reviewSettings);
      withViewTransition(() => flushSync(() => setReviewDay(next)));
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [phase, view, reviewDay, reviewSettings, drawReviewDay]);

  /** Put a remembered lens on screen (Back/Forward, or a reload). */
  function applyNavLens(lens: NavLens) {
    // Review replays the day's frozen batch, drawing it first if the day
    // rolled over — what openReview does.
    if (lens.view === "review" && !reviewDayValid(reviewDay, reviewSettings)) {
      const next = buildReviewDay(activeMemos, reviewSettings);
      persistReviewDay(next);
      setReviewDay(next);
    }
    // A selection and a Trash search belong to the view they were made in.
    if (lens.view !== view) {
      setSelectMode(false);
      setSelected(new Set());
      setConfirmBatchDelete(false);
      setTrashQuery("");
    }
    setView(lens.view);
    setActiveTag(lens.tag);
    setActiveDay(lens.day);
    setStatsDrilldown(lens.drilldown);
    setFilters(lens.filters);
    swapQuery(lens.query);
  }

  // Records lens changes into session history. The first ready commit
  // either restores the lens this tab's entry remembers (a reload) or stamps
  // the entry with the current one. After that a discrete pick adds an
  // entry and anything else (typing) edits the current one.
  useLayoutEffect(() => {
    const store = navStoreRef.current;
    if (phase !== "ready" || !store) {
      navBootedRef.current = false;
      return;
    }
    if (!navBootedRef.current) {
      navBootedRef.current = true;
      try {
        window.history.scrollRestoration = "manual";
      } catch {
        // Older engines: the browser's own restore only lands at the top.
      }
      const id = navIdOf(window.history.state);
      const entry = id ? store.get(id) : null;
      if (id && entry) {
        currentNavIdRef.current = id;
        if (!lensesEqual(entry.lens, navLens)) applyNavLens(entry.lens);
        if (entry.place) {
          pendingPlaceRef.current = entry.place;
          setPlaceTick((tick) => tick + 1);
        }
      } else {
        currentNavIdRef.current = store.replace(null, navLens);
      }
      return;
    }
    const intent = navIntentRef.current;
    navIntentRef.current = "replace";
    const id = currentNavIdRef.current;
    const entry = id ? store.get(id) : null;
    if (entry && lensesEqual(entry.lens, navLens)) return;
    currentNavIdRef.current = intent === "push" && entry ? store.push(navLens) : store.replace(id, navLens);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per lens change; applyNavLens reads this render
  }, [phase, navLens]);

  const popNavRef = useRef<(state: unknown, browserAnimated: boolean) => void>(() => undefined);
  popNavRef.current = (state, browserAnimated) => {
    const store = navStoreRef.current;
    if (!store) return;
    const id = navIdOf(state);
    const entry = id ? store.get(id) : null;
    const lens = entry?.lens ?? ROOT_LENS;
    const current = navLensRef.current;
    // Trash and Daily review wait for an open edit, as their nav items do.
    // The browser has already stepped, so the lens on screen goes back on top.
    if (lens.view !== current.view && lens.view !== "memos") {
      const held = lens.view === "trash" ? holdForOpenEdit("open Trash", "打开回收站") : holdForOpenEdit("open Daily review", "打开每日回顾");
      if (held) {
        currentNavIdRef.current = store.push(current);
        return;
      }
    }
    noteLeavingPlace();
    // An id the store no longer knows (an entry from before a logout, or one
    // trimmed past the cap) is stamped again with the lens it now shows, so
    // the next pick still adds a Back step on top of it.
    currentNavIdRef.current = id && entry ? id : store.replace(id, lens);
    if (drawerOpen) closeDrawer();
    setStatsOpen(false);
    if (lensesEqual(lens, current)) {
      if (entry?.place) restoreFeedPlace(entry.place);
      return;
    }
    returnToFeed(() => applyNavLens(lens), entry?.place ?? null, "replace", !browserAnimated);
  };

  useEffect(() => {
    if (phase !== "ready") return;
    // A Back swipe that the browser already slid in (iOS Safari, Chrome on
    // Android) lands without the feed morph on top.
    const onPopState = (event: PopStateEvent) => popNavRef.current(event.state, (event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true);
    // A reload in this tab comes back to the same card, not just the lens.
    const onPageHide = () => {
      const id = currentNavIdRef.current;
      if (id) navStoreRef.current?.setPlace(id, captureFeedPlace(FEED_PAGE));
      navStoreRef.current?.flush();
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [phase]);

  function handleSaveReviewSettings(next: ReviewSettings) {
    setReviewSettingsOpen(false);
    showToast(tr("Saved review settings", "已保存回顾设置"));
    adoptReviewSettings(next);
  }

  /**
   * Keep the review scope on the tags it named after a sidebar rename or
   * removal. A rename leaves the same memos eligible, so today's batch is
   * carried over under the new fingerprint instead of being redrawn mid-day.
   */
  function followTagChangeInReview(next: ReviewSettings, sameMemos: boolean) {
    if (next === reviewSettings) return;
    if (sameMemos && reviewDayValid(reviewDay, reviewSettings)) {
      const carried = { ...reviewDay, fingerprint: reviewFingerprint(next) };
      persistReviewDay(carried);
      setReviewDay(carried);
      adoptReviewSettings(next, carried);
    } else {
      adoptReviewSettings(next);
    }
  }

  function adoptReviewSettings(next: ReviewSettings, currentDay: ReviewDay | null = reviewDay) {
    setReviewSettings(next);
    persistReviewSettings(next);
    if (reviewDayValid(currentDay, next)) return;
    if (view === "review") {
      // Redraw immediately — after the dialog's exit has painted, so the
      // feed's morph to the new batch reads as its own beat.
      const nextDay = drawReviewDay(activeMemos, next);
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
  const enterSelectMode = useCallback((firstId?: string) => {
    if (holdForOpenEdit("select memos", "多选笔记")) return;
    withViewTransition(() =>
      flushSync(() => {
        setSelectMode(true);
        setSelected(new Set(firstId ? [firstId] : []));
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
    setLoggingOut(true);
    try {
      const result = await logout();
      if (!result.ok) throw new ApiError("LOGOUT_FAILED", 500, "The server did not confirm logout");
    } catch (cause) {
      if (!(cause instanceof AuthRequiredError)) {
        setLoggingOut(false);
        setConfirmLogout(false);
        showToast(tr("Logout wasn’t confirmed. Your session remains open.", "退出未得到服务器确认，当前登录仍然有效"), "error");
        return;
      }
    } finally {
      logoutBusyRef.current = false;
    }

    sessionEpochRef.current += 1;
    notifyLogout();
    const localCleanup = clearLocalDeviceData();
    discardHeldDrafts();
    resetSessionUi();
    resetLocalWorkspaceState();
    setLoggingOut(false);
    setPhase("login");
    await localCleanup;
  }

  async function handleCreate(data: EditorSubmission): Promise<boolean> {
    const content = activeTag ? inheritTagContext(data.content, activeTag) : data.content;
    setCreating(true);
    try {
      const result = await guard(() => createMemo(data.clientId, content, data.newImages, { onUploadProgress: data.onUploadProgress }));
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
      // The composer stays up under a search, a day or a filter, and a memo
      // those lenses exclude would just vanish as the editor clears — read
      // as a failed send. Say where it went and offer the way to it.
      const lens = lensRef.current;
      const savedId = saved.id;
      if (lens.view === "memos" && !(memoMatchesSearchScope(saved, lens) && memoMatchesQuery(saved, lens.parsedQuery))) {
        showToast(tr("Saved the memo — this view hides it", "已保存这条笔记，当前视图下看不到它"), "info", {
          action: { label: tr("Show", "显示"), run: () => revealMemo(savedId) }
        });
      } else if (lens.view === "memos") {
        // In the view, but maybe past the render window (see the effect).
        createdPlacementRef.current = savedId;
        window.setTimeout(() => {
          if (createdPlacementRef.current === savedId) createdPlacementRef.current = null;
        }, 1000);
      }
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

  /** Pending attachments in a stashed draft hold object URLs; free them. */
  function releaseDiscardedEdit() {
    const stash = discardedEditRef.current;
    discardedEditRef.current = null;
    for (const image of stash?.draft.newImages ?? []) URL.revokeObjectURL(image.previewUrl);
  }

  /**
   * Esc / Cancel close the editor at once. A dirty edit leaves a "Discarded"
   * toast whose Undo reopens it exactly as it was — text, attachments,
   * selection and the version it was based on (so a remote change made
   * meanwhile still raises the conflict notice).
   */
  function handleCancelEdit(draft: EditDraft | null) {
    const memoId = editingIdRef.current;
    const baseSeq = editingBaseSeqRef.current;
    editingBaseSeqRef.current = null;
    setEditConflictId(null);
    setEditingId(null);
    if (!draft || !memoId) return;
    releaseDiscardedEdit();
    const entry = { memoId, draft, baseSeq };
    discardedEditRef.current = entry;
    showToast(tr("Discarded your edits", "已放弃这次修改"), "info", {
      action: { label: tr("Undo", "撤销"), run: () => feedActionsRef.current.reopenEdit(entry) }
    });
  }

  function reopenDiscardedEdit(entry: { memoId: string; draft: EditDraft; baseSeq: number | null }) {
    // A later discard replaced (and released) this one.
    if (discardedEditRef.current !== entry) return;
    if (editingIdRef.current) {
      showToast(tr("Save or cancel the open edit before editing another memo.", "请先保存或取消当前编辑，再编辑其他笔记"));
      return;
    }
    const current = syncStateRef.current.memos.get(entry.memoId);
    if (!current || current.deletedAt) {
      releaseDiscardedEdit();
      showToast(tr("Couldn’t reopen the edit: the memo was deleted.", "无法恢复编辑：这条笔记已被删除"), "error");
      return;
    }
    if (view !== "memos" || selectMode) {
      showToast(tr("Go back to your memos to reopen the edit.", "回到笔记列表后再恢复编辑"));
      return;
    }
    // The editor owns the draft (and its preview URLs) from here on.
    discardedEditRef.current = null;
    editingBaseSeqRef.current = entry.baseSeq;
    setEditConflictId(null);
    setReopenedDraft({ memoId: entry.memoId, draft: entry.draft });
    setEditingId(entry.memoId);
  }

  async function handleSaveEdit(memo: Memo, data: EditorSubmission): Promise<boolean> {
    setSavingEdit(true);
    try {
      const result = await guard(() =>
        updateMemo(
          memo.id,
          {
            expectedSeq: editingBaseSeqRef.current ?? memo.seq,
            content: data.content,
            addImages: data.newImages,
            removeImageIds: data.removeImageIds
          },
          { onUploadProgress: data.onUploadProgress }
        )
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

  /**
   * One optimistic pin / trash / restore. The guess lands at the click, in
   * the view transition that moves the card (to the top, out of the feed,
   * into Trash); the server's answer then replaces it in place — same
   * outcome, nothing moves. A failure peels the guess off in a transition
   * of its own, so the card glides back, and rethrows for the caller's
   * toast. Resolves to null when the memo already has an action in flight
   * (or the session went away) — nothing to report then.
   */
  async function runOptimisticMemoAction(memo: Memo, patch: OptimisticPatch, request: () => Promise<Memo | null>): Promise<Memo | null> {
    const tokens = memoActionTokensRef.current;
    if (tokens.has(memo.id)) return null;
    const token = {};
    tokens.set(memo.id, token);
    // A card the guess removes (trash, restore) must not drop keyboard focus
    // to <body>: hand it on to a neighbour, as applyRemoval does.
    const refocus = holdFeedFocus();
    withViewTransition(() => {
      flushSync(() => {
        // The transition's update can run after a very fast response has
        // already settled this action; a stale guess must not land then.
        if (tokens.get(memo.id) === token) setOptimisticMemos((current) => withPatch(current, memo.id, patch));
      });
      refocus();
    });
    let settled: Memo | null = null;
    try {
      settled = await request();
    } finally {
      tokens.delete(memo.id);
      const land = () => {
        if (settled) applySyncChanges([settled], [], []);
        setOptimisticMemos((current) => withoutPatch(current, memo.id));
      };
      if (settled) land();
      else withViewTransition(() => flushSync(land));
    }
    if (settled) {
      void runSync();
      notifyPeers();
    }
    return settled;
  }

  async function handleTogglePin(memo: Memo) {
    const pinning = !memo.pinnedAt;
    try {
      const nextMemo = await runOptimisticMemoAction(memo, { pinnedAt: pinning ? new Date().toISOString() : null }, async () => {
        const result = await guard(() => updateMemo(memo.id, { expectedSeq: memo.seq, pinned: pinning }));
        return result?.memo ?? (result?.memoPatch ? { ...memo, ...result.memoPatch } : null);
      });
      if (!nextMemo) return;
      // Pinning lifts a card from deep in the feed out of view, so the
      // reverse rides on the toast.
      showToast(nextMemo.pinnedAt ? tr("Pinned", "已置顶") : tr("Unpinned", "已取消置顶"), "info", {
        action: { label: tr("Undo", "撤销"), run: () => void handleTogglePin(nextMemo) }
      });
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
      const refocus = holdFeedFocus();
      withViewTransition(() => {
        flushSync(() => applySyncChanges(changed, purged, []));
        refocus();
      });
      void runSync();
      notifyPeers();
    },
    [applySyncChanges, runSync, notifyPeers]
  );

  async function handleTrash(memo: Memo) {
    try {
      const trashed = await runOptimisticMemoAction(
        memo,
        { deletedAt: new Date().toISOString() },
        async () => (await guard(() => trashMemo(memo.id, memo.seq)))?.memo ?? null
      );
      if (!trashed) return;
      // Reversible, so the toast carries the reverse — the trashed memo's
      // own seq, since the trip to Trash bumped it.
      showToast(tr("Moved to Trash", "已移入回收站"), "info", { action: { label: tr("Undo", "撤销"), run: () => void handleRestore(trashed) } });
    } catch (cause) {
      if (reconcileVersionConflict(cause)) return;
      showToast(errorMessage(cause, "Couldn’t delete the memo.", "删除笔记失败"), "error");
    }
  }

  async function handleRestore(memo: Memo) {
    try {
      const restored = await runOptimisticMemoAction(
        memo,
        { deletedAt: null },
        async () => (await guard(() => restoreMemo(memo.id, memo.seq)))?.memo ?? null
      );
      if (!restored) return;
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
    // The server purges every trashed memo, so the count it confirms must be
    // the whole set: never while a cold start is still loading older pages.
    if (emptyTrashBusyRef.current || bootstrapJobRef.current) return;
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

  /** The selected memos as live objects — the batch actions' targets. */
  function selectedMemos(inTrash: boolean): Memo[] {
    return [...visibleSelected]
      .map((id) => syncStateRef.current.memos.get(id))
      .filter((memo): memo is Memo => Boolean(memo && Boolean(memo.deletedAt) === inTrash));
  }

  /**
   * One batch of memo mutations, settled together: the survivors' cards and
   * the selection toolbar move in one view transition, the failures stay
   * selected so a retry is one tap away, and the toast reports the outcome.
   * Trash ↔ restore share this shape; each hands the other over as Undo.
   */
  async function settleBatch(
    targets: Memo[],
    op: "trash" | "restore",
    { fromSelection, done, failed }: { fromSelection: boolean; done: (changed: Memo[]) => void; failed: (failedCount: number) => string }
  ) {
    if (targets.length === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      const result = await guard(() => runMemoBatch(op, targets));
      if (!result) return;
      // The server confirmed each change at the version we sent, so the
      // patch over our copy is exactly the server row.
      const byId = new Map(targets.map((memo) => [memo.id, memo]));
      const changed = result.patches.flatMap((patch) => {
        const memo = byId.get(patch.id);
        return memo ? [{ ...memo, ...patch }] : [];
      });
      const failedIds = result.failed.map((failure) => failure.id);
      if (changed.length > 0) {
        withViewTransition(() =>
          flushSync(() => {
            applySyncChanges(changed, [], []);
            if (!fromSelection) return;
            if (failedIds.length === 0) {
              // Job done — leave select mode in the same breath.
              restoreLocationFocusRef.current = true;
              setSelectMode(false);
              setSelected(new Set());
            } else {
              // Keep only the failures selected so a retry is one tap away.
              setSelected(new Set(failedIds));
            }
          })
        );
        notifyPeers();
      }
      // Refusals (a version changed elsewhere) pull the server truth too.
      if (changed.length > 0 || failedIds.length > 0) void runSync();
      if (failedIds.length > 0) showToast(failed(failedIds.length) + batchFailureDetail(result.failed), "error");
      else done(changed);
    } catch (cause) {
      showToast(failed(targets.length) + tr(" ", "，") + errorMessage(cause), "error");
    } finally {
      setBatchBusy(false);
      setBatchProgress(null);
    }
  }

  /**
   * One select-mode action through the batch endpoint, a chunk per request.
   * Large selections report settled/total for the busy pill; a single-chunk
   * job finishes before a count would mean anything.
   */
  function runMemoBatch(op: "trash" | "restore" | "purge" | "tag", targets: Memo[], tag?: string) {
    return batchMemos(
      op,
      targets.map((memo) => ({ id: memo.id, expectedSeq: memo.seq })),
      { tag, onProgress: (settled) => setBatchProgress(settled < targets.length ? { done: settled, total: targets.length } : null) }
    );
  }

  /** The first refusal's reason, appended to a batch failure toast. */
  function batchFailureDetail(failures: MemoBatchFailure[]): string {
    if (failures.length === 0) return "";
    return tr(" ", "，") + errorMessage(failures[0]);
  }

  /**
   * Batch trash rides the same removal choreography as a single delete: one
   * view transition in which every selected card recedes while the survivors
   * (and the selection toolbar collapsing back into the breadcrumb) glide.
   * Reversible, so its toast carries the reverse.
   */
  function trashMany(targets: Memo[], fromSelection: boolean) {
    return settleBatch(targets, "trash", {
      fromSelection,
      failed: (n) => tr(`Couldn’t move ${count(n, "memo")} to Trash.`, `有 ${count(n, "memo")}未能移入回收站`),
      done: (changed) =>
        showToast(tr(`Moved ${count(changed.length, "memo")} to Trash`, `已将 ${count(changed.length, "memo")}移入回收站`), "info", {
          action: { label: tr("Undo", "撤销"), run: () => void restoreMany(changed, false) }
        })
    });
  }

  function restoreMany(targets: Memo[], fromSelection: boolean) {
    return settleBatch(targets, "restore", {
      fromSelection,
      failed: (n) => tr(`Couldn’t restore ${count(n, "memo")}.`, `有 ${count(n, "memo")}恢复失败`),
      done: (changed) =>
        showToast(tr(`Restored ${count(changed.length, "memo")}`, `已恢复 ${count(changed.length, "memo")}`), "info", {
          action: { label: tr("Undo", "撤销"), run: () => void trashMany(changed, false) }
        })
    });
  }

  /** Permanent, so no Undo — the armed pill asked twice. */
  async function purgeMany(targets: Memo[]) {
    if (targets.length === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      const result = await guard(() => runMemoBatch("purge", targets));
      if (!result) return;
      const purged = result.purged;
      const failedIds = result.failed.map((failure) => failure.id);
      if (purged.length > 0) {
        withViewTransition(() =>
          flushSync(() => {
            applySyncChanges([], purged, []);
            if (failedIds.length === 0) {
              setSelectMode(false);
              setSelected(new Set());
            } else {
              setSelected(new Set(failedIds));
            }
          })
        );
        notifyPeers();
      }
      // Refusals (a version changed elsewhere) pull the server truth too.
      if (purged.length > 0 || failedIds.length > 0) void runSync();
      if (failedIds.length > 0) {
        showToast(
          tr(`Couldn’t delete ${count(failedIds.length, "memo")}.`, `有 ${count(failedIds.length, "memo")}删除失败`) + batchFailureDetail(result.failed),
          "error"
        );
      } else showToast(tr(`Permanently deleted ${count(purged.length, "memo")}`, `已彻底删除 ${count(purged.length, "memo")}`));
    } catch (cause) {
      showToast(
        tr(`Couldn’t delete ${count(targets.length, "memo")}.`, `有 ${count(targets.length, "memo")}删除失败`) + tr(" ", "，") + errorMessage(cause),
        "error"
      );
    } finally {
      setBatchBusy(false);
      setBatchProgress(null);
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
    try {
      // The server appends to its own current text, so no memo body is
      // uploaded, and a memo another tab already tagged comes back as is.
      const result = await guard(() => runMemoBatch("tag", pendingTargets, tag));
      if (!result) return false;

      // Gone or in Trash elsewhere (sync brings that news) or too long to
      // take the tag: a retry would fail the same way, so those leave the selection.
      const final = new Set(["MEMO_NOT_FOUND", "MEMO_TRASHED", "MEMO_CONTENT_TOO_LONG"]);
      // Even an all-failed batch has a settled result: close the sheet and
      // retain precisely those failures so retrying is one action away.
      pendingBatchTagRef.current = {
        scope,
        tag,
        changed: result.memos,
        retryIds: result.failed.filter((failure) => !final.has(failure.code)).map((failure) => failure.id),
        failedCount: result.failed.length,
        firstFailure: result.failed.length > 0 ? errorMessage(result.failed[0]) : null,
        alreadyTagged: targets.length - pendingTargets.length + result.unchanged.length,
        targetCount: targets.length
      };
      return true;
    } catch (cause) {
      showToast(errorMessage(cause, "Couldn’t add the tag.", "添加标签失败"), "error");
      return false;
    } finally {
      setBatchProgress(null);
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
        if (result.changed.length > 0) applySyncChanges(result.changed, [], []);
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

    if (result.changed.length > 0 || result.failedCount > 0) {
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
    cancelEdit: handleCancelEdit,
    reopenEdit: reopenDiscardedEdit,
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
    toggleSelect,
    selectFrom: (memo: Memo) => enterSelectMode(memo.id)
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
    cancelEdit: handleCancelEdit,
    reopenEdit: reopenDiscardedEdit,
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
    toggleSelect,
    selectFrom: (memo: Memo) => enterSelectMode(memo.id)
  };
  const getEntering = useCallback(() => !enterSuppressRef.current, []);
  const feedHandlers = useMemo<FeedHandlers>(
    () => ({
      startEdit: (id) => feedActionsRef.current.startEdit(id),
      cancelEdit: (draft) => feedActionsRef.current.cancelEdit(draft),
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
      selectFrom: (memo) => feedActionsRef.current.selectFrom(memo),
      toggleTask: (memo, lineKey, checked) => feedActionsRef.current.toggleTask(memo, lineKey, checked),
      editDraftChange: (memoId, content) => {
        editDraftRef.current = { memoId, content };
      }
    }),
    []
  );

  // The sidebar is memoized; its handlers read the latest closures through a
  // ref so App re-renders (every keystroke in search) never reach it.
  const sidebarActions = {
    onCloseDrawer: () => closeDrawer(),
    onPinTag: (path: string, pinned: boolean) => void handlePinTag(path, pinned),
    onRenameTag: (path: string) => closeDrawer(() => setRenameTagTarget(path)),
    onRemoveTag: (path: string) => void handleRemoveTag(path),
    onPickTag: (path: string | null) => {
      pickTag(path);
      closeDrawer();
    },
    onPickDay: (key: string | null) => {
      pickDay(key);
      closeDrawer();
    },
    onShowAll: () => {
      showAll();
      closeDrawer();
    },
    onOpenTrash: () => {
      openTrash();
      closeDrawer();
    },
    onOpenReview: () => {
      openReview();
      closeDrawer();
    },
    onOpenReviewSettings: () => closeDrawer(() => setReviewSettingsOpen(true)),
    onOpenModelSettings: () =>
      closeDrawer(() => {
        setEnableSemanticWhenReady(false);
        setModelSettingsOpen(true);
      }),
    onOpenStats: () => closeDrawer(() => setStatsOpen(true)),
    onChangePasscode: () =>
      closeDrawer(() => {
        sessionEpochRef.current += 1;
        passcodeChangesRef.current += 1;
        changingPasscodeRef.current = true;
        setChangingPasscode(true);
      }),
    onExportData: () => closeDrawer(() => void handleExport()),
    onImportData: () => closeDrawer(() => importFileRef.current?.click()),
    onLogout: () => closeDrawer(() => setConfirmLogout(true))
  };
  const sidebarActionsRef = useRef(sidebarActions);
  sidebarActionsRef.current = sidebarActions;
  const sidebarHandlers = useMemo(() => stableHandlers(sidebarActionsRef), []);

  const lazyDialogFailed = useCallback(() => {
    setShareMemo(null);
    setStatsOpen(false);
    setReviewSettingsOpen(false);
    setModelSettingsOpen(false);
    showToast(tr("Couldn’t open this panel. Reload the page and try again.", "无法打开此面板，请刷新页面后重试"), "error");
  }, [showToast, tr]);
  useEffect(() => prefetchLazyDialogs(), []);

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
      // An Escape that cancels an IME candidate belongs to the IME.
      if (event.key === "Escape" && !event.isComposing) exitSelectMode();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelectMode]);

  // A filter change can hide a selected memo. Prune against the rendered feed
  // so a later batch action can never affect a card the user can no longer
  // see — and say so, since the picks left the count without a click. A
  // batch in flight is exempt: a sync can deliver its first committed chunk
  // before the last one returns, and the batch settles the selection itself.
  useEffect(() => {
    if (!selectMode || batchBusy) return;
    const next = selectionWithinVisibleIds(selected, visibleFeedIds);
    const unchanged = next.size === selected.size && [...next].every((id) => selected.has(id));
    if (unchanged) return;
    setSelected(next);
    setConfirmBatchDelete(false);
    const dropped = selected.size - next.size;
    if (selectionNoticeRef.current) dismissToast(selectionNoticeRef.current);
    if (next.size === 0) {
      // A sync can delete or filter away every failed retry target. Do not
      // strand the toolbar in an inert "0 selected" state.
      restoreLocationFocusRef.current = true;
      setSelectMode(false);
      selectionNoticeRef.current = showToast(
        tr("Selection cleared — the selected memos are no longer in view", "所选笔记已不在当前视图，选择已清除")
      );
    } else {
      selectionNoticeRef.current = showToast(
        tr(`${count(dropped, "memo")} left the selection — no longer in view`, `${count(dropped, "memo")}已不在当前视图，已从选择中移除`)
      );
    }
  }, [selectMode, batchBusy, selected, visibleFeedIds, showToast, dismissToast, count, tr]);

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
    // Onto a path already in use the two tags merge, and their memos can no
    // longer be told apart — no Undo for that. A plain rename reverses exactly.
    const merges = tagPathInUse(to);
    setDialogBusy(true);
    try {
      const result = await performTagRename(from, to, setRenameProgress);
      if (!result) return;
      setRenameTagTarget(null);
      if (merges) {
        showToast(tr(`Merged #${from} into #${to} in ${count(result.updated, "memo")}`, `已将 #${from} 合并到 #${to}，更新了 ${count(result.updated, "memo")}`));
      } else {
        showToast(tr(`Renamed #${from} to #${to} in ${count(result.updated, "memo")}`, `已将 #${from} 重命名为 #${to}，更新了 ${count(result.updated, "memo")}`), "info", {
          action: { label: tr("Undo", "撤销"), run: () => void tagRenameUndoRef.current(from, to) }
        });
      }
    } catch (cause) {
      void runSync();
      notifyPeers();
      showToast(errorMessage(cause, "Couldn’t rename the tag.", "重命名标签失败"), "error");
    } finally {
      setDialogBusy(false);
      setRenameProgress(null);
    }
  }

  /** True when `path` or a tag under it is on any memo, Trash included — renaming onto it merges. */
  function tagPathInUse(path: string): boolean {
    return memos.some((memo) => tagsOf(memo).some((tag) => tagMatches(tag, path)));
  }

  /**
   * Rename on the server, then carry every per-device reference along: the
   * open tag lens, saved presets, a stats drill-down and the review scope.
   */
  async function performTagRename(from: string, to: string, onProgress?: (fraction: number) => void) {
    const result = await guard(() => renameTag(from, to, onProgress));
    if (!result) return undefined;
    applySyncChanges(result.memos, [], result.tags);
    setActiveTag((current) => (current && tagMatches(current, from) ? to + current.slice(from.length) : current));
    setSavedFilters((current) => renameSavedFilterTags(current, from, to));
    setStatsDrilldown((current) =>
      current?.kind === "tag" && tagMatches(current.tag, from) ? { ...current, tag: to + current.tag.slice(from.length) } : current
    );
    followTagChangeInReview(renameReviewSettingsTag(reviewSettings, from, to), true);
    void runSync();
    notifyPeers();
    return result;
  }

  /** The rename toast's Undo: the same rename in reverse, unless that would now merge. */
  async function undoTagRename(from: string, to: string) {
    if (tagPathInUse(from)) {
      showToast(tr(`Couldn’t undo: #${from} is in use again`, `无法撤销：#${from} 已重新使用`), "error");
      return;
    }
    try {
      const result = await performTagRename(to, from);
      if (result) showToast(tr(`Renamed #${to} back to #${from}`, `已将 #${to} 改回 #${from}`));
    } catch (cause) {
      void runSync();
      notifyPeers();
      showToast(errorMessage(cause, "Couldn’t undo the rename.", "撤销重命名失败"), "error");
    }
  }
  // A toast's Undo outlives the render that created it; read the latest state.
  tagRenameUndoRef.current = undoTagRename;

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
      followTagChangeInReview(removeReviewSettingsTag(reviewSettings, path), false);
      void runSync();
      notifyPeers();
      showToast(tr(`Removed #${path} from ${count(result.updated, "memo")}`, `已从 ${count(result.updated, "memo")}中移除 #${path}`));
    } catch (cause) {
      void runSync();
      notifyPeers();
      showToast(errorMessage(cause, "Couldn’t remove the tag.", "移除标签失败"), "error");
    }
  }

  function showExportToast(text: string, detail: string | undefined, controller: AbortController): number {
    return showToast(text, "info", {
      detail,
      duration: STICKY_TOAST_MS,
      action: { label: tr("Stop", "停止"), run: () => controller.abort() }
    });
  }

  async function handleExport() {
    // One export at a time. Asking again only brings a dismissed progress
    // toast back into view.
    const running = exportRef.current;
    if (running) {
      if (!toastsRef.current.some((toast) => toast.id === running.toastId && !toast.leaving)) {
        running.toastId = showExportToast(running.text, running.detail, running.controller);
      }
      return;
    }
    const controller = new AbortController();
    const text = tr("Exporting your backup…", "正在导出备份…");
    const job: { controller: AbortController; toastId: number; text: string; detail?: string } = {
      controller,
      toastId: showExportToast(text, undefined, controller),
      text
    };
    exportRef.current = job;
    const finish = () => {
      if (exportRef.current === job) exportRef.current = null;
      dismissToast(job.toastId);
    };
    let blob: Blob | undefined;
    try {
      blob = await guard(() =>
        exportData({
          signal: controller.signal,
          onProgress: ({ done, total }) => {
            job.detail = tr(`${formatNumber(done)} of ${count(total, "memo")}`, `${formatNumber(done)} / ${count(total, "memo")}`);
            updateToastDetail(job.toastId, job.detail);
          }
        })
      );
    } catch (cause) {
      finish();
      if (controller.signal.aborted) showToast(tr("Stopped exporting your backup", "已停止导出备份"));
      else showToast(errorMessage(cause, "Couldn’t export the backup.", "导出备份失败"), "error");
      return;
    }
    finish();
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
  }

  async function handleImportFile(file: File) {
    try {
      // Validates and counts in one streaming pass; nothing of the file is
      // kept but its handle.
      const { memoCount, imageCount } = await inspectBackup(file);
      setImportTarget({ file, memoCount, imageCount });
    } catch (cause) {
      showToast(
        cause instanceof BackupFormatError
          ? tr("This isn’t a memo backup file.", "这不是有效的备份文件")
          : tr("Couldn’t read the backup file.", "无法读取备份文件"),
        "error"
      );
    }
  }

  function stopImport() {
    importAbortRef.current?.abort();
    setImportProgress((current) => (current ? { ...current, stopping: true } : current));
  }

  async function handleImportConfirmed() {
    if (!importTarget || importAbortRef.current) return;
    const { file } = importTarget;
    const controller = new AbortController();
    importAbortRef.current = controller;
    let done = 0;
    setDialogBusy(true);
    setImportProgress({ done: 0, stopping: false });
    try {
      const result = await guard(() =>
        importDataInChunks(readBackupItems(file), {
          signal: controller.signal,
          onProgress: (progress) => {
            done = progress.done;
            setImportProgress((current) => ({ done: progress.done, stopping: current?.stopping ?? false }));
          }
        })
      );
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
      // Earlier chunks are already committed; reconcile them and let a rerun
      // skip their stable ids.
      void runSync();
      notifyPeers();
      if (controller.signal.aborted) {
        setImportTarget(null);
        showToast(
          tr(
            `Stopped the import after ${count(done, "memo")}. Import the file again to pick up where it left off.`,
            `已停止导入，已处理 ${count(done, "memo")}。再次导入同一文件即可从中断处继续`
          )
        );
        return;
      }
      const reason = errorMessage(cause, "Couldn’t import the backup.", "导入备份失败");
      // A rerun resumes past the committed chunks, but only a transient
      // failure can get further: a rejected memo fails the same way again.
      // The reason's own closing stop is dropped so the hint always joins it
      // as a second sentence.
      if (done > 0 && isTransientImportFailure(cause)) {
        const base = reason.replace(/[.。]\s*$/u, "");
        showToast(tr(`${base}. Import the file again to pick up where it left off.`, `${base}，再次导入同一文件即可从中断处继续`), "error");
      } else {
        showToast(reason, "error");
      }
    } finally {
      if (importAbortRef.current === controller) importAbortRef.current = null;
      setDialogBusy(false);
      setImportProgress(null);
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
        <LoginScreen needsSetup={needsSetup} setupAllowed={setupAllowed} onLogin={handleLogin} onSetup={handleSetup} />
        <ToastStack toasts={toasts} dismissLabel={tr("Dismiss", "关闭")} regionLabel={tr("Notifications", "通知")} onDismiss={dismissToast} onPause={pauseToasts} onResume={resumeToasts} />
      </>
    );
  }

  const visibleSelectedCount = visibleSelected.size;
  const allVisibleSelected = feedMemos.length > 0 && visibleSelectedCount === feedMemos.length;
  // Select mode is a view's own: memos or Trash, each with its own verbs.
  const selectingTrash = selectMode && view === "trash";
  const selectingFeed = selectMode && (view === "memos" || view === "trash");

  function toggleSelectAll() {
    mutateSelection(() => {
      if (allVisibleSelected) setSelected(new Set());
      else setSelected(new Set(visibleFeedIds));
    });
  }

  // Permanent deletion inside Trash is two-step: the first click arms the
  // pill (it names the count), the second fires. Moving to Trash is undoable
  // from its toast, so an ordinary selection goes in one click; only a sweep
  // past BATCH_TRASH_CONFIRM_AT (a Select all over a big lens) still shows
  // the count first.
  function handleBatchDeleteClick() {
    if (batchBusy) return;
    if (!confirmBatchDelete && (selectingTrash || visibleSelectedCount > BATCH_TRASH_CONFIRM_AT)) {
      if (visibleSelectedCount > 0) setBatchDeleteArm(true);
      return;
    }
    setConfirmBatchDelete(false);
    if (selectingTrash) void purgeMany(selectedMemos(true));
    else void trashMany(selectedMemos(false), true);
  }

  // What "all" means while selecting: the lenses the toolbar replaced. The
  // count says how many; this says of what.
  const selectLens: string[] = [];
  if (selectMode && view === "memos") {
    if (activeTag) selectLens.push(`#${activeTag}`);
    if (activeDay) selectLens.push(formatDayLabel(activeDay, locale));
    if (statsChipLabel) selectLens.push(statsChipLabel);
    if (rangeChipLabel) selectLens.push(rangeChipLabel);
    for (const row of FACET_ROWS) if (filters[row.key]) selectLens.push(tr(row.en, row.zh));
    if (trimmedQuery) selectLens.push(`“${query.trim()}”`);
  }
  const armedDeleteLabel = selectingTrash
    ? tr(`Delete ${count(visibleSelectedCount, "memo")} forever?`, `彻底删除 ${count(visibleSelectedCount, "memo")}？`)
    : tr(`Move ${count(visibleSelectedCount, "memo")} to Trash?`, `将 ${count(visibleSelectedCount, "memo")}移入回收站？`);
  const batchBusyLabel = batchProgress
    ? tr(`Working… ${formatNumber(batchProgress.done)}/${formatNumber(batchProgress.total)}`, `处理中… ${formatNumber(batchProgress.done)}/${formatNumber(batchProgress.total)}`)
    : tr("Working…", "处理中…");

  return (
    <div className={`app-shell${reveal ? " first-reveal" : ""}`}>
      {/* Keyboard users skip the sidebar (stats, heatmap, the whole tag
          tree) and land at the top of the feed column: location, search,
          composer. Focus is lent to <main> only for the jump. */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          if (!main) return;
          main.setAttribute("tabindex", "-1");
          main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
          main.focus();
        }}
      >
        {tr("Skip to main content", "跳到主要内容")}
      </a>
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
          trashCount={trashedMemos.length}
          theme={theme}
          pinnedTags={pinnedTags}
          onSetTheme={setTheme}
          {...sidebarHandlers}
        />
      </aside>
      {drawerOpen ? <div className={`drawer-backdrop${drawerClosing ? " is-closing" : ""}`} onClick={() => closeDrawer()} /> : null}

      <main id="main-content" className="main-column">
        <div ref={topbarRef} className="topbar">
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
            {selectMode && (view === "memos" || view === "trash") ? (
              // Multi-select toolbar. The count pill inherits the fused
              // pill's view-transition-name, so entering the mode morphs the
              // location label into the live counter; the sibling pills
              // cascade in with the breadcrumb language. Inside Trash the
              // verbs are Restore and Delete forever.
              <div className="select-bar">
                <span className="select-count" aria-live="polite" aria-atomic="true">
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
                {selectLens.length > 0 ? (
                  <span className="select-lens" title={selectLens.join(" · ")}>
                    {tr("in ", "范围：")}
                    {selectLens.join(" · ")}
                  </span>
                ) : null}
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
                {selectingTrash ? (
                  <button
                    type="button"
                    className="select-pill select-tag select-restore"
                    disabled={visibleSelectedCount === 0 || batchBusy}
                    aria-label={tr("Restore selected memos", "恢复所选笔记")}
                    onClick={() => void restoreMany(selectedMemos(true), true)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    <span>{tr("Restore", "恢复")}</span>
                  </button>
                ) : (
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
                )}
                <button
                  type="button"
                  className={`select-delete${confirmBatchDelete ? " is-confirm" : ""}`}
                  disabled={visibleSelectedCount === 0 || batchBusy}
                  aria-label={
                    batchBusy
                      ? batchBusyLabel
                      : confirmBatchDelete
                        ? armedDeleteLabel
                        : selectingTrash
                          ? tr("Delete selected memos forever", "彻底删除所选笔记")
                          : tr("Move selected memos to Trash", "将所选笔记移入回收站")
                  }
                  onClick={handleBatchDeleteClick}
                  onBlur={() => setConfirmBatchDelete(false)}
                >
                  {batchBusy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                  <span>
                    {batchBusy
                      ? batchBusyLabel
                      : confirmBatchDelete
                        ? armedDeleteLabel
                        : selectingTrash
                          ? tr("Delete forever", "彻底删除")
                          : tr("Trash", "移入回收站")}
                  </span>
                </button>
                <button type="button" className="select-pill select-exit" onClick={exitSelectMode} aria-label={tr("Cancel selection", "取消多选")}>
                  <X size={14} className="select-exit-icon" aria-hidden="true" />
                  <span className="select-exit-label">{tr("Cancel", "取消")}</span>
                </button>
              </div>
            ) : view === "trash" ? (
              // Trash reuses the tag-drilldown breadcrumb language: ⌂ / 回收站,
              // same cascade-in, ⌂ steps back out to All memos (the trail
              // folds back on its own snapshot — see .view-trail).
              <nav className="crumbs view-trail" aria-label={tr("Location", "当前位置")}>
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
              <nav className="crumbs view-trail" aria-label={tr("Location", "当前位置")}>
                <button type="button" className="crumb crumb-home" onClick={showAll} aria-label={tr("All memos", "全部笔记")} style={{ animationDelay: "0s" }}>
                  <Home size={15} aria-hidden="true" />
                </button>
                <ChevronRight size={13} className="crumb-sep" aria-hidden="true" style={{ animationDelay: "0.015s" }} />
                <span className="crumb crumb-review is-current" aria-current="page" style={{ animationDelay: "0.035s" }}>
                  <Sparkles size={13} aria-hidden="true" />
                  {tr("Daily review", "每日回顾")}
                </span>
              </nav>
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
                  trigger={(open, triggerProps) => (
                    // Named by its visible text (where you are: All memos or
                    // the tag), so voice control can say what it sees; what
                    // the button does, and the sort in force, is the
                    // description.
                    <button
                      type="button"
                      {...triggerProps}
                      className={`loc-trigger${open ? " is-open" : ""}${activeTag ? "" : " is-root"}`}
                      aria-describedby={`${triggerProps.id}-desc`}
                      {...tip.bind(() => ({
                        strong: tr("Sort & select", "排序与多选"),
                        text: sortOptions.find((option) => option.key === sortKey)?.label ?? ""
                      }))}
                      onPointerDown={tip.hide}
                    >
                      <span className="loc-label">{activeTag ? activeTag.split("/").at(-1) : tr("All memos", "全部笔记")}</span>
                      {/* A sort other than newest-first is a lens too: it
                          shows on the pill, not only inside the menu. */}
                      {sortKey !== "created-desc" ? <ArrowDownUp size={13} className="loc-sort-mark" aria-hidden="true" /> : null}
                      <ChevronDown size={14} className="loc-caret" aria-hidden="true" />
                      <span id={`${triggerProps.id}-desc`} hidden>
                        {tr("Sort and select", "排序与多选")}: {sortOptions.find((option) => option.key === sortKey)?.label ?? ""}
                      </span>
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
            {view === "trash" && trashedMemos.length > 0 && !selectMode ? (
              // Select is Trash's way into multi-select (the feed's sits in
              // its location menu): pick several, restore or purge at once.
              <button type="button" className="trash-select-button" aria-label={tr("Select memos", "多选笔记")} onClick={() => enterSelectMode()}>
                <ListChecks size={14} aria-hidden="true" />
                <span>{tr("Select", "多选")}</span>
              </button>
            ) : null}
            {view === "trash" && trashedMemos.length > 0 && !selectMode ? (
              // Empty Trash lives in the same slot as Sort (and shares its
              // view-transition-name), so swapping views morphs one pill into
              // the other.
              <button
                type="button"
                className={`trash-empty-button${confirmEmptyTrash ? " is-confirm" : ""}`}
                // Older pages may still hold trashed memos this count misses,
                // and emptying purges them all; wait for the whole notebook.
                disabled={bootstrapLoad !== null}
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
            <div className="search-tools" role="search">
              <div className={`searchbox${searchOpen || searchText ? " is-open" : ""}`}>
                <Search size={15} className="searchbox-icon" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={searchText}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  aria-describedby="search-syntax-hint"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => {
                    // Mid-composition the box shows the IME's text but the
                    // feed waits; compositionend (or WebKit's trailing
                    // non-composing input event) hands over the result.
                    if (searchComposingRef.current || (event.nativeEvent as InputEvent).isComposing) {
                      setSearchComposition(event.target.value);
                      return;
                    }
                    typeQuery(event.target.value);
                  }}
                  onCompositionStart={(event) => {
                    searchComposingRef.current = true;
                    setSearchComposition(event.currentTarget.value);
                  }}
                  onCompositionEnd={(event) => {
                    searchComposingRef.current = false;
                    typeQuery(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    // Keys that confirm or cancel an IME candidate belong to it.
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Escape") {
                      if (query) {
                        // Consumed: select mode's window listener must not
                        // also back out on the same press.
                        event.preventDefault();
                        event.stopPropagation();
                        changeFeed(() => swapQuery(""));
                      } else event.currentTarget.blur();
                    } else if (event.key === "Enter" && window.matchMedia("(pointer: coarse)").matches) {
                      // The feed already follows each keystroke; on a phone
                      // the Search key just puts the keyboard away.
                      event.currentTarget.blur();
                    }
                  }}
                  onMouseEnter={(event) => {
                    if (document.activeElement !== event.currentTarget) tip.show(event.currentTarget, { text: searchSyntaxHint });
                  }}
                  onMouseLeave={tip.hide}
                  onFocus={() => {
                    tip.hide();
                    setSearchOpen(true);
                  }}
                  onBlur={() => setSearchOpen(false)}
                />
                <span id="search-syntax-hint" className="search-sr">
                  {searchSyntaxHint}
                </span>
                {searchText ? (
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
                // A switch only while idle: busy or stopped, a press opens the
                // details panel instead, and the name carries the state the
                // bubble shows (the bubble itself is aria-hidden).
                aria-pressed={semanticMonitor ? undefined : semanticOn}
                aria-haspopup={semanticMonitor ? "dialog" : undefined}
                aria-label={semanticState ? tr(`Semantic Search: ${semanticState}`, `语义搜索：${semanticState}`) : tr("Semantic Search", "语义搜索")}
                // The in-app bubble rather than a native title: it shows at
                // once, matches the funnel beside it, and names the state
                // (on / off / working) before the explanation.
                {...tip.bind(() => {
                  const indexProgress = semantic.live.getSnapshot().progress;
                  const text =
                    semantic.status === "error"
                      ? tr("Semantic search stopped — open details", "语义搜索已停止——打开详情")
                      : modelBusy
                        ? tr(
                            modelPhase === "downloading" ? "Downloading the semantic model — open progress" : "Starting the semantic model — open progress",
                            modelPhase === "downloading" ? "语义模型下载中——打开进度" : "语义模型启动中——打开进度"
                          )
                      : semantic.status === "indexing"
                        ? tr(
                            `Semantic search — indexing${indexProgress ? ` ${indexProgress.done}/${indexProgress.total}` : "…"}; keyword search remains available`,
                            `语义搜索——索引中${indexProgress ? ` ${indexProgress.done}/${indexProgress.total}` : "…"}；关键词搜索仍可用`
                          )
                        : semantic.queryBusy
                          ? tr("Semantic search is working — open progress", "语义搜索正在工作——打开进度")
                          : semantic.status === "preparing"
                            ? tr("Semantic model is loading — open progress", "语义模型正在加载——打开进度")
                            : semanticOn
                              ? tr(
                                  "Keyword matches stay first; related memos are added",
                                  "关键词命中优先，并补充意思相关的笔记"
                                )
                              : tr("Semantic search finds memos by meaning", "语义搜索：按意思找笔记");
                  return {
                    strong: semanticBusy || semantic.status === "error" ? undefined : semanticOn ? tr("Semantic search on", "语义搜索已开启") : undefined,
                    text
                  };
                })}
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
                minDay={minDay}
                openRequest={filterOpenRequest}
                onToggleFacet={toggleFacet}
                onDateChange={patchDateRange}
                onPresetRange={applyPresetRange}
                onClearDates={clearDateRange}
                onApplySaved={applySavedFilter}
                onDeleteSaved={deleteSavedFilter}
                onSaveCurrent={() => setSavingFilter(true)}
              />
              {/* The result line, read out once typing settles. */}
              <p className="search-sr" role="status">
                {searchAnnouncement}
              </p>
            </div>
          ) : view === "trash" && trashedMemos.length > 0 ? (
            // Trash's search: the same box, keywords only — no Brain, no
            // funnel. Its text never follows the reader out of Trash.
            <div className="search-tools">
              <div className={`searchbox${searchOpen || trashQuery ? " is-open" : ""}`}>
                <Search size={15} className="searchbox-icon" aria-hidden="true" />
                <input
                  value={trashQuery}
                  placeholder={tr("Search Trash", "搜索回收站")}
                  aria-label={tr("Search Trash", "搜索回收站")}
                  onChange={(event) => setTrashQuery(event.target.value)}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setSearchOpen(false)}
                />
                {trashQuery ? (
                  <button
                    type="button"
                    className="searchbox-clear"
                    aria-label={tr("Clear search", "清空搜索")}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      const input = event.currentTarget.parentElement?.querySelector("input");
                      changeFeed(() => setTrashQuery(""));
                      input?.focus();
                    }}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {bootstrapLoad ? (
          // A cold start shows its first page at once; this line counts the
          // rest in, and says so plainly if a page keeps failing (the next
          // attempt resumes where loading stopped). Not a live region: the
          // count ticks per page, so only a failure is spoken (see above).
          <div className="sync-notice">
            {bootstrapLoad.failed ? <CloudOff size={14} aria-hidden="true" /> : <Loader2 size={14} className="spin" aria-hidden="true" />}
            <span className="sync-notice-text">
              {bootstrapLoad.total === null
                ? bootstrapLoad.failed
                  ? tr(`Couldn’t load the rest of your memos · ${formatNumber(loadedMemoCount)} loaded`, `其余笔记载入失败 · 已载入 ${formatNumber(loadedMemoCount)} 条`)
                  : tr(`Loading memos · ${formatNumber(loadedMemoCount)} loaded`, `正在载入笔记 · 已载入 ${formatNumber(loadedMemoCount)} 条`)
                : bootstrapLoad.failed
                  ? tr(
                      `Couldn’t load the rest of your memos · ${formatNumber(loadedMemoCount)} of ${formatNumber(bootstrapLoad.total)} loaded`,
                      `其余笔记载入失败 · 已载入 ${formatNumber(loadedMemoCount)} / ${formatNumber(bootstrapLoad.total)}`
                    )
                  : tr(
                      `Loading memos · ${formatNumber(loadedMemoCount)} of ${formatNumber(bootstrapLoad.total)}`,
                      `正在载入笔记 · ${formatNumber(loadedMemoCount)} / ${formatNumber(bootstrapLoad.total)}`
                    )}
            </span>
            {bootstrapLoad.failed ? (
              <button type="button" className="sync-notice-retry" onClick={retryBootstrap}>
                {tr("Retry", "重试")}
              </button>
            ) : null}
          </div>
        ) : syncNotice ? (
          // Offline, or pulls failing while online. Until it clears, the feed
          // is the last good sync — which is still the whole notebook. Not a
          // live region itself: it mounts with its text, so the standing
          // regions speak it (see syncNotice).
          <div className="sync-notice">
            {syncStatus.online ? <CloudOff size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
            <span className="sync-notice-text">{syncNotice}</span>
            {syncStatus.online ? (
              <button type="button" className="sync-notice-retry" onClick={retrySync}>
                {tr("Retry", "重试")}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* data-searching: on phones an empty composer folds away while a
            search is up, so results start under the search box (app.css). */}
        <div className="composer" hidden={view !== "memos"} data-searching={view === "memos" && trimmedQuery ? "" : undefined}>
          <Editor
            mode="create"
            initialContent={composerSeed}
            onDraftChange={(content) => {
              composerDraftRef.current = content;
            }}
            knownTags={knownTags}
            contextTag={activeTag}
            busy={creating}
            onSubmit={handleCreate}
          />
        </div>

        <section
          ref={feedRef}
          className={`memo-feed${selectingFeed ? " is-select" : ""}${renderedFeedMemos.length <= SMALL_FEED ? " is-small" : ""}`}
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
          {searching && feedMemos.length > 0 ? (
            // Announced through the live region in the search tools, once
            // typing settles; this line is the one sighted readers scan.
            <p className="search-summary">
              {searchSummary}
            </p>
          ) : null}
          {feedMemos.length === 0 ? (
            <div className="feed-empty">
              {view === "trash" && trashedMemos.length > 0 ? (
                <>
                  <p className="feed-empty-title">{tr("No matching memos in Trash", "回收站里没有相关笔记")}</p>
                  <p>{tr("Try a different search.", "换个关键词试试")}</p>
                </>
              ) : view === "trash" ? (
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
              ) : searching && searchScopeText && (outsideHitCount > 0 || semanticOn) ? (
                <>
                  <p className="feed-empty-title">{searchEmptyTitle}</p>
                  <p>
                    {outsideHitCount > 0
                      ? tr(
                          `${count(outsideHitCount, "memo")} outside this view ${outsideHitCount === 1 ? "matches" : "match"}.`,
                          `范围外有 ${count(outsideHitCount, "memo")}匹配`
                        )
                      : tr("Memos outside this view may still match by meaning.", "范围外的笔记可能有意思相近的")}
                  </p>
                  <button type="button" className="ghost-button feed-empty-action" onClick={searchAllMemos}>
                    <Search size={15} aria-hidden="true" />
                    {tr("Search all memos", "在全部笔记中搜索")}
                  </button>
                </>
              ) : (
                <>
                  <p className="feed-empty-title">{searching ? searchEmptyTitle : tr("No matching memos", "没有找到相关笔记")}</p>
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
                editDraft={editingId === memo.id && reopenedDraft?.memoId === memo.id ? reopenedDraft.draft : null}
                selecting={selectingFeed}
                selected={selectingFeed && selected.has(memo.id)}
                canSelect={view === "memos" || view === "trash"}
                taskFlips={pendingTaskFlips.get(memo.id)}
                resumeContent={editSeed?.memoId === memo.id ? editSeed.content : undefined}
                busy={optimisticMemos.has(memo.id)}
                vtName={`memo-${memo.id}`}
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
      {shareMemo ? (
        <LazyDialog onFail={lazyDialogFailed}>
          <ShareDialog memo={shareMemo} onToast={showToast} onClose={() => setShareMemo(null)} />
        </LazyDialog>
      ) : null}
      {statsOpen ? (
        <LazyDialog onFail={lazyDialogFailed}>
          <StatsModal memos={activeMemos} uniqueTagCount={uniqueTagCount} onClose={() => setStatsOpen(false)} onDrilldown={openStatsDrilldown} />
        </LazyDialog>
      ) : null}
      {bulkTagOpen ? (
        <BulkTagDialog
          selectedCount={visibleSelectedCount}
          knownTags={knownTags}
          progress={batchProgress}
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
        <LazyDialog onFail={lazyDialogFailed}>
          <ReviewSettingsModal
            settings={reviewSettings}
            memos={activeMemos}
            knownTags={knownTags}
            onSave={handleSaveReviewSettings}
            onClose={() => setReviewSettingsOpen(false)}
          />
        </LazyDialog>
      ) : null}
      {modelSettingsOpen ? (
        <LazyDialog onFail={lazyDialogFailed}>
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
            semanticLive={semantic.live}
            semanticError={semantic.error}
            semanticIndexedMemos={semantic.indexedMemos}
            semanticRebuilding={semantic.rebuilding}
            semanticQuery={view === "memos" ? feedQuery : ""}
            attend={modelSettingsAttend}
          />
        </LazyDialog>
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
          tone="accent"
          progress={
            importProgress
              ? {
                  value: importProgress.done,
                  max: importTarget.memoCount,
                  text: tr(
                    `${formatNumber(importProgress.done)} of ${count(importTarget.memoCount, "memo")}`,
                    `${formatNumber(importProgress.done)} / ${count(importTarget.memoCount, "memo")}`
                  )
                }
              : undefined
          }
          onStop={importProgress && !importProgress.stopping ? stopImport : undefined}
          stopping={importProgress?.stopping}
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
          busyLabel={
            renameProgress === null
              ? tr("Renaming…", "重命名中…")
              : tr(`Renaming… ${formatNumber(Math.floor(renameProgress * 100))}%`, `重命名中… ${formatNumber(Math.floor(renameProgress * 100))}%`)
          }
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
            tagPathInUse(value)
              ? {
                  text: tr(`#${value} already exists. Merging the two tags can’t be undone.`, `#${value} 已存在，两个标签将合并，且无法撤销。`),
                  strong: true,
                  confirmLabel: tr("Merge", "合并"),
                  busyLabel:
                    renameProgress === null
                      ? tr("Merging…", "合并中…")
                      : tr(`Merging… ${formatNumber(Math.floor(renameProgress * 100))}%`, `合并中… ${formatNumber(Math.floor(renameProgress * 100))}%`)
                }
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
            showToast(tr("Updated your passcode. Other devices will ask for the new one.", "已更新密码，其他设备需要输入新密码"));
          }}
        />
      ) : null}
      {confirmLogout ? (
        <ConfirmDialog
          title={tr("Log out of this device?", "退出这台设备的登录？")}
          body={tr(
            "Your memos stay on the server. This device forgets its offline copy, search index, saved filters and Daily Review settings. Theme, language and the downloaded semantic search model stay.",
            "笔记仍保存在服务器上。这台设备会清除离线副本、搜索索引、已保存的筛选和每日回顾设置；主题、语言和已下载的语义搜索模型会保留。"
          )}
          confirmLabel={tr("Log Out", "退出登录")}
          busyLabel={tr("Logging out…", "正在退出…")}
          busy={loggingOut}
          onCancel={() => {
            if (!loggingOut) setConfirmLogout(false);
          }}
          onConfirm={() => void handleLogout()}
        />
      ) : null}
      <ToastStack toasts={toasts} dismissLabel={tr("Dismiss", "关闭")} regionLabel={tr("Notifications", "通知")} onDismiss={dismissToast} onPause={pauseToasts} onResume={resumeToasts} />
    </div>
  );
}
