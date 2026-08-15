/* =========================================================================
   Dotted thought-orbs — the six frame collectors the semantic-search panel
   wears, one per lifecycle state:

     working    orbits  — particles on tilted orbits (fetch / load / query)
     solving    rubik   — bands scramble in quarter turns, then click back
     searching  globe   — a scan meridian sweeps a dotted globe
     breathing  ring    — a face-on ring whose radius swells and pinches
     shaping    morph   — a dotted outline cycling circle → triangle → square
     connecting web     — a constellation wires itself

   Ported from thinking-orbs with each preset's scaling resolved ahead of
   time (see the notes on the *_OPTS blocks). Two departures from the
   library: the grayscale ink is a two-stop ramp the caller reads out of the
   app's own tokens, so the orb follows the theme the way every other
   surface does; and a state change is a real MORPH — every collector
   reports its dot field instead of drawing it, so two fields can be
   resampled to a common count, paired in angular order and interpolated.
   The dust reorganises itself from one mark into the next rather than one
   image cross-fading into another.

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

/** Which of the six orbs to paint. */
export type OrbState = "working" | "solving" | "searching" | "breathing" | "shaping" | "connecting";

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

export interface OrbDot {
  x: number;
  y: number;
  z: number;
  r: number;
  /** 0 = nearest ink, 1 = furthest. */
  white: number;
  a?: number;
}

/** A stroke of the edge pass — only `connecting` uses these. */
export interface OrbLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  white: number;
  w: number;
  a?: number;
}

/** One frame's worth of marks, reported rather than drawn — see the morph. */
export interface OrbField {
  dots: OrbDot[];
  lines: OrbLine[];
  rMin: number;
}

interface Move {
  axis: 0 | 1 | 2;
  lo: number;
  hi: number;
  ang: number;
}

type Projector = (x: number, y: number, z: number) => [number, number, number];

/* ---- shared primitives ------------------------------------------------- */

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

