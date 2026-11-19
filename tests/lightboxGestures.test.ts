import { describe, expect, it } from "vitest";
import { EDGE_FLICK_PX, EDGE_HANDOFF_PX, WHEEL_GAP_MS, WHEEL_PAGE_PX, createWheelPager, edgeHandoff } from "../src/lib/lightboxGestures";

describe("createWheelPager", () => {
  /** Feeds deltas one frame (16ms) apart from `t0`; returns every page it asked for. */
  function stream(pager: ReturnType<typeof createWheelPager>, deltas: number[], t0 = 0) {
    return deltas.map((dx, frame) => pager.push(dx, t0 + frame * 16)).filter((step) => step !== 0);
  }

  it("pages once the sideways travel passes the threshold, right for next and left for previous", () => {
    expect(stream(createWheelPager(), [10, 15, 20])).toEqual([]);
    expect(stream(createWheelPager(), [10, 15, 20, WHEEL_PAGE_PX])).toEqual([1]);
    expect(stream(createWheelPager(), [-30, -40])).toEqual([-1]);
  });

  it("pages once per swipe however long the stroke and its inertial tail run on", () => {
    const pager = createWheelPager();
    // A hard stroke, then momentum decaying over a second of frames.
    const tail = Array.from({ length: 60 }, (_, frame) => Math.max(1, Math.round(80 * 0.93 ** frame)));
    expect(stream(pager, [40, 60, 80, ...tail])).toEqual([1]);
  });

  it("treats a pause as the end of a swipe: the next one pages again", () => {
    const pager = createWheelPager();
    expect(stream(pager, [40, 40, 40], 0)).toEqual([1]);
    expect(stream(pager, [40, 40, 40], 32 + WHEEL_GAP_MS + 1)).toEqual([1]);
    // Too soon after the last event, it is still the same gesture.
    expect(stream(pager, [40, 40, 40], 32 + WHEEL_GAP_MS + 1 + 32 + 50)).toEqual([]);
  });

  it("takes a swipe straight back inside the tail, but never a jitter", () => {
    const pager = createWheelPager();
    expect(stream(pager, [40, 40, 30, -1, 20, -2, 10, 8, 6, 4, 2])).toEqual([1]);
    const back = createWheelPager();
    expect(stream(back, [40, 40, 30, -30, -40])).toEqual([1, -1]);
  });

  it("ignores zero-delta events without extending an active gesture", () => {
    const pager = createWheelPager();
    expect(pager.push(70, 0)).toBe(1);
    expect(pager.push(0, 150)).toBe(0);
    // Past the gap from the last non-zero delta, so a new swipe pages again.
    expect(pager.push(70, WHEEL_GAP_MS + 1)).toBe(1);
  });

  it("forgets everything on reset", () => {
    const pager = createWheelPager();
    expect(stream(pager, [70])).toEqual([1]);
    pager.reset();
    expect(stream(pager, [70], 20)).toEqual([1]);
  });
});

describe("edgeHandoff", () => {
  const limits = [-300, 300] as const;
  const slow = (dx: number, dy = 0) => ({ dx, dy, vx: 0 });

  it("stays a pan while the picture is inside its edges", () => {
    expect(edgeHandoff(-200, limits, slow(-400), 0.45)).toBe(0);
    expect(edgeHandoff(299, limits, slow(400), 0.45)).toBe(0);
  });

  it("hands over once the finger pulls far enough past an edge: left for next, right for previous", () => {
    expect(edgeHandoff(-300 - EDGE_HANDOFF_PX + 1, limits, slow(-400), 0.45)).toBe(0);
    expect(edgeHandoff(-300 - EDGE_HANDOFF_PX, limits, slow(-400), 0.45)).toBe(1);
    expect(edgeHandoff(300 + EDGE_HANDOFF_PX, limits, slow(400), 0.45)).toBe(-1);
  });

  it("hands over sooner on a flick toward the edge", () => {
    const flick = { dx: -200, dy: 0, vx: -0.8 };
    expect(edgeHandoff(-300 - EDGE_FLICK_PX - 1, limits, flick, 0.45)).toBe(1);
    expect(edgeHandoff(-300 - EDGE_FLICK_PX + 1, limits, flick, 0.45)).toBe(0);
    // A flick the other way is not one toward this edge.
    expect(edgeHandoff(-300 - EDGE_FLICK_PX - 1, limits, { dx: -200, dy: 0, vx: 0.8 }, 0.45)).toBe(0);
  });

  it("ignores mostly vertical drags and a finger travelling away from the edge it is past", () => {
    expect(edgeHandoff(-500, limits, slow(-100, 300), 0.45)).toBe(0);
    expect(edgeHandoff(-500, limits, slow(100), 0.45)).toBe(0);
  });

  it("pages at once off a picture narrower than the screen, which has no sideways pan", () => {
    expect(edgeHandoff(-EDGE_HANDOFF_PX, [0, 0], slow(-EDGE_HANDOFF_PX), 0.45)).toBe(1);
  });
});
