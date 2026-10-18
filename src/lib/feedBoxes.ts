/**
 * Reading a feed card's box while the feed's motion layer may be moving it.
 * getBoundingClientRect answers with where a card is drawn — a glide's
 * `translate` and an entrance's `transform` included — which is right for
 * starting motion from the reader's frame and wrong for everything that has
 * to agree with where the card will rest: a remembered reading place, the
 * scroll that puts it back.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The computed `translate` property ("12px 30px", "12px", "none"). */
export function translateOf(value: string): { x: number; y: number } {
  if (!value || value === "none") return { x: 0, y: 0 };
  const [x = "0", y = "0"] = value.trim().split(/\s+/);
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

/** The translation part of a computed `transform` matrix. */
export function translationOf(transform: string): { x: number; y: number } {
  if (!transform || transform === "none" || typeof DOMMatrixReadOnly !== "function") return { x: 0, y: 0 };
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** How far a running glide (`translate`) and the element's own transform carry it from its layout box. */
export function motionOffset(el: Element): { glide: { x: number; y: number }; own: { x: number; y: number } } {
  const style = getComputedStyle(el);
  return { glide: translateOf(style.translate), own: translationOf(style.transform) };
}

/** Where an element rests, in viewport coordinates: its rect without the motion carrying it. */
export function layoutRect(el: Element): Box & { bottom: number } {
  const rect = el.getBoundingClientRect();
  const { glide, own } = motionOffset(el);
  const top = rect.top - glide.y - own.y;
  return { left: rect.left - glide.x - own.x, top, width: rect.width, height: rect.height, bottom: top + rect.height };
}