/** Deterministic hash in [0, 1) — the orbits and the move list are stable. */
function hashD(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** Value noise on a 2D lattice — smooth, deterministic, cheap. */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let fx = x - xi;
  let fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hashD(xi, yi);
  const b = hashD(xi + 1, yi);
  const c = hashD(xi, yi + 1);
  const d = hashD(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Stable directions on a unit sphere (Fibonacci lattice). */
function fibDir(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / n;
  const rad = Math.sqrt(1 - y * y);
  const a = i * golden;
  return [rad * Math.cos(a), y, rad * Math.sin(a)];
}

/** Shortest signed angular distance, wrapped to (-pi, pi]. */
function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
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

/** Ink value 0 (nearest) → 1 (furthest), resolved against the caller's ramp. */
function inkAt(white: number, ink: OrbInk): [number, number, number] {
  const w = white < 0 ? 0 : white > 1 ? 1 : white;
  return [
    Math.round(ink.near[0] + (ink.far[0] - ink.near[0]) * w),
    Math.round(ink.near[1] + (ink.far[1] - ink.near[1]) * w),
    Math.round(ink.near[2] + (ink.far[2] - ink.near[2]) * w)
  ];
}

/** Stroke pass for edge-based marks. Runs before the dots sit on top. */
export function paintLines(ctx: CanvasRenderingContext2D, lines: readonly OrbLine[], ink: OrbInk): void {
  for (const l of lines) {
    const alpha = l.a ?? 1;
    if (alpha < 0.02) continue;
    const [r, g, b] = inkAt(l.white, ink);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = l.w;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
}

/**
 * Painter: z-sort far→near, then flat filled arcs — no ctx.filter, no
 * gradients, so Chrome, Safari and Firefox land on the same pixels.
 */
export function paintDots(ctx: CanvasRenderingContext2D, dots: OrbDot[], ink: OrbInk, rMin: number): void {
  dots.sort((a, b) => a.z - b.z);
  for (const d of dots) {
    const alpha = d.a ?? 1;
    if (alpha < 0.02) continue;
    const [r, g, b] = inkAt(d.white, ink);
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(rMin, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---- working: particles on tilted orbits (orbits, ×1) ------------------- */

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

function collectWorking(size: number, t: number): OrbField {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.12, 0.3, cx, cy, 1);
  const rs = radiusScale(size, WORKING_OPTS.rsPow);
  const dots: OrbDot[] = [];

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
  return { dots, lines: [], rMin: WORKING_OPTS.rMin };
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

function collectSolving(size: number, t: number): OrbField {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), cx, cy, R);
  const rs = radiusScale(size, SOLVING_OPTS.rsPow);
  const cycle = solveCycle(t, SOLVING_OPTS.moveCount, 0.42, 1.2);
  const dots: OrbDot[] = [];

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
  return { dots, lines: [], rMin: SOLVING_OPTS.rMin };
}

/* ---- searching: a scan meridian sweeps a globe (globe, ×0.42 / ×1.15) --- */

const SEARCHING_OPTS = {
  latRings: 11,
  lonDensity: 29,
  rBase: 0.69,
  rDepth: 1.955,
  rBoost: 1,
  inkFar: 0.62,
  inkSpan: 0.54,
  scanMul: 4.08,
  dimBase: 0.45,
  rsPow: 0.6,
  rMin: 0.3
} as const;

/** Baked clock multiplier for the 64px `searching` preset. */
const SEARCHING_SPEED = 2.015;

function collectSearching(size: number, t: number): OrbField {
  const spin = 0.5;
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size / 2) * 0.82;
  const tilt = 0.4 + 0.06 * Math.sin(t * 0.35);
  const pt = makeProj(t * spin, tilt, cx, cy, radius);
  const scan = t * (spin + (1.7 - spin) * SEARCHING_OPTS.scanMul);
  const rs = radiusScale(size, SEARCHING_OPTS.rsPow);
  const dots: OrbDot[] = [];
  for (let li = 0; li <= SEARCHING_OPTS.latRings; li++) {
    const lat = -Math.PI / 2 + (li / SEARCHING_OPTS.latRings) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * SEARCHING_OPTS.lonDensity));
    for (let lj = 0; lj < lonCount; lj++) {
      const lon = (lj / lonCount) * 2 * Math.PI;
      const [px, py, z] = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon));
      const depth = (z + 1) / 2;
      const d = angleDelta(lon + t * spin, scan);
      // the scan reads as a size ripple, not a shine
      const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, z);
      dots.push({
        x: px,
        y: py,
        z,
        r: (SEARCHING_OPTS.rBase + SEARCHING_OPTS.rDepth * depth + SEARCHING_OPTS.rBoost * boost) * rs,
        white: SEARCHING_OPTS.inkFar - SEARCHING_OPTS.inkSpan * depth,
        a: SEARCHING_OPTS.dimBase + (1 - SEARCHING_OPTS.dimBase) * Math.min(1, boost)
      });
    }
  }
  return { dots, lines: [], rMin: SEARCHING_OPTS.rMin };
}

/* ---- breathing: a face-on ring morphing (ring, ×0.25 / ×0.956) ---------- */

const BREATHING_OPTS = {
  lanes: 3,
  segs: 44,
  rBase: 1.0516,
  rDepth: 1.6252,
  bandMul: 3.627,
  wobMul: 0.368,
  rsPow: 0.6,
  rMin: 0.3
} as const;

/** Baked clock multiplier for the 64px `breathing` preset. */
const BREATHING_SPEED = 3.24;

