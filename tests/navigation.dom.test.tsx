// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { RangeCalendar } from "../src/components/RangeCalendar";
import { TipProvider } from "../src/components/Tip";
import { useTopbarTuck } from "../src/hooks/useTopbarTuck";
import { dateKey } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import { SCROLL_JUMP_EVENT } from "../src/lib/navHistory";
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

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

const now = new Date();

function memo(id: string, content: string, extra: Partial<Memo> = {}): Memo {
  const timestamp = now.toISOString();
  return { id, content, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq: 1, images: [], ...extra };
}

function serve(memos: Memo[]) {
  mocks.bootstrap.mockResolvedValue({
    memos,
    tags: [],
    cursor: memos.length,
    syncEpoch: "epoch-a",
    serverTime: now.toISOString(),
    hasMore: false,
    nextAfter: null
  });
}

function renderApp() {
  return render(
    <Providers>
      <App />
    </Providers>
  );
}

function matchMediaWith(matching: (query: string) => boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: matching(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // jsdom keeps one session history per file: a fresh push drops the
  // forward entries an earlier test's Back left, so length counts steps.
  window.history.pushState(null, "");
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 0, syncEpoch: "epoch-a", serverTime: now.toISOString() });
  serve([memo("a", "alpha note #alpha"), memo("b", "beta note #beta")]);
  matchMediaWith((query) => query.includes("prefers-reduced-motion"));
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
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

describe("lens history", () => {
  it("adds a Back step per lens pick, keeps lens text out of history.state, and Back returns", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const before = window.history.length;

    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());
    expect(window.history.length).toBe(before + 1);
    // Only an opaque id rides the entry: tag paths are memo content.
    expect(JSON.stringify(window.history.state)).not.toContain("alpha");
    expect(window.location.hash).toBe("");

    act(() => window.history.back());
    await screen.findByText(/beta note/);
    expect(screen.getByText(/alpha note/)).toBeTruthy();
  });

  it("adds one Back step per search, and Back clears it", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const before = window.history.length;

    const search = screen.getByPlaceholderText("Search memos") as HTMLInputElement;
    await user.type(search, "beta");
    await waitFor(() => expect(screen.queryByText(/alpha note/)).toBeNull());
    // The first keystroke left All memos; the rest edited that entry.
    expect(window.history.length).toBe(before + 1);
    expect(JSON.stringify(window.history.state)).not.toContain("beta");

    act(() => window.history.back());
    await screen.findByText(/alpha note/);
    expect(search.value).toBe("");
  });

  it("keeps the tag a search was typed in one Back step away", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);

    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());
    const inTag = window.history.length;
    // Inside a tag the search box names its scope (search cluster).
    const search = screen.getByPlaceholderText("Search in #alpha") as HTMLInputElement;
    await user.type(search, "note");
    expect(window.history.length).toBe(inTag + 1);

    act(() => window.history.back());
    await waitFor(() => expect(search.value).toBe(""));
    // Still inside the tag: Back cleared only the search.
    expect(screen.getByText(/alpha note/)).toBeTruthy();
    expect(screen.queryByText(/beta note/)).toBeNull();

    act(() => window.history.back());
    await screen.findByText(/beta note/);
  });

  it("brings a typed search back after a reload in the same tab", async () => {
    const user = userEvent.setup();
    const first = renderApp();
    await screen.findByText(/beta note/);

    const search = screen.getByPlaceholderText("Search memos");
    await user.type(search, "beta");
    await waitFor(() => expect(screen.queryByText(/alpha note/)).toBeNull());

    // Reload: pagehide flushes the store, a fresh App reads it back.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    first.unmount();
    renderApp();
    await screen.findByText(/beta note/);
    expect((screen.getByPlaceholderText("Search memos") as HTMLInputElement).value).toBe("beta");
    expect(screen.queryByText(/alpha note/)).toBeNull();
  });
});

