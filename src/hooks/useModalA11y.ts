import { useLayoutEffect, useRef, type RefObject } from "react";
import { LIVE_REGION_ATTR } from "../lib/liveAnnouncer";
import { SHEET_QUERY } from "./useSheet";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * Marks a branch that stays live above any modal: the toast stack. A dialog
 * that stays open on a failure (a rename refused, a share that couldn't
 * copy) says why in a toast, and that toast — its Undo, its ✕, the hover
 * that holds its clock — has to work over the dialog. Inert, it let the
 * click fall through to the scrim and dismiss the dialog instead.
 */
export const MODAL_EXEMPT_ATTR = "data-modal-exempt";
const EXEMPT_SELECTOR = `[${MODAL_EXEMPT_ATTR}]`;

function inExempt(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EXEMPT_SELECTOR) !== null;
}

/** Still able to hold focus — not disabled, not folded into an inert region, still in the page. */
function canHoldFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.matches(":disabled") && element.closest("[inert]") === null;
}

interface IsolationState {
  count: number;
  inert: boolean;
  ariaHidden: string | null;
}

interface BodyState {
  overflow: string;
  overscrollBehavior: string;
  paddingRight: string;
}

const modalStack: symbol[] = [];
const isolated = new Map<HTMLElement, IsolationState>();
let bodyLocks = 0;
let bodyState: BodyState | null = null;

