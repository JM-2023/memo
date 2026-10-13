import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useReducedMotion } from "./useReducedMotion";

/**
 * The standard overlay exit, for an engine that can't report its own (no
 * Web Animations API). Where it can, the CSS says how long: the exit ends
 * when the surface's own animations do, so a fling's shorter exit or a
 * reduced-motion dissolve never waits on a copy of the number kept here.
 */
export const OVERLAY_EXIT_MS = 170;

/** What an element shows mid-animation: read before a class flip swaps its animation. */
export interface PaintedFrame {
  opacity: string;
  transform: string;
}

type Watchable = Element & { getAnimations: () => Animation[] };

function canWatch(element: Element | null | undefined): element is Watchable {
  return Boolean(element) && typeof (element as Partial<Watchable>).getAnimations === "function";
}

function isCssAnimation(animation: Animation): animation is CSSAnimation {
  return "animationName" in animation;
}

function finite(animation: Animation): boolean {
  const end = animation.effect?.getComputedTiming().endTime;
  return typeof end === "number" && Number.isFinite(end);
}

/** The element's own CSS animations still to run — never its subtree's, never an endless loop. */
function pendingAnimations(element: Watchable): CSSAnimation[] {
  return element
    .getAnimations()
    .filter((animation): animation is CSSAnimation => isCssAnimation(animation) && animation.playState !== "finished" && animation.playState !== "idle" && finite(animation));
}

function remainingMs(animation: Animation): number {
  const end = Number(animation.effect?.getComputedTiming().endTime) || 0;
  const now = Number(animation.currentTime) || 0;
  return Math.max(0, (end - now) / Math.abs(animation.playbackRate || 1));
}

/**
 * Calls `done` once the elements' exit animations have run, and returns a
 * cancel. Nothing running means nothing to wait for. Without the Web
 * Animations API there is nothing to watch, so `fallbackMs` stands in (0:
 * at once). A safety timer covers an engine that never settles an
 * animation whose element left the render tree.
 */
export function afterExit(elements: Array<Element | null | undefined>, fallbackMs: number, done: () => void): () => void {
  let settled = false;
  let timer = 0;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    done();
  };
  const cancel = () => {
    settled = true;
    window.clearTimeout(timer);
  };
  const targets = elements.filter((element): element is Element => Boolean(element));
  if (targets.length === 0 || !targets.every(canWatch)) {
    if (fallbackMs > 0) timer = window.setTimeout(finish, fallbackMs);
    else finish();
    return cancel;
  }
  const running = (targets as Watchable[]).flatMap(pendingAnimations);
  if (running.length === 0) {
    finish();
    return cancel;
  }
  timer = window.setTimeout(finish, Math.max(...running.map(remainingMs)) + 100);
  void Promise.all(running.map((animation) => animation.finished.catch(() => undefined))).then(finish);
  return cancel;
}

/**
 * The frame an element is painting while one of its entrance (or exit)
 * animations is still in flight; null once they have all settled, when the
 * next animation's own first frame already matches what is on screen.
 */
export function paintedFrameOf(element: Element | null | undefined): PaintedFrame | null {
  if (!canWatch(element) || pendingAnimations(element).every((animation) => animation.playState !== "running")) return null;
  const style = window.getComputedStyle(element);
  return { opacity: style.opacity, transform: style.transform };
}

/**
 * Carries a just-swapped CSS animation on from the frame that was painted.
 * A class flip (open → closing, or back) replaces one animation with another,
 * and the new one starts from its own first frame: a menu re-opened mid-exit
 * blinked back to transparent, a dialog closed mid-entrance jumped to full
 * size before receding. A script animation — composited over the CSS one,
 * same length, same curve — runs from the painted frame to the new
 * animation's last keyframe instead, and both end together. Reduced motion
 * carries only the opacity: a dissolve never moves.
 */
