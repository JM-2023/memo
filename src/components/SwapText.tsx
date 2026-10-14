import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EASE_OUT } from "../lib/motion";

interface SwapTextProps {
  /** Identity of the content; a change triggers the swap animation. */
  id: string;
  /** 1 = forward (old exits left, new enters from the right), -1 = back, 0 = crossfade. */
  dir?: number;
  className?: string;
  /**
   * Tween the box's width between the old and new content (default). Off
   * for content that sits centred between fixed neighbours — the heatmap
   * title between its arrows — where a width tween moves nothing but forces
   * the box through widths the content doesn't fit, clipping its ends.
   */
  tweenWidth?: boolean;
  children: ReactNode;
}

interface OldLayer {
  node: ReactNode;
  dir: number;
  serial: number;
  /** The outgoing layer's rendered width, so it keeps its line breaks while the box tweens. */
  width: number | null;
}

interface BoxSize {
  width: number;
  height: number;
}

function dirClass(dir: number): string {
  return dir > 0 ? " dir-fwd" : dir < 0 ? " dir-back" : "";
}

/**
 * The box's laid-out size: fractional, and blind to transforms. A rect is
 * scaled by every transformed ancestor — a label measured inside a button
 * still pressed to 0.96 came out 4% short, so the incoming copy was pinned
 * narrower than its own text, sat off-centre with its last letter clipped,
 * and jumped back when the pin came off. offsetWidth/Height ignore the
 * transform but round, which left the tween a fraction off the layout it
 * hands over to. Null when the box is not laid out.
 */
function layoutSize(el: HTMLElement): BoxSize | null {
  const style = window.getComputedStyle(el);
  const width = parseFloat(style.width);
  const height = parseFloat(style.height);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

/**
 * Directional text swap: the outgoing copy slides out on an absolute layer
 * while the incoming one slides in, and the container tweens between the two
 * sizes so neighbouring content glides instead of jumping. Width is the usual
 * axis; height joins in when the incoming content re-wraps — the heatmap
 * title folds its count under the date range once the sidebar runs out of
 * room, and the grid below has to glide down a line rather than jump.
 *
 * While the box tweens, both layers are pinned to their own final widths: the
 * incoming content is laid out at the width it will have when the tween ends,
 * the outgoing at the width it had when it started. Without the pins, content
 * that wraps would re-wrap at every intermediate width — a week range growing
 * into a month name broke onto two lines for the length of the tween and then
 * snapped back to one. Pinned, the box clips a few pixels at the edges mid-tween
 * instead of reflowing the text.
 */
export function SwapText({ id, dir = 0, className, tweenWidth = true, children }: SwapTextProps) {
  const [old, setOld] = useState<OldLayer | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);
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
    // current size is the starting point of the size tween. Mid-tween that is
    // the animated width, so a rapid second swap takes over from the exact
    // in-flight size without a snap.
    const size = boxRef.current ? layoutSize(boxRef.current) : null;
    fromSizeRef.current = size;
    serialRef.current += 1;
    enterDirRef.current = dir;
    setOld({ node: last.node, dir, serial: serialRef.current, width: size ? size.width : null });
  }
  lastRef.current = { id, node: children };

  useLayoutEffect(() => {
    const el = boxRef.current;
    const from = fromSizeRef.current;
    fromSizeRef.current = null;
    // Cancel after the outgoing size has been captured above. This
    // reveals the new content's natural size for measurement and prevents
    // multiple size effects from competing during quick repeated swaps.
    sizeAnimationRef.current?.cancel();
    sizeAnimationRef.current = null;
    if (!el || from === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = layoutSize(el);
    if (to === null) return;
    const start: Keyframe = {};
    const end: Keyframe = {};
    if (tweenWidth && Math.abs(to.width - from.width) >= 1) {
      start.width = `${from.width}px`;
      end.width = `${to.width}px`;
    }
    if (Math.abs(to.height - from.height) >= 1) {
      start.height = `${from.height}px`;
      end.height = `${to.height}px`;
    }
    if (Object.keys(end).length === 0) return;
    // Pin the incoming layer to its final width before the box starts
    // narrower (or wider) than that, so its line breaks are settled from the
    // first frame. A hundredth of a pixel over the layout width: the computed
    // width comes back rounded to a few decimals, and a pin even a fraction
    // short of the natural width wraps the last word. Any more than a hair
    // over shows: a button centres its text in the wider layer, so a
    // whole-pixel ceiling left the label up to half a pixel off, and it
    // twitched back when the pin came off with the tween and the box sized
    // the layer again.
    const cur = tweenWidth ? curRef.current : null;
    if (cur) cur.style.width = `${to.width + 0.01}px`;
    const unpin = () => {
      if (cur) cur.style.width = "";
    };
    const animation = el.animate([start, end], {
      duration: 220,
      easing: EASE_OUT
    });
    sizeAnimationRef.current = animation;
    void animation.finished.then(
      () => {
        unpin();
        if (sizeAnimationRef.current === animation) sizeAnimationRef.current = null;
      },
      () => unpin()
    );

    return () => {
      unpin();
      if (sizeAnimationRef.current !== animation) return;
      animation.cancel();
      sizeAnimationRef.current = null;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const entered = serialRef.current > 0;
  return (
    <span ref={boxRef} className={`swap${className ? ` ${className}` : ""}`}>
      <span ref={curRef} key={id} className={`swap-cur${entered ? ` swap-anim${dirClass(enterDirRef.current)}` : ""}`}>
        {children}
      </span>
      {old ? (
        <span
          key={`old-${old.serial}`}
          className={`swap-old${dirClass(old.dir)}`}
          style={old.width === null ? undefined : { width: `${old.width}px` }}
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
