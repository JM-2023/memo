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

function dirClass(dir: number): string {
  return dir > 0 ? " dir-fwd" : dir < 0 ? " dir-back" : "";
}

/**
 * Directional text swap: the outgoing copy slides out on an absolute layer
 * while the incoming one slides in, and the container width tweens between
 * the two sizes so neighbouring content glides instead of jumping.
 */
export function SwapText({ id, dir = 0, className, children }: SwapTextProps) {
  const [old, setOld] = useState<OldLayer | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const fromWidthRef = useRef<number | null>(null);
  const widthAnimationRef = useRef<Animation | null>(null);
  const lastRef = useRef<{ id: string; node: ReactNode } | null>(null);
  const serialRef = useRef(0);
  // Frozen at swap time so a later `dir` prop change can't rename (and hence
  // restart) the entrance animation mid-flight.
  const enterDirRef = useRef(0);

  const last = lastRef.current;
  if (last !== null && last.id !== id) {
    // Render-phase capture: the DOM still shows the outgoing content, so its
    // current visual width is the starting point of the width tween. Using
    // the rendered rect (rather than offsetWidth) lets a rapid second swap
    // take over from the exact in-flight width without a snap.
    fromWidthRef.current = boxRef.current?.getBoundingClientRect().width ?? null;
    serialRef.current += 1;
    enterDirRef.current = dir;
    setOld({ node: last.node, dir, serial: serialRef.current });
  }
  lastRef.current = { id, node: children };

  useLayoutEffect(() => {
    const el = boxRef.current;
    const from = fromWidthRef.current;
    fromWidthRef.current = null;
    // Cancel after the outgoing visual width has been captured above. This
    // reveals the new content's natural width for measurement and prevents
    // multiple width effects from competing during quick repeated swaps.
    widthAnimationRef.current?.cancel();
    widthAnimationRef.current = null;
    if (!el || from === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.offsetWidth;
    if (Math.abs(to - from) < 1) return;
    const animation = el.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: 220,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)"
    });
    widthAnimationRef.current = animation;
    void animation.finished.then(
      () => {
        if (widthAnimationRef.current === animation) widthAnimationRef.current = null;
      },
      () => undefined
    );

    return () => {
      if (widthAnimationRef.current !== animation) return;
      animation.cancel();
      widthAnimationRef.current = null;
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