export function continueFrom(element: Element | null | undefined, from: PaintedFrame | null, reducedMotion: boolean): void {
  if (!from || !canWatch(element) || typeof element.animate !== "function") return;
  const effect = pendingAnimations(element)[0]?.effect;
  if (typeof KeyframeEffect === "undefined" || !(effect instanceof KeyframeEffect)) return;
  const duration = Number(effect.getComputedTiming().duration) || 0;
  if (duration <= 0) return;
  const frames = effect.getKeyframes();
  const last = frames[frames.length - 1];
  const start: Keyframe = { opacity: from.opacity };
  const end: Keyframe = { opacity: String(last?.opacity ?? "1") };
  if (!reducedMotion) {
    start.transform = from.transform;
    end.transform = String(last?.transform ?? "none");
  }
  element.animate([start, end], { duration, easing: frames[0]?.easing ?? "ease" });
}

export interface OverlayExit {
  /** The surface is playing its exit: render `.is-closing`. */
  closing: boolean;
  /** Synchronous twin of `closing`, for guards inside the same event. */
  closingRef: { readonly current: boolean };
  /** Plays the exit, then calls `callback`; false when an exit is already under way. */
  leave: (callback: () => void) => boolean;
}

/**
 * One exit for every overlay surface: hold the `.is-closing` phase while the
 * overlay and its card (the overlay's first child) play their exit, then hand
 * over. It ends on the animations themselves rather than a copied 170ms, so
 * the reduced-motion dissolve and a flung sheet's own pace both line up; an
 * exit begun mid-entrance carries on from the painted frame.
 */
export function useOverlayExit(overlayRef: RefObject<HTMLElement>, fallbackMs = OVERLAY_EXIT_MS): OverlayExit {
  const reducedMotion = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const callbackRef = useRef<(() => void) | null>(null);
  const framesRef = useRef<{ overlay: PaintedFrame | null; card: PaintedFrame | null }>({ overlay: null, card: null });
  const cancelRef = useRef<(() => void) | null>(null);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  const leave = useCallback(
    (callback: () => void) => {
      if (closingRef.current) return false;
      const overlay = overlayRef.current;
      // Nothing to watch a dissolve on: leave at once rather than guess.
      // Nothing plays, so nothing is latched either: unmounting is the
      // parent's to do, and a surface the parent keeps stays usable.
      if (!overlay || (reducedRef.current && !canWatch(overlay))) {
        callback();
        return true;
      }
      closingRef.current = true;
      framesRef.current = { overlay: paintedFrameOf(overlay), card: paintedFrameOf(overlay.firstElementChild) };
      callbackRef.current = callback;
      setClosing(true);
      return true;
    },
    [overlayRef]
  );

  // Before paint, so the swapped-in exit never shows its own first frame.
  useLayoutEffect(() => {
    if (!closing) return;
    const overlay = overlayRef.current;
    const card = overlay?.firstElementChild ?? null;
    continueFrom(overlay, framesRef.current.overlay, reducedRef.current);
    continueFrom(card, framesRef.current.card, reducedRef.current);
    cancelRef.current = afterExit([overlay, card], reducedRef.current ? 0 : fallbackMs, () => {
      const callback = callbackRef.current;
      callbackRef.current = null;
      callback?.();
    });
    // An exit never turns back; the unmount below cancels a pending hand-over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  useEffect(() => () => cancelRef.current?.(), []);

  return { closing, closingRef, leave };
}

/**
 * Back over an open dialog (App's popNav) bumps a counter; each bump asks
 * the dialog to leave through its own close — which a busy dialog declines,
 * keeping its work. Only a bump after mount counts.
 */
export function useCloseSignal(signal: number | undefined, requestClose: () => void): void {
  const seenRef = useRef(signal);
  const requestRef = useRef(requestClose);
  requestRef.current = requestClose;
  useEffect(() => {
    if (signal === seenRef.current) return;
    seenRef.current = signal;
    requestRef.current();
  }, [signal]);
}

/**
 * A refused submit answers in the pin pad's vocabulary: the field row gives
 * a small sideways nudge (`.is-refused`, app.css). Restarted on every
 * refusal; no motion at all under reduced motion.
 */
export function nudgeRefusal(element: HTMLElement | null, reducedMotion: boolean): void {
  if (!element || reducedMotion) return;
  element.classList.remove("is-refused");
  // A reflow between remove and add restarts the keyframes on a repeat press.
  void element.offsetWidth;
  element.classList.add("is-refused");
  const clear = (event: AnimationEvent) => {
    if (event.target !== element) return;
    element.classList.remove("is-refused");
    element.removeEventListener("animationend", clear);
  };
  element.addEventListener("animationend", clear);
}
