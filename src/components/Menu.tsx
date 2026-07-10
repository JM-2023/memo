import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface MenuProps {
  /** Renders the trigger button; `open` lets it style its active state. */
  trigger: (open: boolean) => ReactNode;
  /** Menu body; call `close()` from item handlers. */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
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

/**
 * Popover action menu (Tier A floating glass). Owns open state, closes on
 * outside pointer-down and Escape, and animates in via .action-menu CSS.
 * Closing holds the panel one beat in a "closing" phase so it can play the
 * reverse morph before unmounting.
 */
export function Menu({ trigger, children, align = "right", className, panelClassName, portal = false }: MenuProps) {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [pos, setPos] = useState<PortalPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = phase === "open";

  function requestClose() {
    setPhase((value) => (value === "open" ? "closing" : value));
  }

  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setPhase("closed"), 170);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      requestClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

  useEffect(() => {
    if (!open || !portal) return;
    const close = () => requestClose();
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open, portal]);

  useEffect(() => {
    if (phase === "closed") setPos(null);
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
        className={`action-menu align-${align}${portal ? " is-portal" : ""}${phase === "closing" ? " is-closing" : ""}${panelClassName ? ` ${panelClassName}` : ""}`}
        style={panelStyle}
        role="menu"
      >
        {children(requestClose)}
      </div>
    ) : null;

  return (
    <div ref={rootRef} className={`menu-root${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
      <div className="menu-trigger-slot" onClick={() => setPhase((value) => (value === "open" ? "closing" : "open"))}>
        {trigger(open)}
      </div>
      {portal ? (panel ? createPortal(panel, document.body) : null) : panel}
    </div>
  );
}