function lockBody() {
  bodyLocks += 1;
  if (bodyLocks !== 1) return;
  const body = document.body;
  bodyState = {
    overflow: body.style.overflow,
    overscrollBehavior: body.style.overscrollBehavior,
    paddingRight: body.style.paddingRight
  };
  const scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  if (scrollbar > 0) {
    const currentPadding = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${currentPadding + scrollbar}px`;
  }
  body.style.overflow = "hidden";
  body.style.overscrollBehavior = "contain";
}

function unlockBody() {
  bodyLocks = Math.max(0, bodyLocks - 1);
  if (bodyLocks !== 0 || !bodyState) return;
  document.body.style.overflow = bodyState.overflow;
  document.body.style.overscrollBehavior = bodyState.overscrollBehavior;
  document.body.style.paddingRight = bodyState.paddingRight;
  bodyState = null;
}

function isolate(element: HTMLElement) {
  const current = isolated.get(element);
  if (current) {
    current.count += 1;
    return;
  }
  isolated.set(element, {
    count: 1,
    inert: Boolean(element.inert),
    ariaHidden: element.getAttribute("aria-hidden")
  });
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function restoreIsolation(element: HTMLElement) {
  const state = isolated.get(element);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
  isolated.delete(element);
}

/**
 * Makes every sibling branch outside a modal inert. Reference counting keeps
 * nested overlays from re-enabling the page when only the top layer closes.
 */
function isolateOutside(container: HTMLElement, exemptSelector?: string): HTMLElement[] {
  const changed: HTMLElement[] = [];
  let branch: HTMLElement = container;
  let parent = branch.parentElement;
  while (parent) {
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      if (exemptSelector && sibling.matches(exemptSelector)) continue;
      // The app's live regions must keep speaking while a modal is up, and
      // its toasts must stay usable (MODAL_EXEMPT_ATTR).
      if (sibling.hasAttribute(LIVE_REGION_ATTR) || sibling.hasAttribute(MODAL_EXEMPT_ATTR)) continue;
      isolate(sibling);
      changed.push(sibling);
    }
    if (parent === document.body) break;
    branch = parent;
    parent = parent.parentElement;
  }
  return changed;
}

/**
 * Where the opener sat in tab order: the next few stops after it, then the
 * few before (nearest first). An opener can unmount while its modal is up
 * (a renamed tag's row is re-keyed), and focus should land beside where it
 * stood rather than on <body>. A few, not one: the nearest stops are often
 * gone too (the closing menu's items, the opener's own row).
 */
function tabNeighbours(element: HTMLElement | null, modal: HTMLElement): HTMLElement[] {
  if (!element) return [];
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !modal.contains(item));
  const index = all.indexOf(element);
  if (index < 0) return [];
  return [...all.slice(index + 1, index + 5), ...all.slice(Math.max(0, index - 4), index).reverse()];
}

/**
 * A dialog card scales in from (and back out to) the control that opened
 * it: its transform-origin is put on the opener's centre, kept within half a
 * card of its own box so a far opener tilts the motion rather than flinging
 * the card. Not for a phone's sheet, which rises from the bottom edge, nor
 * for an opener that isn't on screen (a shortcut, Back).
 */
function growFromOpener(overlay: HTMLElement, opener: HTMLElement | null) {
  if (!opener || opener === document.body || !overlay.matches(".overlay:not(.lightbox)")) return;
  if (typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches) return;
  const card = overlay.firstElementChild;
  if (!(card instanceof HTMLElement)) return;
  const from = opener.getBoundingClientRect();
  if (from.width === 0 && from.height === 0) return;
  // Layout boxes, not painted ones: the entrance's scale is already on the card.
  const box = overlay.getBoundingClientRect();
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const x = from.left + from.width / 2 - (box.left + overlay.clientLeft + card.offsetLeft);
  const y = from.top + from.height / 2 - (box.top + overlay.clientTop + card.offsetTop);
  const clamp = (value: number, size: number) => Math.min(size * 1.5, Math.max(-size * 0.5, value));
  card.style.transformOrigin = `${clamp(x, width).toFixed(1)}px ${clamp(y, height).toFixed(1)}px`;
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.inert && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0
  );
}

interface ModalA11yOptions {
  enabled?: boolean;
  onEscape?: () => void;
  escapeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  /** Permit focus in a body portal owned by this surface, such as a menu. */
  allowOutsideSelector?: string;
  /** Keep an outside branch interactive, such as a drawer backdrop. */
  isolateExemptSelector?: string;
}

/** Focus trap, focus restoration, background isolation and nested body lock. */
export function useModalA11y<T extends HTMLElement>({
  enabled = true,
  onEscape,
  escapeDisabled = false,
  initialFocusRef,
  allowOutsideSelector,
  isolateExemptSelector
}: ModalA11yOptions = {}) {
  const containerRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);
  const allowOutsideSelectorRef = useRef(allowOutsideSelector);
  const isolateExemptSelectorRef = useRef(isolateExemptSelector);
  onEscapeRef.current = onEscape;
  escapeDisabledRef.current = escapeDisabled;
  allowOutsideSelectorRef.current = allowOutsideSelector;
  isolateExemptSelectorRef.current = isolateExemptSelector;

  useLayoutEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const modal: HTMLElement = container;
    const token = Symbol("modal");
    let restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let fallbackFocus = tabNeighbours(restoreFocus, modal);
    growFromOpener(modal, restoreFocus);
    modalStack.push(token);
    lockBody();

    const requestedInitial = initialFocusRef?.current;
    const initial = requestedInitial && !requestedInitial.matches(":disabled, [aria-disabled='true']") ? requestedInitial : null;
    const first = focusableWithin(modal)[0];
    (initial ?? first ?? modal).focus({ preventScroll: true });
    const changed = isolateOutside(modal, isolateExemptSelectorRef.current);
    // The control inside that last held focus, and one that lost it by
    // turning unusable (see the focus floor below).
    let lastInside: HTMLElement | null = document.activeElement instanceof HTMLElement && document.activeElement !== modal ? document.activeElement : null;
    let parked: HTMLElement | null = null;

    function onKeyDown(event: KeyboardEvent) {
      if (modalStack.at(-1) !== token || event.isComposing) return;
      const eventTarget = event.target;
      if (
        allowOutsideSelectorRef.current &&
        eventTarget instanceof Element &&
        eventTarget.closest(allowOutsideSelectorRef.current)
      ) {
        return;
      }
      // Escape inside the toast stack is the stack's own (it hands focus
      // back into the dialog); Tab from there falls into the trap below.
      if (event.key === "Escape" && inExempt(eventTarget)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!escapeDisabledRef.current) onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(modal);
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      const firstItem = focusable[0];
      const lastItem = focusable.at(-1)!;
      // Focus parked on the dialog itself counts as outside its controls:
      // Shift+Tab from there must not walk out of the page.
      const outside = !modal.contains(active) || active === modal;
      if (event.shiftKey && (active === firstItem || outside)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || outside)) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    function onFocusIn(event: FocusEvent) {
      if (modalStack.at(-1) !== token) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (modal.contains(target)) {
        if (target !== modal) {
          lastInside = target;
          parked = null;
        }
        return;
      }
      // F6 or a click reaches a toast's Undo or ✕ over the dialog.
      if (inExempt(target)) return;
      if (allowOutsideSelectorRef.current && target.closest(allowOutsideSelectorRef.current)) return;
      // A closing menu can return focus to its trigger after this modal has
      // mounted. Remember that useful destination, then keep focus trapped.
      restoreFocus = target;
      fallbackFocus = tabNeighbours(target, modal);
      (focusableWithin(modal)[0] ?? modal).focus({ preventScroll: true });
    }

    // The focus floor. A busy dialog disables the very control that was
    // pressed (Rename, Import, Save image), and an inline confirm folds its
    // Cancel away; either way focus drops to <body> — outside the trap, with
    // nothing to bring it back when the request fails and the dialog stays.
    // Focus parks on the dialog itself, and when the control it left comes
    // back while focus is still parked, it is handed back there.
    const floor =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (modalStack.at(-1) !== token) return;
            const active = document.activeElement;
            const lost =
              !(active instanceof HTMLElement) ||
              active === document.body ||
              !active.isConnected ||
              (active !== modal && modal.contains(active) && !canHoldFocus(active));
            if (lost) {
              parked = lastInside && lastInside !== modal && modal.contains(lastInside) ? lastInside : null;
              modal.focus({ preventScroll: true });
              return;
            }
            if (active === modal && parked && canHoldFocus(parked) && modal.contains(parked)) {
              const control = parked;
              parked = null;
              control.focus({ preventScroll: true });
            }
          });
    floor?.observe(modal, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "inert", "hidden"] });

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      floor?.disconnect();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      for (const element of changed) restoreIsolation(element);
      unlockBody();
      const settleFocus = () => {
        for (const candidate of [restoreFocus, ...fallbackFocus]) {
          if (!candidate?.isConnected || candidate.inert || candidate.matches(":disabled")) continue;
          candidate.focus({ preventScroll: true });
          if (document.activeElement === candidate) return;
        }
      };
      settleFocus();
      // The commit that closes the modal can remove the opener after this
      // cleanup ran (it sits later in the tree); try again once it is done.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected) settleFocus();
      });
    };
    // The refs intentionally keep callbacks and busy state current without
    // tearing down the trap during a modal's closing animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return containerRef;
}