function collectBreathing(size: number, t: number): OrbField {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.78;
  const camTilt = 0.3;
  // The preset freezes the 3D tumble (spin 0) and cancels the camera tilt
  // (faceOn), so the band reads as a true circle and only the traveling
  // undulation moves — on the RADIUS, so lobes genuinely swell and pinch.
  const pt = makeProj(0, camTilt, cx, cy, 1);
  const rs = radiusScale(size, BREATHING_OPTS.rsPow);
  const dots: OrbDot[] = [];
  const ta = -camTilt;
  const ux = 1;
  const uy = 0;
  const uz = 0;
  const vx = -uz * Math.sin(ta);
  const vy = Math.cos(ta);
  const vz = ux * Math.sin(ta);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const baseR = R / (1 + 0.85 * (0.23 * BREATHING_OPTS.wobMul));
  const lanes = Math.max(1, Math.round(BREATHING_OPTS.lanes * BREATHING_OPTS.bandMul));
  for (let w = 0; w < lanes; w++) {
    const laneOff = (w - (lanes - 1) / 2) * 0.075;
    const edge = Math.abs(w - (lanes - 1) / 2) / Math.max(1, (lanes - 1) / 2);
    for (let k = 0; k < BREATHING_OPTS.segs; k++) {
      const a = (k / BREATHING_OPTS.segs) * 2 * Math.PI;
      const wob =
        (0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1)) * BREATHING_OPTS.wobMul;
      const x = ux * Math.cos(a) + vx * Math.sin(a) + nx * laneOff;
      const y = uy * Math.cos(a) + vy * Math.sin(a) + ny * laneOff;
      const z = uz * Math.cos(a) + vz * Math.sin(a) + nz * laneOff;
      const l = Math.sqrt(x * x + y * y + z * z);
      const rr = baseR * (1 + wob);
      const [px, py, zr] = pt((x / l) * rr, (y / l) * rr, (z / l) * rr);
      const depth = (zr / R + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z: zr,
        r: (BREATHING_OPTS.rBase + BREATHING_OPTS.rDepth * depth) * (1 - 0.25 * edge) * rs,
        white: 0.52 - 0.44 * depth + 0.18 * edge,
        a: 0.4 + 0.6 * depth
      });
    }
  }
  return { dots, lines: [], rMin: BREATHING_OPTS.rMin };
}

/* ---- shaping: circle → triangle → square (morph, ×0.702 / ×0.395) -------

   Each shape is a closed path parameterised by arc length (top-centre
   start, clockwise). Every frame blends the two neighbouring paths, then
   lays the dots EVENLY along the blended outline, so spacing stays uniform
   through holds and transitions alike. */

const SHAPING_OPTS = { rDot: 0.008295, iconD: 0.702, spread: 1.45, rMin: 0.25 } as const;

/** Baked clock multiplier for the 64px `shaping` preset. */
const SHAPING_SPEED = 2.405;
const SHAPE_HOLD = 1.4;
const SHAPE_MORPH = 0.9;
const SHAPE_SEG = SHAPE_HOLD + SHAPE_MORPH;

function smoothE(x: number): number {
  return x * x * (3 - 2 * x);
}

type ShapePath = (f: number) => [number, number];

function polyPath(verts: ReadonlyArray<readonly [number, number]>): ShapePath {
  const V = verts.length;
  const L: number[] = [];
  let total = 0;
  for (let i = 0; i < V; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % V];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    L.push(l);
    total += l;
  }
  return (f) => {
    let target = f * total;
    let i = 0;
    while (target > L[i] && i < V - 1) {
      target -= L[i];
      i++;
    }
    const a = verts[i];
    const b = verts[(i + 1) % V];
    const ff = L[i] ? Math.min(1, target / L[i]) : 0;
    return [a[0] + (b[0] - a[0]) * ff, a[1] + (b[1] - a[1]) * ff];
  };
}

const SHAPE_CYCLE: readonly ShapePath[] = [
  (f) => {
    const a = -Math.PI / 2 + f * 2 * Math.PI;
    return [Math.cos(a) * 0.24, Math.sin(a) * 0.24];
  },
  polyPath([
    [0.0, -0.26],
    [0.24, 0.16],
    [-0.24, 0.16]
  ]),
  // 5-vertex walk so the path starts at top-centre like the other shapes
  polyPath([
    [0, -0.2],
    [0.2, -0.2],
    [0.2, 0.2],
    [-0.2, 0.2],
    [-0.2, -0.2]
  ])
];

