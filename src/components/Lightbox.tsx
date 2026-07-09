import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function requestClose() {
    setClosing(true);
    window.setTimeout(() => closeRef.current(), 240);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
      if (event.key === "ArrowLeft") setCurrent((value) => (value + items.length - 1) % items.length);
      if (event.key === "ArrowRight") setCurrent((value) => (value + 1) % items.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const item = items[current];

  return (
    <div
      className={`overlay lightbox${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("View image", "查看图片")}
      onClick={requestClose}
    >
      <button type="button" className="lightbox-close icon-button" onClick={requestClose} aria-label={tr("Close", "关闭")}>
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
        alt=""
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
        <div className="lightbox-count" aria-hidden="true">
          {current + 1} / {items.length}
        </div>
      ) : null}
    </div>
  );
}
