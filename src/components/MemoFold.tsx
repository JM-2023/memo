import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "../lib/i18n";
import { SwapText } from "./SwapText";
import { EASE, EASE_OUT, T_BASE, T_ENTER, T_EXIT } from "../lib/motion";
import { SCROLL_JUMP_EVENT } from "../lib/navHistory";

/** Visible body height of a folded memo — keep in step with .memo-fold's max-height. */
export const FOLD_HEIGHT = 320;
/** Fold only when it hides at least this much more: a toggle that reveals
    two lines costs a tap and saves nothing. */
const FOLD_SLACK = 96;

/**
 * Cheap upper bound, no layout: could this text render taller than the fold
 * threshold? (Generous rows-per-character for a phone-width card.) Most
 * memos fail it and never pay for a measurement or the wrapper.
 */
export function mightFold(content: string): boolean {
  let rows = 1 + content.length / 16;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) rows += 1;
  return rows > 14;
}

interface MemoFoldProps {
  /** The memo text the children render — re-measured whenever it changes. */
  content: string;
  expanded: boolean;
  /** Absent on the inert ghost copy (MemoStage's measure layer). */
  onExpandedChange?: (expanded: boolean) => void;
  /** id for the clamped region (the toggle's aria-controls). */
  regionId?: string;
  /** The `.memo-content` element. */
  children: ReactNode;
}

/** Depth of the fade at the folded edge — keep in step with --fold-fade's initial value. */
const FOLD_FADE = "56px";
/**
 * Show less with the card's top above the viewport: how long the roll back to
 * the memo's start takes. A short base, plus 10ms per 100px travelled, so
 * a very long memo does not streak past in a blur; capped. Off the motion
 * steps on purpose: the pace follows the distance.
 */
function rollDuration(distance: number): number {
  return Math.min(560, 280 + distance / 10);
}

/* Search hits a folded body hides. useSearchHighlight publishes, per fold
   element, how many hits there are when every one of them sits below the
   cut, and the toggle says so: a highlight nobody can see is no help. Keyed
   by element so the fold needs no memo id; each paint replaces the whole
   map, so a fold that left the feed leaves the map with it. */
let hiddenHits: ReadonlyMap<Element, number> = new Map();
const hiddenHitListeners = new Set<() => void>();

/** Replace the hidden-hit counts; an empty map clears them. */
export function publishHiddenHits(next: ReadonlyMap<Element, number>): void {
  if (next.size === hiddenHits.size && [...next].every(([fold, count]) => hiddenHits.get(fold) === count)) return;
  hiddenHits = next;
  for (const listener of hiddenHitListeners) listener();
}

function subscribeHiddenHits(listener: () => void): () => void {
  hiddenHitListeners.add(listener);
  return () => hiddenHitListeners.delete(listener);
}

/**
 * Height clamp for a long memo body, with a Show more / Show less toggle.
 *
 * Whether the body overflows is measured before paint and written straight
 * onto the DOM (`data-overflow`) rather than into React state: MemoStage
 * measures the card in its own layout effect right after this one, so the
 * clamp has to be in place within the same commit or its height tweens would
 * aim at the unfolded size. CSS hides the toggle while the attribute is absent.
 */