describe("ways back", () => {
  afterEach(() => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("returns a cleared search to the reading place it left, by × and by backspacing", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const scrollTo = window.scrollTo as unknown as ReturnType<typeof vi.fn>;
    // 900px down All memos when the search starts.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    const search = screen.getByPlaceholderText("Search memos") as HTMLInputElement;
    await user.type(search, "beta");
    await waitFor(() => expect(screen.queryByText(/alpha note/)).toBeNull());

    scrollTo.mockClear();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByText(/alpha note/);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 900));

    await user.type(search, "b");
    await waitFor(() => expect(screen.queryByText(/alpha note/)).toBeNull());
    scrollTo.mockClear();
    await user.type(search, "{Backspace}");
    await screen.findByText(/alpha note/);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 900));
  });

  it("names the lenses that emptied the feed, offers the way out, and keeps focus on the trail", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await screen.findByText(/beta note/);
    fireEvent.click(container.querySelector<HTMLButtonElement>(".heat-cell.is-today")!);
    await screen.findByRole("button", { name: /^Clear date filter/ });
    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await user.click(screen.getByRole("button", { name: /With images/ }));
    await user.keyboard("{Escape}");
    expect(await screen.findByText("No memos match these filters")).toBeTruthy();

    // The day chip's × takes itself away: focus moves on to the chip now
    // standing in its place, not down to the page.
    act(() => screen.getByRole("button", { name: /^Clear date filter/ }).focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Clear date filter/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear “With images” filter" }));

    // One lens left: named, with its own way out.
    expect(await screen.findByText("No memos with images")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Clear “With images”" }).focus());
    await user.keyboard("{Enter}");
    await screen.findByText(/alpha note/);
    expect(document.activeElement?.classList.contains("loc-trigger")).toBe(true);
  });

  it("lands focus on the location pill when ⌂ leaves Trash", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    await user.click(screen.getByRole("button", { name: /^Trash/ }));
    const home = await screen.findByRole("button", { name: "All memos" });
    act(() => home.focus());
    await user.keyboard("{Enter}");
    await screen.findByText(/beta note/);
    await waitFor(() => expect(document.activeElement?.classList.contains("loc-trigger")).toBe(true));
  });
});

describe("sidebar selection", () => {
  it("moves one mark from the row it leaves to the row it lands on", async () => {
    const user = userEvent.setup();
    // Motion on, so the mark glides.
    matchMediaWith(() => false);
    const rows = new Map<string, DOMRect>([
      ["nav", new DOMRect(6, 100, 268, 40)],
      ["tag", new DOMRect(6, 320, 268, 34)]
    ]);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!this.classList.contains("sel-glow")) return new DOMRect(0, 0, 0, 0);
      return rows.get(this.closest(".tag-row") ? "tag" : "nav")!;
    });
    const glides: Keyframe[][] = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(this: HTMLElement, keyframes: Keyframe[]) {
        if (this.classList.contains("sel-glow")) glides.push(keyframes);
        return { cancel() {}, pause() {}, play() {}, finish() {}, finished: Promise.resolve(), addEventListener() {}, removeEventListener() {}, onfinish: null };
      }
    });
    try {
      renderApp();
      await screen.findByText(/beta note/);
      expect(document.querySelectorAll(".sel-glow")).toHaveLength(1);
      expect(document.querySelector(".sel-glow")?.closest(".nav-item")?.getAttribute("aria-current")).toBe("page");

      await user.click(screen.getByRole("button", { name: /^alpha/ }));
      await waitFor(() => expect(document.querySelector(".sel-glow")?.closest(".tag-row")).toBeTruthy());
      expect(document.querySelectorAll(".sel-glow")).toHaveLength(1);
      // It starts where All memos' mark was painted and runs home.
      const glide = glides.find((frames) => String(frames[0]?.transform).startsWith("translate("));
      expect(glide?.[0]).toMatchObject({ transform: "translate(0px, -220px)", height: "40px" });
      expect(glide?.[1]).toMatchObject({ transform: "none", height: "34px" });
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });
});

