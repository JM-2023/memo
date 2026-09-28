/**
 * The share card's ink, painted rather than faked.
 *
 * Privacy mode and the dateline take marks off the sheet and put them back.
 * While a mark travels, its DOM text stays exactly where it is (so nothing
 * reflows) but goes transparent, and a canvas laid over it carries the ink:
 *
 *   drink — the Riddle diary's own dissolve (ink.rs dissolve_pass): every
 *           device pixel of the glyphs is dealt a moment by the diary's
 *           per-pixel hash and soaks away at it, so the page drinks the mark
 *           speck by speck instead of fading it as a whole.
 *   write — the diary's hand (script.rs): the glyphs are rasterized,
 *           thinned to a one-pixel skeleton (Zhang–Suen) and traced into pen
 *           strokes ordered left to right. The pen then walks those strokes,
 *           and each glyph pixel comes up as the pen passes the point of the
 *           skeleton nearest to it. What the pen lays down is the mark's own
 *           rendered pixels, not a monoline stand-in, so the last frame is the
 *           text itself and the hand-off back to the DOM has nothing to jump.
 *
 * Thinning and tracing are ported from riddle-ink.js (after riddle, MIT).
 */

/** The diary's per-pixel hash (ink.rs px_hash). */
export function pxHash(x: number, y: number): number {
  let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Zhang–Suen thinning, in place: a 0/1 mask down to one-pixel-wide lines.
    The outermost ring is never touched, so callers leave a margin. */
export function thin(mask: Uint8Array, w: number, h: number): void {
  const clear: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      clear.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!mask[i]) continue;
          // P2..P9 clockwise from north.
          const p2 = mask[i - w], p3 = mask[i - w + 1], p4 = mask[i + 1], p5 = mask[i + w + 1];
          const p6 = mask[i + w], p7 = mask[i + w - 1], p8 = mask[i - 1], p9 = mask[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a =
            (+!p2 & p3) + (+!p3 & p4) + (+!p4 & p5) + (+!p5 & p6) + (+!p6 & p7) + (+!p7 & p8) + (+!p8 & p9) + (+!p9 & p2);
          if (a !== 1) continue;
          if (phase === 0 ? (p2 & p4 & p6) | (p4 & p6 & p8) : (p2 & p4 & p8) | (p2 & p6 & p8)) continue;
          clear.push(i);
        }
      }
      if (clear.length) {
        changed = true;
        for (const i of clear) mask[i] = 0;
      }
    }
  }
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1]
];

/**
 * Walk a skeleton into polylines of pixel indices: from its endpoints first,
 * then whatever is left (closed loops), always taking the first unvisited
 * neighbour. Unsorted — the caller decides what "left to right" means once
 * a mark can wrap onto a second line. Short paths are kept, as the port
 * keeps them: at card sizes they are the dots on i and j.
 */
export function trace(mask: Uint8Array, w: number, h: number): number[][] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const degree = (x: number, y: number) => {
    let n = 0;
    for (const [dx, dy] of NEIGHBOURS) if (on(x + dx, y + dy)) n++;
    return n;
  };
  const starts: number[] = [];
  for (let i = 0; i < w * h; i++) if (mask[i] && degree(i % w, (i / w) | 0) === 1) starts.push(i);
  for (let i = 0; i < w * h; i++) if (mask[i]) starts.push(i);

  const visited = new Uint8Array(w * h);
  const strokes: number[][] = [];
  for (const start of starts) {
    if (visited[start]) continue;
    visited[start] = 1;
    const path = [start];
    let x = start % w;
    let y = (start / w) | 0;
    for (;;) {
      let next = -1;
      for (const [dx, dy] of NEIGHBOURS) {
        if (on(x + dx, y + dy) && !visited[(y + dy) * w + x + dx]) {
          next = (y + dy) * w + x + dx;
          break;
        }
      }
      if (next < 0) break;
      visited[next] = 1;
      path.push(next);
      x = next % w;
      y = (next / w) | 0;
    }
    strokes.push(path);
  }
  return strokes;
}

