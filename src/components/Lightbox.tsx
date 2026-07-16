import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import type { LightboxItem } from "../lib/types";

interface LightboxProps {
  items: LightboxItem[];
  index: number;
  onClose: () => void;
}

/** Full-screen image viewer: backdrop fade, image zoom-in, ←/→ paging. */
export function Lightbox({ items, index, onClose }: LightboxProps) {
  const { tr } = useI18n();
  const [current, setCurrent] = useState(index);
  const [closing, setClosing] = useState(false);
  const reducedMotion = useReducedMotion();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function requestClose() {
    if (closing) return;
    if (reducedMotion) {
      closeRef.current();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => closeRef.current(), 170);
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, initialFocusRef: closeButtonRef });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") setCurrent((value) => (value + items.length - 1) % items.length);
      if (event.key === "ArrowRight") setCurrent((value) => (value + 1) % items.length);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(closeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const item = items[current];

  return (
    <div
      ref={overlayRef}
      className={`overlay lightbox${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("View image", "查看图片")}
      tabIndex={-1}
      onClick={requestClose}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="lightbox-close icon-button"
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
            className="lightbox-nav prev icon-button"
            aria-label={tr("Previous image", "上一张")}
            onClick={(event) => {
              event.stopPropagation();
              setCurrent((value) => (value + items.length - 1) % items.length);
            }}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="lightbox-nav next icon-button"
            aria-label={tr("Next image", "下一张")}
            onClick={(event) => {
              event.stopPropagation();
              setCurrent((value) => (value + 1) % items.length);
            }}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
        </>
      ) : null}
      <img
        key={item.src}
        className="lightbox-image"
        src={item.src}
        alt={tr(`Image ${current + 1} of ${items.length}`, `第 ${current + 1} 张图片，共 ${items.length} 张`)}
        referrerPolicy={item.external ? "no-referrer" : undefined}
        onClick={(event) => event.stopPropagation()}
      />
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
