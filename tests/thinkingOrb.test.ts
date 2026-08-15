import { describe, expect, it } from "vitest";
import {
  blendDots,
  blendInk,
  easeInOut,
  fadeLines,
  MORPH_MS,
  ORB_MARKS,
  type OrbInk,
  type OrbState
} from "../src/lib/thinkingOrb";

const STATES = Object.keys(ORB_MARKS) as OrbState[];

describe("thinking-orb marks", () => {
  it("collects a sane dot field for every mark at the panel's 112px", () => {
    for (const state of STATES) {
      const { speed, collect } = ORB_MARKS[state];
      expect(speed).toBeGreaterThan(0);
      for (const t of [0, 0.6, 3.7, 42]) {
        const field = collect(112, t);
        expect(field.dots.length).toBeGreaterThan(5);
        expect(field.rMin).toBeGreaterThan(0);
        for (const dot of field.dots) {
          expect(Number.isFinite(dot.x)).toBe(true);
          expect(Number.isFinite(dot.y)).toBe(true);
          expect(Number.isFinite(dot.r)).toBe(true);
          // Dots stay inside the frame with a little slack for glow-less edges.
          expect(dot.x).toBeGreaterThan(-12);
          expect(dot.x).toBeLessThan(124);
          expect(dot.y).toBeGreaterThan(-12);
          expect(dot.y).toBeLessThan(124);
        }
      }
    }
  });

  it("wires the constellation: only connecting reports edge lines", () => {
    for (const state of STATES) {
      const { lines } = ORB_MARKS[state].collect(112, 1.2);
      if (state === "connecting") expect(lines.length).toBeGreaterThan(0);
      else expect(lines).toHaveLength(0);
    }
  });

  it("morphs by resampling both fields to a common count and interpolating", () => {
    const a = ORB_MARKS.shaping.collect(112, 0.6);
    const b = ORB_MARKS.working.collect(112, 0.6);
    const mid = blendDots(a.dots, b.dots, 0.5, 112);
    expect(mid).toHaveLength(Math.max(a.dots.length, b.dots.length));
    // The endpoints are the source fields themselves (angular order aside).
    const atStart = blendDots(a.dots, b.dots, 0, 112);
    const atEnd = blendDots(a.dots, b.dots, 1, 112);
    const xs = (dots: ReadonlyArray<{ x: number }>) => dots.map((dot) => dot.x).sort((p, q) => p - q);
    expect(xs(atEnd).at(-1)).toBeCloseTo(xs([...b.dots]).at(-1)!, 6);
    expect(xs(atStart).at(0)).toBeCloseTo(xs([...a.dots]).at(0)!, 6);
  });

  it("keeps the morph clock and easing well-formed", () => {
    expect(MORPH_MS).toBe(760);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
  });

  it("fades lines and blends ink ramps linearly", () => {
    const faded = fadeLines([{ x1: 0, y1: 0, x2: 1, y2: 1, white: 0.4, w: 1, a: 0.8 }], 0.5);
    expect(faded[0].a).toBeCloseTo(0.4, 6);
    const inkA: OrbInk = { near: [0, 0, 0], far: [100, 100, 100] };
    const inkB: OrbInk = { near: [200, 100, 50], far: [0, 0, 0] };
    const mid = blendInk(inkA, inkB, 0.5);
    expect(mid.near).toEqual([100, 50, 25]);
    expect(mid.far).toEqual([50, 50, 50]);
  });
});