describe("feed motion on a lens change", () => {
  interface Played {
    target: Element;
    keyframes: Keyframe[];
    timing: KeyframeAnimationOptions;
  }
  let played: Played[] = [];
  let startViewTransition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    played = [];
    matchMediaWith(() => false);
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value(this: Element, keyframes: Keyframe[], timing?: number | KeyframeAnimationOptions) {
        played.push({ target: this, keyframes, timing: typeof timing === "object" ? timing : {} });
        return { cancel() {}, finish() {}, finished: new Promise(() => undefined), effect: { target: this } };
      }
    });
    startViewTransition = vi.fn((update: () => void) => {
      update();
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition() {} };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
  });

  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate;
    delete (document as Partial<Document>).startViewTransition;
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  /** The cards stand one under another on the screen, from 200px down. */
  function stackCards(): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!this.classList.contains("memo-slot") || !this.parentElement) return new DOMRect(0, 0, 0, 0);
      const slots = Array.from(this.parentElement.querySelectorAll(":scope > .memo-slot"));
      return new DOMRect(0, 200 + slots.indexOf(this) * 114, 600, 100);
    });
  }

  it("moves the feed for a tag pick itself, with no view transition: the card the lens drops sinks where it stood", async () => {
    const user = userEvent.setup();
    stackCards();
    renderApp();
    await screen.findByText(/beta note/);
    played = [];

    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    // (Its stand-in still shows its words while it sinks.)
    const live = () => Array.from(document.querySelectorAll(".memo-feed > .memo-slot"), (slot) => slot.textContent).join(" ");
    await waitFor(() => expect(live()).not.toContain("beta note"));

    expect(startViewTransition).not.toHaveBeenCalled();
    const sink = played.find((entry) => entry.target.classList.contains("feed-ghost") && entry.target.textContent?.includes("beta note"));
    expect(sink?.keyframes[1]).toMatchObject({ opacity: 0, transform: "scale(0.965)" });
  });

  it("lands a return on the place it left with motion on: the restore comes after the query's scroll to the top", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const scrollTo = window.scrollTo as unknown as ReturnType<typeof vi.fn>;
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    await user.type(screen.getByPlaceholderText("Search memos"), "beta");
    await waitFor(() => expect(screen.queryByText(/alpha note/)).toBeNull());

    scrollTo.mockClear();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByText(/alpha note/);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 900));

    const calls = scrollTo.mock.calls.map((call) => JSON.stringify(call));
    expect(calls.lastIndexOf(JSON.stringify([0, 0]))).toBeLessThan(calls.indexOf(JSON.stringify([0, 900])));
    expect(calls.at(-1)).toBe(JSON.stringify([0, 900]));
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("gives the cards a control's search brings their arrival once, from the change that brought them", async () => {
    const user = userEvent.setup();
    stackCards();
    renderApp();
    await screen.findByText(/beta note/);
    await user.type(screen.getByPlaceholderText("Search memos"), "beta");
    await waitFor(() => expect(screen.queryByText(/alpha note/)).toBeNull());
    played = [];

    // The × sets the search text outright: the full list lands inside the change.
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    const alpha = (await screen.findByText(/alpha note/)).closest(".memo-slot")!;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entrances = played.filter((entry) => entry.target === alpha);
    expect(entrances).toHaveLength(1);
    expect(entrances[0].keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(18px) scale(0.995)" });
    // A beat behind what leaves, not the feed's own entrance.
    expect(entrances[0].timing.delay).toBeGreaterThanOrEqual(30);
  });
});

