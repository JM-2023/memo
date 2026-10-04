import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "../hooks/useReducedMotion";

/** ARIA wiring for the trigger button — spread it onto the button. */
export interface MenuTriggerProps {
  id: string;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

interface MenuProps {
  /**
   * Renders the trigger button; `open` lets it style its active state, and
   * `triggerProps` carries the popup/expanded/controls wiring (plus the id
   * the panel is labelled by) so callers don't each re-derive it.
   */
  trigger: (open: boolean, triggerProps: MenuTriggerProps) => ReactNode;
  /** Menu body; call `close()` from item handlers. */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  /**
   * "menu" (default) is a menuitem list: arrow-key roving focus, Tab closes.
   * "panel" is a small non-modal dialog for mixed controls (toggles, date
   * inputs): Tab moves naturally, arrow keys stay with the focused control.
   * Both share the same surface, phases and dismissal behavior.
   */
  kind?: "menu" | "panel";
  /** Accessible name for the panel — required with kind="panel". */
  panelLabel?: string;
  /** Extra class on the floating panel itself — the only way to style a
      portaled panel, which renders outside `.menu-root`. */
  panelClassName?: string;
  /**
   * Render the panel in a body portal with fixed positioning — needed when
   * the trigger lives inside an overflow container (the sidebar tag list)
   * that would otherwise clip an absolutely-positioned panel. Flips upward
   * near the bottom edge; any scroll closes it.
   */
  portal?: boolean;
  /**
   * Opens the menu from outside: bump the number and the panel opens as if
   * its trigger had been clicked (a filter chip handing the reader back to
   * the panel it came from). 0 / undefined never opens.
   */
  openSignal?: number;
  /**
   * Where an openSignal open puts focus (a selector inside the panel): the
   * control the outside caller stands for, scrolled into the panel's view.
   * Falls back to the usual first control when nothing matches.
   */
  openSignalFocus?: string;
}

interface PortalPos {
  /** Downward panels pin `top`; upward ones pin `bottom` so the panel stays
      glued to the trigger even when its content (e.g. a delete-confirm swap)
      changes height. */
  top?: number;
  bottom?: number;
  left: number;
  up: boolean;
}

/** Type-ahead keeps its letters this long between presses. */
const TYPEAHEAD_RESET_MS = 500;

function itemLabel(item: HTMLElement): string {
  return (item.textContent || item.getAttribute("aria-label") || "").trim().toLocaleLowerCase();
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

const PAGE_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * Popover action menu (opaque floating surface). Owns open state, closes on
 * outside pointer-down and Escape, and animates in via .action-menu CSS.
 * Closing holds the panel one beat in a "closing" phase so it can play the
 * reverse morph before unmounting.
 */
export function Menu({ trigger, children, align = "right", className, panelClassName, portal = false, kind = "menu", panelLabel, openSignal, openSignalFocus }: MenuProps) {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [pos, setPos] = useState<PortalPos | null>(null);
  // In-flow (non-portal) panels open downward unless that would run past the
  // viewport bottom while the space above has room — see the flip effect.
  const [flipUp, setFlipUp] = useState(false);
  const reducedMotion = useReducedMotion();
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const panelId = `${baseId}-panel`;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusEdgeRef = useRef<"first" | "last">("first");
  const restoreTriggerRef = useRef(false);
  const typeaheadRef = useRef({ text: "", timer: 0 });
  const open = phase === "open";

  function triggerElement() {
    return rootRef.current?.querySelector<HTMLElement>(".menu-trigger-slot > button, .menu-trigger-slot [tabindex]:not([tabindex='-1'])") ?? null;
  }

  function menuItems() {
    return [...(panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']") ?? [])].filter(
      (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true"
    );
  }

  function focusAfterTrigger(backward: boolean) {
    const triggerNode = triggerElement();
    if (!triggerNode) return;
    const candidates = [...document.querySelectorAll<HTMLElement>(PAGE_FOCUSABLE)].filter(
      (element) =>
        !panelRef.current?.contains(element) &&
        !element.inert &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.getClientRects().length > 0
    );
    const index = candidates.indexOf(triggerNode);
    const target = index < 0 ? triggerNode : candidates[index + (backward ? -1 : 1)] ?? triggerNode;
    target.focus({ preventScroll: true });
  }

  function requestClose(restoreTrigger = false) {
    restoreTriggerRef.current = restoreTrigger;
    setPhase((value) => (value === "open" ? "closing" : value));
  }

  /**
   * Item handlers' close: focus goes back to the trigger now, not after the
   * exit beat. An item that opens a dialog mounts it in this same commit, and
   * the dialog makes the page inert before a delayed restore could land — it
   * would remember the departing item as its opener and drop focus to <body>
   * on close.
   */
  function closeFromItem() {
    const active = document.activeElement;
    if (active === document.body || (active instanceof Node && panelRef.current?.contains(active))) {
      triggerElement()?.focus({ preventScroll: true });
    }
    requestClose(false);
  }

  function requestOpen(edge: "first" | "last" = "first", focusSelector: string | null = null) {
    focusEdgeRef.current = edge;
    focusTargetRef.current = focusSelector;
    restoreTriggerRef.current = false;
    setPhase("open");
  }

  // Only a bump after mount opens: a menu that (re)mounts while the counter
  // already stands at 3 was not asked to open — the view it lives in was.
  const seenOpenSignalRef = useRef(openSignal);
  const focusTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (openSignal === seenOpenSignalRef.current) return;
    seenOpenSignalRef.current = openSignal;
    if (openSignal) {
      // Already open (a second chip's edit half): just move to its control.
      if (phase === "open") focusSignalTarget(openSignalFocus ?? null);
      else requestOpen("first", openSignalFocus ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one open per bump
  }, [openSignal]);

  /** Focus the signal's target, scrolling it into the panel's own view. */
  function focusSignalTarget(selector: string | null): boolean {
    const panel = panelRef.current;
    const target = selector && panel ? panel.querySelector<HTMLElement>(selector) : null;
    if (!panel || !target) return false;
    target.focus({ preventScroll: true });
    const panelRect = panel.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.bottom > panelRect.bottom) panel.scrollTop += rect.bottom - panelRect.bottom + 8;
    else if (rect.top < panelRect.top) panel.scrollTop -= panelRect.top - rect.top + 8;
    return true;
  }

  useEffect(() => {
    if (phase !== "closing") return;
    if (reducedMotion) {
      setPhase("closed");
      return;
    }
    const timer = window.setTimeout(() => setPhase("closed"), 130);
    return () => window.clearTimeout(timer);
  }, [phase, reducedMotion]);

  useLayoutEffect(() => {
    if (!open) return;
    // Name the panel after its trigger. Triggers that spread `triggerProps`
    // already carry the id; older call sites get it assigned here.
    const triggerNode = triggerElement();
    if (!panelLabel && triggerNode && panelRef.current) {
      if (!triggerNode.id) triggerNode.id = triggerId;
      panelRef.current.setAttribute("aria-labelledby", triggerNode.id);
    }
    const focusTarget = focusTargetRef.current;
    focusTargetRef.current = null;
    if (focusSignalTarget(focusTarget)) return;
    if (kind === "panel") {
      panelRef.current?.querySelector<HTMLElement>(PAGE_FOCUSABLE)?.focus({ preventScroll: true });
      return;
    }
    const items = menuItems();
    const target = focusEdgeRef.current === "last" ? items.at(-1) : items[0];
    target?.focus({ preventScroll: true });
  }, [open, kind]);

  // Some action menus replace their focused destructive item with an inline
  // confirm/cancel branch. Removing that DOM node sends focus to <body>; put
  // it back on the first item in the new branch (and again when cancelling)
  // so the next Tab does not close the menu before confirmation is reachable.
  // A branch confirming something irreversible marks its Cancel with
  // data-menu-autofocus: a reflexive second Enter then backs out instead of
  // destroying.
  useEffect(() => {
    if (!open || kind !== "menu") return;
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
      const preferred = panel.querySelector<HTMLElement>("[data-menu-autofocus]");
      (preferred ?? menuItems()[0])?.focus({ preventScroll: true });
    });
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, kind]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      requestClose(false);
    }
    // The pointer moves focus with it, so the row under the mouse and the
    // keyboard's row are always the same one — one highlight, not two.
    function onPointerMove(event: PointerEvent) {
      if (kind === "panel" || event.pointerType === "touch") return;
      const item = event.target instanceof Element ? event.target.closest<HTMLElement>("[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']") : null;
      if (!item || item === document.activeElement || !menuItems().includes(item)) return;
      item.focus({ preventScroll: true });
    }
    /** First-letter type-ahead: the next row whose label starts with what was typed. */
    function typeahead(event: KeyboardEvent, items: HTMLElement[], activeIndex: number): HTMLElement | undefined {
      if (event.key.length !== 1 || event.key === " " || event.ctrlKey || event.metaKey || event.altKey || isTextEntry(event.target)) return undefined;
      const state = typeaheadRef.current;
      window.clearTimeout(state.timer);
      state.text += event.key.toLocaleLowerCase();
      state.timer = window.setTimeout(() => {
        state.text = "";
      }, TYPEAHEAD_RESET_MS);
      // One letter pressed again cycles through the rows it starts; a longer
      // run keeps matching from the current row.
      const repeated = [...state.text].every((char) => char === state.text[0]);
      const query = repeated ? state.text[0] : state.text;
      const start = repeated ? activeIndex + 1 : Math.max(0, activeIndex);
      for (let step = 0; step < items.length; step += 1) {
        const item = items[(start + step) % items.length];
        if (itemLabel(item).startsWith(query)) return item;
      }
      return undefined;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose(true);
        return;
      }
      // Panels keep native keyboarding: Tab walks the controls in order and
      // arrows stay with whatever is focused (date-input segments need them).
      if (kind === "panel") return;
      if (event.key === "Tab") {
        event.preventDefault();
        requestClose(false);
        focusAfterTrigger(event.shiftKey);
        return;
      }
      const items = menuItems();
      if (items.length === 0) return;
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      let target: HTMLElement | undefined;
      if (event.key === "ArrowDown") target = activeIndex < 0 ? items[0] : items[(activeIndex + 1) % items.length];
      else if (event.key === "ArrowUp") target = activeIndex < 0 ? items.at(-1) : items[(activeIndex - 1 + items.length) % items.length];
      else if (event.key === "Home") target = items[0];
      else if (event.key === "End") target = items.at(-1);
      else target = typeahead(event, items, activeIndex);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    panel?.addEventListener("pointermove", onPointerMove);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
      panel?.removeEventListener("pointermove", onPointerMove);
      window.clearTimeout(typeaheadRef.current.timer);
      typeaheadRef.current.text = "";
    };
  }, [open, kind]);

  // Portal mode: measure, then place — the layout effect runs before paint,
  // so the panel never flashes at a wrong position.
  useLayoutEffect(() => {
    if (!open || !portal) return;
    const anchor = rootRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const up = rect.bottom + 6 + panelHeight > window.innerHeight - 8 && rect.top - panelHeight - 6 > 8;
    const rawLeft = align === "right" ? rect.right - panelWidth : rect.left;
    setPos({
      top: up ? undefined : rect.bottom + 6,
      bottom: up ? window.innerHeight - rect.top + 6 : undefined,
      left: Math.min(Math.max(rawLeft, 8), window.innerWidth - 8 - panelWidth),
      up
    });
  }, [open, portal, align]);

  // In-flow mode: same before-paint measurement, but the answer is only a
  // direction. The panel stays inside .menu-root (so scrolling keeps it open
  // and glued to its card); near the bottom edge it opens upward instead of
  // hanging its last items — often Delete — below the fold.
  useLayoutEffect(() => {
    if (!open || portal) return;
    const anchor = rootRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const panelHeight = panel.offsetHeight;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - 8 - (rect.bottom + 6);
    const spaceAbove = rect.top - 6 - 8;
    setFlipUp(panelHeight > spaceBelow && (panelHeight <= spaceAbove || spaceAbove > spaceBelow));
  }, [open, portal]);

  useEffect(() => {
    if (!open || !portal) return;
    const close = () => requestClose(false);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open, portal]);

  useEffect(() => {
    if (phase !== "closed") return;
    setPos(null);
    setFlipUp(false);
    if (restoreTriggerRef.current) triggerElement()?.focus({ preventScroll: true });
    restoreTriggerRef.current = false;
  }, [phase]);

  // right: "auto" neutralises the class-based `.align-right { right: 0 }` —
  // combined with the inline fixed `left` it would otherwise double-constrain
  // the panel and stretch it to a viewport-spanning width.
  const panelStyle: CSSProperties | undefined = portal
    ? pos
      ? {
          position: "fixed",
          top: pos.up ? "auto" : pos.top,
          bottom: pos.up ? pos.bottom : "auto",
          left: pos.left,
          right: "auto",
          transformOrigin: `${pos.up ? "bottom" : "top"} ${align === "right" ? "right" : "left"}`
        }
      : { position: "fixed", top: -9999, left: -9999, right: "auto", visibility: "hidden" }
    : undefined;

  const panel =
    phase !== "closed" ? (
      <div
        ref={panelRef}
        id={panelId}
        className={`action-menu align-${align}${portal ? " is-portal" : ""}${flipUp ? " is-up" : ""}${phase === "closing" ? " is-closing" : ""}${panelClassName ? ` ${panelClassName}` : ""}`}
        style={panelStyle}
        role={kind === "panel" ? "dialog" : "menu"}
        aria-label={panelLabel}
        aria-orientation={kind === "panel" ? undefined : "vertical"}
      >
        {children(closeFromItem)}
      </div>
    ) : null;

  return (
    <div ref={rootRef} className={`menu-root${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
      <div
        className="menu-trigger-slot"
        onClick={() => (open ? requestClose(true) : requestOpen("first"))}
        onKeyDown={(event) => {
          if (kind === "panel" || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          requestOpen(event.key === "ArrowUp" ? "last" : "first");
        }}
      >
        {trigger(open, {
          id: triggerId,
          "aria-haspopup": kind === "panel" ? "dialog" : "menu",
          "aria-expanded": open,
          "aria-controls": phase !== "closed" ? panelId : undefined
        })}
      </div>
      {portal ? (panel ? createPortal(panel, document.body) : null) : panel}
    </div>
  );
}
