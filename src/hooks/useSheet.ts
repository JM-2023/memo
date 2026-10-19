import { useEffect, useMemo, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { EASE, EASE_POP, T_FAST, T_SLOW } from "../lib/motion";

/** Phones re-present dialogs as bottom sheets (app.css, "Dialogs as bottom sheets"). */
export const SHEET_QUERY = "(max-width: 560px)";
/** A sheet's header row: a pull from there starts at once (it keeps its touch, app.css). */
const DRAG_ZONES = ".confirm-card > h2, .bulk-tag-head, .stats-head, .review-head, .model-panel-head, .share-head";
const INTERACTIVE = "button, a[href], input, textarea, select, label, [contenteditable='true'], [role='slider'], [tabindex]:not([tabindex='-1'])";
/** Body presses that never pull: text being edited, or a control that drags on its own. */
const KEEPS_ITS_TOUCH = "input, textarea, select, [contenteditable='true'], [role='slider']";
/** The grabber band at the top of a sheet that has no header element to hold. */
const GRABBER_BAND = 28;
/** Movement before a press counts as a drag, so a tap on the title stays a tap. */
const DRAG_SLOP = 6;
const DISMISS_FRACTION = 0.25;
const DISMISS_VELOCITY = 0.5; // px/ms, downward
/** How far a sheet that has to stay gives under the finger, either way (px). */
const RESIST_CAP = 48;

/** The let-go spring: stiff and nearly critically damped (ζ ≈ 0.93), so it lands without a wobble. */
const STIFFNESS = 420;
const DAMPING = 38;
const MASS = 1;
/** Keyframe spacing when a spring is sampled into WAAPI keyframes (ms). */
const SAMPLE_MS = 10;
/** A spring that hasn't come to rest by then is cut there. */
const SPRING_MAX_MS = 900;

export interface BackdropDismissProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

export interface SheetOptions {
  /**
   * True while the dialog must not be dismissed by a stray gesture — an
   * unsaved draft. A pull rubber-bands and springs home, a backdrop click
   * boops the card. A busy dialog (aria-busy) always resists.
   */
  resist?: () => boolean;
}

/** Where a spring goes, sampled every SAMPLE_MS; the last point lands at `ms`. */
export interface SpringPath {
  points: number[];
  ms: number;
}

/**
 * The path of a spring released at `from` with `velocity` (px/ms) toward
 * `to`. Integrated in 1ms steps (semi-implicit Euler), so a release carries
 * on at the pace the finger let go with. Ends when the spring rests — or,
 * with `until`, at the first position it accepts (a sheet off screen needn't
 * finish settling).
 */
export function springPath(from: number, to: number, velocity: number, until?: (position: number) => boolean): SpringPath {
  let x = from - to;
  let v = velocity * 1000;
  const points = [from];
  for (let ms = 1; ms <= SPRING_MAX_MS; ms += 1) {
    v += ((-STIFFNESS * x - DAMPING * v) / MASS) * 0.001;
    x += v * 0.001;
    const position = to + x;
    if (until ? until(position) : Math.abs(x) < 0.5 && Math.abs(v) < 20) {
      points.push(until ? position : to);
      return { points, ms };
    }
    if (ms % SAMPLE_MS === 0) points.push(position);
  }
  points.push(until ? to + x : to);
  return { points, ms: SPRING_MAX_MS };
}

/** Each sample's place on the path's own timeline, 0–1. */
function offsetsOf(path: SpringPath): number[] {
  const last = path.points.length - 1;
  return path.points.map((_, index) => (index === last ? 1 : Math.min(1, (index * SAMPLE_MS) / path.ms)));
}

/** The path as a CSS linear() easing: its progress from `start` across `span`. */
export function linearEasing(path: SpringPath, start: number, span: number): string {
  const offsets = offsetsOf(path);
  const stops = path.points.map((point, index) => `${((point - start) / span).toFixed(4)} ${(offsets[index] * 100).toFixed(2)}%`);
  return `linear(${stops.join(", ")})`;
}

function linearEasingSupported(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timing-function", "linear(0, 1)");
}

/** The scrim's layer (::before) can carry its own script animation. */
function canAnimateScrim(): boolean {
  return typeof KeyframeEffect !== "undefined" && "pseudoElement" in KeyframeEffect.prototype;
}

function sheetMode(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A pull that has to stop gives a little and then stiffens, like the sheet is held. */
function band(distance: number): number {
  return RESIST_CAP * (1 - 1 / (1 + distance / 120));
}

/** How much of the finger's pace the band passes on at `distance`. */
function bandSlope(distance: number): number {
  return RESIST_CAP / 120 / (1 + distance / 120) ** 2;
}

/** The share of the sheet pulled off screen, which the scrim gives up with it (app.css). */
function pullOf(offset: number, height: number): number {
  return height > 0 ? Math.min(1, Math.max(0, offset / height)) : 0;
}

/** The vertical offset a sheet is painted at, mid-spring included. */
function paintedOffset(card: HTMLElement): number {
  const value = window.getComputedStyle(card).getPropertyValue("translate").trim();
  if (!value || value === "none") return 0;
  return Number.parseFloat(value.split(/\s+/)[1] ?? "0") || 0;
}

/** Every vertical scroller between a press and the sheet, nearest first. */
function scrollersOf(target: Element, card: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let node: Element | null = target; node && node !== card.parentElement; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 1) continue;
    const overflow = window.getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") found.push(node);
  }
  return found;
}

