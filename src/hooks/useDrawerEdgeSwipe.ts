import { useEffect, useRef, type RefObject } from "react";
import { EASE_OUT, SPRING_MS, T_BASE, T_ENTER, T_FAST } from "../lib/motion";

/** A touch must start this close to the left edge to be the drawer's. */
const EDGE = 20;
/** Movement before a touch counts as a gesture (useDrawerSwipe's). */
const SLOP = 10;
/** Let go past this share of the drawer's width, it opens (closing's mirror)… */
const OPEN_SHARE = 1 / 3;
/** …or flicked faster than this, in px/ms, whatever the distance. */
const FLICK = 0.5;
const VELOCITY_WINDOW = 100;
/** Past the open edge the drawer gives, never more than this. */
const STRETCH = 28;
/** The drawer exists only here (app.css, "Responsive"). */
const DRAWER_QUERY = "(max-width: 900px)";
const OWN_DRAG = "input, textarea, select, [contenteditable='true']";

/**
 * Installed to the home screen there is no browser Back swipe at the left
 * edge to fight with; in a browser tab the edge stays the browser's.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** The drawer's release rule, mirrored from closing: a third of its width, or a flick. */
export function edgeSwipeOpens(dx: number, width: number, velocity: number): boolean {
  return velocity > FLICK || (dx > width * OPEN_SHARE && velocity >= -FLICK);
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  dragging: boolean;
  dx: number;
  width: number;
  samples: { x: number; t: number }[];
}

function animatable(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && typeof element.animate === "function";
}

/** The drawer's painted offset for a finger `dx` in: closed at -width, rubber-banded past open. */
function offsetFor(dx: number, width: number): number {
  const x = dx - width;
  return x <= 0 ? x : (STRETCH * x) / (x + STRETCH);
}

/**
 * Swipe the phone drawer open from the screen's left edge, in an installed
 * app only (isStandaloneDisplay). The drawer follows the finger from the
 * first 10px, the page under it holds still, and a scrim of its own deepens
 * with it; let go past a third of the width or with a flick and the drawer
 * opens through the app's own path, carrying on from the finger (the real
 * scrim takes over the peek's depth); otherwise it slides back shut. Touch
 * events rather than pointer events: only a cancelled touchmove keeps the
 * browser from scrolling the page meanwhile. Under reduced motion the drag
 * still follows the finger, and the release dissolves instead of sliding.
 */
