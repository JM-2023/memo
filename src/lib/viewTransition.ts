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
  const transition = document.startViewTransition(update);
  // A transition can be skipped — another one starting on top of it, the tab
  // going non-visible mid-capture — and a skip rejects `ready`. The DOM update
  // still lands (that is all `update` does), so the only thing left to do with
  // the rejection is keep it from surfacing as an unhandled one.
  void transition.ready.catch(() => {});
}

/**
 * Decide, slot by slot, which feed cards take part in the next capture. A card
 * only morphs when it sits near the viewport its snapshot belongs to, so a
 * shared card whose other endpoint is pages away enters or departs like its
 * neighbours instead of streaking across the screen.
 *
 * `viewportTop` is the document offset that capture's viewport starts at — the
 * live scroll for a swap that stays put, 0 for one that rewinds to the top
 * (the scroll reset has not landed yet when the outgoing pass runs).
 *
 * Both directions matter. Stripping alone would be a one-way ratchet: a slot
 * dropped from a past capture keeps the empty inline name forever, because
 * React bails out of re-rendering unchanged slots and so never rewrites the
 * style it believes is already correct. Scroll down to a card that an earlier
 * swap had left far from the top, filter from there, and the card being looked
 * at would be missing from the outgoing capture — arriving in the new one as a
 * first-time entrance instead of a glide. data-vt holds the untouched name, so
 * restoring is always exact.
 */
export function tuneFeedTransitionNames(viewportTop: number): void {
  const height = window.innerHeight;
  const margin = height / 2;
  document.querySelectorAll<HTMLElement>(".memo-slot").forEach((slot) => {
    const rect = slot.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const near = top + rect.height >= viewportTop - margin && top <= viewportTop + height + margin;
    slot.style.viewTransitionName = near ? slot.dataset.vt ?? "" : "";
  });
}
