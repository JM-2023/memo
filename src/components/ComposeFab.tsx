import { Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

/** Scroll that must build up one way before the button moves (the topbar tuck's slack). */
const SLACK = 12;

interface ComposeFabProps {
  /** The view has a composer to bring back (All memos, not Trash or Daily review). */
  available: boolean;
  onActivate: () => void;
}

/**
 * The phone's way back to the composer from deep in the feed: a round
 * new-memo button in the thumb's corner (app.css shows it at phone widths
 * only). It stands down while the composer is on screen, tucks away while
 * the reader scrolls down and comes back on the way up, and rides above a
 * toast at the bottom edge (--toast-lift). Scroll state stays here, so
 * scrolling never re-renders App.
 */
export function ComposeFab({ available, onActivate }: ComposeFabProps) {
  const { tr } = useI18n();
  const [composerOnScreen, setComposerOnScreen] = useState(true);
  const [tucked, setTucked] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const shown = available && !composerOnScreen && !tucked;

  useLayoutEffect(() => {
    if (slotRef.current) slotRef.current.inert = !shown;
  }, [shown]);

  useEffect(() => {
    if (!available) return;
    let anchorY = window.scrollY;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = document.querySelector(".composer:not([hidden])")?.getBoundingClientRect();
      const barBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      // A composer folded away under a search (height 0) is not on screen;
      // the button unfolds it before the caret goes in (revealComposer).
      setComposerOnScreen(Boolean(rect && rect.height > 0 && rect.bottom > barBottom && rect.top < window.innerHeight));
      // Clamped to the real range: iOS's bounce past either end is no direction.
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const y = Math.min(Math.max(0, window.scrollY), max);
      const delta = y - anchorY;
      if (Math.abs(delta) < SLACK) return;
      anchorY = y;
      setTucked(delta > 0);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // Folding away under a search and back (app.css) moves no scroll: the
    // button follows the composer's own size too.
    const composer = document.querySelector(".composer:not([hidden])");
    const resize = composer && typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : null;
    if (composer) resize?.observe(composer);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resize?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [available]);

  return (
    <div ref={slotRef} className={`compose-fab-slot${shown ? " is-shown" : ""}`} aria-hidden={!shown}>
      <button type="button" className="compose-fab" aria-label={tr("New memo", "写一条")} tabIndex={shown ? 0 : -1} onClick={onActivate}>
        <Plus size={24} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </div>
  );
}
