import { useEffect, type RefObject } from "react";

/**
 * Publish how much of the layout viewport an on-screen keyboard covers, as
 * `--kb-inset` on `ref`'s element. Mobile browsers open the keyboard over a
 * fixed overlay instead of shrinking it, so a dialog sitting at the bottom
 * of the screen would end up under the keys; the overlay pads its bottom by
 * this much to keep the dialog in view (see .overlay in app.css). Zero on
 * desktop, and while pinch-zoomed, where the visual viewport is smaller for
 * a reason that isn't a keyboard. iOS also zooms on focusing a field under
 * 16px, which would read as a pinch just as the keyboard opens — so the
 * fields in dialogs using this keep 16px on touch screens (app.css).
 */
export function useKeyboardInset(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!element || !viewport) return;
    let frame = 0;
    const apply = () => {
      const covered = viewport.scale > 1.01 ? 0 : window.innerHeight - viewport.height - viewport.offsetTop;
      element.style.setProperty("--kb-inset", `${Math.max(0, Math.round(covered))}px`);
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
    };
  }, [ref]);
}
