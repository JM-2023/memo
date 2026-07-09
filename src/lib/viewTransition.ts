import { flushSync } from "react-dom";

/**
 * Runs a feed filter/view change inside a same-document view transition so
 * the outgoing list cross-fades into the incoming one (choreographed by the
 * ::view-transition rules in app.css) instead of snapping. flushSync makes
 * React commit synchronously inside the callback — the "new" snapshot must
 * capture the final state. Falls back to an instant swap when the API is
 * unavailable or the user prefers reduced motion.
 */
export function withViewTransition(update: () => void): void {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
