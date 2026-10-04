// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Heatmap } from "../src/components/Heatmap";
import { RangeCalendar } from "../src/components/RangeCalendar";
import { SearchFilter, type FilterOpenTarget } from "../src/components/SearchFilter";
import { StatsModal } from "../src/components/StatsModal";
import { TagTree } from "../src/components/TagTree";
import { TipProvider } from "../src/components/Tip";
import { useTopbarTuck } from "../src/hooks/useTopbarTuck";
import { addDays, dateKey, formatDayLabel } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import { EMPTY_FILTERS, type FeedFilters } from "../src/lib/search";
import type { TagNode } from "../src/lib/tags";
import type { Memo } from "../src/lib/types";

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const today = new Date();
const todayKey = dateKey(today);
/** The first of the month `delta` months from this one. */
const monthStart = (delta: number) => new Date(today.getFullYear(), today.getMonth() + delta, 1);
const monthName = (date: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long" }).format(date);

describe("range calendar", () => {
  function Harness({ initialFrom = null, initialTo = null }: { initialFrom?: string | null; initialTo?: string | null }) {
    const [range, setRange] = useState<{ from: string | null; to: string | null }>({ from: initialFrom, to: initialTo });
    return (
      <>
        <button type="button" onClick={() => setRange({ from: dateKey(addDays(monthStart(-3), 4)), to: dateKey(addDays(monthStart(-3), 9)) })}>
          preset
        </button>
        <RangeCalendar
          from={range.from}
          to={range.to}
          minDay="2000-01-01"
          onStart={(day) => setRange({ from: day, to: null })}
          onRange={(from, to) => setRange({ from, to })}
        />
      </>
    );
  }

  it("always lays out six week rows", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>
    );
    for (let page = 0; page < 6; page += 1) {
      expect(document.querySelectorAll(".range-cal-days [data-day]")).toHaveLength(42);
      await user.click(screen.getByRole("button", { name: "Previous month" }));
    }
  });

  it("brings an outside range's month on screen, sliding back to it", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>
    );
    expect(document.querySelector(".range-cal-month")?.textContent).toBe(monthName(today));
    await user.click(screen.getByRole("button", { name: "preset" }));
    const end = dateKey(addDays(monthStart(-3), 9));
    await waitFor(() => expect(document.querySelector(".range-cal-month .swap-cur")?.textContent).toBe(monthName(monthStart(-3))));
    expect(document.querySelector(".range-cal-days")?.classList.contains("slide-right")).toBe(true);
    // The roving stop sits on the range's end.
    expect(document.querySelector(`[data-day="${end}"]`)?.getAttribute("tabindex")).toBe("0");
  });

  it("previews the pending span under keyboard focus", async () => {
    const start = addDays(monthStart(-2), 9);
    render(
      <Providers>
        <Harness initialFrom={null} initialTo={dateKey(addDays(monthStart(-2), 20))} />
      </Providers>
    );
    const startKey = dateKey(start);
    fireEvent.click(document.querySelector(`[data-day="${startKey}"]`)!);
    const startCell = document.querySelector<HTMLButtonElement>(`[data-day="${startKey}"]`)!;
    act(() => startCell.focus());
    fireEvent.keyDown(startCell, { key: "ArrowRight" });
    fireEvent.keyDown(startCell, { key: "ArrowRight" });
    await waitFor(() => expect(document.querySelector(`[data-day="${dateKey(addDays(start, 2))}"]`)?.classList.contains("is-hi")).toBe(true));
    expect(document.querySelector(`[data-day="${dateKey(addDays(start, 1))}"]`)?.classList.contains("in-span")).toBe(true);
  });
});

