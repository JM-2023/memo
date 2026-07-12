import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

/** Below this the page counts as "at the top" and the button hides. */
const AT_TOP = 2;
/** Launch velocity as a fraction of the spring's pure-decay speed (ω·y),
 * so the click answers instantly without the first frame teleporting. */
const LAUNCH_KICK = 0.35;
/** A frame gap this long means the tab was hidden — land, don't resume. */
const STALL_MS = 250;
/** Spring integration substep (ms) so dropped frames stay numerically calm. */
const SPRING_STEP = 8;
/** User gestures that should cancel the glide and hand the wheel back. */
const INTERRUPTS: (keyof WindowEventMap)[] = ["wheel", "touchstart", "mousedown", "keydown"];

/** Nominal settle time: grows with the log of the distance, capped so even a
 * mile-long feed lands in about a second. */
const flightMs = (distance: number) =>
  Math.min(1050, Math.max(500, 380 + 240 * Math.log10(Math.max(1, distance / 100))));

/**
 * Back-to-top disc — the ChatGPT scroll-to-bottom button mirrored: same
 * frosted glass, same slot choreography (quick shrink-away, deliberate
 * delayed rise-in), opposite direction. Scroll state stays local so wheel
 * events never re-render App. The slot lives at the end of the main column
 * and sticks to the viewport bottom, which keeps it centered on the content
 * column at every width for free.
 *
 * The glide is a hand-integrated critically damped spring rather than
 * scrollTo({behavior: "smooth"}): sweeping up through content-visibility:auto
 * cards materializes them, and the scroll-anchoring adjustments that follow
 * can swallow a native smooth scroll mid-flight — absolute per-frame writes
 * always win that fight. The spring also shapes the feel: velocity ramps in
 * at launch, peaks mid-flight, and decays asymptotically into the landing,
 * so arrival at the top has no terminal-velocity slam.
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

    // Critically damped spring toward 0. The float position is ours — the
    // browser rounds scrollTo to device pixels, and re-reading that rounded
    // value would stall the sub-pixel tail — but any real outside shift
    // (scroll anchoring re-measuring cards above) re-syncs it.
    const omega = 6 / flightMs(window.scrollY); // 1/ms
    let pos = window.scrollY;
    let v = -LAUNCH_KICK * omega * pos;
    let written = pos;
    let last = performance.now();
    const tick = (now: number) => {
      flightFrameRef.current = null;
      const dt = now - last;
      last = now;
      const actual = window.scrollY;
      if (actual <= AT_TOP || dt > STALL_MS) {
        window.scrollTo(0, 0);
        endFlight();
        setShown(false);
        return;
      }
      if (Math.abs(actual - written) > 1.5) pos = actual;
      for (let t = dt; t > 0; t -= SPRING_STEP) {
        const h = Math.min(t, SPRING_STEP);
        v += (-omega * omega * pos - 2 * omega * v) * h;
        pos += v * h;
      }
      if (pos < 0.75) {
        window.scrollTo(0, 0);
        endFlight();
        setShown(false);
        return;
      }
      written = pos;
      window.scrollTo(0, pos);
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
