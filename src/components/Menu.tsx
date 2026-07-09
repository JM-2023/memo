import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface MenuProps {
  /** Renders the trigger button; `open` lets it style its active state. */
  trigger: (open: boolean) => ReactNode;
  /** Menu body; call `close()` from item handlers. */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  /**
   * Render the panel in a body portal with fixed positioning — needed when
   * the trigger lives inside an overflow container (the sidebar tag list)
   * that would otherwise clip an absolutely-positioned panel. Flips upward
   * near the bottom edge; any scroll closes it.
   */
  portal?: boolean;
}

interface PortalPos {
  top: number;
  left: number;
  up: boolean;
}

/**
 * Popover action menu (Tier A floating glass). Owns open state, closes on
 * outside pointer-down and Escape, and animates in via .action-menu CSS.
 */
export function Menu({ trigger, children, align = "right", className, portal = false }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PortalPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
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
      top: up ? rect.top - 6 - panelHeight : rect.bottom + 6,
      left: Math.min(Math.max(rawLeft, 8), window.innerWidth - 8 - panelWidth),
      up
    });
  }, [open, portal, align]);

  useEffect(() => {
    if (!open || !portal) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open, portal]);

  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  const panelStyle: CSSProperties | undefined = portal
    ? pos
      ? { position: "fixed", top: pos.top, left: pos.left, transformOrigin: `${pos.up ? "bottom" : "top"} ${align === "right" ? "right" : "left"}` }
      : { position: "fixed", top: -9999, left: -9999 }
    : undefined;

  const panel = open ? (
    <div ref={panelRef} className={`action-menu align-${align}${portal ? " is-portal" : ""}`} style={panelStyle} role="menu">
      {children(() => setOpen(false))}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`menu-root${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
      <div className="menu-trigger-slot" onClick={() => setOpen((value) => !value)}>
        {trigger(open)}
      </div>
      {portal ? (panel ? createPortal(panel, document.body) : null) : panel}
    </div>
  );
}
