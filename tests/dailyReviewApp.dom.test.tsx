// @vitest-environment jsdom

// Daily review in the app: the weighted batch with its reasons on the cards,
// progress as cards are read, the quiet finish, "Not again" with its Undo,
// and the sidebar row's dot.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { REVIEW_SEEN_MS } from "../src/hooks/useReviewSeen";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  syncApi: {
    setCursor: vi.fn(),
    setSyncEpoch: vi.fn(),
    runSync: vi.fn(async () => undefined),
    notifyPeers: vi.fn(),
    notifyLogout: vi.fn(),
    status: { online: true, degraded: false },
    retryNow: vi.fn()
  }
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, getAuthStatus: mocks.getAuthStatus, bootstrap: mocks.bootstrap, syncSince: mocks.syncSince };
});

vi.mock("../src/lib/cache", () => ({
  adoptCacheKey: vi.fn(),
  forgetCacheKey: vi.fn(),
  invalidateSnapshot: vi.fn(async () => undefined),
  openSnapshot: vi.fn(async () => null),
  readSealedSnapshot: vi.fn(async () => null),
  saveSnapshot: vi.fn(async () => undefined)
}));

vi.mock("../src/lib/useSync", () => ({
  useSync: () => mocks.syncApi
}));

interface Observer {
  callback: IntersectionObserverCallback;
  thresholds: number[];
  observed: Set<Element>;
}
let observers: Observer[] = [];

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

/** Local noon, `back` days or years before today. */
function daysAgo(days: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12).toISOString();
}
function yearsAgo(years: number): string {
  const now = new Date();
  return new Date(now.getFullYear() - years, now.getMonth(), now.getDate(), 12).toISOString();
}

function memo(id: string, content: string, createdAt: string, seq: number): Memo {
  return { id, content, createdAt, updatedAt: createdAt, pinnedAt: null, deletedAt: null, seq, images: [] };
}

const MEMOS = [
  memo("otd", "Written a year ago today", yearsAgo(1), 1),
  memo("week", "Written a week ago", daysAgo(7), 2),
  memo("chance", "Written long ago", daysAgo(100), 3)
];

function renderApp() {
  return render(
    <Providers>
      <App />
    </Providers>
  );
}

function reviewNav(): HTMLElement {
  return screen.getByRole("button", { name: /^Daily review/ });
}

function banner(): string {
  return document.querySelector(".review-banner .sr-only")?.textContent ?? "";
}

