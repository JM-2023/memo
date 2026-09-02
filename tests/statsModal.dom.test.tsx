// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsModal } from "../src/components/StatsModal";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { localMaxima, totalStats } from "../src/lib/stats";
import type { Memo } from "../src/lib/types";

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function memoAt(id: string, created: Date): Memo {
  const timestamp = created.toISOString();
  return { id, content: `Memo ${id}`, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq: 1, images: [] };
}

function renderStats(memos: Memo[]) {
  return render(
    <Providers>
      <StatsModal memos={memos} uniqueTagCount={0} onClose={vi.fn()} onDrilldown={vi.fn()} />
    </Providers>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("statistics bar values", () => {
  it("prints each bar's count above it, leaves zero bars blank and marks the peaks", () => {
    const year = new Date().getFullYear();
    const memos = [
      memoAt("a", new Date(year, 2, 2, 9, 15)),
      memoAt("b", new Date(year, 2, 3, 9, 40)),
      memoAt("c", new Date(year, 2, 4, 9, 5)),
      memoAt("d", new Date(year, 3, 6, 21, 0))
    ];
    renderStats(memos);

    const monthChart = screen.getByRole("group", { name: /^Memos by month\./ });
    const march = within(monthChart).getByRole("button", { name: `March ${year}: 3 memos` });
    const marchValue = march.querySelector(".stats-bar-value");
    expect(marchValue?.textContent).toBe("3");
    // The button's name already carries the count; the label is decoration.
    expect(marchValue?.getAttribute("aria-hidden")).toBe("true");
    expect(marchValue?.classList.contains("is-peak")).toBe(true);
    const april = within(monthChart).getByRole("button", { name: `April ${year}: 1 memo` });
    expect(april.querySelector(".stats-bar-value")?.textContent).toBe("1");
    expect(april.querySelector(".stats-bar-value")?.classList.contains("is-peak")).toBe(false);
    const may = within(monthChart).getByRole("button", { name: `May ${year}: 0 memos` });
    expect(may.querySelector(".stats-bar-value")?.textContent).toBe("");

    // 9 AM (3) and 9 PM (1) are the hour chart's two local maxima.
    const hourChart = screen.getByRole("group", { name: /^Distribution by time\./ });
    expect(hourChart.querySelectorAll(".stats-bar-value.is-peak")).toHaveLength(2);
    // Nothing has been laid out (jsdom), so no chart thins its labels.
    expect(document.querySelector(".stats-bars.is-sparse")).toBeNull();
  });

  it("thins the labels to the peaks once they would collide", () => {
    const originalLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    // Stand-in layout: columns on a 20px pitch, labels 7px per digit.
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement ? Array.prototype.indexOf.call(this.parentElement.children, this) * 20 : 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("stats-bar-value") ? (this.textContent?.length ?? 0) * 7 : 0;
      }
    });
    try {
      const year = new Date().getFullYear();
      // 120 memos, all at 9 AM across four January weeks: the hour chart's
      // three-digit label (21px) no longer fits its 20px column, while the
      // weekday chart's two-digit labels (14px) still do.
      const memos = Array.from({ length: 120 }, (_, index) => memoAt(`m${index}`, new Date(year, 0, 1 + (index % 28), 9, 0)));
      renderStats(memos);
      const hourBars = screen.getByRole("group", { name: /^Distribution by time\./ }).querySelector(".stats-bars");
      expect(hourBars?.classList.contains("is-sparse")).toBe(true);
      expect(hourBars?.querySelectorAll(".stats-bar-value.is-peak")).toHaveLength(1);
      expect(hourBars?.querySelector(".stats-bar-value.is-peak")?.textContent).toBe("120");
      const weekdayBars = screen.getByRole("group", { name: /^Distribution by weekday\./ }).querySelector(".stats-bars");
      expect(weekdayBars?.classList.contains("is-sparse")).toBe(false);
    } finally {
      if (originalLeft) Object.defineProperty(HTMLElement.prototype, "offsetLeft", originalLeft);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetLeft;
      if (originalWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    }
  });

  it("keeps the first bar of a plateau and never labels two neighbours", () => {
    expect(localMaxima([0, 1, 3, 3, 2, 0, 5, 5, 5, 1, 4])).toEqual([false, false, true, false, false, false, true, false, false, false, true]);
    expect(localMaxima([2, 2])).toEqual([true, false]);
    expect(localMaxima([0, 0])).toEqual([false, false]);
    expect(localMaxima([])).toEqual([]);
  });
});

describe("daily activity legend", () => {
  it("keys the shades with the cells' own level classes and describes the scale for screen readers", () => {
    renderStats([memoAt("a", new Date())]);
    expect(screen.getByText("Shade shows memos per day, from 1 to 5 or more.")).toBeTruthy();
    const legend = document.querySelector(".heat-legend");
    expect(legend?.textContent).toContain("Less");
    expect(legend?.textContent).toContain("More");
    const cells = legend?.querySelector(".heat-legend-cells");
    expect(cells?.getAttribute("aria-hidden")).toBe("true");
    expect(Array.from(cells?.children ?? [], (cell) => cell.className)).toEqual([
      "mini-cell level-0",
      "mini-cell level-1",
      "mini-cell level-2",
      "mini-cell level-3",
      "mini-cell level-4"
    ]);
  });

  it("speaks Chinese", () => {
    localStorage.setItem("memo:language", "zh-CN");
    renderStats([memoAt("a", new Date())]);
    const legend = document.querySelector(".heat-legend");
    expect(legend?.textContent).toContain("少");
    expect(legend?.textContent).toContain("多");
    expect(screen.getByText("颜色深浅表示每天的笔记数，从 1 条到 5 条或更多。")).toBeTruthy();
    expect(screen.getByText("距首条笔记")).toBeTruthy();
  });
});

describe("all-time ledger", () => {
  it("labels the calendar span since the first memo, after the active days, with its unit", () => {
    const memos = [memoAt("a", new Date(Date.now() - 2 * 86_400_000)), memoAt("b", new Date())];
    renderStats(memos);
    const labels = Array.from(document.querySelectorAll(".stats-fact-label"), (label) => label.textContent);
    expect(labels).not.toContain("Days recorded");
    expect(labels.indexOf("Active days")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Active days")).toBeLessThan(labels.indexOf("Since first memo"));
    const fact = screen.getByText("Since first memo").closest(".stats-fact");
    expect(fact?.querySelector(".roll")?.getAttribute("aria-label")).toBe(String(totalStats(memos).daySpan));
    expect(fact?.querySelector(".stats-fact-sub")?.textContent).toBe(" days");
  });
});
