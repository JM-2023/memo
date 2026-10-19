interface ActiveTransition {
  transition: ViewTransition;
  /** Pseudo-elements exist (ready resolved) and nothing has skipped it yet. */
  live: boolean;
}

let active: ActiveTransition | null = null;

/**
 * Runs a change inside a same-document view transition, for the few morphs
 * that need snapshots: the sent text becoming its card (App, landCreated),
 * a feed tile growing into the viewer's photo (Lightbox), and the splash's
 * brand mark landing on the gate. Only the parts a morph names take part,
 * and take no press until it ends (≤0.25s); the rest of the page stays live
 * under it (app.css, view-transition section) — the feed's own motion is
 * lib/feedMotion.ts. The callback must
 * leave the DOM in its final state before it returns — React callers wrap
 * their setState in flushSync themselves — and receives whether a snapshot
 * transition is being attempted. Falls back to calling the update directly
 * when the API is unavailable.
 */
export function withViewTransition(update: (animated: boolean) => void): ViewTransition | null {
  if (!document.startViewTransition) {
    update(false);
    return null;
  }
  const transition = document.startViewTransition(() => update(true));
  const entry: ActiveTransition = { transition, live: false };
  active = entry;
  // A transition can be skipped — another one starting on top of it, the tab
  // going non-visible mid-capture — and a skip rejects `ready`. The DOM update
  // still lands (that is all `update` does), so the only thing left to do with
  // the rejection is keep it from surfacing as an unhandled one.
  Promise.resolve(transition.ready).then(
    () => {
      if (active === entry) entry.live = true;
    },
    () => undefined
  );
  const done = () => {
    if (active === entry) active = null;
  };
  Promise.resolve(transition.finished).then(done, done);
  return transition;
}

/** Is a transition's pseudo-element tree on screen right now? */
export function transitionLive(): boolean {
  return active?.live === true;
}

/** End the transition on screen at once; the DOM already holds its end state. */
export function skipLiveTransition(): void {
  if (!active?.live) return;
  active.live = false;
  active.transition.skipTransition();
}
