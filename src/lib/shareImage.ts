/**
 * DOM → PNG for the share card. The card's stylesheet rides along as text
 * beside a serialized clone inside an SVG <foreignObject>; the SVG is loaded
 * through an <img> and drawn onto a canvas. Everything the SVG document
 * needs is self-contained — styles as embedded text, bitmaps as data URIs,
 * fonts by local name — because an SVG rendered as an image cannot make
 * network requests.
 */

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Longest embedded-bitmap side. Card tiles render at ≤600 device px in the
    export, so this keeps full sharpness with headroom while bounding the
    data-URI payload. */
const MAX_BITMAP_SIDE = 1200;

/**
 * Re-encode a loaded <img> as a data URI, downscaled to what the export can
 * actually show. Opaque bitmaps become JPEG (photos would balloon as PNG);
 * anything with an alpha channel stays PNG. Returns null when the bitmap is
 * unusable — not yet loaded, zero-sized, or CORS-tainted (the getImageData
 * probe throws on a tainted canvas).
 */
function bitmapToDataUrl(image: HTMLImageElement): string | null {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const cap = Math.min(1, MAX_BITMAP_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * cap));
  canvas.height = Math.max(1, Math.round(height * cap));
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = true;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 255) {
        opaque = false;
        break;
      }
    }
    return opaque ? canvas.toDataURL("image/jpeg", 0.9) : canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

export interface NodePngOptions {
  /** Stylesheet text embedded beside the clone — shareCard.css via ?raw. */
  css: string;
  /** Rasterization multiplier over the node's CSS-pixel size. */
  scale?: number;
}

/**
 * Rasterize `node` to a PNG blob at `scale`× its layout size. The node must
 * be styled entirely by `css` (plus attributes it carries): the clone is
 * serialized without computed styles. Corners left uncovered by the node's
 * own background stay transparent.
 */
export async function nodeToPngBlob(node: HTMLElement, { css, scale = 2.5 }: NodePngOptions): Promise<Blob> {
  // offsetWidth/Height = layout size, deliberately ignoring the preview's
  // fit-to-dialog transform.
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const clone = node.cloneNode(true) as HTMLElement;
  clone.style.transform = "none";

  const liveImages = node.querySelectorAll("img");
  clone.querySelectorAll("img").forEach((cloneImage, index) => {
    const dataUrl = bitmapToDataUrl(liveImages[index]);
    if (dataUrl) cloneImage.setAttribute("src", dataUrl);
    else cloneImage.remove();
  });

  const markup = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="${XHTML_NS}"><style>${css}</style>${markup}</div>` +
    `</foreignObject></svg>`;

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred revoke — WebKit may still be reading the blob at click time.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function supportsImageClipboard(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copy a rendered PNG to the clipboard. The ClipboardItem is constructed
 * synchronously in the calling gesture with a promise payload — Safari
 * rejects items created after an await. Engines that predate promise
 * payloads throw a TypeError at construction; those get one direct retry.
 */
export async function copyPngToClipboard(render: () => Promise<Blob>): Promise<void> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": render() })]);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": await render() })]);
  }
}