/**
 * When each inked pixel comes up, as a fraction of the pen's walk: skeleton
 * pixels take their place along the ordered strokes, and every other pixel
 * of ink takes the moment of the skeleton pixel it is nearest to through the
 * ink (a multi-source flood). Ink the flood can't reach — a hairline too
 * faint to leave a skeleton — comes up as the pen passes its column.
 * Pixels with no ink are -1.
 */
export function revealOrder(alpha: Uint8Array, w: number, h: number, strokes: number[][]): Float32Array {
  const order = new Float32Array(w * h).fill(-1);
  let total = 0;
  for (const stroke of strokes) total += stroke.length;
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  let n = 0;
  for (const stroke of strokes) {
    for (const i of stroke) {
      if (order[i] < 0) {
        order[i] = total > 1 ? n / (total - 1) : 0;
        queue[tail++] = i;
      }
      n++;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (alpha[j] === 0 || order[j] >= 0) continue;
      order[j] = order[i];
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (alpha[i] > 0 && order[i] < 0) order[i] = w > 1 ? (i % w) / (w - 1) : 0;
  }
  return order;
}

export type InkGesture = "drink" | "write";

export interface InkPlay {
  gesture: InkGesture;
  /** Total length of the gesture — the same clock the dialog unmounts on. */
  durationMs: number;
  /** Write only: a beat before the pen touches down. */
  leadMs: number;
}

/** Room around the mark's box for glyphs that overhang their advance —
    a script face's swashes, mostly. */
const PAD = 4;
/** Each pixel soaks away over this long once its moment comes. Short enough
    that the page reads as speckled mid-drink rather than as a fade. */
const DRINK_SOAK_MS = 90;
/** Ink comes off the pen wet — at a quarter strength — and dries up to full
    over this long behind it. */
const WRITE_WET_MS = 110;
const WRITE_WET_FLOOR = 0.25;
/** Finish a frame or two before the dialog's own timer settles the mark, so
    the hand-off always lands on a finished frame. */
const END_SLACK_MS = 24;
/** Nearly-opaque ink is the part of a glyph the skeleton is traced from. */
const MASK_ALPHA = 128;

interface Glyph {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  line: number;
}

function graphemesOf(text: string): { segment: string; index: number }[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  const out: { segment: string; index: number }[] = [];
  let index = 0;
  for (const segment of text) {
    out.push({ segment, index });
    index += segment.length;
  }
  return out;
}

/** Where every grapheme of the mark sits, in the host's own (untransformed)
    CSS pixels, grouped into the lines it actually broke onto. */
function measureGlyphs(host: HTMLElement, node: CharacterData, hostRect: DOMRect, scale: number): Glyph[] {
  const range = document.createRange();
  const glyphs: Glyph[] = [];
  let lineTop = Number.NaN;
  let line = -1;
  for (const { segment, index } of graphemesOf(node.data)) {
    range.setStart(node, index);
    range.setEnd(node, index + segment.length);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const top = (rect.top - hostRect.top) / scale;
    const height = rect.height / scale;
    if (!(Math.abs(top - lineTop) < height / 2)) {
      line++;
      lineTop = top;
    }
    glyphs.push({ text: segment, left: (rect.left - hostRect.left) / scale, top, width: rect.width / scale, height, line });
  }
  return glyphs;
}

/**
 * Run one gesture over `host`, painting into `canvas` (a child of `host`,
 * absolutely positioned). Returns the cleanup. If the mark can't be measured
 * or painted — no layout, no 2D context — nothing is hidden and the mark
 * simply stays as the DOM draws it until the dialog settles it.
 */
export function playInk(host: HTMLElement, canvas: HTMLCanvasElement, play: InkPlay): () => void {
  const noop = () => {};
  const node = [...host.childNodes].find((child): child is CharacterData & ChildNode => child.nodeType === Node.TEXT_NODE);
  const probe = host.querySelector<HTMLElement>(".sc-ink-base");
  if (!node || !probe || !host.offsetWidth || typeof document.createRange !== "function") return noop;

  const hostRect = host.getBoundingClientRect();
  // The preview shrinks the card with a transform; paint at the pixels the
  // screen will actually show, so a speck is one device pixel. The scale is
  // read off the canvas at a known CSS width — it sits out of flow, so this
  // moves nothing — because offsetWidth is rounded, and a mark's own box is
  // rarely a whole number of pixels wide.
  canvas.style.width = "100px";
  const scale = canvas.getBoundingClientRect().width / 100;
  if (!(scale > 0)) return noop;
  const dpr = window.devicePixelRatio || 1;
  const k = Math.min(4, Math.max(0.5, dpr * scale));

  const glyphs = measureGlyphs(host, node, hostRect, scale);
  if (glyphs.length === 0) return noop;
  // The probe is a zero-height inline-block ahead of the text: its top is the
  // first line's baseline, and every line keeps the same offset below its top.
  const baselineDrop = (probe.getBoundingClientRect().top - hostRect.top) / scale - glyphs[0].top;

  let right = hostRect.width / scale;
  let bottom = hostRect.height / scale;
  const lineTops: number[] = [];
  for (const glyph of glyphs) {
    right = Math.max(right, glyph.left + glyph.width);
    bottom = Math.max(bottom, glyph.top + glyph.height);
    lineTops[glyph.line] ??= glyph.top;
  }
  // A canvas at a fractional device position is snapped when it is
  // composited, and the ink would land a pixel off the text it replaces. So
  // its corner goes onto a whole device pixel, and the fraction moves into
  // where the type is set instead.
  const snap = (screen: number) => ((screen * dpr) % 1 + 1) % 1 / dpr / scale;
  const offX = PAD + snap(hostRect.left - PAD * scale);
  const offY = PAD + snap(hostRect.top - PAD * scale);
  // Whole CSS pixels for the box, too: a canvas 52.5px wide is laid out 53px
  // wide and its bitmap stretched to fit, and the ink drifts off the text by
  // a growing fraction of a pixel along the line.
  const cssWidth = Math.ceil(right + offX + PAD);
  const cssHeight = Math.ceil(bottom + offY + PAD);
  canvas.width = Math.round(cssWidth * k);
  canvas.height = Math.round(cssHeight * k);
  canvas.style.left = `${-offX}px`;
  canvas.style.top = `${-offY}px`;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return noop;

  // ---- Lay the mark down exactly as the DOM set it. ----
  const style = getComputedStyle(host);
  const tracking = style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing) || 0;
  // The canvas shapes each line's run itself, the way the DOM does — placing
  // glyphs one by one at their Range rects drifts off the painted text by a
  // fraction of a pixel per glyph. Two things canvas can't do are handled
  // around the runs: tabular figures (each figure is set alone, centred in
  // the column the DOM gave it), and tracking where ctx.letterSpacing isn't
  // supported (every glyph set alone at its DOM position).
  const tabular = style.fontVariantNumeric.includes("tabular-nums");
  const canTrack = "letterSpacing" in ctx;
  ctx.setTransform(k, 0, 0, k, offX * k, offY * k);
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (canTrack) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${tracking}px`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  // The DOM sets a line on the device pixel at or above its baseline; canvas
  // would round to the nearest one, and half the time put the ink a pixel
  // high. The canvas's corner is on a whole pixel, so flooring here is
  // flooring on the screen.
  const baselineOf = (glyph: Glyph) => Math.floor((glyph.top + baselineDrop + offY) * k + 1e-3) / k - offY;
  const alone = (glyph: Glyph) => (tabular && /\p{Nd}/u.test(glyph.text)) || (tracking !== 0 && !canTrack);
  let run: Glyph[] = [];
  const flush = () => {
    if (run.length) ctx.fillText(run.map((glyph) => glyph.text).join(""), run[0].left, baselineOf(run[0]));
    run = [];
  };
  for (const glyph of glyphs) {
    if (run.length && run[0].line !== glyph.line) flush();
    if (!alone(glyph)) {
      run.push(glyph);
      continue;
    }
    flush();
    if (!glyph.text.trim()) continue;
    // Tracked by the context where it can be, so its advance already counts it.
    const advance = ctx.measureText(glyph.text).width + (canTrack ? 0 : tracking);
    const nudge = /\p{Nd}/u.test(glyph.text) ? (glyph.width - advance) / 2 : 0;
    ctx.fillText(glyph.text, glyph.left + nudge, baselineOf(glyph));
  }
  flush();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const w = canvas.width;
  const h = canvas.height;
  const source = ctx.getImageData(0, 0, w, h);
  const alpha = new Uint8Array(w * h);
  const inked: number[] = [];
  for (let i = 0; i < w * h; i++) {
    alpha[i] = source.data[i * 4 + 3];
    if (alpha[i] > 0) inked.push(i);
  }
  if (inked.length === 0) return noop;

  // ---- Deal every pixel its moment. ----
  const end = Math.max(0, play.durationMs - END_SLACK_MS);
  const at = new Float32Array(inked.length);
  let ramp: number;
  if (play.gesture === "drink") {
    ramp = Math.min(DRINK_SOAK_MS, end);
    const span = end - ramp;
    for (let n = 0; n < inked.length; n++) {
      const i = inked[n];
      at[n] = (pxHash(i % w, (i / w) | 0) / 0x1_0000_0000) * span;
    }
  } else {
    const lead = Math.min(play.leadMs, end);
    ramp = Math.min(WRITE_WET_MS, end - lead);
    const pen = end - lead - ramp;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = alpha[i] >= MASK_ALPHA ? 1 : 0;
    thin(mask, w, h);
    // Left to right within a line, line after line.
    const lineOf = (i: number) => {
      const y = (i / w) | 0;
      let line = 0;
      for (let l = 1; l < lineTops.length; l++) if (y >= (lineTops[l] + offY) * k) line = l;
      return line;
    };
    const keyed = trace(mask, w, h).map((stroke) => {
      let minX = Infinity;
      for (const i of stroke) minX = Math.min(minX, i % w);
      return { stroke, line: lineOf(stroke[0]), minX };
    });
    keyed.sort((a, b) => a.line - b.line || a.minX - b.minX);
    const order = revealOrder(alpha, w, h, keyed.map((entry) => entry.stroke));
    for (let n = 0; n < inked.length; n++) at[n] = lead + order[inked[n]] * pen;
  }

  const frame = ctx.createImageData(w, h);
  const out = frame.data;
  for (const i of inked) {
    out[i * 4] = source.data[i * 4];
    out[i * 4 + 1] = source.data[i * 4 + 1];
    out[i * 4 + 2] = source.data[i * 4 + 2];
  }
  const drinking = play.gesture === "drink";
  const paint = (t: number) => {
    for (let n = 0; n < inked.length; n++) {
      const i = inked[n];
      const u = ramp > 0 ? (t - at[n]) / ramp : t >= at[n] ? 1 : -1;
      let f: number;
      if (drinking) f = u <= 0 ? 1 : u >= 1 ? 0 : 1 - u;
      else f = u < 0 ? 0 : u >= 1 ? 1 : WRITE_WET_FLOOR + (1 - WRITE_WET_FLOOR) * u;
      out[i * 4 + 3] = alpha[i] * f;
    }
    ctx.putImageData(frame, 0, 0);
  };

  // Hand the mark to the canvas in the same frame the canvas first paints it.
  const t0 = performance.now();
  paint(0);
  host.setAttribute("data-ink", "");
  let raf = requestAnimationFrame(function tick(now) {
    const t = now - t0;
    paint(Math.min(t, end));
    if (t < end) raf = requestAnimationFrame(tick);
  });
  return () => {
    cancelAnimationFrame(raf);
    host.removeAttribute("data-ink");
  };
}
