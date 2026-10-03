import { primeImage } from "./imageCache";
import { drawTo, encode, encodeThumb, hasTransparency, type Size } from "./imageEncode";
import type { NewImagePayload } from "./types";

export { resetEncoderProbe, thumbSize, type Size } from "./imageEncode";

// Hard budget: the server rejects anything above ~1MB binary, and D1 stores
// the base64 inline. Recompress until each attachment fits.
const MAX_BYTES = 900_000;
const MAX_DIMENSION = 1600;
const MIN_DIMENSION = 480;
// Long screenshots (chat logs, scrolled pages) are text: capping their long
// edge at 1600px would shrink a 1179×8000 capture to ~236px wide. Past 2:1
// they are bounded by the short edge and by area instead, which keeps the
// text near its captured size; the byte budget below still applies.
const LONG_ASPECT = 2;
const LONG_SHORT_EDGE = 1280;
const LONG_MAX_PIXELS = 6_000_000;
// Under iOS Safari's canvas area limit and WebP's 16383px edge limit.
const LONG_MAX_EDGE = 12_000;
const LONG_MIN_SHORT_EDGE = 320;

/** The pixel size an attachment is stored at before any byte-budget shrink. */
export function storedSize(naturalWidth: number, naturalHeight: number): Size {
  const long = Math.max(naturalWidth, naturalHeight);
  const short = Math.max(1, Math.min(naturalWidth, naturalHeight));
  let scale: number;
  if (long / short <= LONG_ASPECT) {
    scale = MAX_DIMENSION / long;
  } else {
    scale = Math.min(LONG_SHORT_EDGE / short, Math.sqrt(LONG_MAX_PIXELS / (long * short)), LONG_MAX_EDGE / long);
  }
  scale = Math.min(1, scale);
  return { width: Math.max(1, Math.round(naturalWidth * scale)), height: Math.max(1, Math.round(naturalHeight * scale)) };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  // decode() finishes decoding off the main thread, so drawImage below does
  // not stall on a large photo the way onload + a synchronous draw can.
  return image.decode().then(
    () => image,
    () => {
      URL.revokeObjectURL(url);
      throw new Error("Unable to read image");
    }
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Draw onto a canvas at storedSize() and encode, lowering quality then
 * dimensions until the result fits MAX_BYTES; a small feed preview is encoded
 * from the same canvas. Animated GIFs lose animation — acceptable for a
 * personal notebook.
 */
export async function compressImage(file: File): Promise<NewImagePayload> {
  const image = await loadImage(file);
  try {
    const transparent = hasTransparency(file.type, image, image.naturalWidth, image.naturalHeight);
    let { width, height } = storedSize(image.naturalWidth, image.naturalHeight);
    const landscape = width >= height;
    for (;;) {
      const canvas = drawTo(image, { width, height });
      const blob = await encode(canvas, transparent, [0.85, 0.75, 0.62, 0.5], MAX_BYTES);
      if (blob) {
        const id = crypto.randomUUID();
        const thumb = await encodeThumb(canvas, transparent);
        // The just-sent memo then draws from memory instead of downloading
        // what this device already holds.
        primeImage(id, "thumb", thumb ?? blob);
        primeImage(id, "full", blob);
        return {
          id,
          dataBase64: await blobToBase64(blob),
          mime: blob.type,
          width,
          height,
          ...(thumb ? { thumbBase64: await blobToBase64(thumb), thumbMime: thumb.type } : {}),
          previewUrl: URL.createObjectURL(blob)
        };
      }

      const longEdge = landscape ? width : height;
      const shortEdge = landscape ? height : width;
      if (longEdge <= MIN_DIMENSION || shortEdge <= LONG_MIN_SHORT_EDGE) {
        throw new Error("Image is still too large after compression");
      }
      const scale = Math.max(0.72, MIN_DIMENSION / longEdge);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
  } finally {
    URL.revokeObjectURL(image.src);
  }
}
