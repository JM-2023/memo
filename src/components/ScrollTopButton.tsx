import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

/** Show once the page has scrolled a full viewport; hide at the very top. */
const AT_TOP = 2;
/** Exponential glide time constant — remaining distance halves every ~76ms. */
const FLIGHT_TAU = 110;
/** Linear floor (px per ms) so the exponential tail still lands crisply. */
const LANDING_FLOOR = 1.6;
/** User gestures that should cancel the glide and hand the wheel back. */
const INTERRUPTS: (keyof WindowEventMap)[] = ["wheel", "touchstart", "mousedown", "keydown"];

/**
 * Back-to-top disc — the ChatGPT scroll-to-bottom button mirrored: same
 * frosted glass, same slot choreography (quick shrink-away, deliberate
 * delayed rise-in), opposite direction. Scroll state stays local so wheel
 * events never re-render App. The slot lives at the end of the main column
 * and sticks to the viewport bottom, which keeps it centered on the content
 * column at every width for free.
 *
 * The glide is driven by hand rather than scrollTo({behavior: "smooth"}):
 * sweeping up through content-visibility:auto cards materializes them, and
 * the scroll-anchoring adjustments that follow can swallow a native smooth
 * scroll mid-flight. Absolute per-frame writes always win that fight.
 */
export function ScrollTopButton() {
  const { tr } = useI18n();
  const [shown, setShown] = useState(false);
  // True while our glide is in flight: mid-flight scroll events keep the
  // button as-is instead of re-deciding visibility every frame.
  const programmaticRef = useRef(false);
  const flightFrameRef = useRef<number | null>(null);
  const detachInterruptsRef = useRef<(() => void) | null>(null);

  const endFlight = () => {
    if (flightFrameRef.current !== null) {
      window.cancelAnimationFrame(flightFrameRef.current);
      flightFrameRef.current = null;
    }
    detachInterruptsRef.current?.();
    detachInterruptsRef.current = null;
    programmaticRef.current = false;
  };
  const endFlightRef = useRef(endFlight);
  endFlightRef.current = endFlight;

  // The composer marks the top of the page: once it has fully scrolled out
  // of view, the way back up is worth a button. Cached between scrolls and
  // re-queried when a view switch swaps it out (trash has none — fall back
  // to a viewport of scroll).
  const composerRef = useRef<Element | null>(null);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (y <= AT_TOP) {
        setShown(false);
        return;
      }
      if (programmaticRef.current) return;
      let composer = composerRef.current;
      if (!composer || !composer.isConnected) {
        composer = document.querySelector(".composer");
        composerRef.current = composer;
      }
      setShown(composer ? composer.getBoundingClientRect().bottom < 0 : y > window.innerHeight);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      endFlightRef.current();
    };
  }, []);

  const scrollToTop = () => {
    endFlight();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo(0, 0);
      setShown(false);
      return;
    }
    programmaticRef.current = true;

    const onInterrupt = () => endFlight();
    for (const type of INTERRUPTS) window.addEventListener(type, onInterrupt, { passive: true });
    detachInterruptsRef.current = () => {
      for (const type of INTERRUPTS) window.removeEventListener(type, onInterrupt);
    };

    let last = performance.now();
    const tick = (now: number) => {
      flightFrameRef.current = null;
      const y = window.scrollY;
      if (y <= AT_TOP) {
        window.scrollTo(0, 0);
        endFlight();
        setShown(false);
        return;
      }
      // Unclamped dt is deliberate: after a hidden-tab pause the first frame
      // back covers the whole remaining distance — land, don't keep gliding.
      const dt = now - last;
      last = now;
      const step = Math.max(y * (1 - Math.exp(-dt / FLIGHT_TAU)), dt * LANDING_FLOOR);
      window.scrollTo(0, Math.max(0, y - step));
      flightFrameRef.current = window.requestAnimationFrame(tick);
    };
    flightFrameRef.current = window.requestAnimationFrame(tick);
  };

  return (
    <div className={`scroll-top-slot${shown ? " is-shown" : ""}`}>
      <button type="button" className="scroll-top-btn" aria-label={tr("Back to top", "回到顶部")} tabIndex={shown ? 0 : -1} onClick={scrollToTop}>
        {/* The demo's arrow glyph, rotated to point up. */}
        <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path
            d="M9.335 3.333a.665.665 0 0 1 1.33 0v11.728l4.698-4.698.104-.085a.665.665 0 0 1 .836 1.026l-5.833 5.833c-.26.26-.68.26-.94 0l-5.834-5.833-.085-.104a.666.666 0 0 1 .922-.922l.104.085 4.698 4.697z"
            transform="rotate(180 10 10)"
          />
        </svg>
      </button>
    </div>
  );
}
