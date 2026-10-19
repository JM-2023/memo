// The app's own keys, outside any field: / and ⌘K search, N writes, ⌘Z
// undoes the newest toast, ? lists them all. The editor, the feed's select
// mode and dialogs keep their own keys; this only answers keys nobody else
// owns, and never while text is being typed.

import { EASE_OUT, T_ENTER } from "./motion";

export type GlobalShortcut = "search" | "compose" | "undo" | "help";

/** Inputs that take no typed text: a key pressed on one is still the app's. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** Does `element` take typed text (a field, a textarea, editable content)? */
export function isTextEntry(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(element.type);
  if (element.isContentEditable) return true;
  return element.closest("[contenteditable]:not([contenteditable='false'])") !== null;
}

/**
 * Which app shortcut a key press is, if any. Repeats, IME composition and
 * modifier combinations the app doesn't own are nobody's here (⌘⇧Z is redo,
 * ⌥ keys type characters on a Mac).
 */
export function globalShortcutOf(event: KeyboardEvent): GlobalShortcut | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return null;
  if (event.altKey) return null;
  const key = event.key;
  if (event.metaKey || event.ctrlKey) {
    if ((event.metaKey && event.ctrlKey) || event.shiftKey) return null;
    const lower = key.toLowerCase();
    if (lower === "k") return "search";
    if (lower === "z") return "undo";
    return null;
  }
  // "/" and "?" may need Shift on some layouts; the character is what counts.
  if (key === "/") return "search";
  if (key === "?") return "help";
  if (!event.shiftKey && key.toLowerCase() === "n") return "compose";
  return null;
}

/** ⌘Z only ever undoes: Show, Stop and Retry are other verbs. */
export function isUndoLabel(label: string): boolean {
  return label === "Undo" || label === "撤销";
}

/** Mac keyboards name the command key; elsewhere it is Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent ?? "");
}

/** A CSS cubic-bezier() as a function of progress (0–1), for script-driven motion. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton's method, then bisection where the curve is too flat for it.
    let t = x;
    for (let step = 0; step < 8; step += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let step = 0; step < 32 && hi - lo > 1e-6; step += 1) {
      if (sampleX(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** The numbers inside a "cubic-bezier(…)" token (lib/motion.ts holds them as strings). */
function bezierOf(token: string): (x: number) => number {
  const [x1, y1, x2, y2] = (/cubic-bezier\(([^)]+)\)/.exec(token)?.[1] ?? "0,0,1,1").split(",").map(Number);
  return cubicBezier(x1, y1, x2, y2);
}

const easeOut = bezierOf(EASE_OUT);
/** The reader's own hand on the page ends a glide at once. */
const GLIDE_INTERRUPTS = ["wheel", "touchstart", "mousedown"] as const;
/** A glide sweeps at most this many screens; further is a jump to there first. */
const GLIDE_SPAN_SCREENS = 3;

/**
 * Glide the page to `top` on --t-enter / --ease-out; at once under reduced
 * motion. Written frame by frame (as the back-to-top disc does) so scroll
 * anchoring re-measuring cards on the way can't swallow it. Returns a stop.
 */
export function glideWindowTo(top: number, reduced: boolean, duration = T_ENTER): () => void {
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const to = Math.min(Math.max(0, top), max);
  if (reduced || typeof window.requestAnimationFrame !== "function") {
    window.scrollTo(0, to);
    return () => undefined;
  }
  const span = GLIDE_SPAN_SCREENS * window.innerHeight;
  if (Math.abs(window.scrollY - to) > span) window.scrollTo(0, to + Math.sign(window.scrollY - to) * span);
  const from = window.scrollY;
  const distance = to - from;
  if (Math.abs(distance) < 1) return () => undefined;
  let frame = 0;
  let start: number | null = null;
  function stop() {
    window.cancelAnimationFrame(frame);
    for (const type of GLIDE_INTERRUPTS) window.removeEventListener(type, stop);
  }
  function tick(now: number) {
    if (start === null) start = now;
    const progress = Math.min(1, (now - start) / duration);
    window.scrollTo(0, from + distance * easeOut(progress));
    if (progress < 1) frame = window.requestAnimationFrame(tick);
    else stop();
  }
  for (const type of GLIDE_INTERRUPTS) window.addEventListener(type, stop, { passive: true });
  frame = window.requestAnimationFrame(tick);
  return stop;
}

/** Set on the composer while it is called up (revealComposer); app.css unfolds it for that long. */
const COMPOSER_SUMMONED_ATTR = "data-summoned";

/**
 * Hold the composer open: on a phone, under a search, an empty one folds
 * away and out of focus's reach (app.css), so a caret sent to it would land
 * nowhere. Called up, it unfolds first, and folds again once focus leaves
 * it — a draft keeps it open by itself.
 */
function summonComposer(composer: HTMLElement, field: HTMLTextAreaElement): () => void {
  if (composer.hasAttribute(COMPOSER_SUMMONED_ATTR)) return () => undefined;
  composer.setAttribute(COMPOSER_SUMMONED_ATTR, "");
  const release = () => {
    composer.removeAttribute(COMPOSER_SUMMONED_ATTR);
    composer.removeEventListener("focusout", onLeave);
  };
  const onLeave = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node && composer.contains(event.relatedTarget))) release();
  };
  composer.addEventListener("focusout", onLeave);
  // The unfolded style has to be in force before focus() can take.
  void getComputedStyle(field).visibility;
  return release;
}

/**
 * Bring the composer on screen and put the caret in it (N, the phone's
 * new-memo button). False where the view has no composer.
 */
export function revealComposer(reduced: boolean): boolean {
  const composer = document.querySelector<HTMLElement>(".composer:not([hidden])");
  const field = composer?.querySelector<HTMLTextAreaElement>("textarea");
  if (!composer || !field) return false;
  const release = summonComposer(composer, field);
  const rect = composer.getBoundingClientRect();
  const bar = document.querySelector(".topbar")?.getBoundingClientRect();
  const barBottom = Math.max(0, bar?.bottom ?? 0);
  if (rect.top < barBottom || rect.bottom > window.innerHeight) {
    // Under the sticky bar with the composer's own top margin, which at the
    // top of the page is exactly where it rests.
    const margin = Number.parseFloat(getComputedStyle(composer).marginTop) || 0;
    glideWindowTo(window.scrollY + rect.top - (bar?.height ?? 0) - margin, reduced);
  }
  field.focus({ preventScroll: true });
  // Focus that didn't take has nothing to leave: let go at once.
  if (document.activeElement !== field) release();
  return true;
}
