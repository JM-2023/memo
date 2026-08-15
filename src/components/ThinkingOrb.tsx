import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";
import {
  blendDots,
  blendInk,
  easeInOut,
  fadeLines,
  lerp,
  MORPH_MS,
  ORB_MARKS,
  paintDots,
  paintLines,
  parseHexRgb,
  type OrbInk,
  type OrbState
} from "../lib/thinkingOrb";

interface ThinkingOrbProps {
  /** Which of the six marks to wear — see src/lib/thinkingOrb.ts. */
  state: OrbState;
  /** Rendered size in CSS px. The presets are tuned at 64; other sizes scale the dots sub-linearly. */
  size?: number;
  /** Rest states wear the gray ramp (--orb-near-mute / --orb-far-mute) instead of the sage. */
  mute?: boolean;
}

/* Fallbacks for the two depth ramps — the light values in app.css. Only
   reached if those custom properties resolve to nothing (a stripped
   stylesheet, or a test environment without layout). */
const INK_FALLBACK: OrbInk = { near: [45, 98, 72], far: [174, 200, 184] };
const INK_MUTE_FALLBACK: OrbInk = { near: [118, 127, 141], far: [201, 206, 215] };

function readInk(el: HTMLElement, mute: boolean): OrbInk {
  const styles = getComputedStyle(el);
  const fallback = mute ? INK_MUTE_FALLBACK : INK_FALLBACK;
  const near = styles.getPropertyValue(mute ? "--orb-near-mute" : "--orb-near");
  const far = styles.getPropertyValue(mute ? "--orb-far-mute" : "--orb-far");
  return {
    near: near ? parseHexRgb(near, fallback.near) : fallback.near,
    far: far ? parseHexRgb(far, fallback.far) : fallback.far
  };
}

interface OrbTarget {
  state: OrbState;
  ink: OrbInk;
}

/**
 * A dotted thought-orb (see src/lib/thinkingOrb.ts for the six collectors).
 *
 * The clock is `performance.now()`, so every mounted orb runs in phase, and
 * each instance parks its own rAF loop while it is scrolled out of view or
 * the tab is hidden. Colour comes from --orb-near / --orb-far (or the mute
 * pair), re-read whenever the theme flips, so the orb swaps with the rest
 * of the app.
 *
 * A state or ink change is a real MORPH: both collectors keep running on
 * their own clocks while the two dot fields are resampled to a common
 * count, paired in angular order and interpolated over 760ms — the dust
 * reorganises itself from one mark into the next rather than one image
 * cross-fading into another.
 *
 * Reduced motion paints one deterministic frame and stops: unlike the app's
 * spinners — which keep turning because they are sometimes the only "still
 * working" signal — the orb always sits beside a live status line and a
 * ticking figure, so nothing is lost by holding it still.
 *
 * Decorative by design: it restates a status its caller already announces,
 * so it stays out of the accessibility tree.
 */
export function ThinkingOrb({ state, size = 64, mute = false }: ThinkingOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  // Bumped by either theme channel — the manual [data-theme] override and the
  // OS preference — so the next effect run re-reads the resolved tokens.
  const [themeEpoch, setThemeEpoch] = useState(0);

  // The mark on screen right now, and — during a morph — where it came from.
  const targetRef = useRef<OrbTarget | null>(null);
  const fromRef = useRef<(OrbTarget & { at: number }) | null>(null);

  useEffect(() => {
    const bump = () => setThemeEpoch((epoch) => epoch + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener("change", bump);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", bump);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    // A changed state or ramp starts one morph from whatever was current.
    const ink = readInk(canvas, mute);
    const previous = targetRef.current;
    const next: OrbTarget = { state, ink };
    if (previous && (previous.state !== state || JSON.stringify(previous.ink) !== JSON.stringify(ink)) && !reduced) {
      fromRef.current = { ...previous, at: performance.now() };
    }
    targetRef.current = next;

    /** Each mark runs on its own scaled clock, morphs included. */
    const clock = (of: OrbState) => (performance.now() / 1000) * ORB_MARKS[of].speed;

    const frame = (still: boolean) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const target = targetRef.current ?? next;

      let k = 1;
      if (fromRef.current && !still) {
        k = easeInOut(Math.min(1, (performance.now() - fromRef.current.at) / MORPH_MS));
        if (k >= 1) fromRef.current = null;
      } else if (still) {
        fromRef.current = null;
      }

      // 0.6s in: past the entrance, with the orbits spread and a band mid-turn.
      const cur = ORB_MARKS[target.state].collect(size, still ? 0.6 : clock(target.state));
      if (!fromRef.current) {
        paintLines(ctx, cur.lines, target.ink);
        paintDots(ctx, cur.dots, target.ink, cur.rMin);
        return;
      }

      const from = fromRef.current;
      const old = ORB_MARKS[from.state].collect(size, clock(from.state));
      const blended = blendInk(from.ink, target.ink, k);
      paintLines(ctx, fadeLines(old.lines, 1 - k), blended);
      paintLines(ctx, fadeLines(cur.lines, k), blended);
      paintDots(ctx, blendDots(old.dots, cur.dots, k, size), blended, lerp(old.rMin, cur.rMin, k));
    };

    if (reduced) {
      frame(true);
      return;
    }

    let raf = 0;
    let running = false;
    const loop = () => {
      frame(false);
      if (running) raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    frame(false);

    let onscreen = true;
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            onscreen = entry.isIntersecting;
            if (onscreen && document.visibilityState !== "hidden") start();
            else stop();
          })
        : null;
    observer?.observe(canvas);
    if (!observer) start();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else if (onscreen) start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [state, size, mute, themeEpoch, reduced]);

  return (
    <canvas
      ref={canvasRef}
      className="thinking-orb"
      data-orb={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
