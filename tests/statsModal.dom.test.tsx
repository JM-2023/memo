// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsModal } from "../src/components/StatsModal";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { localMaxima, longestRun, totalStats } from "../src/lib/stats";
import { forgetStatsPlace, recallStatsPlace, rememberStatsPlace } from "../src/lib/statsDrilldown";
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

function renderStats(memos: Memo[], { onClose = vi.fn(), onDrilldown = vi.fn() } = {}) {
  return render(
    <Providers>
      <StatsModal memos={memos} uniqueTagCount={0} onClose={onClose} onDrilldown={onDrilldown} />
    </Providers>
  );
}

beforeEach(() => {
  forgetStatsPlace();
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
      memoAt("d", new Date(year, 3, 6, 21, 0)),
      memoAt("e", new Date(year, 5, 6, 21, 0))
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
    // An empty May is a zero once it has come, "not yet" before.
    const may = within(monthChart).getByRole("button", { name: new RegExp(`^May ${year}: (0 memos|Not yet)$`) });
    expect(may.querySelector(".stats-bar-value")?.textContent).toBe("");
    // March and June are the month chart's two local maxima.
    expect(monthChart.querySelectorAll(".stats-bar-value.is-peak")).toHaveLength(2);
    // Nothing has been laid out (jsdom), so no chart thins its labels.
    expect(document.querySelector(".stats-bars.is-sparse")).toBeNull();
    // No year before this one: last year's ticks stay hidden.
    expect(monthChart.classList.contains("has-compare")).toBe(false);
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
      // 120 memos across January: the three-digit label (21px) no longer
      // fits its 20px column, so only the peak keeps its label.
      const memos = Array.from({ length: 120 }, (_, index) => memoAt(`m${index}`, new Date(year, 0, 1 + (index % 28), 9, 0)));
      renderStats(memos);
      const monthBars = screen.getByRole("group", { name: /^Memos by month\./ }).querySelector(".stats-bars");
      expect(monthBars?.classList.contains("is-sparse")).toBe(true);
      expect(monthBars?.querySelectorAll(".stats-bar-value.is-peak")).toHaveLength(1);
      expect(monthBars?.querySelector(".stats-bar-value.is-peak")?.textContent).toBe("120");
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
      "year-cell level-0",
      "year-cell level-1",
      "year-cell level-2",
      "year-cell level-3",
      "year-cell level-4"
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

describe("the year against the one before", () => {
  it("compares a part year with the same stretch of last year, and ticks last year's months", () => {
    const now = new Date();
    const year = now.getFullYear();
    const memos = [
      memoAt("a", new Date(year, 0, 1, 9)),
      memoAt("b", new Date(year - 1, 0, 1, 9)),
      memoAt("c", new Date(year - 1, 0, 1, 10)),
      // Last year, after today's date: not part of the comparison.
      ...(now.getMonth() < 11 ? [memoAt("d", new Date(year - 1, 11, 31, 9))] : [])
    ];
    renderStats(memos);
    expect(document.querySelector(".stats-hero-note")?.textContent).toContain("1 fewer than this time last year");
    const monthChart = screen.getByRole("group", { name: /^Memos by month\./ });
    expect(monthChart.classList.contains("has-compare")).toBe(true);
    expect(within(monthChart).getByRole("button", { name: `January ${year}: 1 memo, ${year - 1}: 2 memos` })).toBeTruthy();
  });

  it("says last year had nothing by this date yet, rather than a gap against zero", () => {
    const now = new Date();
    // On Dec 31 last year's last day is inside the comparison.
    if (now.getMonth() === 11 && now.getDate() === 31) return;
    const year = now.getFullYear();
    renderStats([memoAt("a", new Date(year, 0, 1, 9)), memoAt("b", new Date(year - 1, 11, 31, 9))]);
    const note = document.querySelector(".stats-hero-note")?.textContent ?? "";
    expect(note).toContain("Nothing by this date last year");
    expect(note).not.toContain("more than this time last year");
  });

  it("says it in Chinese too", () => {
    const now = new Date();
    if (now.getMonth() === 11 && now.getDate() === 31) return;
    localStorage.setItem("memo:language", "zh-CN");
    const year = now.getFullYear();
    renderStats([memoAt("a", new Date(year, 0, 1, 9)), memoAt("b", new Date(year - 1, 11, 31, 9))]);
    expect(document.querySelector(".stats-hero-note")?.textContent).toContain("去年此时还没有笔记");
  });

  it("drops the comparison for an empty first year, leaving the one line that is true", () => {
    renderStats([]);
    const note = document.querySelector(".stats-hero-note")!;
    expect(note.textContent).toBe("Nothing written this year");
    expect(note.textContent).not.toContain("first year");
  });

  it("finds the longest run of days, the later one on a tie", () => {
    expect(longestRun(["2026-03-02", "2026-03-01", "2026-03-05", "2026-03-06"])).toEqual({ length: 2, start: "2026-03-05", end: "2026-03-06" });
    expect(longestRun(["2025-12-31", "2026-01-01", "2026-01-03"])).toEqual({ length: 2, start: "2025-12-31", end: "2026-01-01" });
    expect(longestRun([])).toEqual({ length: 0, start: null, end: null });
  });
});

describe("months still to come", () => {
  it("draw a dashed baseline instead of a zero stub and say Not yet", () => {
    const now = new Date();
    // In December nothing is left to come.
    if (now.getMonth() === 11) return;
    const year = now.getFullYear();
    renderStats([memoAt("a", new Date(year, now.getMonth(), 1, 9))]);
    const monthChart = screen.getByRole("group", { name: /^Memos by month\./ });
    const december = within(monthChart).getByRole("button", { name: `December ${year}: Not yet` });
    expect(december.querySelector(".stats-bar")?.className).toContain("is-future");
    expect(december.querySelector(".stats-bar")?.className).not.toContain("is-zero");
    expect(monthChart.getAttribute("aria-label")).toContain(`December ${year}: Not yet`);
  });

  it("are only this year's: last year's empty December is a zero", () => {
    const year = new Date().getFullYear();
    renderStats([memoAt("a", new Date(year - 1, 0, 1, 9)), memoAt("b", new Date(year, 0, 1, 9))]);
    fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
    const monthChart = screen.getByRole("group", { name: /^Memos by month\./ });
    const december = within(monthChart).getByRole("button", { name: `December ${year - 1}: 0 memos` });
    expect(december.querySelector(".stats-bar")?.className).toContain("is-zero");
  });
});

describe("statistics on touch", () => {
  function setup() {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), 1, 9, 15);
    const onDrilldown = vi.fn();
    const onClose = vi.fn();
    renderStats([memoAt("a", day)], { onDrilldown, onClose });
    const dayLabel = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(day);
    const cell = screen.getAllByRole("button", { name: `Show 1 memo from ${dayLabel}` }).find((button) => button.classList.contains("year-cell"))!;
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-01`;
    return { cell, onDrilldown, onClose, key };
  }

  function press(element: Element, pointerType: string) {
    fireEvent.pointerDown(element, { pointerType });
    fireEvent.click(element, { detail: 1 });
  }

  it("picks a day on the first tap, pins its tip and offers the drill in the section head", () => {
    const { cell, onDrilldown } = setup();
    press(cell, "touch");
    expect(onDrilldown).not.toHaveBeenCalled();
    expect(cell.classList.contains("is-picked")).toBe(true);
    const pill = document.querySelector(".stats-pick-pill");
    expect(pill?.textContent).toBe("Show 1 memo ›");
    expect(pill?.closest(".stats-section-head")?.textContent).toContain("Daily activity");
    // The pill stands in for the legend while a day is picked.
    expect(pill?.closest(".stats-section-head")?.querySelector(".heat-legend")).toBeNull();
    expect(document.querySelector(".tip")?.className).toContain("is-show");
    expect(document.querySelector(".tip")?.textContent).toContain("1 memo");
  });

  it("drills on a second tap of the same day", async () => {
    const { cell, onDrilldown, key } = setup();
    press(cell, "touch");
    press(cell, "touch");
    await waitFor(() => expect(onDrilldown).toHaveBeenCalledWith({ kind: "day", day: key }));
  });

  it("drills from the pill", async () => {
    const { cell, onDrilldown, key } = setup();
    press(cell, "touch");
    press(document.querySelector(".stats-pick-pill")!, "touch");
    await waitFor(() => expect(onDrilldown).toHaveBeenCalledWith({ kind: "day", day: key }));
  });

  it("lets go when the tap lands elsewhere, when the body scrolls, and on Escape", () => {
    const { cell, onClose } = setup();
    press(cell, "touch");
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Statistics" }), { pointerType: "touch" });
    expect(cell.classList.contains("is-picked")).toBe(false);
    expect(document.querySelector(".stats-pick-pill")).toBeNull();
    expect(document.querySelector(".heat-legend")).not.toBeNull();

    press(cell, "touch");
    fireEvent.scroll(document.querySelector(".stats-body")!);
    expect(cell.classList.contains("is-picked")).toBe(false);

    press(cell, "touch");
    fireEvent.keyDown(cell, { key: "Escape" });
    expect(cell.classList.contains("is-picked")).toBe(false);
    // That Escape only let go of the pick; the next one closes.
    expect(screen.getByRole("dialog", { name: "Detailed statistics" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves a mouse and the keyboard drilling at once", async () => {
    const { cell, onDrilldown, key } = setup();
    press(cell, "mouse");
    await waitFor(() => expect(onDrilldown).toHaveBeenCalledWith({ kind: "day", day: key }));
    expect(document.querySelector(".stats-pick-pill")).toBeNull();
  });

  it("treats a bar and a rhythm dot the same way", () => {
    const now = new Date();
    const year = now.getFullYear();
    const created = new Date(year, now.getMonth(), 1, 9, 15);
    const onDrilldown = vi.fn();
    renderStats([memoAt("a", created)], { onDrilldown });
    const monthName = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long" }).format(created);
    const bar = within(screen.getByRole("group", { name: /^Memos by month\./ })).getByRole("button", { name: `${monthName}: 1 memo` });
    press(bar, "touch");
    expect(bar.classList.contains("is-picked")).toBe(true);
    expect(document.querySelector(".stats-pick-pill")?.closest(".stats-section-head")?.textContent).toContain("Memos by month");

    const rhythm = screen.getByRole("group", { name: "Memos by weekday and hour" });
    const dot = within(rhythm).getAllByRole("button")[0];
    press(dot, "touch");
    expect(bar.classList.contains("is-picked")).toBe(false);
    expect(dot.classList.contains("is-picked")).toBe(true);
    expect(document.querySelector(".stats-pick-pill")?.closest(".stats-section-head")?.textContent).toContain("Writing rhythm");
    expect(onDrilldown).not.toHaveBeenCalled();
  });
});

describe("the panel's place", () => {
  it("reopens on the year and scroll it was left at, for the session", async () => {
    const year = new Date().getFullYear();
    const memos = [memoAt("a", new Date(year - 1, 5, 1, 9)), memoAt("b", new Date(year, 0, 1, 9))];
    const onClose = vi.fn();
    renderStats(memos, { onClose });
    fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
    (document.querySelector(".stats-body") as HTMLElement).scrollTop = 120;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(recallStatsPlace()).toEqual({ year: year - 1, scrollTop: 120 });
    cleanup();

    renderStats(memos);
    expect(document.querySelector(".stats-year .sr-only")?.textContent).toBe(String(year - 1));
    expect((document.querySelector(".stats-body") as HTMLElement).scrollTop).toBe(120);
  });

  it("keeps a remembered year inside the years there are", () => {
    const year = new Date().getFullYear();
    // A year whose memos have since gone.
    rememberStatsPlace({ year: year - 5, scrollTop: 0 });
    renderStats([memoAt("a", new Date(year, 0, 1, 9))]);
    expect(document.querySelector(".stats-year .sr-only")?.textContent).toBe(String(year));
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
    expect(fact?.querySelector(".roll > .sr-only")?.textContent).toBe(String(totalStats(memos).daySpan));
    expect(fact?.querySelector(".stats-fact-sub")?.textContent).toBe(" days");
  });
});
