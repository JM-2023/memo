import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

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
      isolate(sibling);
      changed.push(sibling);
    }
    if (parent === document.body) break;
    branch = parent;
    parent = parent.parentElement;
  }
  return changed;
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
    modalStack.push(token);
    lockBody();

    const requestedInitial = initialFocusRef?.current;
    const initial = requestedInitial && !requestedInitial.matches(":disabled, [aria-disabled='true']") ? requestedInitial : null;
    const first = focusableWithin(modal)[0];
    (initial ?? first ?? modal).focus({ preventScroll: true });
    const changed = isolateOutside(modal, isolateExemptSelectorRef.current);

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
      if (event.shiftKey && (active === firstItem || !modal.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !modal.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    function onFocusIn(event: FocusEvent) {
      if (modalStack.at(-1) !== token) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || modal.contains(target)) return;
      if (allowOutsideSelectorRef.current && target.closest(allowOutsideSelectorRef.current)) return;
      // A closing menu can return focus to its trigger after this modal has
      // mounted. Remember that useful destination, then keep focus trapped.
      restoreFocus = target;
      (focusableWithin(modal)[0] ?? modal).focus({ preventScroll: true });
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      for (const element of changed) restoreIsolation(element);
      unlockBody();
      if (restoreFocus?.isConnected && !restoreFocus.inert) restoreFocus.focus({ preventScroll: true });
    };
    // The refs intentionally keep callbacks and busy state current without
    // tearing down the trap during a modal's closing animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return containerRef;
}
