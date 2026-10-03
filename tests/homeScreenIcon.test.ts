import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("home screen icon", () => {
  it("links an opaque 180x180 PNG under the static /assets/ route", () => {
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    const href = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
    expect(href).toBe("/assets/icons/apple-touch-icon.png");

    const png = readFileSync(resolve(root, "public", href!.slice(1)));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // IHDR: width, height, then colour type. iOS fills transparent pixels
    // with black, so the icon carries no alpha channel (type 2 = RGB).
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
    expect(png[25]).toBe(2);
  });
});
