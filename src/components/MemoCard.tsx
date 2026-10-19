import { Check, Copy, ImageOff, ListChecks, Loader2, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Share, Tags, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { externalImagesOf } from "../lib/content";
import { formatTime } from "../lib/dates";
import { isUnfolded, rememberFold } from "../lib/foldMemory";
import { useI18n } from "../lib/i18n";
import { externalImageSize, mediaGridProps } from "../lib/imageLayout";
import { visualLinesOf, type VisualLine } from "../lib/lineDiff";
import { parseBlock } from "../lib/markdown";
import { BUSY_HOLD_MS, EXIT_MS } from "../lib/motion";
import type { SendState } from "../lib/outbox";
import { wordCountOf } from "../lib/stats";
import type { LightboxItem, Memo, MemoImage, NewImagePayload } from "../lib/types";
import { Editor, type EditDraft, type EditHandle } from "./Editor";
import { openLightboxFrom } from "./Lightbox";
import { MemoFold, mightFold } from "./MemoFold";
import { MemoLine } from "./memoLines";
import { MemoStage } from "./MemoStage";
import { Menu } from "./Menu";
import { ExternalImageButton, ExternalImageFrame, StoredImageButton, StoredImageFrame } from "./StoredImage";

interface MemoCardProps {
  memo: Memo;
  variant: "normal" | "trash";
  knownTags: string[];
  editing: boolean;
  savingEdit: boolean;
  editConflict: boolean;
  /** Multi-select mode: the whole card becomes a toggle, actions retire. */
  selecting: boolean;
  selected: boolean;
  /** `extend`: a shift-click, which takes the range from the last pick. */
  onToggleSelect: (extend?: boolean) => void;
  /** A search result found by meaning alone: none of the query's words are in it. */
  related?: boolean;
  /** Enter select mode with this card picked; absent where a view has none. */
  onSelect?: () => void;
  onStartEdit: () => void;
  /** `draft` carries a dirty edit for the Undo on its "Discarded" toast. */
  onCancelEdit: (draft: EditDraft | null) => void;
  /** A discarded draft being reopened by that Undo. */
  editDraft?: EditDraft | null;
  onSaveEdit: (data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  onAcceptEditConflict: () => void;
  onTogglePin: () => void;
  onAddTag: () => void;
  onCopy: () => void;
  onShare: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onPickTag: (path: string) => void;
  onOpenImage: (items: LightboxItem[], index: number) => void;
  /** Feed checkbox click; lineKey indexes memo.content.split("\n"). */
  onToggleTask: (lineKey: number, checked: boolean) => void;
  /** Optimistic per-line checkbox states while toggles are in flight. */
  pendingTaskFlips?: ReadonlyMap<number, boolean>;
  /** Text an edit resumes with after a re-login, instead of memo.content. */
  resumeContent?: string;
  /** The open editor's text after each change (held in memory only). */
  onEditDraftChange?: (content: string) => void;
  /** A toast the open editor raises on its own (an image removed, with Undo). */
  onEditNotice?: (text: string, action?: { label: string; run: () => void }) => void;
  /** The open editor's handle, as it opens and as it goes (see EditHandle). */
  onEditHandle?: (handle: EditHandle, open: boolean) => void;
  /** A pin / trash / restore for this memo is in flight (already shown
      optimistically): those actions hold until it settles. */
  busy?: boolean;
  /** Rendered just before the stamp (Daily review's "A year ago ·"). */
  stampPrefix?: ReactNode;
  /** Leads the head's right side (Daily review's seen check). */
  headMark?: ReactNode;
  /**
   * Daily review's row of actions under the body. Called with `live` false
   * for the stage's inert twin, which keeps the row's height without its
   * controls; `edit` opens the editor as the menu's Edit does.
   */
  reviewActions?: (slot: { live: boolean; edit: () => void }) => ReactNode;
  /** A memo still on its way to the server (App's outbox): its head says so
      where the time sits, and offers the send's own actions instead of ⋯. */
  sendState?: SendState;
  /** The composer holds a draft, so this memo cannot go back into it. */
  recallBlocked?: boolean;
  /** 撤回 while sending, 编辑 once it failed: back into the composer. */
  onTakeBack?: () => void;
  onRetrySend?: () => void;
  onDiscardUnsent?: () => void;
}

const NO_EDIT = () => undefined;

interface MemoMenuBodyProps {
  memo: Memo;
  close: () => void;
  inTrash: boolean;
  pinned: boolean;
  busy: boolean;
  onTogglePin: () => void;
  onStartEdit: () => void;
  onAddTag: () => void;
  onCopy: () => void;
  onShare: () => void;
  onSelect?: () => void;
  onDelete: () => void;
  onPurge: () => void;
}

/**
 * Menu rows. Moving to Trash is one step — its toast carries Undo — so only
 * the permanent delete inside Trash keeps a confirmation: that item swaps the
 * menu body for a prompt + confirm/cancel pair instead of raising a modal.
 * The state lives here (the panel unmounts on close), so a reopened menu
 * always starts back at the action list. Restore lives on the trash card
 * itself, not in here.
 */
function MemoMenuBody({ memo, close, inTrash, pinned, busy, onTogglePin, onStartEdit, onAddTag, onCopy, onShare, onSelect, onDelete, onPurge }: MemoMenuBodyProps) {
  const { count, locale, tr } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const promptId = useId();

  let actions: ReactNode;
  if (confirming) {
    // The prompt is the confirm item's description, so a screen reader
    // hears "can't be undone" along with the button itself. Focus starts on
    // Cancel (data-menu-autofocus): a reflexive second Enter backs out.
    actions = (
      <>
        <span id={promptId} className="action-menu__prompt">
          {tr("Delete forever? This can’t be undone.", "彻底删除？此操作无法撤销")}
        </span>
        <button
          type="button"
          role="menuitem"
          className="danger"
          aria-describedby={promptId}
          onClick={() => {
            close();
            onPurge();
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {tr("Delete forever", "彻底删除")}
        </button>
        <button type="button" role="menuitem" data-menu-autofocus="" onClick={() => setConfirming(false)}>
          <X size={16} aria-hidden="true" />
          {tr("Cancel", "取消")}
        </button>
      </>
    );
  } else if (inTrash) {
    actions = (
      <>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onCopy();
          }}
        >
          <Copy size={16} aria-hidden="true" />
          {tr("Copy content", "复制内容")}
        </button>
        {onSelect ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onSelect();
            }}
          >
            <ListChecks size={16} aria-hidden="true" />
            {tr("Select", "多选")}
          </button>
        ) : null}
        <span className="action-menu__sep" />
        <button type="button" role="menuitem" className="danger" onClick={() => setConfirming(true)}>
          <Trash2 size={16} aria-hidden="true" />
          {tr("Delete permanently", "彻底删除")}
        </button>
      </>
    );
  } else {
    actions = (
      <>
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            close();
            onTogglePin();
          }}
        >
          {pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
          {pinned ? tr("Unpin", "取消置顶") : tr("Pin", "置顶")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onStartEdit();
          }}
        >
          <Pencil size={16} aria-hidden="true" />
          {tr("Edit", "编辑")}
        </button>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="dialog"
          onClick={() => {
            close();
            onAddTag();
          }}
        >
          <Tags size={16} aria-hidden="true" />
          {tr("Add tag", "添加标签")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onCopy();
          }}
        >
          <Copy size={16} aria-hidden="true" />
          {tr("Copy content", "复制内容")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onShare();
          }}
        >
          <Share size={16} aria-hidden="true" />
          {tr("Share as image", "分享为图片")}
        </button>
        {onSelect ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onSelect();
            }}
          >
            <ListChecks size={16} aria-hidden="true" />
            {tr("Select", "多选")}
          </button>
        ) : null}
        <span className="action-menu__sep" />
        <button
          type="button"
          role="menuitem"
          className="danger"
          disabled={busy}
          onClick={() => {
            close();
            onDelete();
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {tr("Move to Trash", "移入回收站")}
        </button>
      </>
    );
  }

  return (
    <>
      {actions}
      {/* The confirm swap takes over the whole panel; a meta footer under a
          destructive prompt just competes with it, so it retires while
          confirming. */}
      {!confirming ? (
        <>
          <span className="action-menu__sep" role="separator" />
          <div className="memo-menu-meta" role="presentation">
            <span>{count(wordCountOf(memo), "character")}</span>
            {/* updatedAt equals createdAt until the first real edit — only then
                is an "Edited" time worth showing (the card already carries the
                send time). */}
            {memo.updatedAt !== memo.createdAt ? (
              <time dateTime={memo.updatedAt}>
                {tr("Edited", "编辑于")} {formatTime(memo.updatedAt, locale)}
              </time>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * Bring a card that a save carried off screen back into view, its top just
 * under the sticky topbar. Measured by layout (offsets), not by the painted
 * box: a card the feed is still easing to its new place with a transform
 * would read as where it left from. A far trip jumps most of the way first
 * and glides the last screen and a half — a native smooth scroll across
 * hundreds of content-visibility cards gets cut short by scroll anchoring
 * (see ScrollTopButton).
 */
function revealCard(card: HTMLElement) {
  let top = 0;
  for (let node: HTMLElement | null = card; node; node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null) top += node.offsetTop;
  const bottom = top + card.offsetHeight;
  const band = Math.max(0, document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0);
  const viewTop = window.scrollY + band;
  const viewBottom = window.scrollY + window.innerHeight;
  if (bottom > viewTop && top < viewBottom) return;
  const target = Math.max(0, top - band - 16);
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const span = window.innerHeight * 1.5;
  const distance = target - window.scrollY;
  if (!reduced && Math.abs(distance) > span) window.scrollTo({ top: target - Math.sign(distance) * span, behavior: "instant" });
  window.scrollTo({ top: target, behavior: reduced ? "instant" : "smooth" });
}

/** The select rings' ripple: one step per card, and where it stops. */
const SELECT_RING_STEP_MS = 15;
const SELECT_RING_MAX_MS = 90;

/**
 * Entering select mode pops each card's ring in turn down the screen. The
 * order is counted among the cards the reader can see, from the top of the
 * view — not from the top of the feed, where a reader deep in it saw every
 * ring land at once on the cap, and a review masthead above the list
 * shifted the count by one. Rendered inside the feed; draws nothing.
 */
export function SelectRingStagger({ active, feedRef }: { active: boolean; feedRef: RefObject<HTMLElement> }) {
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!active || !feed) return;
    // Under the sticky topbar is out of view too.
    const top = Math.max(0, document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0);
    const bottom = window.innerHeight;
    const staggered: HTMLElement[] = [];
    for (const slot of Array.from(feed.children)) {
      if (!(slot instanceof HTMLElement) || !slot.classList.contains("memo-slot")) continue;
      const box = slot.getBoundingClientRect();
      if (box.bottom <= top) continue;
      if (box.top >= bottom) break;
      // Before the rings' first frame: the delay is read as they start.
      slot.style.setProperty("--sbd", `${Math.min(staggered.length * SELECT_RING_STEP_MS, SELECT_RING_MAX_MS)}ms`);
      staggered.push(slot);
    }
    return () => {
      for (const slot of staggered) slot.style.removeProperty("--sbd");
    };
  }, [active, feedRef]);
  return null;
}

/**
 * A shift-click's range lands as a ripple from the anchor toward the card
 * clicked, on the rings' own steps (15ms a card up to 90ms), counted among
 * the cards on screen. Its own variable (--srd, read as a transition delay
 * by app.css) rather than --sbd: --sbd times the rings' entrance animation,
 * and moving its delay after the fact could replay it. Call before the
 * selection commits, so the delays are in place when the transitions start.
 */
export function rippleSelectRange(feed: HTMLElement | null, ids: readonly string[]): void {
  if (!feed || ids.length < 2) return;
  const slots = new Map<string, HTMLElement>();
  for (const slot of Array.from(feed.children)) {
    if (slot instanceof HTMLElement && slot.dataset.vt) slots.set(slot.dataset.vt, slot);
  }
  const top = Math.max(0, document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0);
  const rippled: HTMLElement[] = [];
  for (const id of ids) {
    const slot = slots.get(`memo-${id}`);
    if (!slot) continue;
    const box = slot.getBoundingClientRect();
    if (box.bottom <= top || box.top >= window.innerHeight) continue;
    slot.style.setProperty("--srd", `${Math.min(rippled.length * SELECT_RING_STEP_MS, SELECT_RING_MAX_MS)}ms`);
    slot.dataset.ripple = "";
    rippled.push(slot);
  }
  // Past the last step and its transition, a single tap answers at once again.
  window.setTimeout(() => {
    for (const slot of rippled) {
      slot.style.removeProperty("--srd");
      delete slot.dataset.ripple;
    }
  }, SELECT_RING_MAX_MS + 400);
}

/** Done and total task boxes as the card draws them; a flip in flight counts as landed. */
function taskProgressOf(lines: readonly VisualLine[], flips?: ReadonlyMap<number, boolean>): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of lines) {
    const block = parseBlock(line.raw);
    if (block.kind !== "task") continue;
    total += 1;
    if (flips?.get(line.key) ?? block.checked) done += 1;
  }
  return { done, total };
}

