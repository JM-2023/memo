/**
 * Runs a feed/state change inside a same-document view transition so the
 * outgoing DOM morphs/cross-fades into the incoming one (choreographed by
 * the ::view-transition rules in app.css). The callback must leave the DOM
 * in its final state before it returns — React callers wrap their setState
 * in flushSync themselves. Falls back to calling the update directly when
 * the API is unavailable or the user prefers reduced motion.
 */
export function withViewTransition(update: () => void): void {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  document.startViewTransition(update);
}
