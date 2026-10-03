import { useEffect, type RefObject } from "react";

/** Where the topbar wraps search onto its own row (see app.css). */
const PHONE = "(max-width: 440px)";
/** Scroll that must build up in one direction before the row moves. */
const SLACK = 12;
/** Near the top of the page the whole band always shows. */
const TOP_ZONE = 120;

/**
 * On phones the sticky topbar is two rows (~120px): location on the first,
 * search on the second. Reading down the feed, the search row tucks away
 * under the first one (the band clips from the bottom) and the feed gets the
 * room back; any scroll up, focus inside the bar, or the top of the page
 * brings it back. The first row — drawer toggle, location, lens chips —
 * never moves.
 *
 * State lives on the element (data-tuck) rather than in React: scroll never
 * re-renders App. "in" is tucked; "out" plays the reveal, then clears.
 */
export function useTopbarTuck(ref: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    const bar = ref.current;
    if (!enabled || !bar) return;
    const phone = window.matchMedia(PHONE);
    let tucked = false;
    let anchorY = window.scrollY;
    let frame = 0;

    const clearReveal = (event: AnimationEvent) => {
      if (event.target === bar && bar.dataset.tuck === "out") delete bar.dataset.tuck;
    };

    function set(next: boolean) {
      if (next === tucked) return;
      if (next) {
        const tools = bar!.querySelector<HTMLElement>(".search-tools");
        const crumbs = bar!.querySelector<HTMLElement>(".breadcrumb");
        // The second row plus the gap above it is what slides away. Zero or
        // less means search shares the first row: nothing to tuck.
        const distance = tools && crumbs ? tools.offsetTop + tools.offsetHeight - (crumbs.offsetTop + crumbs.offsetHeight) : 0;
        if (distance <= 0) return;
        bar!.style.setProperty("--topbar-tuck", `${distance}px`);
        bar!.dataset.tuck = "in";
      } else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        delete bar!.dataset.tuck;
      } else {
        bar!.dataset.tuck = "out";
      }
      tucked = next;
    }

    function update() {
      frame = 0;
      const y = window.scrollY;
      if (!phone.matches || y < TOP_ZONE) {
        set(false);
        anchorY = y;
        return;
      }
      const delta = y - anchorY;
      if (Math.abs(delta) < SLACK) return;
      anchorY = y;
      // Never tuck away from a focused field or an open menu or panel.
      if (delta > 0 && (bar!.contains(document.activeElement) || bar!.querySelector("[aria-expanded='true']"))) return;
      set(delta > 0);
    }

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const onFocusIn = () => set(false);

    window.addEventListener("scroll", onScroll, { passive: true });
    phone.addEventListener?.("change", onScroll);
    bar.addEventListener("focusin", onFocusIn);
    bar.addEventListener("animationend", clearReveal);
    return () => {
      window.removeEventListener("scroll", onScroll);
      phone.removeEventListener?.("change", onScroll);
      bar.removeEventListener("focusin", onFocusIn);
      bar.removeEventListener("animationend", clearReveal);
      window.cancelAnimationFrame(frame);
      delete bar.dataset.tuck;
    };
  }, [ref, enabled]);
}
