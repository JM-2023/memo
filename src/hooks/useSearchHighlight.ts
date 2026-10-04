import { useLayoutEffect, useRef, type RefObject } from "react";
import { FOLD_HEIGHT, publishHiddenHits } from "../components/MemoFold";
import { SEARCH_HIT_HIGHLIGHT, highlightApi, hitRangesIn } from "../lib/searchHighlight";

/** The live body only: a short memo's sits right in the view surface, a long
    one's inside its fold. Replay ghosts, clones and the editor never match. */
const LIVE_BODY = ".memo-view-surface > .memo-content, .memo-view-surface > .memo-fold > .memo-content";
/** A hit whose top sits this far into the fold's fade is lost in it. */
const FADE_ALLOWANCE = 28;

/**
 * Paints the query's needles inside the rendered feed cards through the CSS
 * Custom Highlight API (silently absent where unsupported). Only cards in
 * `hitIds` — literal keyword matches — are painted: a semantic-only result
 * may share a word or two with the query, and marking those would claim a
 * match the keyword tier never made.
 *
 * A long memo's fold hides everything past its cut, so when every hit in a
 * foldable body sits below it, the fold's toggle is told how many there are
 * ("Show more · 2 matches") — measured against the cut whether the body is
 * folded right now or not, so the count is already right when it folds.
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
    if (!feed || needles.length === 0 || !hitIds || hitIds.size === 0) {
      api?.registry.delete(SEARCH_HIT_HIGHLIGHT);
      publishHiddenHits(new Map());
      return;
    }
    const paint = () => {
      const { needles: current, hitIds: ids } = inputsRef.current;
      const ranges: Range[] = [];
      const hidden = new Map<Element, number>();
      for (const slot of Array.from(feed.querySelectorAll<HTMLElement>(".memo-slot[data-vt]"))) {
        const id = slot.dataset.vt?.replace(/^memo-/, "") ?? "";
        if (!ids?.has(id)) continue;
        const content = slot.querySelector(LIVE_BODY);
        if (!content) continue;
        const fold = content.parentElement?.matches(".memo-fold[data-overflow]") ? content.parentElement : null;
        // Without the Highlight API only a fold's count is worth the walk.
        if (!api && !fold) continue;
        const found = hitRangesIn(content, current);
        ranges.push(...found);
        if (fold && found.length > 0) {
          const cut = fold.getBoundingClientRect().top + FOLD_HEIGHT - FADE_ALLOWANCE;
          // (An engine without Range geometry reports nothing hidden.)
          if (found.every((range) => typeof range.getBoundingClientRect === "function" && range.getBoundingClientRect().top >= cut)) {
            hidden.set(fold, found.length);
          }
        }
      }
      api?.registry.set(SEARCH_HIT_HIGHLIGHT, api.create(ranges));
      publishHiddenHits(hidden);
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
      api?.registry.delete(SEARCH_HIT_HIGHLIGHT);
      publishHiddenHits(new Map());
    };
  }, [feedRef, needles, hitIds]);
}
