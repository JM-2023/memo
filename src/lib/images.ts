import type { NewImagePayload } from "./types";

// Hard budget: the server rejects anything above ~1MB binary, and D1 stores
// the base64 inline. Recompress until each attachment fits.
const MAX_BYTES = 900_000;
const MAX_DIMENSION = 1600;
const MIN_DIMENSION = 480;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read image"));
    };
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
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
 * Draw onto a canvas capped at `maxDim` and encode as WebP (JPEG fallback),
 * lowering quality then dimensions until the result fits MAX_BYTES. Animated
 * GIFs lose animation — acceptable for a personal notebook.
 */
export async function compressImage(file: File): Promise<NewImagePayload> {
  const image = await loadImage(file);
  try {
    let dimension = Math.min(MAX_DIMENSION, Math.max(image.naturalWidth, image.naturalHeight));
    for (;;) {
      const scale = Math.min(1, dimension / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to process image");
      context.drawImage(image, 0, 0, width, height);

      for (const quality of [0.85, 0.75, 0.62, 0.5]) {
        let blob = await toBlob(canvas, "image/webp", quality);
        if (!blob || blob.type !== "image/webp") {
          blob = await toBlob(canvas, "image/jpeg", quality);
        }
        if (blob && blob.size <= MAX_BYTES) {
          return {
            id: crypto.randomUUID(),
            dataBase64: await blobToBase64(blob),
            mime: blob.type,
            width,
            height,
            previewUrl: URL.createObjectURL(blob)
          };
        }
      }

      if (dimension <= MIN_DIMENSION) {
        throw new Error("Image is still too large after compression");
      }
      dimension = Math.max(MIN_DIMENSION, Math.round(dimension * 0.72));
    }
  } finally {
    URL.revokeObjectURL(image.src);
  }
}