describe("sidebar heatmap", () => {
  function renderHeatmap(activeDay: string | null, counts = new Map<string, number>()) {
    const ui = (day: string | null, map: Map<string, number>) => (
      <Providers>
        <Heatmap countsByDay={map} minDay="2000-01-01" activeDay={day} period="month" onPickDay={vi.fn()} />
      </Providers>
    );
    const view = render(ui(activeDay, counts));
    return { ...view, rerenderWith: (day: string | null, map = counts) => view.rerender(ui(day, map)) };
  }

  const title = () => screen.getByRole("button", { name: /\d{4}/ });

  it("follows a day picked elsewhere to its month, and stays when paged by hand", async () => {
    const user = userEvent.setup();
    const view = renderHeatmap(null);
    expect(title().textContent).toContain(monthName(today));
    const earlier = dateKey(addDays(monthStart(-2), 4));
    view.rerenderWith(earlier);
    expect(title().textContent).toContain(monthName(monthStart(-2)));
    expect(document.querySelector(".heat-current")?.classList.contains("slide-right")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    view.rerenderWith(earlier);
    expect(title().textContent).toContain(monthName(monthStart(-1)));
  });

  it("turns the page when an arrow walks off it, and on Page Up", () => {
    renderHeatmap(null);
    const first = monthStart(0);
    const cell = screen.getByRole("button", { name: new RegExp(`^${formatDayLabel(dateKey(first), "en-US")},`) });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "ArrowLeft" });
    const lastOfPrevious = addDays(first, -1);
    expect(title().textContent).toContain(monthName(monthStart(-1)));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(new RegExp(`^${formatDayLabel(dateKey(lastOfPrevious), "en-US")},`));

    fireEvent.keyDown(document.activeElement!, { key: "PageUp" });
    expect(title().textContent).toContain(monthName(monthStart(-2)));
    const sameDay = new Date(monthStart(-2).getFullYear(), monthStart(-2).getMonth() + 1, 0);
    const expected = new Date(sameDay.getFullYear(), sameDay.getMonth(), Math.min(lastOfPrevious.getDate(), sameDay.getDate()));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(new RegExp(`^${formatDayLabel(dateKey(expected), "en-US")},`));

    // Days after today hold nothing: an arrow past today stays put.
    fireEvent.keyDown(document.activeElement!, { key: "PageDown" });
    fireEvent.keyDown(document.activeElement!, { key: "PageDown" });
    expect(title().textContent).toContain(monthName(today));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/,/);
  });

  it("marks the title idle on the current page", async () => {
    const user = userEvent.setup();
    renderHeatmap(null);
    expect(title().getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(title().hasAttribute("aria-disabled")).toBe(false);
  });

  it("rolls the page total when a memo lands on the shown page", () => {
    const view = renderHeatmap(null, new Map([[todayKey, 2]]));
    expect(document.querySelector(".heatmap-total .roll")).toBeTruthy();
    view.rerenderWith(null, new Map([[todayKey, 3]]));
    expect(document.querySelector(".heatmap-total")?.querySelector(".roll-char-in")).toBeTruthy();
  });
});

describe("statistics mini calendar", () => {
  it("steps a week with ↑ ↓, to the nearest day with memos", () => {
    const year = today.getFullYear() - 1;
    const at = (day: number): Memo => {
      const created = new Date(year, 2, day, 12).toISOString();
      return { id: `m${day}`, content: "x", createdAt: created, updatedAt: created, pinnedAt: null, deletedAt: null, seq: 1, images: [] };
    };
    render(
      <Providers>
        <StatsModal memos={[at(2), at(3), at(10), at(20)]} uniqueTagCount={0} onClose={vi.fn()} onDrilldown={vi.fn()} />
      </Providers>
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
    const name = (day: number) => `Show 1 memo from ${new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(year, 2, day))}`;
    const second = screen.getByRole("button", { name: name(2) });
    act(() => second.focus());
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: name(10) }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: name(20) }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: name(10) }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: name(3) }));
  });
});

describe("filter chip edit lands on its own control", () => {
  function renderFilter(filters: FeedFilters, request: number, target: FilterOpenTarget) {
    return (
      <Providers>
        <SearchFilter
          filters={filters}
          saved={[]}
          activeSavedId={null}
          canSave={false}
          disabled={false}
          minDay="2000-01-01"
          openRequest={request}
          openTarget={target}
          onToggleFacet={vi.fn()}
          onDateChange={vi.fn()}
          onPresetRange={vi.fn()}
          onClearDates={vi.fn()}
          onApplySaved={vi.fn()}
          onDeleteSaved={vi.fn()}
          onSaveCurrent={vi.fn()}
        />
      </Providers>
    );
  }

  it("opens on the calendar's roving day for a range chip", async () => {
    const to = dateKey(addDays(monthStart(-1), 5));
    const filters = { ...EMPTY_FILTERS, dateFrom: dateKey(monthStart(-1)), dateTo: to };
    const view = render(renderFilter(filters, 0, "range"));
    view.rerender(renderFilter(filters, 1, "range"));
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.day).toBe(to));
  });

  it("opens on the facet's row for a facet chip", async () => {
    const filters = { ...EMPTY_FILTERS, hasImage: true };
    const view = render(renderFilter(filters, 0, "hasImage"));
    view.rerender(renderFilter(filters, 1, "hasImage"));
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.facet).toBe("hasImage"));
  });
});

