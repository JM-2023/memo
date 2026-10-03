import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "../lib/i18n";

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
  const { tr } = useI18n();
  const foldRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const live = onExpandedChange !== undefined;

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
    if (!expanded) {
      const from = fold.getBoundingClientRect().height;
      flushSync(() => onExpandedChange(true));
      const to = fold.getBoundingClientRect().height;
      if (reduced || typeof fold.animate !== "function" || to <= from) return;
      // Unfold on one curve instead of a jump; clip while the box is short.
      fold.style.overflow = "clip";
      const animation = fold.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 260, easing: EASE_OUT });
      const release = () => {
        fold.style.overflow = "";
      };
      animation.finished.then(release, release);
      return;
    }
    // Folding a long body pulls everything below it up by hundreds of
    // pixels; keep the toggle where the pointer is so the reader does not
    // land in some later memo.
    const before = button.getBoundingClientRect().top;
    flushSync(() => onExpandedChange(false));
    const after = button.getBoundingClientRect().top;
    if (after < before) window.scrollBy({ top: after - before, behavior: "instant" });
  }

  // A link or tag below the fold that receives keyboard focus would sit
  // focused but invisible; unfold for it.
  function revealFocused(target: EventTarget) {
    const fold = foldRef.current;
    if (expanded || !onExpandedChange || !fold?.hasAttribute("data-overflow") || !(target instanceof Element)) return;
    if (target.getBoundingClientRect().bottom > fold.getBoundingClientRect().bottom - 24) onExpandedChange(true);
  }

  return (
    <>
      <div
        ref={foldRef}
        id={regionId}
        className={`memo-fold${expanded ? " is-expanded" : ""}`}
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
        <span>{expanded ? tr("Show less", "收起") : tr("Show more", "展开全文")}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </>
  );
}