/** The sheet's springs in flight, so a new pull can take over from the frame on screen. */
const settling = new WeakMap<HTMLElement, Animation[]>();

function stopSettling(card: HTMLElement): number {
  const running = settling.get(card);
  if (!running) return 0;
  const offset = paintedOffset(card);
  for (const animation of running) animation.cancel();
  settling.delete(card);
  return offset;
}

function clearDrag(card: HTMLElement, overlay: HTMLElement) {
  card.style.removeProperty("translate");
  overlay.style.removeProperty("--sheet-pull");
  overlay.style.removeProperty("--sheet-exit");
  overlay.style.removeProperty("--sheet-exit-ease");
}

/**
 * Lets a sheet go home from `from` at `pace` (px/ms): the inline drag is
 * cleared and the spring plays as sampled keyframes on top of the rest
 * state, the scrim's opacity riding the same samples. Reduced motion takes a
 * short unsprung glide instead.
 */
function settle(card: HTMLElement, overlay: HTMLElement, from: number, height: number, pace: number) {
  clearDrag(card, overlay);
  if (Math.abs(from) < 0.5 || typeof card.animate !== "function") return;
  const reduced = reducedMotion();
  const path: SpringPath = reduced ? { points: [from, 0], ms: T_FAST } : springPath(from, 0, pace);
  const offsets = offsetsOf(path);
  const timing: KeyframeAnimationOptions = { duration: path.ms, easing: reduced ? EASE : "linear" };
  const animations = [card.animate(path.points.map((y, index) => ({ translate: `0 ${y.toFixed(2)}px`, offset: offsets[index] })), timing)];
  if (height > 0 && canAnimateScrim()) {
    animations.push(
      overlay.animate(
        path.points.map((y, index) => ({ opacity: (1 - pullOf(y, height)).toFixed(3), offset: offsets[index] })),
        { ...timing, pseudoElement: "::before" }
      )
    );
  }
  settling.set(card, animations);
  animations[0].onfinish = () => {
    if (settling.get(card) === animations) settling.delete(card);
  };
}

const boops = new WeakMap<Element, Animation>();

/**
 * A dialog that won't go answers the gesture that tried: the card swells a
 * hair and settles (scale, so it composes with the entrance's transform and
 * a sheet's translate). Reduced motion flashes the card's border in the
 * focus colour for two frames instead.
 */
export function boopCard(overlay: Element | null | undefined): void {
  const card = overlay?.firstElementChild;
  if (!(card instanceof HTMLElement) || overlay?.classList.contains("is-closing")) return;
  if (reducedMotion()) {
    card.classList.add("is-flash");
    let frames = 0;
    const frame = (callback: () => void) =>
      typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 16);
    // The class lands before the next paint; it comes off before the third.
    const step = () => {
      frames += 1;
      if (frames < 3) frame(step);
      else card.classList.remove("is-flash");
    };
    frame(step);
    return;
  }
  if (typeof card.animate !== "function") return;
  boops.get(card)?.cancel();
  boops.set(card, card.animate([{ scale: "1" }, { scale: "1.012" }, { scale: "1" }], { duration: T_SLOW, easing: EASE_POP }));
}

