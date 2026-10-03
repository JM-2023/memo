// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearImageCache } from "../src/lib/imageCache";
import { derivePreview } from "../src/lib/imageEncode";
import { compressImage, resetEncoderProbe, storedSize, thumbSize } from "../src/lib/images";

// jsdom has no canvas. The fake below encodes at a fixed cost per pixel for
// each format and, like Safari, falls back to PNG for a type it cannot write.
const BYTES_PER_PIXEL: Record<string, number> = { "image/png": 1.5, "image/jpeg": 0.2, "image/webp": 0.15 };

interface FakeContext {
  drawImage: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
  globalCompositeOperation: string;
  fillStyle: string;
  imageSmoothingQuality: string;
  compositeAtFill: string[];
}

let webp = false;
let sourceAlpha = 255;
let natural = { width: 1600, height: 1200 };
let encodes: string[] = [];
let contexts: FakeContext[] = [];

function stubCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (type?: string) {
    return webp && type === "image/webp" ? "data:image/webp;base64,AA==" : "data:image/png;base64,AA==";
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const canvas = this as HTMLCanvasElement & { __context?: FakeContext };
    if (!canvas.__context) {
      const context: FakeContext = {
        drawImage: vi.fn(),
        fillRect: vi.fn(() => context.compositeAtFill.push(context.globalCompositeOperation)),
        getImageData: (_x, _y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4).fill(200);
          for (let index = 3; index < data.length; index += 4) data[index] = sourceAlpha;
          return { data };
        },
        globalCompositeOperation: "source-over",
        fillStyle: "#000",
        imageSmoothingQuality: "low",
        compositeAtFill: []
      };
      canvas.__context = context;
      contexts.push(context);
    }
    return canvas.__context as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
    const requested = type ?? "image/png";
    const actual = requested === "image/webp" && !webp ? "image/png" : requested;
    encodes.push(`${actual}@${this.width}x${this.height}`);
    const size = Math.round(this.width * this.height * BYTES_PER_PIXEL[actual]);
    callback(new Blob([new Uint8Array(size)], { type: actual }));
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => natural.width });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => natural.height });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:test/${Math.random()}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
}

function file(type: string): File {
  return new File([new Uint8Array([1])], `upload.${type.split("/")[1]}`, { type });
}

beforeEach(() => {
  webp = false;
  sourceAlpha = 255;
  natural = { width: 1600, height: 1200 };
  encodes = [];
  contexts = [];
  resetEncoderProbe();
  stubCanvas();
});

afterEach(() => {
  clearImageCache();
});

describe("stored and preview sizes", () => {
  it("keeps the 1600px long-edge cap for ordinary photos", () => {
    expect(storedSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(storedSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("bounds long screenshots by width and area so their text stays legible", () => {
    const { width, height } = storedSize(1179, 8000);
    expect(width).toBeGreaterThan(900);
    expect(width * height).toBeLessThanOrEqual(6_000_000);
    // An ordinary phone screenshot keeps its captured resolution.
    expect(storedSize(1179, 2556)).toEqual({ width: 1179, height: 2556 });
    // An extreme scroll capture still fits a canvas.
    expect(storedSize(1179, 60_000).height).toBeLessThanOrEqual(12_000);
  });

  it("sizes previews by the short edge so cropped grid cells stay sharp", () => {
    expect(thumbSize(1600, 1200)).toEqual({ width: 640, height: 480 });
    // A long screenshot's preview keeps enough width to fill a square cell.
    expect(thumbSize(940, 6381)!.width).toBeGreaterThanOrEqual(320);
    expect(thumbSize(500, 400)).toBeNull();
  });
});

describe("compressImage", () => {
  it("probes WebP once and never pays a PNG encode for an opaque photo on Safari", async () => {
    const toDataURL = vi.mocked(HTMLCanvasElement.prototype.toDataURL);
    const first = await compressImage(file("image/jpeg"));
    await compressImage(file("image/jpeg"));
    expect(first.mime).toBe("image/jpeg");
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(encodes.some((entry) => entry.startsWith("image/png"))).toBe(false);
    expect(first.thumbMime).toBe("image/jpeg");
    expect(first.thumbBase64).toBeTruthy();
  });

  it("keeps a small transparent image as PNG on Safari", async () => {
    natural = { width: 400, height: 400 };
    sourceAlpha = 0;
    const result = await compressImage(file("image/png"));
    expect(result.mime).toBe("image/png");
    expect(contexts.every((context) => context.fillRect.mock.calls.length === 0)).toBe(true);
  });

  it("puts white, not black, behind a transparent image that must become JPEG", async () => {
    sourceAlpha = 0;
    const result = await compressImage(file("image/png"));
    expect(result.mime).toBe("image/jpeg");
    const flattened = contexts.find((context) => context.fillRect.mock.calls.length > 0);
    expect(flattened?.fillStyle).toBe("#fff");
    // Painted behind the existing pixels, not over them.
    expect(flattened?.compositeAtFill).toEqual(["destination-over"]);
  });

  it("encodes WebP with alpha intact where the browser can", async () => {
    webp = true;
    sourceAlpha = 0;
    const result = await compressImage(file("image/png"));
    expect(result.mime).toBe("image/webp");
    expect(result.thumbMime).toBe("image/webp");
    expect(contexts.every((context) => context.fillRect.mock.calls.length === 0)).toBe(true);
  });

  it("stores a long screenshot near its captured width", async () => {
    webp = true;
    natural = { width: 1179, height: 8000 };
    const result = await compressImage(file("image/png"));
    expect(result.width).toBeGreaterThan(900);
    expect(result.height).toBeGreaterThan(6000);
  });

  it("skips the preview when the attachment is already small", async () => {
    webp = true;
    natural = { width: 500, height: 400 };
    const result = await compressImage(file("image/jpeg"));
    expect(result.thumbBase64).toBeUndefined();
  });
});

describe("derivePreview (attachments stored before previews existed)", () => {
  function original(type: string, bytes: number): Blob {
    return new Blob([new Uint8Array(bytes)], { type });
  }

  it("shrinks a served original to the feed preview size", async () => {
    webp = true;
    const preview = await derivePreview(original("image/jpeg", 300_000), 200_000);
    expect(preview?.type).toBe("image/webp");
    expect(encodes).toEqual(["image/webp@640x480"]);
    expect(preview!.size).toBeLessThanOrEqual(140_000);
  });

  it("keeps a small original as it is", async () => {
    natural = { width: 480, height: 360 };
    expect(await derivePreview(original("image/webp", 40_000), 200_000)).toBeNull();
    expect(encodes).toEqual([]);
  });

  it("re-encodes a preview-sized original that is too heavy to keep", async () => {
    natural = { width: 480, height: 360 };
    const preview = await derivePreview(original("image/png", 260_000), 200_000);
    expect(preview?.type).toBe("image/jpeg");
    expect(encodes.at(-1)).toBe("image/jpeg@480x360");
  });

  it("gives up quietly on bytes this browser cannot decode", async () => {
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.reject(new Error("bad")) });
    expect(await derivePreview(original("image/heic", 300_000), 200_000)).toBeNull();
  });
});
