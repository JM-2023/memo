/* Gesture arithmetic for the image viewer (components/Lightbox.tsx), kept
   free of the DOM so the decisions can be tested on their own. */

/** Sideways wheel travel (px) a trackpad swipe must build up before it pages. */
export const WHEEL_PAGE_PX = 60;
/**
 * A pause this long (ms) between wheel events ends a gesture. A trackpad
 * streams events every frame while the fingers move and then through the
 * inertial tail, so any real gap means the fingers lifted and stopped.
 */
export const WHEEL_GAP_MS = 220;

/**
 * Turns a stream of horizontal wheel deltas — a two-finger trackpad swipe —
 * into at most one page per gesture. Travel accumulates until it passes
 * WHEEL_PAGE_PX; that pages once, and everything after it (the rest of the
 * stroke and its inertial tail, which can run on for a second) is swallowed
 * until the stream pauses. A swipe straight back the other way inside that
 * tail still counts, once it has built up a threshold of its own: momentum
 * only decays, it never turns round that far, while a stray reversed delta
 * of a pixel or two (trackpads jitter) never adds up to a page.
 */
export function createWheelPager(threshold = WHEEL_PAGE_PX, gap = WHEEL_GAP_MS) {
  let travel = 0;
  // The way this gesture already paged (0: not yet), and travel back against it.
  let spent: 1 | -1 | 0 = 0;
  let back = 0;
  let last = -Infinity;
  return {
    /** Feed one event's deltaX (px) at time `at` (ms): 1 next, -1 previous, 0 nothing (yet). */
    push(dx: number, at: number): 1 | -1 | 0 {
      if (dx === 0) return 0;
      if (at - last > gap) {
        travel = 0;
        spent = 0;
        back = 0;
      }
      last = at;
      if (spent !== 0) {
        if (Math.sign(dx) === spent) {
          // Still the tail of the stroke that paged.
          back = 0;
          return 0;
        }
        back += dx;
        if (Math.abs(back) < threshold) return 0;
        spent = back > 0 ? 1 : -1;
        back = 0;
        return spent;
      }
      travel += dx;
      if (Math.abs(travel) < threshold) return 0;
      spent = travel > 0 ? 1 : -1;
      return spent;
    },
    reset() {
      travel = 0;
      spent = 0;
      back = 0;
      last = -Infinity;
    }
  };
}

/** Finger travel (px) past a magnified picture's edge that hands over to its neighbour. */
export const EDGE_HANDOFF_PX = 80;
/** A flick toward the edge hands over sooner, after only this much travel past it. */
export const EDGE_FLICK_PX = 24;

/**
 * Whether a pan of a magnified picture, let go, hands over to the next (1)
 * or previous (-1) picture, as Photos does: the picture's edge already sits
 * on the screen's (`raw`, where the finger would have taken it, lies past
 * the pan's `limits`) and the finger carried on that way, far enough or fast
 * enough. Only a mostly sideways drag counts, so panning down a tall picture
 * that happens to touch a side never pages.
 */
export function edgeHandoff(
  raw: number,
  limits: readonly [low: number, high: number],
  drag: { dx: number; dy: number; vx: number },
  flickSpeed: number
): 1 | -1 | 0 {
  if (Math.abs(drag.dx) <= Math.abs(drag.dy)) return 0;
  // Past the low edge: the picture's right side is in and the finger pulls
  // left, toward the next one. Past the high edge: the previous one.
  const over = raw < limits[0] ? raw - limits[0] : raw > limits[1] ? raw - limits[1] : 0;
  if (over === 0 || Math.sign(over) !== Math.sign(drag.dx)) return 0;
  const flick = Math.abs(drag.vx) > flickSpeed && Math.sign(drag.vx) === Math.sign(over) && Math.abs(over) > EDGE_FLICK_PX;
  if (Math.abs(over) < EDGE_HANDOFF_PX && !flick) return 0;
  return over < 0 ? 1 : -1;
}