/**
 * "1/3" after the stamp: how far a memo's tasks have got. Ticking the last
 * open box turns it the accent with a check, which pops only when that
 * happens in front of the reader (as the pin mark does), not on each mount.
 */
function TaskProgress({ done, total }: { done: number; total: number }) {
  const { tr } = useI18n();
  const complete = done === total;
  const [seen, setSeen] = useState(complete);
  const [pop, setPop] = useState(false);
  if (seen !== complete) {
    setSeen(complete);
    setPop(complete);
  }
  return (
    <span className={`memo-progress${complete ? " is-complete" : ""}`}>
      {/* "1/3" alone reads as a fraction. */}
      <span className="sr-only">{tr(`${done} of ${total} tasks done`, `已完成 ${done}/${total} 项任务`)}</span>
      <span className="memo-progress-figure" aria-hidden="true">
        {complete ? (
          <Check size={12} strokeWidth={2.8} className={`memo-progress-check${pop ? " is-new" : ""}`} onAnimationEnd={() => setPop(false)} />
        ) : null}
        {done}/{total}
      </span>
    </span>
  );
}

/** The ghost header's twin of the live count, read off the content it replays. */
function ContentTaskProgress({ content }: { content: string }) {
  const { done, total } = useMemo(() => taskProgressOf(visualLinesOf(content)), [content]);
  return total > 0 ? <TaskProgress done={done} total={total} /> : null;
}

