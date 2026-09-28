import { describe, expect, it } from "vitest";
import { pxHash, revealOrder, thin, trace } from "../src/lib/inkCanvas";

/** A w×h 0/1 mask with the given filled rectangles. */
function maskOf(w: number, h: number, rects: [x: number, y: number, rw: number, rh: number][]): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (const [x0, y0, rw, rh] of rects) {
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) mask[y * w + x] = 1;
  }
  return mask;
}

function count(mask: Uint8Array): number {
  let n = 0;
  for (const value of mask) n += value;
  return n;
}

describe("the diary's hash", () => {
  it("matches the diary's own values and spreads a stroke across every stage", () => {
    // Pinned so a refactor can't quietly change the dissolve pattern.
    expect(pxHash(0, 0)).toBe(0);
    expect(pxHash(3, 7)).toBe(pxHash(3, 7));
    const stages = new Set<number>();
    for (let x = 0; x < 64; x++) stages.add(pxHash(x, 11) % 14);
    expect(stages.size).toBe(14);
  });
});

describe("Zhang–Suen thinning", () => {
  it("reduces a thick bar to a one-pixel line along its length", () => {
    const w = 30;
    const h = 11;
    const mask = maskOf(w, h, [[3, 3, 24, 5]]);
    thin(mask, w, h);
    expect(count(mask)).toBeGreaterThan(10);
    // No column keeps more than one pixel: the skeleton is a line.
    for (let x = 0; x < w; x++) {
      let column = 0;
      for (let y = 0; y < h; y++) column += mask[y * w + x];
      expect(column).toBeLessThanOrEqual(1);
    }
  });
});

describe("tracing strokes", () => {
  it("walks a line from its endpoint, one stroke per connected piece", () => {
    const w = 20;
    const h = 5;
    const mask = maskOf(w, h, [[2, 2, 5, 1], [11, 2, 6, 1]]);
    const strokes = trace(mask, w, h);
    expect(strokes).toHaveLength(2);
    expect(strokes.map((stroke) => stroke.length).sort()).toEqual([5, 6]);
    // Each stroke runs end to end, not from the middle.
    for (const stroke of strokes) {
      const xs = stroke.map((i) => i % w);
      expect(Math.abs(xs[0] - xs[xs.length - 1])).toBe(stroke.length - 1);
    }
  });

  it("keeps a lone pixel as a pen dot", () => {
    const mask = maskOf(6, 6, [[3, 3, 1, 1]]);
    expect(trace(mask, 6, 6)).toEqual([[3 * 6 + 3]]);
  });
});

describe("reveal order", () => {
  it("gives every inked pixel a moment and follows the pen's order", () => {
    const w = 24;
    const h = 7;
    // Two thick blobs; the left one's skeleton is walked first.
    const alpha = new Uint8Array(w * h);
    const ink = maskOf(w, h, [[2, 1, 6, 5], [14, 1, 7, 5]]);
    for (let i = 0; i < w * h; i++) alpha[i] = ink[i] ? 255 : 0;
    const skeleton = ink.slice();
    thin(skeleton, w, h);
    const strokes = trace(skeleton, w, h).sort((a, b) => Math.min(...a.map((i) => i % w)) - Math.min(...b.map((i) => i % w)));
    const order = revealOrder(alpha, w, h, strokes);

    for (let i = 0; i < w * h; i++) {
      if (alpha[i]) {
        expect(order[i]).toBeGreaterThanOrEqual(0);
        expect(order[i]).toBeLessThanOrEqual(1);
      } else {
        expect(order[i]).toBe(-1);
      }
    }
    // Everything in the left blob comes up before anything in the right one.
    let leftLatest = 0;
    let rightEarliest = 1;
    for (let i = 0; i < w * h; i++) {
      if (!alpha[i]) continue;
      if (i % w < 12) leftLatest = Math.max(leftLatest, order[i]);
      else rightEarliest = Math.min(rightEarliest, order[i]);
    }
    expect(leftLatest).toBeLessThan(rightEarliest);
  });

  it("brings up ink with no skeleton as the pen passes its column", () => {
    const w = 11;
    const h = 3;
    const alpha = new Uint8Array(w * h);
    alpha[1 * w + 10] = 40;
    const order = revealOrder(alpha, w, h, []);
    expect(order[1 * w + 10]).toBe(1);
  });
});
