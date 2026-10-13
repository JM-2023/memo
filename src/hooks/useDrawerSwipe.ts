import { useEffect, useRef, type RefObject } from "react";

/** Movement before a touch counts as a gesture at all (a tap stays a tap). */
const SLOP = 10;
/** Released past this share of the drawer's width, it closes. */
const CLOSE_SHARE = 1 / 3;
/** …or flicked faster than this, in px/ms, whatever the distance. */
const FLICK = 0.5;
/** Velocity is read over the last stretch of the gesture, not all of it. */
const VELOCITY_WINDOW = 100;
/** The drawer's own exit (.sidebar.is-closing) and the spring back. */
const CLOSE_MS = 160;
const SPRING_MS = 280;
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Controls that own a horizontal drag themselves. */
const OWN_DRAG = "input, textarea, select, [contenteditable='true']";
/** Past the open edge the drawer gives, never more than this, and springs back. */
const STRETCH = 28;

interface Gesture {
  id: number;
  x: number;
  y: number;
  dragging: boolean;
  /** Where the drawer is drawn: the finger's travel, rubber-banded past open. */
  dx: number;
  width: number;
  samples: { x: number; t: number }[];
}

function animatable(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && typeof element.animate === "function";
}

/** Rightward travel past the open edge, eased toward STRETCH: a rubber band. */
function stretched(dx: number): number {
  return dx <= 0 ? dx : (STRETCH * dx) / (dx + STRETCH);
}

/**
 * Swipe the phone drawer shut. Touch only: once a press has travelled 10px,
 * mostly leftward, the drawer follows the finger (no easing while dragging)
 * and the backdrop thins with it. Let go past a third of its width, or with
 * a flick, and it closes through the app's own close path, carrying on from
 * where the finger left it; otherwise it springs back open. A vertical start
 * is the sidebar's own scroll and is left alone (the drawer is touch-action:
 * pan-y, so the browser keeps those), as is a plain tap.
 *
 * The swipe can start on the dimmed strip beside the drawer too — the thumb
 * is usually there, not on the drawer — where a plain tap still closes it.
 * A finger that turns back past the open edge meets resistance rather than
 * a wall: the drawer gives a little (rubber band) and springs back.
 *
 * The motion rides Web Animations held over the drawer's CSS: a script
 * animation outranks the CSS entrance (whose fill would otherwise pin the
 * drawer open) and the closing transition, and cancelling it hands the
 * element straight back to its classes.
 */
