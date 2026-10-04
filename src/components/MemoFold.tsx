import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "../lib/i18n";
import { SwapText } from "./SwapText";

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

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Depth of the fade at the folded edge — keep in step with --fold-fade's initial value. */
const FOLD_FADE = "56px";

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
  const motionRef = useRef<Animation | null>(null);
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
    const canAnimate = !reduced && typeof fold.animate === "function";
    // A reversal mid-flight starts from wherever the box is now.
    const running = motionRef.current;
    motionRef.current = null;
    if (!expanded) {
      const from = fold.getBoundingClientRect().height;
      running?.cancel();
      flushSync(() => {
        onExpandedChange(true);
        setUnfolding(canAnimate);
      });
      const to = fold.getBoundingClientRect().height;
      if (!canAnimate || to <= from) {
        if (canAnimate) setUnfolding(false);
        return;
      }
      // Unfold on one curve instead of a jump. The fade drains on the same
      // curve, so the edge dissolves as the text arrives instead of a hard
      // cut sliding down the card. Held at its end state until the class
      // that keeps the mask on is gone, so the fade never flashes back.
      const animation = fold.animate(
        [
          { height: `${from}px`, "--fold-fade": FOLD_FADE },
          { height: `${to}px`, "--fold-fade": "0px" }
        ],
        { duration: 260, easing: EASE_OUT, fill: "forwards" }
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
    // the viewport there is nothing to watch, so it snaps, and the toggle
    // stays where the pointer is so the reader does not land in some later
    // memo.
    const cardTop = (fold.closest(".memo-card") ?? fold).getBoundingClientRect().top;
    const from = fold.getBoundingClientRect().height;
    const before = button.getBoundingClientRect().top;
    running?.cancel();
    flushSync(() => {
      onExpandedChange(false);
      setUnfolding(false);
    });
    const to = fold.getBoundingClientRect().height;
    if (canAnimate && cardTop >= 0 && from > to) {
      // max-height rather than height: the folded rule's own cap takes over
      // exactly where the animation lands.
      motionRef.current = fold.animate(
        [
          { maxHeight: `${from}px`, "--fold-fade": "0px" },
          { maxHeight: `${to}px`, "--fold-fade": FOLD_FADE }
        ],
        { duration: 220, easing: EASE_OUT }
      );
      return;
    }
    const after = button.getBoundingClientRect().top;
    if (after < before) window.scrollBy({ top: after - before, behavior: "instant" });
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
