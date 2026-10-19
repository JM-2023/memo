// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { compactNumber } from "../src/lib/compactNumber";
import { LanguageProvider, useI18n } from "../src/lib/i18n";
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
    // The exact count, grouped from five digits on.
    expect(ui.container.querySelector(".compact-number > .sr-only")?.textContent).toBe("10,000");
    expect(ui.container.querySelector("[role=text]")).toBeNull();
    expect(ui.container.querySelector(".roll")).toBe(numberDrum);
    expect(ui.container.querySelectorAll(".roll")).toHaveLength(2);
    expect(ui.container.querySelector(".roll-char-in.is-up")).not.toBeNull();
  });
  it("groups digits from five on, and the drum keeps its columns across the separator", () => {
    function Probe({ value }: { value: number }) {
      const { formatNumber, count } = useI18n();
      return <output>{`${formatNumber(value)}|${count(value, "memo")}`}</output>;
    }
    const probe = render(<LanguageProvider><Probe value={9255} /></LanguageProvider>);
    expect(probe.container.textContent).toBe("9255|9255 memos");
    probe.rerender(<LanguageProvider><Probe value={15880} /></LanguageProvider>);
    expect(probe.container.textContent).toBe("15,880|15,880 memos");
    probe.rerender(<LanguageProvider><Probe value={-12000} /></LanguageProvider>);
    expect(probe.container.textContent).toBe("-12,000|-12,000 memos");
    probe.unmount();

    const ui = render(<LanguageProvider><RollingText value={15880} /></LanguageProvider>);
    expect(ui.container.querySelector(".roll > .sr-only")?.textContent).toBe("15,880");
    expect([...ui.container.querySelectorAll(".roll-measure")].map((el) => el.textContent)).toEqual(["1", "5", ",", "8", "8", "0"]);
    // The stagger counts digits only: the comma rides with its neighbour.
    expect([...ui.container.querySelectorAll<HTMLElement>(".roll-slot")].map((el) => el.style.getPropertyValue("--ri"))).toEqual(["4", "3", "3", "2", "1", "0"]);
    ui.rerender(<LanguageProvider><RollingText value={15881} /></LanguageProvider>);
    // One column changed, one column rolls; the separator holds still.
    expect(ui.container.querySelectorAll(".roll-char-in")).toHaveLength(1);
    expect(ui.container.querySelector(".roll-char-in")?.textContent).toBe("1");

    ui.rerender(<LanguageProvider><RollingText value={9999} /></LanguageProvider>);
    ui.rerender(<LanguageProvider><RollingText value={10000} /></LanguageProvider>);
    expect(ui.container.querySelector(".roll > .sr-only")?.textContent).toBe("10,000");
    expect([...ui.container.querySelectorAll(".roll-measure")].map((el) => el.textContent)).toEqual(["1", "0", ",", "0", "0", "0"]);
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