describe("trash search", () => {
  it("filters trashed memos by keyword without the semantic or filter controls", async () => {
    const user = userEvent.setup();
    const deletedAt = now.toISOString();
    serve([memo("a", "kept note"), memo("t1", "old receipt", { deletedAt }), memo("t2", "draft letter", { deletedAt })]);
    renderApp();
    await screen.findByText(/kept note/);

    await user.click(screen.getByRole("button", { name: /^Trash/ }));
    await screen.findByText(/old receipt/);
    expect(screen.queryByRole("button", { name: "Semantic Search" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Filter memos" })).toBeNull();

    const search = screen.getByRole("searchbox", { name: "Search Trash" });
    expect(search.closest("[role='search']")).toBeTruthy();
    expect(search.getAttribute("enterkeyhint")).toBe("search");
    expect(search.getAttribute("spellcheck")).toBe("false");
    await user.type(search, "letter");
    await waitFor(() => expect(screen.queryByText(/old receipt/)).toBeNull());
    expect(screen.getByText(/draft letter/)).toBeTruthy();
    // The same answer line as the memo search, read out once typing settles.
    expect(screen.getByText("Found 1 in Trash", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    await waitFor(() => expect(search.closest(".search-tools")?.querySelector("[role='status']")?.textContent).toBe("Found 1 in Trash"), { timeout: 1500 });

    // Esc clears first, then lets go of the field.
    search.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
    expect(document.activeElement).toBe(search);
    await screen.findByText(/old receipt/);
    await user.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(search);

    await user.type(search, "nothing like it");
    expect(await screen.findByText("No matching memos in Trash")).toBeTruthy();
  });
});

describe("date lenses", () => {
  it("keeps one date chip: a heatmap day replaces a range, and a range replaces the day", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await screen.findByText(/beta note/);

    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    await screen.findByRole("button", { name: /^Clear date range/ });

    const today = container.querySelector<HTMLButtonElement>(".heat-cell.is-today");
    if (!today) throw new Error("Today's heatmap cell was not rendered");
    fireEvent.click(today);
    await screen.findByRole("button", { name: /^Clear date filter/ });
    expect(screen.queryByRole("button", { name: /^Clear date range/ })).toBeNull();

    // The panel stays open across live edits; reopen it only if it closed.
    if (!screen.queryByRole("button", { name: "Last 7 days" })) await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    await screen.findByRole("button", { name: /^Clear date range/ });
    expect(screen.queryByRole("button", { name: /^Clear date filter/ })).toBeNull();
  });

  it("stops the range calendar at the month of the first memo", () => {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const minDay = dateKey(new Date(first.getFullYear(), first.getMonth(), 2));
    render(
      <Providers>
        <RangeCalendar from={null} to={null} minDay={minDay} onStart={vi.fn()} onRange={vi.fn()} />
      </Providers>
    );
    // Spent, but still a focus stop: a disabled arrow would drop the focus
    // resting on it (Enter held on ‹ walked off the calendar).
    const previous = screen.getByRole("button", { name: "Previous month" }) as HTMLButtonElement;
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(previous.disabled).toBe(false);
    act(() => previous.focus());
    const month = document.querySelector(".range-cal-month")?.textContent;
    fireEvent.click(previous);
    expect(document.querySelector(".range-cal-month")?.textContent).toBe(month);
    expect(document.activeElement).toBe(previous);
    const before = document.querySelector<HTMLButtonElement>(`[data-day="${dateKey(first)}"]`);
    const floor = document.querySelector<HTMLButtonElement>(`[data-day="${minDay}"]`);
    expect(before?.disabled).toBe(true);
    // The floor day itself stays pickable unless it is in the future.
    if (minDay <= dateKey(now)) expect(floor?.disabled).toBe(false);
  });
});

describe("mobile chrome", () => {
  it("marks the composer while a search is up so phones can fold an empty one away", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await screen.findByText(/beta note/);
    const composer = container.querySelector(".composer");
    expect(composer?.hasAttribute("data-searching")).toBe(false);
    await user.type(screen.getByPlaceholderText("Search memos"), "beta");
    expect(composer?.hasAttribute("data-searching")).toBe(true);
  });

  it("offers a skip link that lands keyboard focus on the main column", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    await user.click(skip);
    expect(document.activeElement?.id).toBe("main-content");
    expect(window.location.hash).toBe("");
  });

  it("tucks the phone search row on a scroll down and brings it back on a scroll up", () => {
    matchMediaWith((query) => query.includes("max-width: 440px") || query.includes("prefers-reduced-motion"));
    function Bar() {
      const ref = useRef<HTMLDivElement>(null);
      useTopbarTuck(ref, true);
      return (
        <div ref={ref} className="topbar">
          <div className="breadcrumb" />
          <div className="search-tools">
            <input aria-label="query" />
          </div>
        </div>
      );
    }
    const { container } = render(<Bar />);
    const bar = container.querySelector<HTMLElement>(".topbar")!;
    const crumbs = container.querySelector<HTMLElement>(".breadcrumb")!;
    const tools = container.querySelector<HTMLElement>(".search-tools")!;
    Object.defineProperties(crumbs, { offsetTop: { value: 16 }, offsetHeight: { value: 44 } });
    Object.defineProperties(tools, { offsetTop: { value: 68 }, offsetHeight: { value: 40 } });

    const scrollTo = (y: number) => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: y });
      act(() => {
        window.dispatchEvent(new Event("scroll"));
        vi.runOnlyPendingTimers();
      });
    };
    // The page's own scroll range (jsdom lays nothing out).
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    vi.useFakeTimers();
    try {
      scrollTo(400);
      expect(bar.dataset.tuck).toBe("in");
      expect(bar.style.getPropertyValue("--topbar-tuck")).toBe("48px");
      scrollTo(380);
      // Reduced motion: the reveal lands at once instead of animating.
      expect(bar.dataset.tuck).toBeUndefined();

      scrollTo(600);
      expect(bar.dataset.tuck).toBe("in");
      act(() => {
        tools.querySelector("input")!.focus();
      });
      expect(bar.dataset.tuck).toBeUndefined();
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
      delete (document.documentElement as unknown as { scrollHeight?: number }).scrollHeight;
    }
  });

  it("leaves the search row alone for a place the app restores, and for the bounce past the bottom", () => {
    matchMediaWith((query) => query.includes("max-width: 440px") || query.includes("prefers-reduced-motion"));
    function Bar() {
      const ref = useRef<HTMLDivElement>(null);
      useTopbarTuck(ref, true);
      return (
        <div ref={ref} className="topbar">
          <div className="breadcrumb" />
          <div className="search-tools" />
        </div>
      );
    }
    const { container } = render(<Bar />);
    const bar = container.querySelector<HTMLElement>(".topbar")!;
    Object.defineProperties(container.querySelector(".breadcrumb")!, { offsetTop: { value: 16 }, offsetHeight: { value: 44 } });
    Object.defineProperties(container.querySelector(".search-tools")!, { offsetTop: { value: 68 }, offsetHeight: { value: 40 } });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 2000 + window.innerHeight });
    const scrollTo = (y: number) => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: y });
      act(() => {
        window.dispatchEvent(new Event("scroll"));
        vi.runOnlyPendingTimers();
      });
    };
    vi.useFakeTimers();
    // After the fake timers, so the clock read is this one whichever
    // performance object they leave in place.
    let clock = 1000;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      // Back lands 1,500px down: the app moved the page, nobody read down it.
      act(() => {
        window.dispatchEvent(new Event(SCROLL_JUMP_EVENT));
      });
      scrollTo(1500);
      expect(bar.dataset.tuck).toBeUndefined();
      // Reading on from there is reading.
      clock += 400;
      scrollTo(1600);
      expect(bar.dataset.tuck).toBe("in");

      // Read to the end; iOS overshoots the bottom and bounces back to it.
      scrollTo(2000);
      scrollTo(2080);
      scrollTo(2000);
      expect(bar.dataset.tuck).toBe("in");
    } finally {
      clockSpy.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
      delete (document.documentElement as unknown as { scrollHeight?: number }).scrollHeight;
    }
  });
});