describe("tag tree keyboard", () => {
  const tree: TagNode[] = [
    { name: "work", path: "work", count: 3, children: [{ name: "client", path: "work/client", count: 1, children: [] }] },
    { name: "life", path: "life", count: 2, children: [] }
  ];

  function renderTree(nodes = tree) {
    // The tree's FLIP pass reads running animations.
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    return render(
      <Providers>
        <TagTree tree={nodes} activeTag={null} pinnedTags={new Map()} onPickTag={vi.fn()} onPinTag={vi.fn()} onRenameTag={vi.fn()} onRemoveTag={vi.fn()} />
      </Providers>
    );
  }

  const label = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name},`) });

  it("is one tab stop that arrows walk, unfold and fold", () => {
    renderTree();
    expect(label("work").tabIndex).toBe(0);
    expect(label("life").tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: "Expand tag work" }).tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: "Actions for tag work" }).tabIndex).toBe(-1);

    act(() => label("work").focus());
    fireEvent.keyDown(label("work"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(label("life"));
    expect(label("life").tabIndex).toBe(0);
    fireEvent.keyDown(label("life"), { key: "Home" });
    expect(document.activeElement).toBe(label("work"));

    fireEvent.keyDown(label("work"), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Collapse tag work" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(label("work"));
    fireEvent.keyDown(label("work"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(label("client"));
    fireEvent.keyDown(label("client"), { key: "End" });
    expect(document.activeElement).toBe(label("life"));
    fireEvent.keyDown(label("life"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(label("client"));
    fireEvent.keyDown(label("client"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(label("work"));
    fireEvent.keyDown(label("work"), { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Expand tag work" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the row's menu with Shift+F10 and comes back to the label", async () => {
    const user = userEvent.setup();
    renderTree();
    act(() => label("life").focus());
    fireEvent.keyDown(label("life"), { key: "F10", shiftKey: true });
    const pin = await screen.findByRole("menuitem", { name: "Pin tag" });
    await waitFor(() => expect(document.activeElement).toBe(pin));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(label("life")));
  });

  it("rolls a tag's count and shows a cut-off name's whole path", async () => {
    const view = renderTree();
    expect(label("work").querySelector(".tag-count .roll")).toBeTruthy();

    fireEvent.keyDown(label("work"), { key: "ArrowRight" });
    const client = label("client");
    const name = client.querySelector<HTMLElement>(".tag-name")!;
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 120 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 60 });
    fireEvent.pointerEnter(client, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector(".tip.is-show")?.textContent).toBe("#work/client"));
    fireEvent.pointerLeave(client, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector(".tip.is-show")).toBeNull());

    // A name that fits says nothing more.
    fireEvent.pointerEnter(label("life"), { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.querySelector(".tip.is-show")).toBeNull();
    view.unmount();
  });
});

describe("topbar edge", () => {
  it("marks the band scrolled once the top sentinel leaves, where scroll timelines don't run", () => {
    let report: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          report = callback;
        }
        observe(): void {}
        disconnect(): void {}
      }
    );
    function Bar() {
      const ref = useRef<HTMLDivElement>(null);
      useTopbarTuck(ref, true);
      return <div ref={ref} className="topbar" />;
    }
    const { container, unmount } = render(<Bar />);
    const bar = container.querySelector<HTMLElement>(".topbar")!;
    expect(bar.hasAttribute("data-scrolled")).toBe(false);
    act(() => report?.([{ isIntersecting: false }]));
    expect(bar.hasAttribute("data-scrolled")).toBe(true);
    act(() => report?.([{ isIntersecting: true }]));
    expect(bar.hasAttribute("data-scrolled")).toBe(false);
    unmount();
  });
});