function collectShaping(size: number, t: number): OrbField {
  const K = SHAPE_CYCLE.length;
  const tc = t % (SHAPE_SEG * K);
  const k = Math.floor(tc / SHAPE_SEG);
  const local = tc - k * SHAPE_SEG;
  const m = local > SHAPE_HOLD ? smoothE((local - SHAPE_HOLD) / SHAPE_MORPH) : 0;
  const sprd = SHAPING_OPTS.spread;
  const pA = SHAPE_CYCLE[k];
  const pB = SHAPE_CYCLE[(k + 1) % K];
  const M = 160;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < M; i++) {
    const f = i / M;
    const a = pA(f);
    const b = pB(f);
    pts.push([(a[0] + (b[0] - a[0]) * m) * sprd, (a[1] + (b[1] - a[1]) * m) * sprd]);
  }
  const L: number[] = [];
  let total = 0;
  for (let i = 0; i < M; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % M];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    L.push(l);
    total += l;
  }
  const n = Math.max(6, Math.round(34 * SHAPING_OPTS.iconD));
  const re = SHAPING_OPTS.rDot * 1.35 * sprd;
  const pulse = 1 + 0.02 * Math.sin(local * 3.1);
  const dots: OrbDot[] = [];
  const c2 = size / 2;
  let seg = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (acc + L[seg] < target && seg < M - 1) {
      acc += L[seg];
      seg++;
    }
    const a = pts[seg];
    const b = pts[(seg + 1) % M];
    const f = L[seg] ? Math.min(1, (target - acc) / L[seg]) : 0;
    const x = (a[0] + (b[0] - a[0]) * f) * pulse;
    const y = (a[1] + (b[1] - a[1]) * f) * pulse;
    dots.push({ x: c2 + x * size, y: c2 + y * size, z: 0, r: Math.max(0.35, re * size), white: 0.1 });
  }
  return { dots, lines: [], rMin: SHAPING_OPTS.rMin };
}

/* ---- connecting: a constellation wires itself (web, ×1.35 / ×0.95) ------

   Nodes drift on the sphere under slow value noise; any pair closer than
   `thr` grows an edge, and bright packets run along re-picked node pairs. */

const CONNECTING_OPTS = {
  nodeN: 41,
  thr: 0.72,
  signals: 7,
  nodeR: 1.33,
  nodeRDepth: 1.71,
  lineW: 0.8,
  rsPow: 0.6,
  rMin: 0.3
} as const;

/** Baked clock multiplier for the 64px `connecting` preset. */
const CONNECTING_SPEED = 3.315;

