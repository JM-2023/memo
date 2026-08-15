import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { ORB_PAINTERS, parseHexRgb, type OrbInk, type OrbState } from "../lib/thinkingOrb";

interface ThinkingOrbProps {
  /** `working` while the model is fetched, started or queried; `solving` while the index builds. */
  state: OrbState;
  /** Rendered size in CSS px. The presets are tuned at 64; other sizes scale the dots sub-linearly. */
  size?: number;
}

/* Fallbacks for the depth ramp — the light --orb-near / --orb-far in
   app.css. Only reached if those custom properties resolve to nothing (a
   stripped stylesheet, or a test environment without layout). */
const INK_FALLBACK: OrbInk = { near: [45, 98, 72], far: [174, 200, 184] };

function readInk(el: HTMLElement, fallback: OrbInk): OrbInk {
  const styles = getComputedStyle(el);
  const near = styles.getPropertyValue("--orb-near");
  const far = styles.getPropertyValue("--orb-far");
  return {
    near: near ? parseHexRgb(near, fallback.near) : fallback.near,
    far: far ? parseHexRgb(far, fallback.far) : fallback.far
  };
}

/**
 * A dotted thought-orb (see src/lib/thinkingOrb.ts for the two painters).
 *
 * The clock is `performance.now()`, so every mounted orb runs in phase, and
 * each instance parks its own rAF loop while it is scrolled out of view or
 * the tab is hidden. Colour comes from --orb-near / --orb-far, re-read
 * whenever the theme flips, so the orb swaps with the rest of the app.
 *
 * Reduced motion paints one deterministic frame and stops: unlike the app's
 * spinners — which keep turning because they are sometimes the only "still
 * working" signal — the orb always sits beside a live status line and a
 * ticking figure, so nothing is lost by holding it still.
 *
 * Decorative by design: it restates a status its caller already announces,
 * so it stays out of the accessibility tree.
 */
export function ThinkingOrb({ state, size = 64 }: ThinkingOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  // Bumped by either theme channel — the manual [data-theme] override and the
  // OS preference — so the next effect run re-reads the resolved tokens.
  const [themeEpoch, setThemeEpoch] = useState(0);

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

    const ink = readInk(canvas, INK_FALLBACK);
    const { speed, draw } = ORB_PAINTERS[state];
    const frame = (seconds: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      draw(ctx, size, seconds, ink);
    };

    if (reduced) {
      // 0.6s in: past the entrance, with the orbits spread and a band mid-turn.
      frame(0.6);
      return;
    }

    let raf = 0;
    let running = false;
    const loop = () => {
      frame((performance.now() / 1000) * speed);
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

    frame((performance.now() / 1000) * speed);

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
  }, [state, size, themeEpoch, reduced]);

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
