import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface SwapTextProps {
  /** Identity of the content; a change triggers the swap animation. */
  id: string;
  /** 1 = forward (old exits left, new enters from the right), -1 = back, 0 = crossfade. */
  dir?: number;
  className?: string;
  children: ReactNode;
}

interface OldLayer {
  node: ReactNode;
  dir: number;
  serial: number;
}

interface BoxSize {
  width: number;
  height: number;
}

function dirClass(dir: number): string {
  return dir > 0 ? " dir-fwd" : dir < 0 ? " dir-back" : "";
}

/**
 * Directional text swap: the outgoing copy slides out on an absolute layer
 * while the incoming one slides in, and the container tweens between the two
 * sizes so neighbouring content glides instead of jumping. Width is the usual
 * axis; height joins in when the incoming content re-wraps — the heatmap
 * title folds its count under the date range once the sidebar runs out of
 * room, and the grid below has to glide down a line rather than jump.
 */
export function SwapText({ id, dir = 0, className, children }: SwapTextProps) {
  const [old, setOld] = useState<OldLayer | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const fromSizeRef = useRef<BoxSize | null>(null);
  const sizeAnimationRef = useRef<Animation | null>(null);
  const lastRef = useRef<{ id: string; node: ReactNode } | null>(null);
  const serialRef = useRef(0);
  // Frozen at swap time so a later `dir` prop change can't rename (and hence
  // restart) the entrance animation mid-flight.
  const enterDirRef = useRef(0);

  const last = lastRef.current;
  if (last !== null && last.id !== id) {
    // Render-phase capture: the DOM still shows the outgoing content, so its
    // current visual size is the starting point of the size tween. Using the
    // rendered rect (rather than offsetWidth/Height) lets a rapid second swap
    // take over from the exact in-flight size without a snap.
    const rect = boxRef.current?.getBoundingClientRect();
    fromSizeRef.current = rect ? { width: rect.width, height: rect.height } : null;
    serialRef.current += 1;
    enterDirRef.current = dir;
    setOld({ node: last.node, dir, serial: serialRef.current });
  }
  lastRef.current = { id, node: children };

  useLayoutEffect(() => {
    const el = boxRef.current;
    const from = fromSizeRef.current;
    fromSizeRef.current = null;
    // Cancel after the outgoing visual size has been captured above. This
    // reveals the new content's natural size for measurement and prevents
    // multiple size effects from competing during quick repeated swaps.
    sizeAnimationRef.current?.cancel();
    sizeAnimationRef.current = null;
    if (!el || from === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = { width: el.offsetWidth, height: el.offsetHeight };
    const start: Keyframe = {};
    const end: Keyframe = {};
    if (Math.abs(to.width - from.width) >= 1) {
      start.width = `${from.width}px`;
      end.width = `${to.width}px`;
    }
    if (Math.abs(to.height - from.height) >= 1) {
      start.height = `${from.height}px`;
      end.height = `${to.height}px`;
    }
    if (Object.keys(end).length === 0) return;
    const animation = el.animate([start, end], {
      duration: 220,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)"
    });
    sizeAnimationRef.current = animation;
    void animation.finished.then(
      () => {
        if (sizeAnimationRef.current === animation) sizeAnimationRef.current = null;
      },
      () => undefined
    );

    return () => {
      if (sizeAnimationRef.current !== animation) return;
      animation.cancel();
      sizeAnimationRef.current = null;
    };
  }, [id]);

  const entered = serialRef.current > 0;
  return (
    <span ref={boxRef} className={`swap${className ? ` ${className}` : ""}`}>
      <span key={id} className={`swap-cur${entered ? ` swap-anim${dirClass(enterDirRef.current)}` : ""}`}>
        {children}
      </span>
      {old ? (
        <span
          key={`old-${old.serial}`}
          className={`swap-old${dirClass(old.dir)}`}
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setOld(null);
          }}
        >
          {old.node}
        </span>
      ) : null}
    </span>
  );
}
