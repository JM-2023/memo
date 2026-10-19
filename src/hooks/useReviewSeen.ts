import { useEffect, useRef, type RefObject } from "react";

/** A review card counts as seen once this share of it — or of the screen,
    for a card taller than the screen — has shown for REVIEW_SEEN_MS. */
export const REVIEW_SEEN_RATIO = 0.6;
export const REVIEW_SEEN_MS = 1_200;
const THRESHOLDS = Array.from({ length: 11 }, (_, index) => index / 10);
/** Slots carry their card's key, `memo-<id>`, in data-vt. */
const SLOT_KEY_PREFIX = "memo-";
/** A press on one of these inside a card is reading it: opening its menu, unfolding it, pinning, editing. */
const PRESSABLE = "button, a, input, label, summary, [role='button']";

/**
 * Daily review's quiet progress: watch today's cards (`ids`, the feed's
 * `.memo-slot` children) and report each the first time it has been seen
 * (`onSeen`). Seen means at least 60% of the card on screen for 1.2s with
 * the tab visible — a hidden tab stops every clock, and coming back starts
 * them over — or a press on one of the card's controls, or a double-click
 * (which opens its editor). Cards already in `seen` are left alone. Pass no
 * ids outside the review view.
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
    const report = (id: string) => {
      if (!seenRef.current.has(id)) onSeenRef.current(id);
    };
    const hidden = () => document.visibilityState === "hidden";

    let observer: IntersectionObserver | null = null;
    const timers = new Map<Element, number>();
    // Slots showing enough right now, clocks running or held by a hidden tab.
    const showing = new Set<Element>();
    const arm = (slot: Element) => {
      if (timers.has(slot) || hidden()) return;
      timers.set(
        slot,
        window.setTimeout(() => {
          timers.delete(slot);
          showing.delete(slot);
          observer?.unobserve(slot);
          const id = idOf(slot);
          if (id) report(id);
        }, REVIEW_SEEN_MS)
      );
    };
    const disarm = (slot: Element) => {
      const timer = timers.get(slot);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(slot);
    };

    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const screen = entry.rootBounds?.height || window.innerHeight;
            const enough =
              entry.isIntersecting && (entry.intersectionRatio >= REVIEW_SEEN_RATIO || entry.intersectionRect.height >= REVIEW_SEEN_RATIO * screen);
            if (enough) {
              showing.add(entry.target);
              arm(entry.target);
            } else {
              showing.delete(entry.target);
              disarm(entry.target);
            }
          }
        },
        { threshold: THRESHOLDS }
      );
      for (const slot of Array.from(feed.children)) {
        const id = idOf(slot);
        if (id && !seenRef.current.has(id)) observer.observe(slot);
      }
    }

    const onPress = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (event.type === "click" && !target.closest(PRESSABLE)) return;
      const id = idOf(target);
      if (id) report(id);
    };
    const onVisibility = () => {
      if (hidden()) for (const slot of [...timers.keys()]) disarm(slot);
      else for (const slot of showing) arm(slot);
    };
    feed.addEventListener("click", onPress, true);
    feed.addEventListener("dblclick", onPress, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer?.disconnect();
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      feed.removeEventListener("click", onPress, true);
      feed.removeEventListener("dblclick", onPress, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [feedRef, key]);
}