/** Every review card the seen observer watches comes fully on screen. */
function showReviewCards() {
  act(() => {
    for (const observer of observers) {
      if (observer.thresholds.length < 2) continue;
      const entries = [...observer.observed].map(
        (target) =>
          ({
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            intersectionRect: { height: 120 } as DOMRectReadOnly,
            rootBounds: { height: 800 } as DOMRectReadOnly
          }) as IntersectionObserverEntry
      );
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "");
  observers = [];
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos: MEMOS,
    tags: [],
    cursor: 3,
    syncEpoch: "epoch-a",
    serverTime: new Date().toISOString(),
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 3, syncEpoch: "epoch-a", serverTime: new Date().toISOString() });
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
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly record: Observer;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        const threshold = options?.threshold ?? 0;
        this.record = { callback, thresholds: Array.isArray(threshold) ? threshold : [threshold], observed: new Set() };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.observed.add(target);
      }
      unobserve(target: Element): void {
        this.record.observed.delete(target);
      }
      disconnect(): void {
        this.record.observed.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Daily review", () => {
  it("deals on this day first, says why on each card, and closes quietly once every card is read", async () => {
    renderApp();
    await screen.findByText("Written a year ago today");
    // Nothing dealt yet, but there is something to deal: the row's dot says so.
    expect(within(reviewNav()).getByRole("img", { name: "Not revisited yet today" })).toBeTruthy();

    fireEvent.click(reviewNav());
    await waitFor(() => expect(banner()).toMatch(/ · 0 of 3 revisited$/));
    expect(document.querySelector(".review-banner-mix")?.textContent).toBe("On this day 1 · Anniversaries 1 · Random 1");
    const cards = [...document.querySelectorAll<HTMLElement>(".memo-feed > .memo-slot")];
    expect(cards.map((slot) => slot.dataset.vt)).toEqual(["memo-otd", "memo-week", "memo-chance"]);
    expect(cards.map((slot) => slot.querySelector(".review-context-text")?.textContent)).toEqual([
      "1 year ago today",
      "A week ago",
      "Random · 3 months ago"
    ]);
    // The stamp itself is untouched, year and all.
    expect(cards[0].querySelector(".memo-time")?.textContent).toContain(String(new Date(MEMOS[0].createdAt).getFullYear()));
    expect(JSON.parse(localStorage.getItem("memo-review-day") ?? "{}").reasons).toEqual({
      otd: { reason: "onThisDay", years: 1 },
      week: { reason: "anniversary", span: "week" },
      chance: { reason: "random" }
    });
    // Open, the row counts today's set instead.
    expect(within(reviewNav()).queryByRole("img")).toBeNull();
    expect(within(reviewNav()).getByText("0/3")).toBeTruthy();
    expect(screen.queryByText(/revisited for today/)).toBeNull();

    // Opening a card's menu is reading it.
    fireEvent.click(within(cards[1]).getByRole("button", { name: /^Memo actions/ }));
    await waitFor(() => expect(banner()).toMatch(/ · 1 of 3 revisited$/));
    expect(within(cards[1]).getByRole("img", { name: "Revisited" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // The rest are read on screen.
    showReviewCards();
    await new Promise((resolve) => setTimeout(resolve, REVIEW_SEEN_MS + 100));
    await waitFor(() => expect(banner()).toMatch(/ · 3 of 3 revisited$/));
    expect(screen.getByRole("progressbar", { name: "Revisited today" }).getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByText("All three revisited for today")).toBeTruthy();
    expect(screen.getByText("A new set tomorrow")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("memo-review-seen") ?? "{}").ids.sort()).toEqual(["chance", "otd", "week"]);

    // Done for today: the dot does not come back.
    fireEvent.click(screen.getAllByRole("button", { name: /^All memos/ })[0]);
    await waitFor(() => expect(document.querySelector(".review-banner")).toBeNull());
    expect(within(reviewNav()).queryByRole("img")).toBeNull();
  }, 15_000);

  it("sets a memo aside with Not again, and Undo lets it back into its place", async () => {
    renderApp();
    await screen.findByText("Written a year ago today");
    fireEvent.click(reviewNav());
    await waitFor(() => expect(banner()).toMatch(/0 of 3 revisited$/));

    const week = document.querySelector<HTMLElement>('[data-vt="memo-week"]')!;
    fireEvent.click(within(week).getByRole("button", { name: /^Not again: memo from / }));
    await waitFor(() => expect(document.querySelector('.memo-feed > [data-vt="memo-week"]')).toBeNull());
    expect(banner()).toMatch(/0 of 2 revisited$/);
    expect(JSON.parse(localStorage.getItem("memo-review-hidden") ?? "[]")).toEqual(["week"]);
    expect(screen.getByText("This memo won’t come back in Daily review")).toBeTruthy();

    // Deciding on a card is reading it: it comes back seen.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(banner()).toMatch(/1 of 3 revisited$/));
    expect(within(document.querySelector<HTMLElement>('[data-vt="memo-week"]')!).getByRole("img", { name: "Revisited" })).toBeTruthy();
    expect([...document.querySelectorAll<HTMLElement>(".memo-feed > .memo-slot")].map((slot) => slot.dataset.vt)).toEqual([
      "memo-otd",
      "memo-week",
      "memo-chance"
    ]);
    expect(localStorage.getItem("memo-review-hidden")).toBeNull();
  });

  it("keeps a set-aside memo out of a fresh draw, and the settings dialog can let it back", async () => {
    localStorage.setItem("memo-review-hidden", JSON.stringify(["otd"]));
    renderApp();
    await screen.findByText("Written a year ago today");
    fireEvent.click(reviewNav());
    await waitFor(() => expect(banner()).toMatch(/0 of 2 revisited$/));
    expect(JSON.parse(localStorage.getItem("memo-review-day") ?? "{}").ids).toEqual(["week", "chance"]);

    fireEvent.click(screen.getByRole("button", { name: "Review settings" }));
    const restore = await screen.findByRole("button", { name: "Restore" });
    expect(screen.getByText("Set aside with “Not again” · 1")).toBeTruthy();
    fireEvent.click(restore);
    expect(localStorage.getItem("memo-review-hidden")).toBeNull();
    expect(screen.getByRole("button", { name: "Restored" }).getAttribute("aria-disabled")).toBe("true");
  });
});