/**
 * The body-started pull in progress, if any. A touch in the scrolling body
 * belongs to the browser unless its first move is claimed, which only a
 * non-passive touchmove can do — so one standing listener asks the gesture.
 */
let bodyGesture: { claim: (touch: Touch) => boolean } | null = null;
let guardMounts = 0;

function onGuardedTouchMove(event: TouchEvent) {
  if (!bodyGesture || event.touches.length !== 1) return;
  if (bodyGesture.claim(event.touches[0]) && event.cancelable) event.preventDefault();
}

/** Standing before any touch starts: WebKit decides at touchstart whether a move can be claimed. */
function mountTouchGuard(): () => void {
  guardMounts += 1;
  if (guardMounts === 1) document.addEventListener("touchmove", onGuardedTouchMove, { passive: false });
  return () => {
    guardMounts = Math.max(0, guardMounts - 1);
    if (guardMounts === 0) document.removeEventListener("touchmove", onGuardedTouchMove);
  };
}

/**
 * The sheet controller behind every dialog's overlay props. A click on the
 * backdrop closes the dialog only when the press also began on the backdrop:
 * selecting text in a field and letting go past the card's edge produces a
 * click on the overlay too, and must not throw the field away.
 *
 * On a phone, where the dialog is a bottom sheet, a touch pulls it down from
 * its header or grabber, or from its body when that is scrolled to the top
 * and the first move is downward (the body has the gesture back the moment
 * the sheet is home again). Let go, the sheet follows the finger's pace: a
 * spring started from the release velocity takes it home, or — past a
 * quarter of its height, or flicked — the regular closing exit carries it
 * off along the same spring (`--sheet-exit`, `--sheet-exit-ease`). The scrim
 * is a fixed blur whose opacity gives way as the sheet comes down. A dialog
 * that resists (a draft, busy work) rubber-bands both ways instead and boops
 * on a backdrop click.
 */
