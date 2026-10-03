/**
 * Wide blocks on the share card. A code block keeps its spacing (white-space:
 * pre) and a display formula can't break, so either can be wider than the
 * sheet — and the PNG is a photograph of the card's own box, so whatever runs
 * past it is simply not in the image. Each one is brought inside the sheet
 * instead, as an inline style on the live node so the export clone carries
 * exactly what the preview shows:
 *
 * - code steps its type down until the longest line fits, to CODE_MIN_PX;
 *   past that it wraps (`.is-wrapped` in shareCard.css) at the floor size,
 *   which keeps as many lines whole as the measure allows;
 * - a formula is one object, so it scales down until it fits, like an image.
 *
 * Measures layout boxes (scrollWidth/clientWidth), which the preview's
 * fit-to-dialog transform does not touch.
 */

/** Smallest code size before lines wrap: 25 device px in a 2.5× export. */
export const CODE_MIN_PX = 10;
/** A formula gives up its size before its shape, but not to nothing. */
const MATH_MIN_PX = 4;
const STEP_PX = 0.5;

function overflows(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth;
}

function fontSizeOf(element: HTMLElement): number {
  return Number.parseFloat(window.getComputedStyle(element).fontSize) || 16;
}

/** Shrink `block`'s type — its line height follows, being relative — until
    it stops overflowing or `floor` is hit; returns whether it fits. Starts
    from the proportional guess, then steps, since padding keeps the ratio
    from being exact. */
function shrinkToFit(block: HTMLElement, floor: number): boolean {
  const base = fontSizeOf(block);
  let size = Math.max(floor, Math.floor(((base * block.clientWidth) / block.scrollWidth) * 10) / 10);
  block.style.fontSize = `${size}px`;
  while (overflows(block) && size > floor) {
    size = Math.max(floor, size - STEP_PX);
    block.style.fontSize = `${size}px`;
  }
  return !overflows(block);
}

/**
 * Fit every code block and display formula inside `card`. Idempotent: each
 * pass first clears what the last one set, so it can re-run whenever the
 * sheet's face or width changes. Returns true when some code had to wrap.
 */
export function fitWideBlocks(card: HTMLElement): boolean {
  let wrapped = false;
  for (const block of card.querySelectorAll<HTMLElement>(".md-codeblock")) {
    block.classList.remove("is-wrapped");
    block.style.removeProperty("font-size");
    if (!overflows(block)) continue;
    if (shrinkToFit(block, CODE_MIN_PX)) continue;
    block.classList.add("is-wrapped");
    wrapped = true;
  }
  for (const block of card.querySelectorAll<HTMLElement>(".md-math-block")) {
    block.style.removeProperty("font-size");
    if (overflows(block)) shrinkToFit(block, MATH_MIN_PX);
  }
  return wrapped;
}
