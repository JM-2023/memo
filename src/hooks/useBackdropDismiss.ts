import { useEffect, useMemo, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { SPRING_MS } from "../lib/motion";

/** Phones re-present dialogs as bottom sheets (app.css, "Dialogs as bottom sheets"). */
const SHEET_QUERY = "(max-width: 560px)";
/** Where a sheet is dragged from: its header row (and, on the card's own top padding, the grabber). */
const DRAG_ZONES = ".confirm-card > h2, .bulk-tag-head, .stats-head, .review-head, .model-panel-head, .share-head";
const INTERACTIVE = "button, a[href], input, textarea, select, label, [contenteditable='true'], [role='slider'], [tabindex]:not([tabindex='-1'])";
/** The grabber band at the top of a sheet that has no header element to hold. */
const GRABBER_BAND = 28;
/** Movement before a press counts as a drag, so a tap on the title stays a tap. */
const DRAG_SLOP = 6;
const DISMISS_FRACTION = 0.25;
const DISMISS_VELOCITY = 0.5; // px/ms, downward
/** A flung sheet leaves at the finger's pace, within these bounds (ms). */
const EXIT_MIN_MS = 100;
const EXIT_MAX_MS = 220;

export interface BackdropDismissProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

function sheetMode(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches;
}

/** Upward pulls give a little and then stiffen, like the sheet's top edge is held. */
function rubberBand(distance: number): number {
  return 48 * (1 - 1 / (1 + distance / 120));
}

function clearDrag(card: HTMLElement, overlay: HTMLElement) {
  card.style.removeProperty("translate");
  card.style.removeProperty("transition");
  overlay.style.removeProperty("--sheet-pull");
  overlay.style.removeProperty("--sheet-exit");
  overlay.style.removeProperty("transition");
}

/** The share of the sheet pulled off screen, which the scrim gives up with it (app.css). */
function setPull(overlay: HTMLElement, offset: number, height: number) {
  const pull = height > 0 ? Math.min(1, Math.max(0, offset / height)) : 0;
  overlay.style.setProperty("--sheet-pull", pull.toFixed(3));
}

/**
 * The overlay's dismissal props. A click on the backdrop closes the dialog
 * only when the press also began on the backdrop: selecting text in a field
 * and letting go past the card's edge produces a click on the overlay too,
 * and must not throw the field away.
 *
 * On a phone, where the dialog is a bottom sheet, a touch drag from the
 * sheet's header or grabber pulls it down: past a quarter of its height (or
 * flicked) it leaves through the regular closing exit, which continues from
 * where the finger let go (the drag rides `translate`, the exit `transform`)
 * at the pace of the flick (`--sheet-exit`); otherwise it springs back. The
 * scrim thins as the sheet comes down (`--sheet-pull`), so the page behind
 * is already coming back when the sheet goes. Never while the dialog is busy (aria-busy), and
 * never from inside a scrolling body — only the header rows start a drag.
 */
export function useBackdropDismiss(onDismiss: () => void): BackdropDismissProps {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const pressedBackdropRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  return useMemo<BackdropDismissProps>(() => {
    function startSheetDrag(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch" || !sheetMode()) return;
      const overlay = event.currentTarget;
      const child = overlay.firstElementChild;
      const target = event.target;
      if (!(child instanceof HTMLElement) || !(target instanceof Element) || !child.contains(target)) return;
      const card: HTMLElement = child;
      if (overlay.getAttribute("aria-busy") === "true" || overlay.classList.contains("is-closing")) return;
      const inHeader = target.closest(DRAG_ZONES) !== null && target.closest(INTERACTIVE) === null;
      const onGrabber = target === card && event.clientY - card.getBoundingClientRect().top < GRABBER_BAND;
      if (!inHeader && !onGrabber) return;

      cleanupRef.current?.();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let offset = 0;
      let height = 0;
      let springTimer = 0;
      const samples: Array<{ y: number; t: number }> = [{ y: startY, t: event.timeStamp }];

      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (cleanupRef.current === detach) cleanupRef.current = null;
      };
      const springBack = () => {
        card.style.transition = `translate ${SPRING_MS}ms var(--ease-out)`;
        card.style.translate = "0 0";
        overlay.style.transition = `--sheet-pull ${SPRING_MS}ms var(--ease-out)`;
        overlay.style.setProperty("--sheet-pull", "0");
        overlay.style.removeProperty("--sheet-exit");
        window.clearTimeout(springTimer);
        springTimer = window.setTimeout(() => clearDrag(card, overlay), SPRING_MS + 40);
      };
      function onMove(move: PointerEvent) {
        if (move.pointerId !== pointerId) return;
        const dy = move.clientY - startY;
        if (!dragging) {
          if (Math.abs(dy) < DRAG_SLOP && Math.abs(move.clientX - startX) < DRAG_SLOP) return;
          // A sideways start is not a dismiss gesture.
          if (Math.abs(move.clientX - startX) > Math.abs(dy)) {
            detach();
            return;
          }
          dragging = true;
          card.style.transition = "none";
          overlay.style.transition = "none";
          height = card.offsetHeight || card.getBoundingClientRect().height;
        }
        offset = dy >= 0 ? dy : -rubberBand(-dy);
        card.style.translate = `0 ${offset.toFixed(1)}px`;
        setPull(overlay, offset, height);
        samples.push({ y: move.clientY, t: move.timeStamp });
        if (samples.length > 6) samples.shift();
      }
      function onUp(up: PointerEvent) {
        if (up.pointerId !== pointerId) return;
        detach();
        if (!dragging) return;
        const first = samples.find((sample) => up.timeStamp - sample.t <= 100) ?? samples[0];
        const elapsed = Math.max(1, up.timeStamp - first.t);
        const velocity = (up.clientY - first.y) / elapsed;
        if (offset > height * DISMISS_FRACTION || (offset > 0 && velocity > DISMISS_VELOCITY)) {
          // The rest of the way down at the speed the finger let go with:
          // a flick leaves fast, a slow pull past the line glides out.
          const exitMs = Math.min(EXIT_MAX_MS, Math.max(EXIT_MIN_MS, (height - offset) / Math.max(velocity, DISMISS_VELOCITY)));
          overlay.style.setProperty("--sheet-exit", `${Math.round(exitMs)}ms`);
          dismissRef.current();
          // A dialog that declines to close (or closes without an exit)
          // must not stay pulled down.
          window.requestAnimationFrame(() => {
            if (card.isConnected && !overlay.classList.contains("is-closing")) springBack();
          });
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
      cleanupRef.current = detach;
    }

    return {
      onPointerDown: (event) => {
        pressedBackdropRef.current = event.target === event.currentTarget;
        startSheetDrag(event);
      },
      onClick: (event) => {
        const pressed = pressedBackdropRef.current;
        pressedBackdropRef.current = false;
        if (pressed && event.target === event.currentTarget) dismissRef.current();
      }
    };
  }, []);
}