/** A touch held this long, and this still, picks the card. */
const HOLD_MS = 450;
const HOLD_SLOP_PX = 8;
/** Pressed here, a hold or a right-click is the platform's (a link's or picture's own menu, a field). */
const NATIVE_PRESS = "a[href], img, .memo-image, input, textarea, [contenteditable], .action-menu";

/**
 * After a hold has picked a card, the finger is still down: the long press
 * that follows must not also open the platform's menu, and the tap its lift
 * may still fire must not toggle the card straight back out.
 */
function swallowHoldRelease(pointerId: number): void {
  const block = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const done = () => {
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
    window.removeEventListener("contextmenu", block, true);
    window.removeEventListener("click", block, true);
    window.clearTimeout(timer);
  };
  function lift(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
    window.addEventListener("click", block, true);
    // The lift's tap, if it comes, comes at once.
    window.clearTimeout(timer);
    timer = window.setTimeout(done, 350);
  }
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);
  window.addEventListener("contextmenu", block, true);
  // A finger that never lifts (or a lost pointerup) lets go of the guards anyway.
  let timer = window.setTimeout(done, 3000);
}

export function MemoCard(props: MemoCardProps) {
  const { locale, tr } = useI18n();
  const { memo, variant, editing, selecting, selected } = props;
  // External links that failed to load render as a compact fallback chip.
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(new Set());
  const articleRef = useRef<HTMLElement>(null);
  const viewSurfaceRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const previousEditingRef = useRef(editing);
  // How the open edit was last driven — a keyboard reader's focus must never
  // be left somewhere off screen when the edit closes (see below).
  const editInputRef = useRef<"keyboard" | "pointer">("pointer");
  // Where a double-click asked the editor to put its caret; null = the end.
  const editCaretRef = useRef<{ offset: number; viewportY: number } | null>(null);
  // Long bodies fold to a fixed height; this card's reader can unfold it.
  // The choice outlives the card (lib/foldMemory): a card remounted by a
  // lens change or a trip to Trash comes back open if it was left open, so
  // the reading place restored around it still lands where it was taken.
  const [expanded, setExpanded] = useState(() => isUnfolded(memo.id));
  const memoId = memo.id;
  const changeExpanded = useCallback(
    (next: boolean) => {
      rememberFold(memoId, next);
      setExpanded(next);
    },
    [memoId]
  );
  const foldId = useId();
  // The card is named by its time, as its ⋯ is (see menuLabel).
  const timeId = useId();

  // A touch held still on the card opens select mode with it picked — the
  // phone's way into selection, where no shift key or ⋯ hover exists.
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const holdRef = useRef<{ pointer: number; x: number; y: number; timer: number } | null>(null);
  const [holding, setHolding] = useState(false);
  const releaseHold = useCallback(() => {
    const hold = holdRef.current;
    if (!hold) return;
    window.clearTimeout(hold.timer);
    holdRef.current = null;
    setHolding(false);
  }, []);
  useEffect(() => releaseHold, [releaseHold]);

  function startHold(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType !== "touch" || !event.isPrimary || !props.onSelect || selecting || editing) return;
    if (event.target instanceof Element && event.target.closest(NATIVE_PRESS)) return;
    releaseHold();
    const pointer = event.pointerId;
    const timer = window.setTimeout(() => {
      holdRef.current = null;
      setHolding(false);
      swallowHoldRelease(pointer);
      window.getSelection()?.removeAllRanges();
      try {
        navigator.vibrate?.(10);
      } catch {
        // Not every engine lets a page buzz.
      }
      onSelectRef.current?.();
    }, HOLD_MS);
    holdRef.current = { pointer, x: event.clientX, y: event.clientY, timer };
    setHolding(true);
  }

  function moveHold(event: ReactPointerEvent<HTMLElement>) {
    const hold = holdRef.current;
    if (hold && hold.pointer === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) >= HOLD_SLOP_PX) releaseHold();
  }

  // Right-click opens the card's own ⋯ menu (from its trigger: the menu
  // has no anchor point of its own). A link's, a picture's or selected
  // text's menu stays the platform's, as does a touch's long press.
  const [menuSignal, setMenuSignal] = useState(0);
  function openMenuFromContext(event: ReactMouseEvent<HTMLElement>) {
    // An unsent card has no ⋯ (its send's own actions stand in for it): a
    // menu opened unseen would hold the keys and pop up once it is sent.
    // The platform's menu stays.
    if (props.sendState) return;
    // A platform whose long press beats the hold: the hold still wins.
    if (holdRef.current) {
      event.preventDefault();
      return;
    }
    if (selecting || editing) return;
    if ((event.nativeEvent as MouseEvent & { pointerType?: string }).pointerType === "touch") return;
    if (event.target instanceof Element && event.target.closest(NATIVE_PRESS)) return;
    const picked = window.getSelection();
    if (picked && !picked.isCollapsed && picked.toString().trim() && articleRef.current?.contains(picked.anchorNode)) return;
    event.preventDefault();
    setMenuSignal((value) => value + 1);
  }

  // One stable task callback for every row (rows pass their own lineKey), so
  // memoized MemoLines don't re-render just because the card did.
  const onToggleTaskRef = useRef(props.onToggleTask);
  onToggleTaskRef.current = props.onToggleTask;
  const toggleTask = useCallback((lineKey: number, checked: boolean) => onToggleTaskRef.current(lineKey, checked), []);

  // The select overlay is the card's only control in selection mode. `inert`
  // keeps the covered tag/image/link controls out of keyboard navigation,
  // while aria-hidden removes the duplicate surface from virtual cursors.
  useLayoutEffect(() => {
    if (viewSurfaceRef.current) viewSurfaceRef.current.inert = selecting;
  }, [selecting]);

  useEffect(() => {
    const card = articleRef.current;
    if (!editing || !card) return;
    editInputRef.current = "pointer";
    const onKey = () => {
      editInputRef.current = "keyboard";
    };
    const onPointer = () => {
      editInputRef.current = "pointer";
    };
    card.addEventListener("keydown", onKey, true);
    card.addEventListener("pointerdown", onPointer, true);
    return () => {
      card.removeEventListener("keydown", onKey, true);
      card.removeEventListener("pointerdown", onPointer, true);
    };
  }, [editing]);

  // Cancel/save unmounts the focused editor. Once the steady card surface has
  // committed, return focus to its action trigger instead of letting it fall
  // back to <body> and restart the page's tab order. A save can carry the
  // card off screen (a re-sort under "Edited" order lifts it to the top):
  // the feed then hands focus to the card that took this one's place, at
  // the reader's place (handleSaveEdit), and that choice stands — focus
  // already parked outside this card is left alone. Otherwise focus goes
  // with the memo, and the page only follows it for a keyboard reader,
  // whose focus ring would otherwise be nowhere to be seen.
  useEffect(() => {
    const wasEditing = previousEditingRef.current;
    previousEditingRef.current = editing;
    if (!wasEditing || editing) return;
    const viaKeyboard = editInputRef.current === "keyboard";
    // MemoStage deliberately keeps the outgoing editor connected during its
    // exit morph, so connectivity cannot be used as a focus-restoration guard.
    const frame = window.requestAnimationFrame(() => {
      const trigger = menuTriggerRef.current;
      const card = articleRef.current;
      const active = document.activeElement;
      if (!trigger || (active && active !== document.body && !card?.contains(active))) return;
      trigger.focus({ preventScroll: true });
      if (viaKeyboard && card?.isConnected) revealCard(card);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  // The pin mark pops when this card sees its memo become pinned — not on
  // every mount of the mark (first load, a lens bringing the card in, the
  // view scene coming back when an edit closes). Unpinning plays the same
  // pop backwards: the mark stays for the exit beat, then goes.
  const pinned = Boolean(memo.pinnedAt);
  const [pinSeen, setPinSeen] = useState(pinned);
  const [pinPop, setPinPop] = useState(false);
  const [pinLeaving, setPinLeaving] = useState(false);
  if (pinSeen !== pinned) {
    setPinSeen(pinned);
    setPinPop(pinned);
    setPinLeaving(!pinned);
  }
  // A timer, not animationend: an off-screen slot (content-visibility)
  // never runs the animation, and its mark must still go.
  useEffect(() => {
    if (!pinLeaving) return;
    const timer = window.setTimeout(() => setPinLeaving(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [pinLeaving]);

  // A send's state stands where the time will. Once the server has the
  // memo, the time dissolves in over what stood there — over nothing when
  // "Sending…" was still waiting out its hold (app.css), so a fast send
  // never flashes it.
  const sendState = props.sendState;
  const [sendSeen, setSendSeen] = useState(() => (sendState ? { state: sendState, since: performance.now() } : null));
  const [stampArriving, setStampArriving] = useState<SendState | "quiet" | null>(null);
  // The send's buttons trade places as it moves on; focus on one of them
  // goes to what takes its place (below), not to <body>. Read as the
  // change renders, while the DOM still shows the old buttons.
  const sendFocusRef = useRef(false);
  if ((sendState ?? null) !== (sendSeen?.state ?? null)) {
    if (!sendState && sendSeen) setStampArriving(sendSeen.state !== "sending" || performance.now() - sendSeen.since >= BUSY_HOLD_MS ? sendSeen.state : "quiet");
    else setStampArriving(null);
    setSendSeen(sendState ? { state: sendState, since: performance.now() } : null);
    const active = document.activeElement;
    sendFocusRef.current = active instanceof Element && active.closest(".memo-send-actions") !== null && articleRef.current?.contains(active) === true;
  }
  // A timer, as for the pin mark: an off-screen slot never runs the animation.
  useEffect(() => {
    if (!stampArriving) return;
    const timer = window.setTimeout(() => setStampArriving(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [stampArriving]);
  useLayoutEffect(() => {
    if (!sendFocusRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    sendFocusRef.current = false;
    articleRef.current?.querySelector<HTMLElement>(sendState ? ".memo-send-action" : ".memo-menu-trigger")?.focus({ preventScroll: true });
  }, [sendState]);

  // A lone linked picture is drawn square until the browser knows its
  // shape; learning it re-renders the card, and a shape learned from a load
  // (not one known at mount) eases the box to it (.is-reshaping).
  const [, setShapesKnown] = useState(0);
  const [reshaping, setReshaping] = useState(false);
  const onExternalSize = useCallback((loaded: boolean) => {
    setShapesKnown((value) => value + 1);
    if (loaded) setReshaping(true);
  }, []);
  useEffect(() => {
    if (!reshaping) return;
    const timer = window.setTimeout(() => setReshaping(false), 400);
    return () => window.clearTimeout(timer);
  }, [reshaping]);

  const externalUrls = useMemo(() => externalImagesOf(memo.content), [memo.content]);
  const lightboxItems = useMemo<LightboxItem[]>(
    () => [
      // The id lets the viewer draw the copy the tile already holds.
      ...memo.images.map((image) => ({ src: `/api/images/${image.id}`, imageId: image.id })),
      ...externalUrls.filter((url) => !brokenUrls.has(url)).map((url) => ({ src: url, external: true }))
    ],
    [memo.images, externalUrls, brokenUrls]
  );

  const lines = useMemo(() => visualLinesOf(memo.content), [memo.content]);
  const foldable = useMemo(() => mightFold(memo.content), [memo.content]);
  const inTrash = variant === "trash";
  const progress = useMemo(() => taskProgressOf(lines, props.pendingTaskFlips), [lines, props.pendingTaskFlips]);
  const busy = Boolean(props.busy);
  const mediaCount = memo.images.length + externalUrls.length;
  // Media-set fingerprint for the stage's change detection.
  const mediaKey = useMemo(() => [...memo.images.map((image) => image.id), ...externalUrls].join("|"), [memo.images, externalUrls]);
  // A lone linked picture's shape, once known, sizes the grid as a stored
  // one's dimensions do (read fresh each render: see onExternalSize).
  const mediaGrid = mediaGridProps(mediaCount, memo.images[0] ?? (externalUrls.length > 0 ? externalImageSize(externalUrls[0]) : undefined));

  function startEditFromDoubleClick(target: EventTarget, clientY: number) {
    if (editing || selecting || inTrash || sendState) return;

    // Preserve the behavior of controls embedded in a memo. A double-click on
    // a tag, link, image or action button belongs to that control, and one
    // inside a code or formula block selects a word (a triple-click, a line)
    // to copy; the card's otherwise inert surface is the shortcut for
    // entering edit mode.
    if (target instanceof Element && target.closest("button, a, input, textarea, select, [contenteditable], .md-codeblock, .md-math-block")) return;

    editCaretRef.current = caretFromDoubleClick(target, clientY);
    props.onStartEdit();
  }

  /** Edit from a control: the caret goes to the end, as from the menu. */
  function startEditPlain() {
    editCaretRef.current = null;
    props.onStartEdit();
  }

  /**
   * Map a double-click on the rendered text back to a source offset, so the
   * editor opens with its caret on that line: after the clicked word when
   * the browser's word selection can be found in the source line, else at
   * the line's end. Rows in .memo-content are 1:1 with visualLinesOf (see
   * lib/lineDiff), whose keys index content.split("\n").
   */
  function caretFromDoubleClick(target: EventTarget, clientY: number): { offset: number; viewportY: number } | null {
    const container = target instanceof Element ? target.closest(".memo-content") : null;
    let row = target instanceof Element ? target : null;
    while (row && row.parentElement !== container) row = row.parentElement;
    if (!container || !row) return null;
    const line = visualLinesOf(memo.content)[Array.prototype.indexOf.call(container.children, row)];
    if (!line) return null;
    let lineStart = 0;
    for (let k = 0; k < line.key; k++) lineStart = memo.content.indexOf("\n", lineStart) + 1;
    // line.raw is display text (references resolved, "| " added to unbordered
    // table rows); measure on the row's own source lines instead. Only fenced
    // code and math rows span more than one.
    const source = memo.content
      .split("\n")
      .slice(line.key, line.key + line.raw.split("\n").length)
      .join("\n");
    let offset = lineStart + source.length;
    const selection = window.getSelection();
    const word = selection?.toString().trim() ?? "";
    if (selection && selection.rangeCount > 0 && word && !word.includes("\n")) {
      const picked = selection.getRangeAt(0);
      if (row.contains(picked.startContainer)) {
        const before = document.createRange();
        before.setStart(row, 0);
        before.setEnd(picked.startContainer, picked.startOffset);
        // Markers and hidden syntax make the source longer than the text:
        // pick the occurrence nearest the same relative spot.
        const rowLength = row.textContent?.length ?? 0;
        const expected = rowLength > 0 ? (before.toString().length / rowLength) * source.length : 0;
        let best = -1;
        for (let at = source.indexOf(word); at !== -1; at = source.indexOf(word, at + 1)) {
          if (best === -1 || Math.abs(at - expected) < Math.abs(best - expected)) best = at;
        }
        if (best !== -1) offset = lineStart + best + word.length;
      }
    }
    return { offset: Math.min(offset, memo.content.length), viewportY: clientY };
  }

  function markBroken(url: string) {
    setBrokenUrls((value) => {
      const next = new Set(value);
      next.add(url);
      return next;
    });
  }

  // In Trash the stamp is the deletion time, and the state is said in words
  // and weight ("Deleted" at 600) rather than in alarm red.
  const stamp = formatTime(inTrash ? memo.deletedAt ?? memo.createdAt : memo.createdAt, locale);
  const timeLabel = inTrash ? (
    <>
      <span className="memo-time-state">{tr("Deleted", "删除于")}</span> {stamp}
    </>
  ) : (
    stamp
  );
  // Each card's controls are told apart by its time — 80 identical "Memo
  // actions" buttons give a screen-reader user nothing to choose by.
  const menuLabel = inTrash ? tr(`Memo actions, deleted ${stamp}`, `笔记操作，删除于 ${stamp}`) : tr(`Memo actions, ${stamp}`, `笔记操作，${stamp}`);
  const sendLabel = (state: SendState) =>
    state === "sending" ? (
      <>
        <Loader2 size={11} className="spin" aria-hidden="true" />
        <span className="memo-send-text">{tr("Sending…", "发送中…")}</span>
      </>
    ) : (
      <>
        <span className="memo-send-dot" aria-hidden="true" />
        <span className="memo-send-text">
          {state === "refused"
            ? tr("Not sent · the server refused it", "未发送 · 服务器未接受")
            : state === "retrying"
              ? tr("Not sent · retrying", "未发送 · 正在重试")
              : tr("Not sent · will retry when you’re online", "未发送 · 联网后会自动补发")}
        </span>
      </>
    );
  const sendStateClass = (state: SendState) => `memo-send-state ${state === "sending" ? "is-sending" : "is-failed"}`;
  const time = (
    <time id={timeId} className={`memo-time${stampArriving ? " is-arriving" : ""}`} dateTime={inTrash ? memo.deletedAt ?? memo.createdAt : memo.createdAt}>
      {timeLabel}
    </time>
  );

  const renderBody = (content: string, contentLines: ReturnType<typeof visualLinesOf>, live: boolean) => {
    const body = (
      <div className="memo-content">
        {contentLines.map((line, index, all) =>
          live ? (
            <MemoLine
              key={line.key}
              raw={line.raw}
              nextRaw={all[index + 1]?.raw}
              tagMode={inTrash ? "static" : "button"}
              onPickTag={props.onPickTag}
              lineKey={line.key}
              onToggleTask={toggleTask}
              taskCheckedOverride={props.pendingTaskFlips?.get(line.key)}
            />
          ) : (
            <MemoLine key={line.key} raw={line.raw} nextRaw={all[index + 1]?.raw} tagMode={inTrash ? "static" : "ghost"} />
          )
        )}
      </div>
    );
    if (!(live ? foldable : mightFold(content))) return body;
    return (
      <MemoFold content={content} expanded={expanded} onExpandedChange={live ? changeExpanded : undefined} regionId={live ? foldId : undefined}>
        {body}
      </MemoFold>
    );
  };

  // Inert clone of one content line — replay overlay + ghost measure layer.
  // Tags keep their live look (ghosts must be pixel-identical to the card).
  const renderGhostLine = (raw: string, nextRaw?: string) => (
    <MemoLine raw={raw} nextRaw={nextRaw} tagMode={inTrash ? "static" : "ghost"} />
  );

  // Inert media grid of an arbitrary (content, images) state — same classes
  // as the live grid so geometry and paint match exactly.
  const renderGhostMedia = (content: string, images: MemoImage[]) => {
    const urls = externalImagesOf(content);
    const count = images.length + urls.length;
    if (count === 0) return null;
    return (
      <div {...mediaGridProps(count, images[0] ?? (urls.length > 0 ? externalImageSize(urls[0]) : undefined))}>
        {images.map((image) => (
          <StoredImageFrame key={image.id} image={image} sizing={count === 1 ? "auto" : "thumb"} />
        ))}
        {urls.map((url) =>
          brokenUrls.has(url) ? (
            <div key={url} className="memo-image-broken">
              <ImageOff size={16} aria-hidden="true" />
              <span>{tr("Image link is unavailable", "图片链接已失效")}</span>
            </div>
          ) : (
            <ExternalImageFrame key={url} url={url} />
          )
        )}
      </div>
    );
  };

  // The ghost's header is the live one's twin, pin and ⋯ included: during a
  // remote update the ghost is the opaque top layer, and a header missing
  // them made the pin (and the touch-visible ⋯) blink out and fade back.
  // The ⋯ and the select ring are inert stand-ins; CSS mirrors the live
  // trigger's open/focus state onto them.
  const renderGhost = (content: string, images: MemoImage[]) => (
    <>
      <header className="memo-head">
        {props.stampPrefix}
        <time className="memo-time">{timeLabel}</time>
        {inTrash ? null : <ContentTaskProgress content={content} />}
        <div className="memo-head-right">
          {props.headMark}
          {props.related ? <span className="memo-related">{tr("Related", "意思相近")}</span> : null}
          {pinned && !inTrash ? <Pin size={13} className="memo-pin-mark" aria-hidden="true" /> : null}
          {inTrash ? (
            <span className="memo-restore">
              <RotateCcw size={13} aria-hidden="true" />
              {tr("Restore", "恢复")}
            </span>
          ) : null}
          <div className="memo-tool-slot">
            <span className="icon-button memo-menu-trigger">
              <MoreHorizontal size={17} aria-hidden="true" />
            </span>
            <span className="memo-select-box">
              <Check size={13} strokeWidth={3.2} />
            </span>
          </div>
        </div>
      </header>
      {renderBody(content, visualLinesOf(content), false)}
      {renderGhostMedia(content, images)}
      {props.reviewActions?.({ live: false, edit: NO_EDIT })}
    </>
  );

  const viewBody = (
    <>
      <div ref={viewSurfaceRef} className="memo-view-surface" aria-hidden={selecting || undefined}>
        <header className="memo-head">
          {props.stampPrefix}
          {sendState ? (
            <span key={sendState} id={timeId} className={sendStateClass(sendState)}>
              {sendLabel(sendState)}
            </span>
          ) : stampArriving ? (
            <span className="memo-stamp-swap">
              {time}
              {stampArriving !== "quiet" ? (
                <span className={`${sendStateClass(stampArriving)} is-leaving`} aria-hidden="true">
                  {sendLabel(stampArriving)}
                </span>
              ) : null}
            </span>
          ) : (
            time
          )}
          {progress.total > 0 && !inTrash && !sendState ? <TaskProgress done={progress.done} total={progress.total} /> : null}
          <div className="memo-head-right">
            {props.headMark}
            {props.related ? <span className="memo-related">{tr("Related", "意思相近")}</span> : null}
            {sendState ? (
              // The send's own actions; the ⋯ (hidden, app.css) has nothing
              // to act on before the server has the memo.
              <div className={`memo-send-actions${sendState === "sending" ? " is-holding" : ""}`}>
                {sendState === "sending" ? (
                  <button type="button" className="memo-send-action" aria-disabled={props.recallBlocked || undefined} onClick={props.onTakeBack}>
                    {tr("Take back", "撤回")}
                  </button>
                ) : (
                  <>
                    <button type="button" className="memo-send-action is-primary" onClick={props.onRetrySend}>
                      {tr("Retry", "重试")}
                    </button>
                    <button type="button" className="memo-send-action" aria-disabled={props.recallBlocked || undefined} onClick={props.onTakeBack}>
                      {tr("Edit", "编辑")}
                    </button>
                    <button type="button" className="memo-send-action" onClick={props.onDiscardUnsent}>
                      {tr("Discard", "舍弃")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
            {pinned && !inTrash ? (
              <Pin
                size={13}
                className={`memo-pin-mark${pinPop ? " is-new" : ""}`}
                aria-label={tr("Pinned", "已置顶")}
                onAnimationEnd={() => setPinPop(false)}
              />
            ) : pinLeaving && !inTrash ? (
              // Already unpinned: the leaving mark says nothing.
              <Pin key="leaving" size={13} className="memo-pin-mark is-leaving" aria-hidden="true" />
            ) : null}
            {/* Restore is the one thing a trashed memo is for: it sits on the
                card, always visible, instead of behind a hover-only ⋯. */}
            {inTrash ? (
              <button
                type="button"
                className="memo-restore"
                disabled={busy}
                tabIndex={selecting ? -1 : undefined}
                aria-label={tr(`Restore memo deleted ${stamp}`, `恢复删除于 ${stamp} 的笔记`)}
                onClick={props.onRestore}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {tr("Restore", "恢复")}
              </button>
            ) : null}
            {/* The ⋯ menu and the select ring share one 26px cell: entering
                select mode swaps them in place with zero layout shift. */}
            <div className="memo-tool-slot">
              <Menu
                panelClassName="memo-action-menu"
                openSignal={menuSignal}
                trigger={(open, triggerProps) => (
                  <button
                    ref={menuTriggerRef}
                    type="button"
                    {...triggerProps}
                    className={`icon-button memo-menu-trigger${open ? " is-open" : ""}`}
                    aria-label={menuLabel}
                    tabIndex={selecting ? -1 : 0}
                  >
                    <MoreHorizontal size={17} aria-hidden="true" />
                  </button>
                )}
              >
                {(close) => (
                  <MemoMenuBody
                    memo={memo}
                    close={close}
                    inTrash={inTrash}
                    pinned={pinned}
                    busy={busy}
                    onTogglePin={props.onTogglePin}
                    onStartEdit={() => {
                      editCaretRef.current = null;
                      props.onStartEdit();
                    }}
                    onAddTag={props.onAddTag}
                    onCopy={props.onCopy}
                    onShare={props.onShare}
                    onSelect={props.onSelect}
                    onDelete={props.onDelete}
                    onPurge={props.onPurge}
                  />
                )}
              </Menu>
              <span className="memo-select-box" aria-hidden="true">
                <Check size={13} strokeWidth={3.2} />
              </span>
            </div>
          </div>
        </header>

        {/* Tags stay live buttons while selecting: the surface is inert then,
            and CSS dims them — re-rendering every row as static pills made
            entering select mode re-parse the whole mounted feed. */}
        {renderBody(memo.content, lines, true)}

        {mediaCount > 0 ? (
          <div
            {...mediaGrid}
            className={`${mediaGrid.className}${reshaping ? " is-reshaping" : ""}`}
          >
            {memo.images.map((image, index) => (
              <StoredImageButton
                key={image.id}
                image={image}
                sizing={mediaCount === 1 ? "auto" : "thumb"}
                tabIndex={selecting ? -1 : undefined}
                lightboxIndex={index}
                onOpen={(tile) => openLightboxFrom(tile, () => props.onOpenImage(lightboxItems, index))}
                label={mediaCount > 1 ? tr(`View image ${index + 1} of ${mediaCount}`, `查看图片 ${index + 1}/${mediaCount}`) : tr("View image", "查看图片")}
              />
            ))}
            {externalUrls.map((url, urlIndex) =>
              brokenUrls.has(url) ? (
                <a
                  key={url}
                  className="memo-image-broken"
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={url}
                  tabIndex={selecting ? -1 : undefined}
                >
                  <ImageOff size={16} aria-hidden="true" />
                  <span>{tr("Image link is unavailable", "图片链接已失效")}</span>
                </a>
              ) : (
                <ExternalImageButton
                  key={url}
                  url={url}
                  tabIndex={selecting ? -1 : undefined}
                  lightboxIndex={lightboxItems.findIndex((item) => item.src === url)}
                  onOpen={(tile) =>
                    openLightboxFrom(tile, () => props.onOpenImage(lightboxItems, Math.max(0, lightboxItems.findIndex((item) => item.src === url))))
                  }
                  onBroken={() => markBroken(url)}
                  onShape={mediaCount === 1 ? onExternalSize : undefined}
                  label={
                    mediaCount > 1
                      ? tr(
                          `View external image ${memo.images.length + urlIndex + 1} of ${mediaCount}`,
                          `查看外链图片 ${memo.images.length + urlIndex + 1}/${mediaCount}`
                        )
                      : tr("View external image", "查看外链图片")
                  }
                />
              )
            )}
          </div>
        ) : null}

        {props.reviewActions?.({ live: true, edit: startEditPlain })}
      </div>

      {selecting ? (
        // One interactive surface for the whole card: it sits above every
        // inner control (tags, images, the retired ⋯ menu), so a tap
        // anywhere toggles selection and nothing else can fire.
        <button
          type="button"
          className="memo-select-overlay"
          aria-pressed={selected}
          aria-label={selected ? tr("Deselect this memo", "取消选择这条笔记") : tr("Select this memo", "选择这条笔记")}
          onClick={(event) => props.onToggleSelect(event.shiftKey)}
        />
      ) : null}
    </>
  );

  return (
    <article
      ref={articleRef}
      aria-labelledby={timeId}
      className={`memo-card${pinned && !inTrash ? " is-pinned" : ""}${inTrash ? " is-trash" : ""}${selecting ? " is-selecting" : ""}${
        selected ? " is-selected" : ""
      }${sendState ? ` is-unsent${sendState === "sending" ? "" : " is-send-failed"}` : ""}${stampArriving ? " is-settling" : ""}${holding ? " is-holding" : ""}`}
      onDoubleClick={(event) => startEditFromDoubleClick(event.target, event.clientY)}
      onPointerDown={startHold}
      onPointerMove={holding ? moveHold : undefined}
      onPointerUp={holding ? releaseHold : undefined}
      onPointerCancel={holding ? releaseHold : undefined}
      onContextMenu={openMenuFromContext}
    >
      <MemoStage
        editing={editing}
        content={memo.content}
        mediaKey={mediaKey}
        images={memo.images}
        view={viewBody}
        editor={
          editing ? (
            <Editor
              mode="edit"
              initialContent={memo.content}
              onDraftChange={props.onEditDraftChange}
              onNotice={props.onEditNotice}
              onHandle={props.onEditHandle}
              onOpenImage={props.onOpenImage}
              existingImages={memo.images}
              knownTags={props.knownTags}
              busy={props.savingEdit}
              conflictMessage={
                props.editConflict
                  ? tr(
                      "This memo changed elsewhere. Your draft is preserved. Continue only if you intend to save it over the latest version.",
                      "这条笔记已在别处更新。你的草稿已保留；确认要基于最新版本继续后，再次保存会覆盖远端内容。"
                    )
                  : null
              }
              onAcceptRemoteBase={props.onAcceptEditConflict}
              onSubmit={props.onSaveEdit}
              onCancel={props.onCancelEdit}
              initialDraft={
                props.editDraft ??
                (props.resumeContent !== undefined
                  ? {
                      content: props.resumeContent,
                      newImages: [],
                      removedIds: [],
                      selectionStart: props.resumeContent.length,
                      selectionEnd: props.resumeContent.length
                    }
                  : null)
              }
              initialCaret={editCaretRef.current}
              autoFocus
            />
          ) : null
        }
        renderGhost={renderGhost}
        renderGhostMedia={renderGhostMedia}
        renderLine={renderGhostLine}
      />
    </article>
  );
}
