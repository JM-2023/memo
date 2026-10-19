/**
 * Swipe-away dismissal for a toast on a touch screen, toward the edge the
 * stack is anchored to: up from the top of a desktop-sized screen, down from
 * the bottom of a phone's (TOAST_BOTTOM_QUERY) — up again while a dialog
 * sends a phone's stack to the top (app.css). The toast follows the finger
 * (that way freely, the other way only a little), and past 24px or a quick
 * flick it leaves through its regular exit, which continues from where it
 * was let go — the drag rides `translate`, the exit animates `transform`.
 * Anything shorter springs back. The toast's own CSS keeps `touch-action:
 * pan-x`, so the vertical drag is the toast's, never the page's.
 */
import { SPRING_MS } from "./motion";

const SLOP = 4;
const DISMISS_DISTANCE = 24;
const DISMISS_VELOCITY = 0.3; // px/ms, toward the anchored edge

/** Where the stack sits at the bottom of the screen (app.css, "Toast"). Keep the two together. */
export const TOAST_BOTTOM_QUERY = "(max-width: 560px)";

export type ToastSwipeDirection = "up" | "down";

/**
 * The way a toast leaves: toward the edge its stack is anchored to — read
 * from where `stack` sits, as the anchor moves with an open dialog; from
 * the screen's width where it can't be measured.
 */
export function toastSwipeDirection(stack?: Element | null): ToastSwipeDirection {
  const rect = stack?.getBoundingClientRect();
  if (rect && rect.height > 0) return rect.top + rect.height / 2 > window.innerHeight / 2 ? "down" : "up";
  return typeof window.matchMedia === "function" && window.matchMedia(TOAST_BOTTOM_QUERY).matches ? "down" : "up";
}

function resistBack(distance: number): number {
  return 14 * (1 - 1 / (1 + distance / 60));
}

/** A drag ends with a click on whatever is under the finger; it must not press Undo. */
function swallowNextClick(element: HTMLElement) {
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  element.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => element.removeEventListener("click", swallow, { capture: true }), 400);
}

export function startToastSwipe(down: PointerEvent, toast: HTMLElement, dismiss: () => void, direction: ToastSwipeDirection = "up"): void {
  if (down.pointerType !== "touch" || !down.isPrimary) return;
  // Distances below are measured toward the anchored edge: positive leaves.
  const sign = direction === "up" ? -1 : 1;
  const pointerId = down.pointerId;
  const startX = down.clientX;
  const startY = down.clientY;
  let dragging = false;
  let offset = 0;
  const samples: Array<{ y: number; t: number }> = [{ y: startY, t: down.timeStamp }];

  const detach = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  };
  const springBack = () => {
    toast.style.transition = `translate ${SPRING_MS}ms var(--ease-out)`;
    toast.style.translate = "0 0";
    window.setTimeout(() => {
      toast.style.removeProperty("translate");
      toast.style.removeProperty("transition");
    }, SPRING_MS + 40);
  };
  function onMove(move: PointerEvent) {
    if (move.pointerId !== pointerId) return;
    const dy = move.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < SLOP) return;
      // A sideways start belongs to the page (pan-x), not to the toast.
      if (Math.abs(move.clientX - startX) > Math.abs(dy)) {
        detach();
        return;
      }
      dragging = true;
      toast.style.transition = "none";
    }
    const along = dy * sign;
    offset = along >= 0 ? along : -resistBack(-along);
    toast.style.translate = `0 ${(offset * sign).toFixed(1)}px`;
    samples.push({ y: move.clientY, t: move.timeStamp });
    if (samples.length > 6) samples.shift();
  }
  function onUp(up: PointerEvent) {
    if (up.pointerId !== pointerId) return;
    detach();
    if (!dragging) return;
    swallowNextClick(toast);
    const first = samples.find((sample) => up.timeStamp - sample.t <= 100) ?? samples[0];
    const velocity = ((up.clientY - first.y) * sign) / Math.max(1, up.timeStamp - first.t);
    if (offset > DISMISS_DISTANCE || (offset > 0 && velocity > DISMISS_VELOCITY)) {
      toast.style.removeProperty("transition");
      dismiss();
      return;
    }
    springBack();
  }
  function onCancel(cancel: PointerEvent) {
    if (cancel.pointerId !== pointerId) return;
    detach();
    if (dragging) springBack();
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