export function useDrawerSwipe(drawerRef: RefObject<HTMLElement>, backdropRef: RefObject<HTMLElement>, open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!open || !drawer) return;
    let gesture: Gesture | null = null;
    const held = new Map<HTMLElement, Animation>();
    let clickGuard = 0;

    /** Pin `element` at `frame` (or update the pin) while the finger drags. */
    function hold(element: HTMLElement | null, frame: Keyframe) {
      if (!animatable(element)) return;
      const current = held.get(element);
      const effect = current?.effect as (KeyframeEffect & { setKeyframes?: (frames: Keyframe[]) => void }) | null | undefined;
      if (current && typeof effect?.setKeyframes === "function") {
        effect.setKeyframes([frame, frame]);
        return;
      }
      current?.cancel();
      const animation = element.animate([frame, frame], { duration: 1000, fill: "both" });
      animation.pause();
      held.set(element, animation);
    }

    /** Release a pin into a timed move from where it stands. */
    function settle(element: HTMLElement | null, frames: Keyframe[], duration: number, easing: string, keep: boolean) {
      if (!animatable(element)) return;
      held.get(element)?.cancel();
      const animation = element.animate(frames, { duration, easing, fill: keep ? "forwards" : "none" });
      if (keep) held.set(element, animation);
      else held.delete(element);
    }

    // On window: a drag that began on the scrim lifts over the drawer, or the
    // other way round, and neither tap target should take the release.
    function swallowClick(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      window.clearTimeout(clickGuard);
      window.removeEventListener("click", swallowClick, true);
    }

    function onPointerDown(event: PointerEvent) {
      if (event.pointerType !== "touch" || !event.isPrimary || gesture) return;
      if (drawer!.classList.contains("is-closing")) return;
      if (event.target instanceof Element && event.target.closest(OWN_DRAG)) return;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
        dx: 0,
        width: drawer!.getBoundingClientRect().width || drawer!.offsetWidth || 1,
        samples: [{ x: event.clientX, t: event.timeStamp }]
      };
    }

    function onPointerMove(event: PointerEvent) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.abs(dx) <= SLOP && Math.abs(dy) <= SLOP) return;
        // Leftward and more across than down: the drawer's. Anything else
        // (a scroll, a rightward push) is not, for the rest of this touch.
        if (dx >= -SLOP || Math.abs(dx) <= Math.abs(dy)) {
          gesture = null;
          return;
        }
        gesture.dragging = true;
        try {
          drawer!.setPointerCapture(event.pointerId);
        } catch {
          // Capture is a nicety: moves still arrive while over the drawer.
        }
      }
      gesture.dx = stretched(dx);
      gesture.samples.push({ x: event.clientX, t: event.timeStamp });
      while (gesture.samples.length > 2 && event.timeStamp - gesture.samples[0].t > VELOCITY_WINDOW) gesture.samples.shift();
      hold(drawer, { transform: `translateX(${gesture.dx}px)` });
      hold(backdropRef.current, { opacity: String(Math.min(1, 1 + gesture.dx / gesture.width)) });
    }

    function finish(event: PointerEvent, cancelled: boolean) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const done = gesture;
      gesture = null;
      if (!done.dragging) return;
      // The lift after a drag is not a tap on whatever lies under it.
      window.addEventListener("click", swallowClick, true);
      clickGuard = window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 400);
      const first = done.samples[0];
      const last = done.samples.at(-1)!;
      // A finger that stopped before lifting has no flick left in it.
      const velocity = last.t > first.t && event.timeStamp - last.t <= VELOCITY_WINDOW ? (last.x - first.x) / (last.t - first.t) : 0;
      const close = !cancelled && (velocity < -FLICK || (-done.dx > done.width * CLOSE_SHARE && velocity <= FLICK));
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const fade = String(Math.min(1, 1 + done.dx / done.width));
      if (close) {
        // On from the finger, not back to open first: the pins become the
        // exit and hold there until the drawer is gone.
        settle(drawer, [{ transform: `translateX(${done.dx}px)` }, { transform: "translateX(-102%)" }], reduced ? 0 : CLOSE_MS, EASE, true);
        settle(backdropRef.current, [{ opacity: fade }, { opacity: "0" }], reduced ? 0 : CLOSE_MS, EASE, true);
        onCloseRef.current();
      } else {
        settle(drawer, [{ transform: `translateX(${done.dx}px)` }, { transform: "none" }], reduced ? 0 : SPRING_MS, EASE_OUT, false);
        settle(backdropRef.current, [{ opacity: fade }, { opacity: "1" }], reduced ? 0 : SPRING_MS, EASE_OUT, false);
      }
    }

    const onPointerUp = (event: PointerEvent) => finish(event, false);
    const onPointerCancel = (event: PointerEvent) => finish(event, true);

    // The drawer and the scrim beside it: one gesture, from either.
    const surfaces = [drawer, backdropRef.current].filter((surface): surface is HTMLElement => surface !== null);
    for (const surface of surfaces) {
      surface.addEventListener("pointerdown", onPointerDown);
      surface.addEventListener("pointermove", onPointerMove);
      surface.addEventListener("pointerup", onPointerUp);
      surface.addEventListener("pointercancel", onPointerCancel);
    }
    return () => {
      for (const surface of surfaces) {
        surface.removeEventListener("pointerdown", onPointerDown);
        surface.removeEventListener("pointermove", onPointerMove);
        surface.removeEventListener("pointerup", onPointerUp);
        surface.removeEventListener("pointercancel", onPointerCancel);
      }
      window.removeEventListener("click", swallowClick, true);
      window.clearTimeout(clickGuard);
      // The drawer is gone (or the app is): its classes take it from here.
      for (const animation of held.values()) animation.cancel();
      held.clear();
    };
  }, [drawerRef, backdropRef, open]);
}