export function useDrawerEdgeSwipe(drawerRef: RefObject<HTMLElement>, backdropRef: RefObject<HTMLElement>, open: boolean, enabled: boolean, onOpen: () => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (open || !enabled) return;
    let gesture: Gesture | null = null;
    let pinned: Animation | null = null;
    let peek: HTMLElement | null = null;
    let peekPin: Animation | null = null;
    // Set while the peek hands its depth to the real scrim (the open state
    // re-runs this effect before that frame).
    let handingOver = false;

    function pin(element: HTMLElement, current: Animation | null, frame: Keyframe): Animation {
      const effect = current?.effect as (KeyframeEffect & { setKeyframes?: (frames: Keyframe[]) => void }) | null | undefined;
      if (current && typeof effect?.setKeyframes === "function") {
        effect.setKeyframes([frame, frame]);
        return current;
      }
      current?.cancel();
      const animation = element.animate([frame, frame], { duration: 1000, fill: "both" });
      animation.pause();
      return animation;
    }

    /** Play `frames` from where the pin stands, then hand the element back to its classes. */
    function release(element: HTMLElement, held: Animation | null, frames: Keyframe[], duration: number, after?: () => void) {
      held?.cancel();
      const animation = element.animate(frames, { duration, easing: EASE_OUT, fill: "forwards" });
      // A beat past the end, so the classes' own entrance has finished under it.
      window.setTimeout(() => {
        animation.cancel();
        after?.();
      }, duration + 80);
    }

    function removePeek() {
      peekPin?.cancel();
      peekPin = null;
      peek?.remove();
      peek = null;
    }

    function touchOf(list: TouchList, id: number): Touch | undefined {
      return Array.from(list).find((touch) => touch.identifier === id);
    }

    function detach() {
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    }

    function onTouchStart(event: TouchEvent) {
      if (gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE || typeof window.matchMedia !== "function" || !isStandaloneDisplay() || !window.matchMedia(DRAWER_QUERY).matches) return;
      if (event.target instanceof Element && event.target.closest(OWN_DRAG)) return;
      // Over a dialog or sheet, the edge is not the drawer's.
      if (document.querySelector("[aria-modal='true']")) return;
      const drawer = drawerRef.current;
      if (!animatable(drawer)) return;
      gesture = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        dragging: false,
        dx: 0,
        width: drawer.offsetWidth || drawer.getBoundingClientRect().width || 1,
        samples: [{ x: touch.clientX, t: event.timeStamp }]
      };
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("touchend", onTouchEnd, { passive: false });
      window.addEventListener("touchcancel", onTouchCancel);
    }

    function onTouchMove(event: TouchEvent) {
      const drawer = drawerRef.current;
      const touch = gesture ? touchOf(event.changedTouches, gesture.id) : undefined;
      if (!gesture || !touch || !animatable(drawer)) return;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.abs(dx) <= SLOP && Math.abs(dy) <= SLOP) return;
        // Rightward and more across than down: the drawer's. Anything else
        // is the page's, for the rest of this touch.
        if (dx <= SLOP || Math.abs(dx) <= Math.abs(dy)) {
          gesture = null;
          detach();
          return;
        }
        gesture.dragging = true;
        peek = document.createElement("div");
        peek.className = "drawer-backdrop is-peek";
        peek.setAttribute("aria-hidden", "true");
        drawer.parentElement?.appendChild(peek);
      }
      event.preventDefault();
      gesture.dx = dx;
      gesture.samples.push({ x: touch.clientX, t: event.timeStamp });
      while (gesture.samples.length > 2 && event.timeStamp - gesture.samples[0].t > VELOCITY_WINDOW) gesture.samples.shift();
      pinned = pin(drawer, pinned, { visibility: "visible", transform: `translateX(${offsetFor(dx, gesture.width)}px)` });
      if (animatable(peek)) peekPin = pin(peek, peekPin, { opacity: String(Math.min(1, Math.max(0, dx / gesture.width))) });
    }

    function onTouchEnd(event: TouchEvent) {
      const touch = gesture ? touchOf(event.changedTouches, gesture.id) : undefined;
      if (!gesture || !touch) return;
      const done = gesture;
      gesture = null;
      detach();
      const drawer = drawerRef.current;
      if (!done.dragging || !animatable(drawer)) {
        removePeek();
        return;
      }
      // The lift after a drag is no tap on what lies under it.
      event.preventDefault();
      const first = done.samples[0];
      const last = done.samples[done.samples.length - 1];
      const velocity = last.t > first.t && event.timeStamp - last.t <= VELOCITY_WINDOW ? (last.x - first.x) / (last.t - first.t) : 0;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const from = `translateX(${offsetFor(done.dx, done.width)}px)`;
      const depth = String(Math.min(1, Math.max(0, done.dx / done.width)));
      const held = pinned;
      pinned = null;
      if (edgeSwipeOpens(done.dx, done.width, velocity)) {
        const duration = reduced ? T_BASE : T_ENTER;
        release(
          drawer,
          held,
          reduced
            ? [{ visibility: "visible", transform: "none", opacity: 0 }, { visibility: "visible", transform: "none", opacity: 1 }]
            : [{ visibility: "visible", transform: from }, { visibility: "visible", transform: "none" }],
          duration
        );
        handingOver = true;
        onOpenRef.current();
        // The open state brings the real scrim; it starts at the peek's depth,
        // in the same frame the peek goes.
        window.requestAnimationFrame(() => {
          const scrim = backdropRef.current;
          if (animatable(scrim)) scrim.animate([{ opacity: depth }, { opacity: "1" }], { duration, easing: EASE_OUT });
          handingOver = false;
          removePeek();
        });
        return;
      }
      release(
        drawer,
        held,
        reduced
          ? [{ visibility: "visible", transform: from, opacity: 1 }, { visibility: "visible", transform: from, opacity: 0 }]
          : [{ visibility: "visible", transform: from }, { visibility: "visible", transform: "translateX(-102%)" }],
        reduced ? T_FAST : SPRING_MS
      );
      const scrim = peek;
      const scrimPin = peekPin;
      peek = null;
      peekPin = null;
      if (scrim && typeof scrim.animate === "function") release(scrim, scrimPin, [{ opacity: depth }, { opacity: "0" }], reduced ? T_FAST : SPRING_MS, () => scrim.remove());
      else scrim?.remove();
    }

    function onTouchCancel(event: TouchEvent) {
      const touch = gesture ? touchOf(event.changedTouches, gesture.id) : undefined;
      if (!gesture || !touch) return;
      gesture = null;
      detach();
      pinned?.cancel();
      pinned = null;
      removePeek();
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      detach();
      // A drag cut short by the drawer opening some other way, or the app going.
      pinned?.cancel();
      if (!handingOver) removePeek();
    };
  }, [drawerRef, backdropRef, open, enabled]);
}
