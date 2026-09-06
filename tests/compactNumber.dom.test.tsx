// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { compactNumber } from "../src/lib/compactNumber";
import { LanguageProvider } from "../src/lib/i18n";
import { CompactNumber } from "../src/components/CompactNumber";
import { RollingText } from "../src/components/RollingText";

afterEach(cleanup);
describe("compact sidebar counts", () => {
  it("keeps small tallies exact and carries rounded values into the next unit", () => {
    expect(compactNumber(9999, "en-US")).toEqual({ number: "9999", unit: "" });
    expect(compactNumber(10000, "en-US")).toEqual({ number: "10", unit: "K" });
    expect(compactNumber(999999, "en-US")).toEqual({ number: "1", unit: "M" });
    expect(compactNumber(12345, "zh-CN")).toEqual({ number: "1.23", unit: "万" });
    expect(compactNumber(99999999, "zh-CN")).toEqual({ number: "1", unit: "亿" });
    expect(compactNumber(Number.MAX_SAFE_INTEGER, "zh-CN").number.length).toBeLessThanOrEqual(6);
  });
  it("keeps the exact accessible count and independent number/unit drums", () => {
    const ui = render(<LanguageProvider><CompactNumber value={9999} /></LanguageProvider>);
    const numberDrum = ui.container.querySelector(".roll");
    ui.rerender(<LanguageProvider><CompactNumber value={10000} /></LanguageProvider>);
    expect(ui.container.querySelector(".compact-number")?.getAttribute("aria-label")).toBe("10000");
    expect(ui.container.querySelector(".roll")).toBe(numberDrum);
    expect(ui.container.querySelectorAll(".roll")).toHaveLength(2);
    expect(ui.container.querySelector(".roll-char-in.is-up")).not.toBeNull();
  });
  it("uses the last actual value for direction even when rounded text held still", () => {
    const ui = render(<LanguageProvider><RollingText value={10000} text="10" /></LanguageProvider>);
    ui.rerender(<LanguageProvider><RollingText value={10049} text="10" /></LanguageProvider>);
    // A locale/precision change can expose a smaller value in the same bucket.
    ui.rerender(<LanguageProvider><RollingText value={10020} text="10.02" /></LanguageProvider>);
    expect(ui.container.querySelector(".roll-char-in.is-down")).not.toBeNull();
    expect(ui.container.querySelector(".roll-char-in.is-up")).toBeNull();
  });
});
