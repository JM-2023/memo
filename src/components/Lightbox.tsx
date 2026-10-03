import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import type { LightboxItem } from "../lib/types";

interface LightboxProps {
  items: LightboxItem[];
  index: number;
  onClose: () => void;
}

/** Travel before a touch commits to an axis; under it a touch is still a tap. */
const AXIS_LOCK_PX = 10;
/** A flick this fast (px/ms) commits even when the travel is short. */
const FLICK_SPEED = 0.45;

interface Drag {
  id: number;
  x0: number;
  y0: number;
  axis: "x" | "y" | null;
  dx: number;
  dy: number;
  /** Recent samples, for the release velocity. */
  samples: Array<{ x: number; y: number; t: number }>;
}

/**
 * Full-screen image viewer: backdrop fade, image zoom-in on open, then a
 * directional slide per page. Paging by ←/→, the arrow buttons, or a
 * horizontal swipe; a downward swipe dismisses. Only single-finger touch is
 * claimed (`touch-action: pinch-zoom`), so the platform's own pinch zoom
 * keeps working, and once the page is zoomed the swipes stand down so a
 * finger pans the zoomed view instead.
 */
export function Lightbox({ items, index, onClose }: LightboxProps) {
  const { tr } = useI18n();
  // `dir` picks the entrance: null is the first open (zoom), then the
  // direction of travel for each page change.
  const [view, setView] = useState<{ current: number; dir: "fwd" | "back" | null }>({ current: index, dir: null });
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dragRef = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);

  function requestClose() {
    if (closing) return;
    if (reducedMotion) {
      closeRef.current();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => closeRef.current(), 170);
  }

  function page(step: 1 | -1) {
    setView((value) => ({
      current: (value.current + items.length + step) % items.length,
      dir: step > 0 ? "fwd" : "back"
    }));
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, initialFocusRef: closeButtonRef });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") page(-1);
      if (event.key === "ArrowRight") page(1);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(closeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  // A pinch-zoomed page hands single-finger pans back to the browser.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setZoomed(viewport.scale > 1.01);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);

  const current = Math.min(view.current, items.length - 1);
  const item = items[current];

  function setDragStyle(dx: number, dy: number, fade: number) {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.style.setProperty("--lb-dx", `${dx}px`);
    overlay.style.setProperty("--lb-dy", `${dy}px`);
    overlay.style.setProperty("--lb-fade", String(fade));
  }

  function endDrag() {
    dragRef.current = null;
    setDragging(false);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) {
      // A second finger means pinch: let it go to the browser untouched.
      if (dragRef.current) {
        setDragStyle(0, 0, 0);
        endDrag();
      }
      return;
    }
    // A fresh touch is a new gesture: only the click that trails a swipe's
    // own release is swallowed, never a deliberate tap that follows it.
    suppressClickUntil.current = 0;
    if (event.pointerType === "mouse" || zoomed || closing) return;
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    dragRef.current = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      axis: null,
      dx: 0,
      dy: 0,
      samples: [{ x: event.clientX, y: event.clientY, t: event.timeStamp }]
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    drag.dx = event.clientX - drag.x0;
    drag.dy = event.clientY - drag.y0;
    drag.samples.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });
    if (drag.samples.length > 6) drag.samples.shift();
    if (!drag.axis) {
      if (Math.hypot(drag.dx, drag.dy) < AXIS_LOCK_PX) return;
      drag.axis = Math.abs(drag.dx) > Math.abs(drag.dy) ? "x" : "y";
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture is a nicety; the gesture still tracks without it.
      }
      setDragging(true);
    }
    if (drag.axis === "x") {
      // A lone image has nowhere to page to: resist instead.
      setDragStyle(items.length > 1 ? drag.dx : drag.dx * 0.25, 0, 0);
    } else {
      const dy = drag.dy > 0 ? drag.dy : drag.dy * 0.25;
      setDragStyle(0, dy, Math.min(1, Math.max(0, dy) / (window.innerHeight * 0.5)));
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    endDrag();
    if (!drag.axis) return;
    suppressClickUntil.current = event.timeStamp + 400;
    const first = drag.samples.find((sample) => event.timeStamp - sample.t <= 100) ?? drag.samples[0];
    const elapsed = Math.max(1, event.timeStamp - first.t);
    const vx = (event.clientX - first.x) / elapsed;
    const vy = (event.clientY - first.y) / elapsed;
    if (drag.axis === "x") {
      const far = Math.abs(drag.dx) > window.innerWidth * 0.25;
      const flick = Math.abs(vx) > FLICK_SPEED && Math.abs(drag.dx) > 30 && Math.sign(vx) === Math.sign(drag.dx);
      setDragStyle(0, 0, 0);
      if (items.length > 1 && (far || flick)) page(drag.dx < 0 ? 1 : -1);
      return;
    }
    const far = drag.dy > window.innerHeight * 0.18;
    const flick = vy > FLICK_SPEED && drag.dy > 40;
    if (far || flick) {
      // Leave the image where the finger let go; the overlay fades it out.
      requestClose();
      return;
    }
    setDragStyle(0, 0, 0);
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current || dragRef.current.id !== event.pointerId) return;
    setDragStyle(0, 0, 0);
    endDrag();
  }

  const status = failed === item.src ? "failed" : loaded === item.src ? "ready" : "loading";
  const classes = ["overlay", "lightbox"];
  if (items.length > 1) classes.push("has-nav");
  if (dragging) classes.push("is-dragging");
  if (zoomed) classes.push("is-zoomed");
  if (closing) classes.push("is-closing");

  return (
    <div
      ref={overlayRef}
      className={classes.join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label={tr("View image", "查看图片")}
      tabIndex={-1}
      onClickCapture={(event) => {
        // The tail of a swipe is not a tap on the backdrop.
        if (event.timeStamp < suppressClickUntil.current) {
          event.stopPropagation();
          event.preventDefault();
        }
      }}
      onClick={requestClose}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="lightbox-close"
        onClick={(event) => {
          event.stopPropagation();
          requestClose();
        }}
        aria-label={tr("Close", "关闭")}
      >
        <X size={20} aria-hidden="true" />
      </button>
      {items.length > 1 ? (
        <>
          <button
            type="button"
            className="lightbox-nav prev"
            aria-label={tr("Previous image", "上一张")}
            onClick={(event) => {
              event.stopPropagation();
              page(-1);
            }}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="lightbox-nav next"
            aria-label={tr("Next image", "下一张")}
            onClick={(event) => {
              event.stopPropagation();
              page(1);
            }}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
        </>
      ) : null}
      <img
        key={item.src}
        className={`lightbox-image${status === "ready" ? "" : " is-pending"}${view.dir ? ` dir-${view.dir}` : ""}`}
        src={item.src}
        alt={tr(`Image ${current + 1} of ${items.length}`, `第 ${current + 1} 张图片，共 ${items.length} 张`)}
        referrerPolicy={item.external ? "no-referrer" : undefined}
        aria-busy={status === "loading" || undefined}
        onLoad={() => {
          setLoaded(item.src);
          setFailed((value) => (value === item.src ? null : value));
        }}
        onError={() => setFailed(item.src)}
        onClick={(event) => event.stopPropagation()}
      />
      {status === "loading" ? (
        <span className="lightbox-status is-loading" aria-hidden="true">
          <Loader2 size={26} className="spin" />
        </span>
      ) : null}
      {status === "failed" ? (
        <p className="lightbox-status is-failed" role="alert">
          <ImageOff size={20} aria-hidden="true" />
          {tr("Couldn't load this image", "这张图片加载失败")}
        </p>
      ) : null}
      {item.external ? (
        <a
          className="lightbox-source"
          href={item.src}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLink size={13} aria-hidden="true" />
          {tr("Open original", "打开原图")}
        </a>
      ) : null}
      {items.length > 1 ? (
        <div className="lightbox-count" role="status" aria-live="polite" aria-atomic="true">
          {current + 1} / {items.length}
        </div>
      ) : null}
    </div>
  );
}
