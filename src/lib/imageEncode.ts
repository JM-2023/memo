// Canvas encoding shared by the upload pipeline (images.ts) and the image
// cache (imageCache.ts), which derives a feed preview from an original when
// an attachment stored before previews existed has none. Kept free of either
// module so neither imports the other.

// Feed preview: grid cells are at most 180 CSS px, so a 480px short edge stays
// sharp at 2× (and phones' ~110px cells at 3×) while costing a few dozen KB.
const THUMB_SHORT_EDGE = 480;
// Cells crop to a square, so a long screenshot's preview is bounded by area,
// not by its long edge: its narrow side still has to fill a cell.
const THUMB_MAX_PIXELS = 700_000;
export const THUMB_MAX_BYTES = 140_000;
const THUMB_QUALITIES = [0.72, 0.6];

export interface Size {
  width: number;
  height: number;
}

/** Feed preview size for a stored attachment, or null when it is already small. */
export function thumbSize(width: number, height: number): Size | null {
  const short = Math.min(width, height);
  const scale = Math.min(THUMB_SHORT_EDGE / Math.max(1, short), Math.sqrt(THUMB_MAX_PIXELS / Math.max(1, width * height)));
  // Not worth a second copy unless it saves real pixels.
  if (scale > 0.75) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

let webpEncoding: boolean | undefined;

/**
 * Safari's canvas cannot encode WebP; asked for it, toBlob silently returns a
 * full-size PNG. Probe once on a 1×1 canvas instead of paying that lossless
 * encode on every attachment.
 */
function canEncodeWebp(): boolean {
  if (webpEncoding === undefined) {
    try {
      const probe = document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      webpEncoding = probe.toDataURL("image/webp").startsWith("data:image/webp");
    } catch {
      webpEncoding = false;
    }
  }
  return webpEncoding;
}

/** Test seam: forget the probed encoder support. */
export function resetEncoderProbe(): void {
  webpEncoding = undefined;
}

/**
 * Whether any pixel is not fully opaque, judged on a small downscaled copy:
 * averaging spreads any transparent region (a window shadow, a sticker's
 * background, rounded icon corners) into the sample. JPEG sources cannot
 * carry alpha and skip the check.
 */
export function hasTransparency(mime: string, source: CanvasImageSource, width: number, height: number): boolean {
  if (mime === "image/jpeg") return false;
  const scale = Math.min(1, 128 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  try {
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
  } catch {
    return false;
  }
  return false;
}

export function drawTo(source: CanvasImageSource, size: Size): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to process image");
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

/**
 * Formats without alpha are composited onto opaque black when encoded, which
 * turns a transparent PNG into a black slab. Paint white behind the existing
 * pixels before the first such encode; the canvas is reused afterwards.
 */
const flattened = new WeakSet<HTMLCanvasElement>();

function flattenOntoWhite(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");
  if (!context || flattened.has(canvas)) return;
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
  flattened.add(canvas);
}

/**
 * Encode within `maxBytes`: WebP where the browser can (it keeps alpha), else
 * PNG for a transparent image when that fits, else JPEG over white.
 */
export async function encode(canvas: HTMLCanvasElement, transparent: boolean, qualities: number[], maxBytes: number): Promise<Blob | null> {
  if (canEncodeWebp()) {
    for (const quality of qualities) {
      const blob = await toBlob(canvas, "image/webp", quality);
      if (blob && blob.type === "image/webp" && blob.size <= maxBytes) return blob;
      if (blob && blob.type !== "image/webp") {
        webpEncoding = false;
        break;
      }
    }
    if (webpEncoding !== false) return null;
  }
  if (transparent) {
    const png = await toBlob(canvas, "image/png");
    if (png && png.type === "image/png" && png.size <= maxBytes) return png;
    flattenOntoWhite(canvas);
  }
  for (const quality of qualities) {
    const blob = await toBlob(canvas, "image/jpeg", quality);
    if (blob && blob.size <= maxBytes) return blob;
  }
  return null;
}

/** The feed preview for an upload, encoded from its stored-size canvas. */
export async function encodeThumb(source: HTMLCanvasElement, transparent: boolean): Promise<Blob | null> {
  const size = thumbSize(source.width, source.height);
  if (!size) return null;
  try {
    return await encode(drawTo(source, size), transparent && !flattened.has(source), THUMB_QUALITIES, THUMB_MAX_BYTES);
  } catch {
    // A preview is an optimization; the feed falls back to the original.
    return null;
  }
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decodeBlob(blob: Blob): Promise<Decoded> {
  // createImageBitmap decodes off the main thread where it exists.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to an <img> decode.
    }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

// Each derivation holds a decoded original and a canvas; a screenful of old
// attachments must not decode all of them at once.
const DERIVE_CONCURRENCY = 2;
let deriving = 0;
const waiting: Array<() => void> = [];

async function inSlot<T>(task: () => Promise<T>): Promise<T> {
  if (deriving >= DERIVE_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  else deriving += 1;
  try {
    return await task();
  } finally {
    // Hand the slot straight to the next waiter, or give it back.
    const next = waiting.shift();
    if (next) next();
    else deriving -= 1;
  }
}

/**
 * A feed preview made on this device from an original the server returned in
 * its place (attachments stored before previews existed have none). Null when
 * the original is already preview-sized and small enough to keep, or when
 * this browser cannot decode or encode it; the caller then keeps the bytes.
 */
export function derivePreview(original: Blob, keepUnder: number): Promise<Blob | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return inSlot(async () => {
    const decoded = await decodeBlob(original);
    try {
      const { width, height } = decoded;
      const size = thumbSize(width, height) ?? (original.size > keepUnder ? { width, height } : null);
      if (!size) return null;
      const transparent = hasTransparency(original.type, decoded.source, width, height);
      return await encode(drawTo(decoded.source, size), transparent, THUMB_QUALITIES, THUMB_MAX_BYTES);
    } finally {
      decoded.close();
    }
  }).catch(() => null);
}