export function MemoFold({ content, expanded, onExpandedChange, regionId, children }: MemoFoldProps) {
  const { formatNumber, tr } = useI18n();
  const foldRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // The running fold motion — an Animation, or the roll's own handle.
  const motionRef = useRef<{ cancel(): void } | null>(null);
  // .is-unfolding keeps the fade on past .is-expanded while it drains away.
  const [unfolding, setUnfolding] = useState(false);
  const live = onExpandedChange !== undefined;
  const hidden = useSyncExternalStore(
    subscribeHiddenHits,
    () => (live && foldRef.current ? hiddenHits.get(foldRef.current) ?? 0 : 0),
    () => 0
  );

  useLayoutEffect(() => {
    const fold = foldRef.current;
    const body = fold?.firstElementChild;
    if (!fold || !(body instanceof HTMLElement)) return;
    const measure = () => fold.toggleAttribute("data-overflow", body.offsetHeight > FOLD_HEIGHT + FOLD_SLACK);
    measure();
    // Width changes rewrap the text; only the live card needs to follow.
    if (!live || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [content, live]);

  function toggle() {
    const fold = foldRef.current;
    const button = toggleRef.current;
    if (!fold || !button || !onExpandedChange) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canFade = typeof fold.animate === "function";
    const canAnimate = !reduced && canFade;
    // A reversal mid-flight starts from wherever the box is now.
    const running = motionRef.current;
    motionRef.current = null;
    if (!expanded) {
      const from = fold.getBoundingClientRect().height;
      running?.cancel();
      flushSync(() => {
        onExpandedChange(true);
        setUnfolding(canFade);
      });
      const to = fold.getBoundingClientRect().height;
      if (!canFade || to <= from) {
        if (canFade) setUnfolding(false);
        return;
      }
      // Unfold on one curve instead of a jump. The fade drains on the same
      // curve, so the edge dissolves as the text arrives instead of a hard
      // cut sliding down the card. Held at its end state until the class
      // that keeps the mask on is gone, so the fade never flashes back.
      // Under reduced motion the box opens at once and only the fade
      // drains, over --t: nothing travels, and nothing cuts either.
      const animation = fold.animate(
        reduced
          ? [{ "--fold-fade": FOLD_FADE }, { "--fold-fade": "0px" }]
          : [
              { height: `${from}px`, "--fold-fade": FOLD_FADE },
              { height: `${to}px`, "--fold-fade": "0px" }
            ],
        reduced ? { duration: T_BASE, easing: EASE, fill: "forwards" } : { duration: T_ENTER, easing: EASE_OUT, fill: "forwards" }
      );
      motionRef.current = animation;
      const release = () => {
        if (motionRef.current !== animation) return;
        motionRef.current = null;
        flushSync(() => setUnfolding(false));
        animation.cancel();
      };
      animation.finished.then(release, () => undefined);
      return;
    }
    // Folding pulls everything below the body up by hundreds of pixels. With
    // the card's top in view the reader watches it close in place: the box
    // eases down to the fold while the fade comes back. With the top above
    // the viewport the toggle stays where the pointer is, so the reader does
    // not land in some later memo, and the page rolls back to the memo's
    // start: the page scrolls up on one curve while the box closes by
    // exactly what it scrolled, frame by frame, so everything above the
    // toggle slides down past it instead of jumping in one frame.
    const cardTop = (fold.closest(".memo-card") ?? fold).getBoundingClientRect().top;
    const from = fold.getBoundingClientRect().height;
    const before = button.getBoundingClientRect().top;
    running?.cancel();
    flushSync(() => {
      onExpandedChange(false);
      setUnfolding(false);
    });
    const to = fold.getBoundingClientRect().height;
    if (!canAnimate || from <= to) {
      const after = button.getBoundingClientRect().top;
      if (after < before) window.scrollBy({ top: after - before, behavior: "instant" });
      // Reduced motion: the box snapped shut, and the fade pours back in
      // place over --t rather than appearing as a hard edge.
      if (reduced && canFade && from > to) {
        motionRef.current = fold.animate([{ "--fold-fade": "0px" }, { "--fold-fade": FOLD_FADE }], { duration: T_BASE, easing: EASE });
      }
      return;
    }
    if (cardTop >= 0) {
      // max-height rather than height: the folded rule's own cap takes over
      // exactly where the animation lands. Closing is an exit: its beat.
      motionRef.current = fold.animate(
        [
          { maxHeight: `${from}px`, "--fold-fade": "0px" },
          { maxHeight: `${to}px`, "--fold-fade": FOLD_FADE }
        ],
        { duration: T_EXIT, easing: EASE }
      );
      return;
    }
    // The page only scrolls in whole device pixels, so a box eased on its own
    // would leave the toggle a fraction off on each frame, rounding to a
    // pixel up or down. Instead the curve paces the scroll, and the box is cut to
    // exactly what the scroll paid back. The fade's animation is the clock.
    const fade = fold.animate([{ "--fold-fade": "0px" }, { "--fold-fade": FOLD_FADE }], { duration: rollDuration(from - to), easing: EASE });
    fold.style.maxHeight = `${from}px`;
    const roll = {
      cancel() {
        fade.cancel();
        fold.style.maxHeight = "";
      }
    };
    motionRef.current = roll;
    // Counted from what each scroll actually moved, so a wheel turned
    // mid-roll is never undone.
    let given = 0;
    // What the page's top kept it from scrolling: the toggle has to rise.
    let blocked = 0;
    const follow = () => {
      if (motionRef.current !== roll || !fold.isConnected) return;
      const done = fade.playState === "finished";
      const progress = done ? 1 : fade.effect?.getComputedTiming().progress ?? 0;
      const owed = (from - to) * progress - given - blocked;
      if (owed > 0) {
        const y = window.scrollY;
        // The app is moving the page, not the reader: the phone topbar's
        // search row stays as it was.
        window.dispatchEvent(new Event(SCROLL_JUMP_EVENT));
        window.scrollBy({ top: -owed, behavior: "instant" });
        const moved = y - window.scrollY;
        given += moved;
        // Under a pixel short is rounding, paid on a later frame.
        if (owed - moved >= 1) blocked += owed - moved;
      }
      if (done) {
        // The folded rule takes over; the toggle settles the last fraction.
        motionRef.current = null;
        fold.style.maxHeight = "";
        return;
      }
      fold.style.maxHeight = `${from - given - blocked}px`;
      window.requestAnimationFrame(follow);
    };
    window.requestAnimationFrame(follow);
  }

  // A link or tag below the fold that receives keyboard focus would sit
  // focused but invisible; unfold for it.
  function revealFocused(target: EventTarget) {
    const fold = foldRef.current;
    if (expanded || !onExpandedChange || !fold?.hasAttribute("data-overflow") || !(target instanceof Element)) return;
    if (target.getBoundingClientRect().bottom > fold.getBoundingClientRect().bottom - 24) {
      // A fold still closing would otherwise keep capping the opened box.
      motionRef.current?.cancel();
      motionRef.current = null;
      onExpandedChange(true);
    }
  }

  const label = expanded
    ? tr("Show less", "收起")
    : hidden > 0
      ? tr(`Show more · ${formatNumber(hidden)} ${hidden === 1 ? "match" : "matches"}`, `展开 · ${formatNumber(hidden)} 处匹配`)
      : tr("Show more", "展开全文");

  return (
    <>
      <div
        ref={foldRef}
        id={regionId}
        className={`memo-fold${expanded ? " is-expanded" : ""}${unfolding ? " is-unfolding" : ""}`}
        onFocus={live ? (event) => revealFocused(event.target) : undefined}
      >
        {children}
      </div>
      <button
        ref={toggleRef}
        type="button"
        className="memo-fold-toggle"
        aria-expanded={live ? expanded : undefined}
        aria-controls={live ? regionId : undefined}
        tabIndex={live ? undefined : -1}
        onClick={live ? toggle : undefined}
      >
        <SwapText id={label}>{label}</SwapText>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </>
  );
}
