/* =========================================================================
   Dotted thought-orbs — the two frame painters the semantic-search panel
   uses: `working` (particles on tilted orbits) while the model is being
   fetched, started or queried, and `solving` (bands twist out of order,
   then click back) while the index is being built.

   Ported from thinking-orbs — only the two shipped states this app needs,
   with the preset scaling resolved ahead of time (see the notes on
   WORKING_OPTS / SOLVING_OPTS) and the library's grayscale ink swapped for
   a two-stop ramp the caller reads out of the app's own tokens, so the orb
   follows the theme the way every other surface does.

   ---------------------------------------------------------------------
   MIT License · Copyright (c) 2026 Jakub Antalik

   Permission is hereby granted, free of charge, to any person obtaining a
   copy of this software and associated documentation files (the
   "Software"), to deal in the Software without restriction, including
   without limitation the rights to use, copy, modify, merge, publish,
   distribute, sublicense, and/or sell copies of the Software, and to
   permit persons to whom the Software is furnished to do so, subject to
   the following conditions:

   The above copyright notice and this permission notice shall be included
   in all copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
   ========================================================================= */

/** Which of the two orbs to paint. */
export type OrbState = "working" | "solving";

/** RGB triple, 0–255. */
export type Rgb = readonly [number, number, number];

/**
 * The depth ramp. A dot's ink value runs 0 (nearest) → 1 (furthest); the
 * painter interpolates between these two stops, so depth still reads as a
 * tonal falloff — it is just the app's sage instead of the library's gray.
 */
export interface OrbInk {
  near: Rgb;
  far: Rgb;
}

interface Dot {
  x: number;
  y: number;
  z: number;
  r: number;
  /** 0 = nearest ink, 1 = furthest. */
  white: number;
  a?: number;
}

interface Move {
  axis: 0 | 1 | 2;
  lo: number;
  hi: number;
  ang: number;
}

type Projector = (x: number, y: number, z: number) => [number, number, number];

/* ---- shared primitives ------------------------------------------------- */

