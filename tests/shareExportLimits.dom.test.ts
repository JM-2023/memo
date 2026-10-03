// @vitest-environment jsdom

// Share-card export limits: a card taller than any canvas will hold renders at
// a reduced scale, or — past the smallest scale worth saving — refuses with a
// named error instead of a blank or generic failure; and wide code / display
// math is brought inside the sheet, since the PNG is a photograph of the
// card's own box and anything scrolled past its edge would be missing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_MIN_PX, fitWideBlocks } from "../src/lib/shareFit";
import { MIN_EXPORT_SCALE, ShareImageTooLargeError, exportScaleFor, nodeToPngBlob } from "../src/lib/shareImage";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("exportScaleFor", () => {
  it("keeps the preferred scale while the canvas allows it", () => {
    expect(exportScaleFor(400, 1200, 2.5)).toBe(2.5);
    expect(exportScaleFor(640, 3000, 2.5)).toBe(2.5);
  });

  it("steps down to fit iOS's canvas area limit", () => {
    // 400 × 10,000 at 2.5× would be 25M pixels — over the 16.7M cap.
    const scale = exportScaleFor(400, 10_000, 2.5);
    expect(scale).not.toBeNull();
    expect(scale!).toBeLessThan(2.5);
    expect(scale!).toBeGreaterThanOrEqual(MIN_EXPORT_SCALE);
    expect(400 * scale! * 10_000 * scale!).toBeLessThanOrEqual(16_777_216);
  });

  it("steps down to fit the longest canvas side", () => {
    const scale = exportScaleFor(400, 20_000, 2.5);
    expect(scale).not.toBeNull();
    expect(Math.round(20_000 * scale!)).toBeLessThanOrEqual(32_767);
  });

  it("gives up below the smallest useful scale", () => {
    expect(exportScaleFor(640, 40_000, 2.5)).toBeNull();
    expect(exportScaleFor(400, 40_000, 2.5)).toBeNull();
  });
});

describe("nodeToPngBlob", () => {
  it("throws a named error for a card no canvas can hold, before rasterizing", async () => {
    const node = document.createElement("div");
    vi.spyOn(node, "offsetWidth", "get").mockReturnValue(640);
    vi.spyOn(node, "offsetHeight", "get").mockReturnValue(50_000);
    const createElement = vi.spyOn(document, "createElement");

    await expect(nodeToPngBlob(node, { css: "", scale: 2.5 })).rejects.toBeInstanceOf(ShareImageTooLargeError);
    expect(createElement).not.toHaveBeenCalledWith("canvas");
  });
});

/** A block whose scrollWidth follows its font size, like monospace text. */
function wideBlock(className: string, charsWide: number, room: number, markup: string): HTMLElement {
  const block = document.createElement("div");
  block.className = className;
  block.innerHTML = markup;
  document.body.appendChild(block);
  const fontSize = () => Number.parseFloat(block.style.fontSize) || 14;
  vi.spyOn(block, "clientWidth", "get").mockReturnValue(room);
  vi.spyOn(block, "scrollWidth", "get").mockImplementation(() =>
    block.classList.contains("is-wrapped") ? room : Math.max(room, Math.ceil(charsWide * fontSize() * 0.6))
  );
  return block;
}

describe("fitWideBlocks", () => {
  it("leaves blocks that already fit alone", () => {
    const card = document.createElement("div");
    document.body.appendChild(card);
    const block = wideBlock("md-codeblock", 20, 336, "<code>short</code>");
    card.appendChild(block);

    expect(fitWideBlocks(card)).toBe(false);
    expect(block.style.fontSize).toBe("");
    expect(block.classList.contains("is-wrapped")).toBe(false);
  });

  it("steps long code down until its longest line fits", () => {
    const card = document.createElement("div");
    document.body.appendChild(card);
    // 50 chars at 14px ≈ 420px into 336px of room → ~11.2px fits.
    const block = wideBlock("md-codeblock", 50, 336, "<code>x</code>");
    card.appendChild(block);

    expect(fitWideBlocks(card)).toBe(false);
    const size = Number.parseFloat(block.style.fontSize);
    expect(size).toBeGreaterThanOrEqual(CODE_MIN_PX);
    expect(size).toBeLessThan(14);
    expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
  });

  it("wraps code that is too wide even at the smallest size, and says so", () => {
    const card = document.createElement("div");
    document.body.appendChild(card);
    const block = wideBlock("md-codeblock", 200, 336, "<code>x</code>");
    card.appendChild(block);

    expect(fitWideBlocks(card)).toBe(true);
    expect(block.classList.contains("is-wrapped")).toBe(true);
    expect(block.style.fontSize).toBe(`${CODE_MIN_PX}px`);
  });

  it("scales a wide formula down whole rather than wrapping it", () => {
    const card = document.createElement("div");
    document.body.appendChild(card);
    const block = wideBlock("md-math-block", 60, 336, "<span class='md-math'></span>");
    card.appendChild(block);

    expect(fitWideBlocks(card)).toBe(false);
    expect(block.classList.contains("is-wrapped")).toBe(false);
    expect(Number.parseFloat(block.style.fontSize)).toBeLessThan(14);
    expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
  });

  it("starts each pass from the block's own size", () => {
    const card = document.createElement("div");
    document.body.appendChild(card);
    const block = wideBlock("md-codeblock", 200, 336, "<code>x</code>");
    card.appendChild(block);
    fitWideBlocks(card);

    // The sheet widens (landscape): the same code now fits as set.
    vi.spyOn(block, "clientWidth", "get").mockReturnValue(2000);
    expect(fitWideBlocks(card)).toBe(false);
    expect(block.classList.contains("is-wrapped")).toBe(false);
    expect(block.style.fontSize).toBe("");
  });
});