export function useSheet(onDismiss: () => void, options?: SheetOptions): BackdropDismissProps {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pressedBackdropRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unmountGuard = mountTouchGuard();
    return () => {
      cleanupRef.current?.();
      unmountGuard();
    };
  }, []);

  return useMemo<BackdropDismissProps>(() => {
    const resisting = (overlay: HTMLElement) => Boolean(optionsRef.current?.resist?.()) || overlay.getAttribute("aria-busy") === "true";

    function startSheetDrag(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch" || event.isDefaultPrevented() || !sheetMode()) return;
      const overlay = event.currentTarget;
      const child = overlay.firstElementChild;
      const target = event.target;
      if (!(child instanceof HTMLElement) || !(target instanceof Element) || !child.contains(target)) return;
      if (overlay.classList.contains("is-closing")) return;
      const card: HTMLElement = child;
      const onGrabber = target === card && event.clientY - card.getBoundingClientRect().top < GRABBER_BAND;
      let scrollers: HTMLElement[] = [];
      let fromBody = false;
      if (target.closest(DRAG_ZONES)) {
        if (target.closest(INTERACTIVE)) return;
      } else if (!onGrabber) {
        if (target.closest(KEEPS_ITS_TOUCH)) return;
        scrollers = scrollersOf(target, card);
        if (scrollers.some((scroller) => scroller.scrollTop > 0)) return;
        fromBody = true;
      }
      const scroller = scrollers[0] ?? null;

      cleanupRef.current?.();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      /** Where the finger stood when the sheet was at `base`. */
      let anchorY = event.clientY;
      let base = 0;
      let phase: "pending" | "drag" | "scroll" = "pending";
      let raw = 0;
      let offset = 0;
      let height = 0;
      let resist = false;
      let scrollFrom = 0;
      const samples: Array<{ y: number; t: number }> = [{ y: event.clientY, t: event.timeStamp }];
      // Once the pull is decided the whole touch is the sheet's: its moves
      // are claimed from the browser, which would otherwise scroll.
      const gesture = {
        claim: (touch: Touch) => {
          move(touch.clientX, touch.clientY, null);
          return phase !== "pending";
        }
      };

      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (bodyGesture === gesture) bodyGesture = null;
        if (cleanupRef.current === detach) cleanupRef.current = null;
      };

      function show(next: number) {
        offset = next;
        card.style.translate = `0 ${next.toFixed(1)}px`;
        overlay.style.setProperty("--sheet-pull", pullOf(next, height).toFixed(3));
      }

      function move(x: number, y: number, t: number | null) {
        if (phase === "pending") {
          const dx = x - startX;
          const dy = y - anchorY;
          if (Math.abs(dy) < DRAG_SLOP && Math.abs(dx) < DRAG_SLOP) return;
          // A sideways start is not a dismiss gesture, nor is a body's scroll.
          if (Math.abs(dx) > Math.abs(dy) || (fromBody && (dy < 0 || scrollers.some((item) => item.scrollTop > 0)))) {
            detach();
            return;
          }
          phase = "drag";
          resist = resisting(overlay);
          height = card.offsetHeight || card.getBoundingClientRect().height;
          // Caught mid-spring: carry on from the frame on screen.
          base = stopSettling(card);
        }
        if (t !== null) {
          samples.push({ y, t });
          if (samples.length > 6) samples.shift();
        }
        if (phase === "scroll") {
          // Handed back: the finger scrolls the body until the body is at
          // its top again and the finger keeps coming down.
          const next = scrollFrom + (anchorY - y);
          if (next >= 0) {
            if (scroller) scroller.scrollTop = next;
            return;
          }
          if (scroller) scroller.scrollTop = 0;
          anchorY += scrollFrom;
          base = 0;
          phase = "drag";
        }
        raw = base + (y - anchorY);
        if (fromBody && raw <= 0) {
          // Home again: the sheet lets go and the rest of the touch scrolls.
          anchorY -= base;
          base = 0;
          offset = 0;
          scrollFrom = scroller?.scrollTop ?? 0;
          clearDrag(card, overlay);
          phase = "scroll";
          if (scroller) scroller.scrollTop = scrollFrom + (anchorY - y);
          return;
        }
        show(resist ? Math.sign(raw) * band(Math.abs(raw)) : raw >= 0 ? raw : -band(-raw));
      }

      function onMove(event: PointerEvent) {
        if (event.pointerId === pointerId) move(event.clientX, event.clientY, event.timeStamp);
      }

      function onUp(up: PointerEvent) {
        if (up.pointerId !== pointerId) return;
        detach();
        // A tap, or a pull the body has taken back.
        if (phase !== "drag") return;
        const first = samples.find((sample) => up.timeStamp - sample.t <= 100) ?? samples[0];
        const velocity = (up.clientY - first.y) / Math.max(1, up.timeStamp - first.t);
        const stays = resist || resisting(overlay);
        if (!stays && ((offset > 0 && velocity > DISMISS_VELOCITY) || (offset > height * DISMISS_FRACTION && velocity > -DISMISS_VELOCITY))) {
          // The rest of the way down on the same spring, at the pace it was
          // let go with: a flick leaves fast, a slow pull past the line
          // glides out. It ends once the sheet is off screen.
          const path = springPath(offset, offset + height, Math.max(0, velocity), (position) => position >= height);
          overlay.style.setProperty("--sheet-exit", `${path.ms}ms`);
          if (height > 0 && linearEasingSupported()) overlay.style.setProperty("--sheet-exit-ease", linearEasing(path, offset, height));
          const from = offset;
          dismissRef.current();
          // A dialog that declines to close (or closes without an exit)
          // must not stay pulled down.
          window.requestAnimationFrame(() => {
            if (card.isConnected && !overlay.classList.contains("is-closing")) settle(card, overlay, from, height, 0);
          });
          return;
        }
        // Through the band, only the band's share of the finger's pace.
        settle(card, overlay, offset, height, resist || raw < 0 ? velocity * bandSlope(Math.abs(raw)) : velocity);
      }

      function onCancel(cancel: PointerEvent) {
        if (cancel.pointerId !== pointerId) return;
        detach();
        if (phase === "drag") settle(card, overlay, offset, height, 0);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      if (fromBody) bodyGesture = gesture;
      cleanupRef.current = detach;
    }

    return {
      onPointerDown: (event) => {
        pressedBackdropRef.current = event.target === event.currentTarget;
        startSheetDrag(event);
      },
      onClick: (event) => {
        const pressed = pressedBackdropRef.current;
        pressedBackdropRef.current = false;
        if (!pressed || event.target !== event.currentTarget) return;
        if (resisting(event.currentTarget)) boopCard(event.currentTarget);
        else dismissRef.current();
      }
    };
  }, []);
}
