import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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

/** Room the docked disc keeps from anything else in the topbar's row. */
const DOCK_GAP = 12;

/**
 * Where the disc rests: inside the topbar band, level with its first row —
 * the content column's centre on wide screens, the row's right end on a
 * phone (where the thumb is) — at the nearest spot the row's own content
 * leaves free (a long tag trail, filter chips, a focused search box). The
 * top is relative to the band, which is sticky at 0 whenever the disc shows.
 * Null when the row has no room: the disc then hangs under the band, from
 * the stylesheet's anchors.
 */
function dockSpot(slot: HTMLElement, disc: HTMLElement): { top: number; shift: number } | null {
  const topbar = slot.parentElement?.querySelector<HTMLElement>(":scope > .topbar");
  const row = topbar?.querySelector<HTMLElement>(":scope > .breadcrumb");
  if (!topbar || !row) return null;
  const width = disc.offsetWidth;
  const height = disc.offsetHeight;
  if (!width || !height) return null;
  const bar = topbar.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const top = rowBox.top - bar.top + (rowBox.height - height) / 2;
  const style = getComputedStyle(topbar);
  const half = width / 2;
  // The disc centre's free range: the band's content box, less every piece
  // of the row it would touch (DOCK_GAP around each).
  let free: [number, number][] = [[bar.left + parseFloat(style.paddingLeft) + half, bar.right - parseFloat(style.paddingRight) - half]];
  const block = (el: Element) => {
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return;
    if (box.bottom - bar.top <= top || box.top - bar.top >= top + height) return;
    const from = box.left - DOCK_GAP - half;
    const to = box.right + DOCK_GAP + half;
    free = free.flatMap(([a, b]): [number, number][] =>
      to <= a || from >= b ? [[a, b]] : ([[a, Math.min(b, from)], [Math.max(a, to), b]] as [number, number][]).filter(([x, y]) => y >= x)
    );
  };
  for (const child of Array.from(topbar.children)) {
    if (child === row) for (const part of Array.from(row.children)) block(part);
    else block(child);
  }
  const phone = window.matchMedia("(max-width: 440px)").matches;
  const want = phone ? bar.right : bar.left + bar.width / 2;
  let best: number | null = null;
  for (const [a, b] of free) {
    const x = Math.min(b, Math.max(a, want));
    if (best === null || Math.abs(x - want) < Math.abs(best - want)) best = x;
  }
  if (best === null) return null;
  const slotBox = slot.getBoundingClientRect();
  return { top, shift: best - (slotBox.left + slotBox.width / 2) };
}

/** Longer flights teleport to this many viewports out and glide the rest.
 * Sweeping the whole feed materializes every content-visibility card the
 * flight passes (~2ms of style/layout each, measured) — a hundred-thousand-
 * pixel run crams seconds of that into a 300ms flight, dropping frames and
 * flashing blank, not-yet-painted cards. The eye only reads the last few
 * screens of a glide anyway, so capping the swept distance looks identical. */
const MAX_GLIDE_VIEWPORTS = 3;

/**
 * Lend focus to the top of the main column (where the reader now is) for a
 * control about to vanish under it: tabindex −1 only for the stay, removed
 * again on blur, so <main> never becomes a Tab stop of its own.
 */
export function parkFocusOnMain(): void {
  const main = document.getElementById("main-content");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
  }
  main.focus({ preventScroll: true });
}

/** Nominal settle time: grows with the log of the distance, capped so even a
 * mile-long feed still lands within the UI timing budget. */
const flightMs = (distance: number) =>
  Math.min(300, Math.max(180, 150 + 70 * Math.log10(Math.max(1, distance / 100))));

/**
 * Back-to-top disc — the ChatGPT scroll-to-bottom button mirrored: same
 * frosted glass, same slot choreography (quick shrink-away, deliberate
 * delayed drop-in), opposite direction and opposite edge: the button points
 * up, so it docks in the sticky topbar's band, where it takes you — off the
 * text being read (dockSpot). Scroll state stays local so wheel events never
 * re-render App. The slot lives at the end of the main column and pins near
 * the viewport top (see .scroll-top-slot), centred on the content column;
 * the dock only adds an anchor and a sideways shift.
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
  const slotRef = useRef<HTMLDivElement>(null);

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const discRef = useRef<HTMLButtonElement>(null);
  // Dock the disc in the topbar band (dockSpot), or let it fall back under
  // the band. Kept current while hidden too, so it never slides into place
  // as it appears.
  const placeRef = useRef(() => {});
  placeRef.current = () => {
    const slot = slotRef.current;
    const disc = discRef.current;
    if (!slot || !disc) return;
    const spot = dockSpot(slot, disc);
    if (spot) {
      slot.style.setProperty("--scroll-top-anchor", `${Math.round(spot.top)}px`);
      slot.style.setProperty("--scroll-top-shift", `${Math.round(spot.shift)}px`);
    } else {
      slot.style.removeProperty("--scroll-top-anchor");
      slot.style.removeProperty("--scroll-top-shift");
    }
    // Only a disc hanging under the band meets the wide-screen toast stack's
    // resting line: the stack clears it then (app.css).
    document.documentElement.toggleAttribute("data-scroll-top-shown", shownRef.current && !spot);
  };

  useLayoutEffect(() => {
    if (slotRef.current) slotRef.current.inert = !shown;
    placeRef.current();
  }, [shown]);
  useLayoutEffect(
    () => () => {
      document.documentElement.removeAttribute("data-scroll-top-shown");
    },
    []
  );
  // Re-place whenever the band's row changes: a resize, a search box that
  // widens on focus, a trail or chips that come and go. One frame batches
  // them; the observed set follows the row's children as they swap.
  useEffect(() => {
    const topbar = slotRef.current?.parentElement?.querySelector<HTMLElement>(":scope > .topbar");
    if (!topbar) return;
    let frame = 0;
    const watched = new Set<Element>();
    const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
    const bind = () => {
      const row = topbar.querySelector(":scope > .breadcrumb");
      const want = new Set<Element>([topbar, ...Array.from(topbar.children), ...(row ? Array.from(row.children) : [])]);
      for (const el of watched) {
        if (!want.has(el)) {
          resizes?.unobserve(el);
          watched.delete(el);
        }
      }
      for (const el of want) {
        if (!watched.has(el)) {
          resizes?.observe(el);
          watched.add(el);
        }
      }
    };
    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        bind();
        placeRef.current();
      });
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(topbar, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    bind();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizes?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);

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
      if (!composer || !composer.isConnected || (composer instanceof HTMLElement && composer.hidden)) {
        composer = document.querySelector(".composer:not([hidden])");
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

    // Skip the un-glidable middle first (programmatic, so the scroll handler
    // above ignores it and no interrupt fires). The spring launches from the
    // teleport target, and everything below reads the post-jump position.
    const glideCap = MAX_GLIDE_VIEWPORTS * window.innerHeight;
    if (window.scrollY > glideCap) window.scrollTo(0, glideCap);

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

  // The button goes inert as the page lands, which drops keyboard focus on
  // <body>. A keyboard press (detail 0: no pointer clicks counted) hands
  // focus to the top of the main column instead, where the reader now is.
  const onActivate = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const viaKeyboard = event.detail === 0;
    scrollToTop();
    if (viaKeyboard) parkFocusOnMain();
  };

  return (
    <div ref={slotRef} className={`scroll-top-slot${shown ? " is-shown" : ""}`} aria-hidden={!shown}>
      <button ref={discRef} type="button" className="scroll-top-btn" aria-label={tr("Back to top", "回到顶部")} tabIndex={shown ? 0 : -1} onClick={onActivate}>
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
