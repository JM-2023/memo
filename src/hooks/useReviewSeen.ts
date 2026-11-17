import { useEffect, useRef, type RefObject } from "react";

/** A review card counts as seen once this share of it — or of the screen,
    for a card taller than the screen — has shown for its reading time. */
export const REVIEW_SEEN_RATIO = 0.6;
/** The shortest reading time: a one-line memo. */
export const REVIEW_SEEN_MS = 1_200;
/** A longer memo takes this much per character of its text… */
export const REVIEW_SEEN_MS_PER_CHAR = 20;
/** …up to this, so a long memo still counts while it is plainly on screen. */
export const REVIEW_SEEN_MAX_MS = 3_000;
const THRESHOLDS = Array.from({ length: 11 }, (_, index) => index / 10);
/** Slots carry their card's key, `memo-<id>`, in data-vt. */
const SLOT_KEY_PREFIX = "memo-";
/** A press on one of these inside a card is reading it: opening its menu, unfolding it, pinning, editing. */
const PRESSABLE = "button, a, input, label, summary, [role='button']";

/** How long `slot` has to stay on screen to count as read: one line takes
    REVIEW_SEEN_MS, a longer memo up to REVIEW_SEEN_MAX_MS. */
export function reviewReadingMs(slot: Element): number {
  const text = (slot.querySelector(".memo-content") ?? slot).textContent ?? "";
  const chars = text.replace(/\s+/g, "").length;
  return Math.min(REVIEW_SEEN_MAX_MS, Math.max(REVIEW_SEEN_MS, chars * REVIEW_SEEN_MS_PER_CHAR));
}

/**
 * Daily review's quiet progress: watch today's cards (`ids`, the feed's
 * `.memo-slot` children) and report each the first time it has been seen
 * (`onSeen`). Seen means at least 60% of the card on screen for its reading
 * time (reviewReadingMs) with the tab visible, or a press on one of the
 * card's controls, or a double-click (which opens its editor).
 *
 * Reading is one card at a time, so only one clock runs: the first card in
 * the feed that is showing enough and not yet seen. When it counts, the next
 * showing card starts. Seven short cards on a tall screen take seven
 * readings, not one glance. A hidden tab stops the clock, and coming back
 * starts it over. Cards already in `seen` are left alone. Pass no ids
 * outside the review view.
 */
export function useReviewSeen(feedRef: RefObject<HTMLElement | null>, ids: readonly string[], seen: ReadonlySet<string>, onSeen: (id: string) => void): void {
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  // The list itself, not what has been seen of it: seeing a card must not
  // restart the clocks of the cards beside it.
  const key = ids.join("\n");

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || !key) return;
    const wanted = new Set(key.split("\n"));
    const idOf = (node: Element): string | null => {
      const slot = node.closest<HTMLElement>(".memo-slot[data-vt]");
      if (!slot || slot.parentElement !== feed) return null;
      const vt = slot.dataset.vt ?? "";
      const id = vt.startsWith(SLOT_KEY_PREFIX) ? vt.slice(SLOT_KEY_PREFIX.length) : "";
      return wanted.has(id) ? id : null;
    };
    const isSeen = (slot: Element) => {
      const id = idOf(slot);
      return !id || seenRef.current.has(id);
    };
    const hidden = () => document.visibilityState === "hidden";
    let observer: IntersectionObserver | null = null;
    // Slots showing enough right now, waiting their turn or reading.
    const showing = new Set<Element>();
    // The one card being read, and its clock.
    let reading: Element | null = null;
    let timer: number | undefined;

    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      reading = null;
    };
    /** A card is done: it no longer waits, is no longer watched, and if it
        was the one being read, the next one starts. */
    const finish = (slot: Element) => {
      showing.delete(slot);
      observer?.unobserve(slot);
      if (slot === reading) stop();
    };
    /** Start the clock on the first showing card in feed order, unless one
        is already running or the tab is hidden. */
    const next = () => {
      if (reading || hidden()) return;
      for (const slot of Array.from(feed.children)) {
        if (!showing.has(slot)) continue;
        if (isSeen(slot)) {
          finish(slot);
          continue;
        }
        reading = slot;
        timer = window.setTimeout(() => {
          timer = undefined;
          reading = null;
          finish(slot);
          const id = idOf(slot);
          if (id && !seenRef.current.has(id)) onSeenRef.current(id);
          next();
        }, reviewReadingMs(slot));
        return;
      }
    };

    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const screen = entry.rootBounds?.height || window.innerHeight;
            const enough =
              entry.isIntersecting && (entry.intersectionRatio >= REVIEW_SEEN_RATIO || entry.intersectionRect.height >= REVIEW_SEEN_RATIO * screen);
            if (enough) showing.add(entry.target);
            else {
              showing.delete(entry.target);
              if (entry.target === reading) stop();
            }
          }
          next();
        },
        { threshold: THRESHOLDS }
      );
      for (const slot of Array.from(feed.children)) {
        if (!isSeen(slot)) observer.observe(slot);
      }
    }

    const onPress = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (event.type === "click" && !target.closest(PRESSABLE)) return;
      const id = idOf(target);
      if (!id) return;
      const slot = target.closest(".memo-slot[data-vt]");
      if (slot) finish(slot);
      if (!seenRef.current.has(id)) onSeenRef.current(id);
      next();
    };
    const onVisibility = () => {
      if (hidden()) stop();
      else next();
    };
    feed.addEventListener("click", onPress, true);
    feed.addEventListener("dblclick", onPress, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer?.disconnect();
      stop();
      feed.removeEventListener("click", onPress, true);
      feed.removeEventListener("dblclick", onPress, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [feedRef, key]);
}
