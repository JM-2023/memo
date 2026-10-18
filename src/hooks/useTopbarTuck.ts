import { useEffect, type RefObject } from "react";
import { SCROLL_JUMP_EVENT } from "../lib/navHistory";

/** Where the topbar wraps search onto its own row (see app.css). */
const PHONE = "(max-width: 440px)";
/** Scroll that must build up in one direction before the row moves. */
const SLACK = 12;
/** Near the top of the page the whole band always shows. */
const TOP_ZONE = 120;
/** How long after the app moves the page itself its scrolls are not reading:
    a restored place lands, then re-aims for a few frames (restoreFeedPlace). */
const JUMP_HOLD = 300;

/**
 * On phones the sticky topbar is two rows (~120px): location on the first,
 * search on the second. Reading down the feed, the search row tucks away
 * under the first one (the band clips from the bottom) and the feed gets the
 * room back; any scroll up, focus inside the bar, or the top of the page
 * brings it back. The first row — drawer toggle, location, lens chips —
 * never moves. Only the reader's own scrolling counts: a place the app puts
 * back (Back, ⌂, a cleared search) lands with the band as it was, and iOS's
 * rubber-band past either end is not a scroll in any direction.
 *
 * State lives on the element (data-tuck) rather than in React: scroll never
 * re-renders App. "in" is tucked; "out" plays the reveal, then clears. Under
 * reduced motion both are fades: the row fades out and the band closes up
 * behind it at once, and back.
 */
export function useTopbarTuck(ref: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    const bar = ref.current;
    if (!enabled || !bar) return;
    const phone = window.matchMedia(PHONE);
    let tucked = false;
    let anchorY = window.scrollY;
    let frame = 0;
    let jumpUntil = 0;

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
      } else {
        // Reduced motion plays "out" too, as a fade (app.css): its band
        // opens at once and the row fades back in, and the same animationend
        // clears it.
        bar!.dataset.tuck = "out";
      }
      tucked = next;
    }

    function update() {
      frame = 0;
      // Clamped to the real scroll range: past the bottom, iOS bounces the
      // page back up, which read as a scroll up and brought the row back on
      // every short lens read to its end.
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const y = Math.min(Math.max(0, window.scrollY), max);
      if (!phone.matches || y < TOP_ZONE) {
        set(false);
        anchorY = y;
        return;
      }
      if (performance.now() < jumpUntil) {
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
    const onJump = () => {
      jumpUntil = performance.now() + JUMP_HOLD;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(SCROLL_JUMP_EVENT, onJump);
    phone.addEventListener?.("change", onScroll);
    bar.addEventListener("focusin", onFocusIn);
    bar.addEventListener("animationend", clearReveal);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener(SCROLL_JUMP_EVENT, onJump);
      phone.removeEventListener?.("change", onScroll);
      bar.removeEventListener("focusin", onFocusIn);
      bar.removeEventListener("animationend", clearReveal);
      window.cancelAnimationFrame(frame);
      delete bar.dataset.tuck;
    };
  }, [ref, enabled]);

  // The band's bottom hairline fades in over the first 16px of scroll. Where
  // scroll-driven animations run, CSS does it alone (see .topbar::after);
  // elsewhere a 16px sentinel at the top of the page flips data-scrolled
  // once it has scrolled out, and the hairline transitions in.
  useEffect(() => {
    const bar = ref.current;
    if (!enabled || !bar) return;
    if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll()")) return;
    if (typeof IntersectionObserver !== "function") return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:16px;pointer-events:none;visibility:hidden";
    document.body.insertBefore(sentinel, document.body.firstChild);
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      if (entry.isIntersecting) delete bar.dataset.scrolled;
      else bar.dataset.scrolled = "";
    });
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      sentinel.remove();
      delete bar.dataset.scrolled;
    };
  }, [ref, enabled]);
}
