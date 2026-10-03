import { useLayoutEffect, useRef, type RefObject } from "react";
import { SEARCH_HIT_HIGHLIGHT, highlightApi, hitRangesIn } from "../lib/searchHighlight";

/**
 * Paints the query's needles inside the rendered feed cards through the CSS
 * Custom Highlight API (silently absent where unsupported). Only cards in
 * `hitIds` — literal keyword matches — are painted: a semantic-only result
 * may share a word or two with the query, and marking those would claim a
 * match the keyword tier never made.
 *
 * Re-runs after every commit that changes the inputs, and on DOM mutations
 * inside the feed (a page appended by the scroll sentinel, an edit landing,
 * a formula typesetting late), batched to one pass per frame.
 */
export function useSearchHighlight(feedRef: RefObject<HTMLElement | null>, needles: readonly string[], hitIds: ReadonlySet<string> | null): void {
  const inputsRef = useRef({ needles, hitIds });
  inputsRef.current = { needles, hitIds };

  useLayoutEffect(() => {
    const api = highlightApi();
    const feed = feedRef.current;
    if (!api) return;
    if (!feed || needles.length === 0 || !hitIds || hitIds.size === 0) {
      api.registry.delete(SEARCH_HIT_HIGHLIGHT);
      return;
    }
    const paint = () => {
      const { needles: current, hitIds: ids } = inputsRef.current;
      const ranges: Range[] = [];
      for (const slot of Array.from(feed.querySelectorAll<HTMLElement>(".memo-slot[data-vt]"))) {
        const id = slot.dataset.vt?.replace(/^memo-/, "") ?? "";
        if (!ids?.has(id)) continue;
        // The live surface only: replay ghosts and the editor are not prose.
        const content = slot.querySelector(".memo-view-surface > .memo-content");
        if (content) ranges.push(...hitRangesIn(content, current));
      }
      api.registry.set(SEARCH_HIT_HIGHLIGHT, api.create(ranges));
    };
    paint();
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    });
    observer.observe(feed, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      api.registry.delete(SEARCH_HIT_HIGHLIGHT);
    };
  }, [feedRef, needles, hitIds]);
}
