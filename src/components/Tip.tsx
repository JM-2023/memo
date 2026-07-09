import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TipContent {
  /** Emphasised leading part, e.g. "3 条". */
  strong?: string;
  text: string;
}

interface TipState extends TipContent {
  /** Anchor top-center (or bottom-center when flipped) in viewport coords. */
  x: number;
  y: number;
  below: boolean;
}

interface TipApi {
  show: (anchor: Element, tip: TipContent) => void;
  hide: () => void;
}

const TipContext = createContext<TipApi | null>(null);

export function useTip(): TipApi {
  const api = useContext(TipContext);
  if (!api) throw new Error("useTip must be used inside <TipProvider>");
  return api;
}

const SHOW_DELAY = 90;
const HIDE_GRACE = 80;

/**
 * One floating tooltip for the whole app, portaled to <body> so it can never
 * hide under sibling cells, cards or modals (the old data-tip pseudo-element
 * could). Hover-intent timing: a short delay before the first show, a grace
 * period on leave — so sweeping across a heat grid makes the bubble glide
 * from cell to cell instead of flickering.
 */
export function TipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const [visible, setVisible] = useState(false);
  // Entering from hidden: position instantly (no transform transition).
  const [snap, setSnap] = useState(true);

  const bubbleRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  const visibleRef = useRef(false);
  visibleRef.current = visible;

  const place = useCallback((anchor: Element, content: TipContent): TipState => {
    const rect = anchor.getBoundingClientRect();
    const below = rect.top < 76;
    return { ...content, x: rect.left + rect.width / 2, y: below ? rect.bottom : rect.top, below };
  }, []);

  const show = useCallback(
    (anchor: Element, content: TipContent) => {
      window.clearTimeout(hideTimer.current);
      if (visibleRef.current) {
        window.clearTimeout(showTimer.current);
        setSnap(false);
        setTip(place(anchor, content));
        return;
      }
      window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => {
        setSnap(true);
        setTip(place(anchor, content));
        setVisible(true);
      }, SHOW_DELAY);
    },
    [place]
  );

  const hide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), HIDE_GRACE);
  }, []);

  // Anything that moves or reinterprets the page kills the tip immediately.
  useEffect(() => {
    if (!visible) return;
    const dismiss = () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      setVisible(false);
    };
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("pointerdown", dismiss, true);
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("pointerdown", dismiss, true);
    };
  }, [visible]);

  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
    },
    []
  );

  // Keep the bubble on screen: nudge it horizontally once its true width is
  // known (direct style write — no re-render, no feedback loop).
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble || !tip) return;
    const half = bubble.offsetWidth / 2;
    const clampedX = Math.min(Math.max(tip.x, 8 + half), window.innerWidth - 8 - half);
    const dx = clampedX - tip.x;
    bubble.style.setProperty("--tip-dx", `${dx.toFixed(1)}px`);
  }, [tip]);

  const api = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <TipContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          className={`tip${visible ? " is-show" : ""}${snap ? " is-snap" : ""}${tip?.below ? " is-below" : ""}`}
          style={tip ? { transform: `translate3d(${tip.x.toFixed(1)}px, ${tip.y.toFixed(1)}px, 0)` } : undefined}
          aria-hidden="true"
        >
          {tip ? (
            <div ref={bubbleRef} className="tip-bubble">
              {tip.strong ? <b>{tip.strong}</b> : null}
              <span>{tip.text}</span>
            </div>
          ) : null}
        </div>,
        document.body
      )}
    </TipContext.Provider>
  );
}