function collectConnecting(size: number, t: number): OrbField {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.8;
  // the projector carries the radius as its scale, so node vectors stay
  // unit-length and the distances below are in unit-sphere space
  const pt = makeProj(t * 0.12, 0.32, cx, cy, R);
  const rs = radiusScale(size, CONNECTING_OPTS.rsPow);
  const n = CONNECTING_OPTS.nodeN;
  const nodes: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const d = fibDir(i, n);
    const x = d[0] + 0.3 * (vnoise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
    const y = d[1] + 0.3 * (vnoise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
    const z = d[2] + 0.3 * (vnoise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
    const l = Math.sqrt(x * x + y * y + z * z);
    nodes.push([x / l, y / l, z / l]);
  }
  const lines: OrbLine[] = [];
  const dots: OrbDot[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = nodes[i][0] - nodes[j][0];
      const dy = nodes[i][1] - nodes[j][1];
      const dz = nodes[i][2] - nodes[j][2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= CONNECTING_OPTS.thr) continue;
      const [x1, y1, z1] = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
      const [x2, y2, z2] = pt(nodes[j][0], nodes[j][1], nodes[j][2]);
      const depth = ((z1 + z2) / 2 + 1) / 2;
      lines.push({
        x1,
        y1,
        x2,
        y2,
        white: 0.42,
        a: (1 - dist / CONNECTING_OPTS.thr) * (0.3 + 0.55 * depth),
        w: Math.max(0.6, CONNECTING_OPTS.lineW * rs)
      });
    }
  }
  for (let i = 0; i < n; i++) {
    const [px, py, z] = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
    const depth = (z + 1) / 2;
    const pulse = 1 + 0.25 * Math.sin(t * 1.4 + i * 2.7);
    dots.push({
      x: px,
      y: py,
      z,
      r: (CONNECTING_OPTS.nodeR + CONNECTING_OPTS.nodeRDepth * depth) * pulse * rs,
      white: 0.55 - 0.45 * depth
    });
  }
  for (let s = 0; s < CONNECTING_OPTS.signals; s++) {
    const seg = Math.floor(t * 0.55 + s * 7.31);
    const a = Math.floor(hashD(seg, s * 3.1 + 1.7) * n);
    const b = Math.floor(hashD(seg, s * 5.7 + 4.2) * n);
    if (a === b) continue;
    const f = frac(t * 0.55 + s * 7.31);
    const x = lerp(nodes[a][0], nodes[b][0], f);
    const y = lerp(nodes[a][1], nodes[b][1], f);
    const z = lerp(nodes[a][2], nodes[b][2], f);
    const l = Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
    const [px, py, zr] = pt(x / l, y / l, z / l);
    const depth = (zr + 1) / 2;
    dots.push({
      x: px,
      y: py,
      z: zr,
      r: (CONNECTING_OPTS.nodeR * 1.5 + CONNECTING_OPTS.nodeRDepth * depth) * rs,
      white: 0.05,
      a: 0.5 + 0.5 * depth
    });
  }
  return { dots, lines, rMin: CONNECTING_OPTS.rMin };
}

/* ---- the registry ------------------------------------------------------ */

export interface OrbMark {
  /** Multiplier on the shared wall clock, baked into the preset. */
  speed: number;
  collect: (size: number, t: number) => OrbField;
}

export const ORB_MARKS: Record<OrbState, OrbMark> = {
  working: { speed: WORKING_SPEED, collect: collectWorking },
  solving: { speed: SOLVING_SPEED, collect: collectSolving },
  searching: { speed: SEARCHING_SPEED, collect: collectSearching },
  breathing: { speed: BREATHING_SPEED, collect: collectBreathing },
  shaping: { speed: SHAPING_SPEED, collect: collectShaping },
  connecting: { speed: CONNECTING_SPEED, collect: collectConnecting }
};

/* ---- morphing one mark into the next ----------------------------------- */

/** How long a state (or ink) change spends reorganising the dust. */
export const MORPH_MS = 760;

/** Angular order around the centre: the reorganisation reads as a turn of
    the same dust rather than every dot crossing the frame. */
function angularSort(dots: OrbDot[], size: number): OrbDot[] {
  const c = size / 2;
  return dots
    .map((d) => ({ d, a: Math.atan2(d.y - c, d.x - c) }))
    .sort((p, q) => p.a - q.a)
    .map((p) => p.d);
}

/** Resample both fields to a common count, then interpolate pairwise. */
export function blendDots(a: OrbDot[], b: OrbDot[], k: number, size: number): OrbDot[] {
  const A = angularSort(a, size);
  const B = angularSort(b, size);
  if (A.length === 0) return B;
  if (B.length === 0) return A;
  const n = Math.max(A.length, B.length);
  const out = new Array<OrbDot>(n);
  for (let i = 0; i < n; i++) {
    const p = A[Math.floor((i * A.length) / n)];
    const q = B[Math.floor((i * B.length) / n)];
    out[i] = {
      x: lerp(p.x, q.x, k),
      y: lerp(p.y, q.y, k),
      z: lerp(p.z, q.z, k),
      r: lerp(p.r, q.r, k),
      white: lerp(p.white, q.white, k),
      a: lerp(p.a ?? 1, q.a ?? 1, k)
    };
  }
  return out;
}

export function fadeLines(lines: readonly OrbLine[], factor: number): OrbLine[] {
  return lines.map((l) => ({ ...l, a: (l.a ?? 1) * factor }));
}

export function blendInk(a: OrbInk, b: OrbInk, k: number): OrbInk {
  return {
    near: [lerp(a.near[0], b.near[0], k), lerp(a.near[1], b.near[1], k), lerp(a.near[2], b.near[2], k)],
    far: [lerp(a.far[0], b.far[0], k), lerp(a.far[1], b.far[1], k), lerp(a.far[2], b.far[2], k)]
  };
}

export function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

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
