import type { CSSProperties } from "react";
import type { MemoImage } from "./types";
import { thumbSize } from "./imageEncode";

/** A lone image keeps its own shape within these bounds; beyond them it crops. */
const SINGLE_MIN_RATIO = 2 / 3;
const SINGLE_MAX_RATIO = 16 / 9;

/** The clamped width/height ratio a lone image is drawn at, or null when unknown. */
export function singleImageRatio(image: Pick<MemoImage, "width" | "height"> | undefined): number | null {
  if (!image || !(image.width > 0) || !(image.height > 0)) return null;
  return Math.min(SINGLE_MAX_RATIO, Math.max(SINGLE_MIN_RATIO, image.width / image.height));
}

/**
 * Grid geometry shared by the live card and MemoStage's ghost layers, so both
 * lay out identically. Two or four images form a 2-wide grid (a pair, a 2×2),
 * every other count three columns; cells share one size cap in CSS, so more
 * images never mean bigger cells. A lone stored image reserves its own aspect
 * ratio from the stored dimensions before any byte arrives.
 */
export function mediaGridProps(count: number, first: MemoImage | undefined): { className: string; style?: CSSProperties } {
  if (count <= 1) {
    const ratio = singleImageRatio(first);
    return {
      className: "memo-images count-1",
      style: ratio ? ({ "--media-ratio": ratio.toFixed(4) } as CSSProperties) : undefined
    };
  }
  return { className: `memo-images ${count === 2 || count === 4 ? "cols-2" : "cols-3"}` };
}

/**
 * Whether the feed preview is sharp enough for a box of this CSS size at this
 * device pixel ratio. The tile uses object-fit: cover, which scales the
 * source until it fills both box edges; a little upscaling is invisible.
 */
export function previewCovers(image: Pick<MemoImage, "width" | "height">, boxWidth: number, boxHeight: number, dpr: number): boolean {
  const thumb = thumbSize(image.width, image.height);
  // No preview was made for a small image: both URLs serve the same bytes.
  if (!thumb) return true;
  return Math.max(boxWidth / thumb.width, boxHeight / thumb.height) * dpr <= 1.15;
}