/** Deterministic hash in [0, 1) — the orbits and the move list are stable. */
function hashD(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** Spin + tilt + orthographic projection. */
function makeProj(yaw: number, tilt: number, cx: number, cy: number, scale: number): Projector {
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  const sy = Math.sin(yaw);
  const cyw = Math.cos(yaw);
  return (x, y, z) => {
    const x1 = x * cyw + z * sy;
    const z1 = -x * sy + z * cyw;
    const y1 = y * ct - z1 * st;
    const z2 = y * st + z1 * ct;
    return [cx + x1 * scale, cy - y1 * scale, z2];
  };
}

/**
 * Dot radii were tuned against a 300pt frame; the sub-linear exponent keeps
 * the mark legible when it is painted much smaller than that.
 */
function radiusScale(size: number, pow: number): number {
  return (size / 300) ** pow;
}

/**
 * Painter: z-sort far→near, then flat filled arcs — no ctx.filter, no
 * gradients, so Chrome, Safari and Firefox land on the same pixels.
 */
function paint(ctx: CanvasRenderingContext2D, dots: Dot[], ink: OrbInk, rMin: number): void {
  dots.sort((a, b) => a.z - b.z);
  const { near, far } = ink;
  for (const d of dots) {
    const alpha = d.a ?? 1;
    if (alpha < 0.02) continue;
    const w = d.white < 0 ? 0 : d.white > 1 ? 1 : d.white;
    const r = Math.round(near[0] + (far[0] - near[0]) * w);
    const g = Math.round(near[1] + (far[1] - near[1]) * w);
    const b = Math.round(near[2] + (far[2] - near[2]) * w);
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(rMin, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---- working: particles on tilted orbits -------------------------------- */

/**
 * thinking-orbs' `orbits` base profile. The shipped 64px preset multiplies
 * counts and radii by 1, so these are the tuned numbers verbatim.
 */
const WORKING_OPTS = {
  orbitN: 12,
  ghostN: 40,
  ghostR: 0.9,
  ghostA: 0.5,
  particles: 3,
  partR: 1.2,
  partRDepth: 1.6,
  rsPow: 0.6,
  rMin: 0.3
} as const;

/** Baked clock multiplier for the 64px `working` preset. */
const WORKING_SPEED = 1.885;

function drawWorking(ctx: CanvasRenderingContext2D, size: number, t: number, ink: OrbInk): void {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.12, 0.3, cx, cy, 1);
  const rs = radiusScale(size, WORKING_OPTS.rsPow);
  const dots: Dot[] = [];

  for (let orb = 0; orb < WORKING_OPTS.orbitN; orb++) {
    const h1 = hashD(orb, 1.7);
    const h2 = hashD(orb, 5.2);
    const h3 = hashD(orb, 8.9);
    const ro = R * (0.45 + 0.52 * h1);
    const th = h1 * 2 * Math.PI;
    const phi = Math.acos(2 * h2 - 1);
    // orbit-plane basis (u, v ⟂ the plane normal n)
    const nx = Math.sin(phi) * Math.cos(th);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(th);
    let ux = -ny;
    let uy = nx;
    const uz = 0;
    const ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy));
    ux /= ul;
    uy /= ul;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

    // the ghost path the particles run on
    for (let k = 0; k < WORKING_OPTS.ghostN; k++) {
      const a = (k / WORKING_OPTS.ghostN) * 2 * Math.PI;
      const [px, py, z] = pt(
        (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
        (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
        (uz * Math.cos(a) + vz * Math.sin(a)) * ro
      );
      dots.push({
        x: px,
        y: py,
        z,
        r: WORKING_OPTS.ghostR * rs,
        white: 0.72,
        a: WORKING_OPTS.ghostA * (0.4 + 0.6 * ((z / ro + 1) / 2))
      });
    }
    // and the particles doing the work
    for (let m = 0; m < WORKING_OPTS.particles; m++) {
      const a = t * speed + (m / WORKING_OPTS.particles) * 2 * Math.PI + h2 * 6;
      const [px, py, z] = pt(
        (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
        (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
        (uz * Math.cos(a) + vz * Math.sin(a)) * ro
      );
      const depth = (z / ro + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z,
        r: (WORKING_OPTS.partR + WORKING_OPTS.partRDepth * depth) * rs,
        white: 0.3 - 0.22 * depth
      });
    }
  }
  paint(ctx, dots, ink, WORKING_OPTS.rMin);
}

/* ---- solving: bands scramble in quarter turns, then click back ---------- */

/**
 * thinking-orbs' `rubik` base profile with the shipped 64px preset already
 * applied: counts × 0.35 (each side of the lat/long pair takes √0.35, so the
 * total dot count scales by 0.35 — 15→9 rings, 40→24 longitudes) and radii
 * × 1.05.
 */
const SOLVING_OPTS = {
  latRings: 9,
  lonDensity: 24,
  moveCount: 14,
  rBase: 0.63,
  rDepth: 1.785,
  rActive: 0.315,
  inkFar: 0.62,
  inkSpan: 0.54,
  rsPow: 0.6,
  rMin: 0.3
} as const;

/** Baked clock multiplier for the 64px `solving` preset. */
const SOLVING_SPEED = 1.82;

/** The move list is a pure function of its length — build it once. */
const MOVES: readonly Move[] = (() => {
  const moves: Move[] = [];
  for (let i = 0; i < SOLVING_OPTS.moveCount; i++) {
    const axis = Math.min(2, Math.floor(hashD(i, 2.3) * 3)) as 0 | 1 | 2;
    const lo = -1.0 + 0.5 * Math.min(3, Math.floor(hashD(i, 5.9) * 4));
    const dir = hashD(i, 7.7) < 0.5 ? 1 : -1;
    moves.push({ axis, lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
  }
  return moves;
})();

/**
 * The solver heartbeat: rapid eased quarter turns scramble the sphere, then
 * the same list replays in reverse so every band clicks back to solved. It
 * rests there for a beat before starting over.
 */
function solveCycle(time: number, count: number, slotDur: number, rest: number) {
  const cyc = 2 * count * slotDur + rest;
  const tc = time % cyc;
  const amount = new Array<number>(count).fill(0);
  let active = -1;
  if (tc < 2 * count * slotDur) {
    const slot = Math.floor(tc / slotDur);
    const p = (tc - slot * slotDur) / slotDur;
    const cl = Math.min(1, p / 0.7);
    const ep = 1 - (1 - cl) ** 3; // machine ease-out — the turn's damped stop
    if (slot < count) {
      for (let i = 0; i < slot; i++) amount[i] = 1;
      amount[slot] = ep;
      active = slot;
    } else {
      const u = 2 * count - 1 - slot;
      for (let i = 0; i < u; i++) amount[i] = 1;
      amount[u] = 1 - ep;
      active = u;
    }
  }
  return { amount, active };
}

function applyMoves(
  point: [number, number, number],
  cycle: { amount: number[]; active: number }
): [number, number, number, boolean] {
  let [x, y, z] = point;
  let inActive = false;
  for (let i = 0; i < MOVES.length; i++) {
    if (cycle.amount[i] <= 0) continue;
    const mv = MOVES[i];
    const coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
    if (coord < mv.lo || coord >= mv.hi) continue;
    if (i === cycle.active) inActive = true;
    const a = mv.ang * cycle.amount[i];
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    if (mv.axis === 0) {
      const y2 = y * ca - z * sa;
      z = y * sa + z * ca;
      y = y2;
    } else if (mv.axis === 1) {
      const x2 = x * ca + z * sa;
      z = -x * sa + z * ca;
      x = x2;
    } else {
      const x2 = x * ca - y * sa;
      y = x * sa + y * ca;
      x = x2;
    }
  }
  return [x, y, z, inActive];
}

function drawSolving(ctx: CanvasRenderingContext2D, size: number, t: number, ink: OrbInk): void {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), cx, cy, R);
  const rs = radiusScale(size, SOLVING_OPTS.rsPow);
  const cycle = solveCycle(t, SOLVING_OPTS.moveCount, 0.42, 1.2);
  const dots: Dot[] = [];

  for (let li = 0; li <= SOLVING_OPTS.latRings; li++) {
    const lat = -Math.PI / 2 + (li / SOLVING_OPTS.latRings) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * SOLVING_OPTS.lonDensity));
    for (let lj = 0; lj < lonCount; lj++) {
      const lon = (lj / lonCount) * 2 * Math.PI;
      const [x, y, z, inActive] = applyMoves([cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)], cycle);
      const [px, py, zr] = pt(x, y, z);
      const depth = (zr + 1) / 2;
      // the band currently being turned inks a touch nearer — the "hand"
      dots.push({
        x: px,
        y: py,
        z: zr,
        r: (SOLVING_OPTS.rBase + SOLVING_OPTS.rDepth * depth + (inActive ? SOLVING_OPTS.rActive : 0)) * rs,
        white: SOLVING_OPTS.inkFar - SOLVING_OPTS.inkSpan * depth - (inActive ? 0.14 : 0)
      });
    }
  }
  paint(ctx, dots, ink, SOLVING_OPTS.rMin);
}

/* ---- the two-entry registry -------------------------------------------- */

export interface OrbPainter {
  /** Multiplier on the shared wall clock, baked into the preset. */
  speed: number;
  draw: (ctx: CanvasRenderingContext2D, size: number, t: number, ink: OrbInk) => void;
}

export const ORB_PAINTERS: Record<OrbState, OrbPainter> = {
  working: { speed: WORKING_SPEED, draw: drawWorking },
  solving: { speed: SOLVING_SPEED, draw: drawSolving }
};

/** #rgb / #rrggbb → RGB triple. Anything else falls back to `fallback`. */
export function parseHexRgb(value: string, fallback: Rgb): Rgb {
  const hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const r = Number.parseInt(hex[0] + hex[0], 16);
    const g = Number.parseInt(hex[1] + hex[1], 16);
    const b = Number.parseInt(hex[2] + hex[2], 16);
    return Number.isNaN(r + g + b) ? fallback : [r, g, b];
  }
  if (hex.length === 6) {
    const n = Number.parseInt(hex, 16);
    return Number.isNaN(n) ? fallback : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return fallback;
}
