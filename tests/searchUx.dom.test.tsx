// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  createMemo: vi.fn(),
  // The ranked map a semantic query would hand back (null: no ranking).
  semanticResults: null as ReadonlyMap<string, number> | null,
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
  return {
    ...actual,
    getAuthStatus: mocks.getAuthStatus,
    bootstrap: mocks.bootstrap,
    syncSince: mocks.syncSince,
    createMemo: mocks.createMemo
  };
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

vi.mock("../src/hooks/useSemanticSearch", () => ({
  useSemanticSearch: (enabled: boolean, _memos: unknown, query: string) => ({
    status: enabled ? "ready" : "off",
    progress: null,
    queryProgress: null,
    results: enabled && query.trim() ? mocks.semanticResults : null,
    error: null,
    indexedMemos: enabled ? 4 : 0,
    rebuilding: false,
    retry: () => undefined,
    rebuild: () => undefined
  })
}));

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function memo(index: number, content: string): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return { id: `memo-${index}`, content, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq: index + 1, images: [] };
}

const NOTEBOOK = [
  memo(0, "Fruit salad #ideas"),
  memo(1, "Green apple and more fruit #journal"),
  memo(2, "Window seat #journal"),
  memo(3, "Plain note")
];

function renderApp() {
  return render(
    <Providers>
      <App />
    </Providers>
  );
}

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

beforeEach(() => {
  localStorage.clear();
  // Lens history (memo:nav + history.state) would restore the previous test's search.
  sessionStorage.clear();
  window.history.replaceState(null, "");
  mocks.semanticResults = null;
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos: NOTEBOOK,
    tags: [],
    cursor: NOTEBOOK.length,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: NOTEBOOK.length, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z" });
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
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
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
  delete (Element.prototype as Element & { scrollIntoView?: () => void }).scrollIntoView;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("search box", () => {
  it("is a named search field that keeps phone keyboards from rewriting keywords", async () => {
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    expect(search.getAttribute("type")).toBe("search");
    expect(search.getAttribute("enterkeyhint")).toBe("search");
    expect(search.getAttribute("autocorrect")).toBe("off");
    expect(search.getAttribute("autocapitalize")).toBe("none");
    expect(search.getAttribute("spellcheck")).toBe("false");
    // The syntax note describes the field instead of naming it.
    expect(search.hasAttribute("title")).toBe(false);
    expect(document.getElementById(search.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/Space separates keywords/);
    expect(screen.getByRole("search")).toBeTruthy();
  });

  it("clears on Escape, then lets go of focus on a second Escape", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.keyboard("{Escape}");
    expect((search as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
    expect(document.activeElement).toBe(search);
    await user.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(search);
  });

  it("shows the result count and announces it once typing settles", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    await user.type(search, "fruit");
    expect(await screen.findByText("Found 2 memos", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".search-sr[role='status']")?.textContent).toBe("Found 2 memos"), { timeout: 1500 });
  });

  it("does not filter on the pinyin while an IME is composing", async () => {
    renderApp();
    const search = (await screen.findByRole("searchbox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: "chuang" } });
    expect(search.value).toBe("chuang");
    // Still the whole notebook: no empty-state flash on the raw pinyin.
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.queryByText("No matching memos")).toBeNull();
    fireEvent.change(search, { target: { value: "Window" } });
    fireEvent.compositionEnd(search);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(search.value).toBe("Window");
  });

  it("takes WebKit's order too: compositionend first, then a plain input event", async () => {
    renderApp();
    const search = (await screen.findByRole("searchbox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: "chuang" } });
    expect(screen.getAllByRole("article")).toHaveLength(4);
    // The composition closes while the field still holds the pinyin…
    fireEvent.compositionEnd(search);
    // …and the committed text arrives as an ordinary (non-composing) input.
    fireEvent.change(search, { target: { value: "Window" } });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(search.value).toBe("Window");
    expect(screen.getByText("Found 1 memo", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    // A further keystroke after the composition filters live again.
    fireEvent.change(search, { target: { value: "Windo" } });
    await waitFor(() => expect(search.value).toBe("Windo"));
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("clears the query on Escape without also leaving select mode", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "All memos" }));
    await user.click(await screen.findByRole("menuitem", { name: "Select memos" }));
    const exit = await screen.findByRole("button", { name: "Cancel selection" });
    expect(exit).toBeTruthy();
    search.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
    expect(screen.getByRole("button", { name: "Cancel selection" })).toBeTruthy();
    // With the query gone, Escape is select mode's again.
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel selection" })).toBeNull());
  });
});

describe("search with meaning", () => {
  it("counts what meaning added beside the keyword hits", async () => {
    localStorage.setItem("memo:semantic-search", "1");
    // memo-0 and memo-1 match "fruit" literally; memo-2 only by meaning.
    mocks.semanticResults = new Map([
      ["memo-0", 0.9],
      ["memo-2", 0.8]
    ]);
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("searchbox", { name: "Search by meaning" }), "fruit");
    expect(await screen.findByText("Found 3 memos · 1 related by meaning", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".search-sr[role='status']")?.textContent).toBe("Found 3 memos · 1 related by meaning"), { timeout: 1500 });
  });

  it("says the count may still grow while meaning is on its way, and rolls it", async () => {
    localStorage.setItem("memo:semantic-search", "1");
    // A live index with no ranking back yet: the keyword tier has answered.
    mocks.semanticResults = null;
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("searchbox", { name: "Search by meaning" }), "fruit");
    expect(await screen.findByText("Found 2 memos · looking for related…", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    const line = document.querySelector(".search-summary > [aria-hidden='true']");
    expect(line?.querySelector(".search-summary-pending")?.textContent).toBe(" · looking for related…");
    expect(line?.querySelector(".roll")).toBeTruthy();
    // The live region waits for the settled answer.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector(".search-sr[role='status']")?.textContent).toBe("");
  });

  it("says the same in Chinese", async () => {
    localStorage.setItem("memo:language", "zh-CN");
    localStorage.setItem("memo:semantic-search", "1");
    mocks.semanticResults = new Map([
      ["memo-0", 0.9],
      ["memo-2", 0.8]
    ]);
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("searchbox", { name: "按意思搜索" }), "fruit");
    expect(await screen.findByText("找到 3 条笔记 · 其中 1 条意思相近", { selector: ".search-summary > .sr-only" })).toBeTruthy();
  });
});

describe("scoped search", () => {
  it("names the tag scope and widens to every memo from the empty state, keeping the query", async () => {
    const user = userEvent.setup();
    renderApp();
    const cards = await screen.findAllByRole("article");
    const journalCard = cards.find((card) => card.textContent?.includes("Window seat"));
    if (!journalCard) throw new Error("journal memo missing");
    await user.click(within(journalCard).getByRole("button", { name: "#journal" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));

    const search = screen.getByRole("searchbox", { name: "Search in #journal" });
    await user.type(search, "salad");
    expect(await screen.findByText("No matching memos in #journal")).toBeTruthy();
    expect(screen.getByText("1 memo outside this view matches.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Search all memos" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(screen.getByRole("searchbox", { name: "Search memos" })).toHaveProperty("value", "salad");
    expect(screen.getByText("Found 1 memo", { selector: ".search-summary > .sr-only" })).toBeTruthy();
  });

  it("says the scope in the result line", async () => {
    const user = userEvent.setup();
    renderApp();
    const cards = await screen.findAllByRole("article");
    const journalCard = cards.find((card) => card.textContent?.includes("Window seat"));
    if (!journalCard) throw new Error("journal memo missing");
    await user.click(within(journalCard).getByRole("button", { name: "#journal" }));
    await user.type(screen.getByRole("searchbox", { name: "Search in #journal" }), "fruit");
    expect(await screen.findByText("Found 1 memo in #journal", { selector: ".search-summary > .sr-only" })).toBeTruthy();
  });
});

describe("search hit highlighting", () => {
  it("registers ranges over the literal hits inside the rendered cards", async () => {
    const registry = new Map<string, unknown>();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    await user.type(search, "FRUIT");
    await waitFor(() => {
      const highlight = registry.get("search-hit") as FakeHighlight | undefined;
      expect(highlight?.ranges.map((range) => range.toString()).sort()).toEqual(["Fruit", "fruit"]);
    });
    await user.clear(search);
    await waitFor(() => expect(registry.has("search-hit")).toBe(false));
  });

  it("paints the hits inside a long memo's fold and counts them on the toggle when the fold hides them all", async () => {
    const registry = new Map<string, unknown>();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);
    const long = memo(4, [...Array.from({ length: 30 }, (_, index) => `filler line ${index + 1}`), "a kumquat at the very end"].join("\n"));
    mocks.bootstrap.mockResolvedValue({
      memos: [...NOTEBOOK, long],
      tags: [],
      cursor: NOTEBOOK.length + 1,
      syncEpoch: "epoch-a",
      serverTime: "2026-01-01T00:02:00.000Z",
      hasMore: false,
      nextAfter: null
    });
    // The long body measures past the fold, and its one hit sits far below
    // the 320px cut (the fold itself starts at 0 in jsdom).
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memo-content") ? 900 : 0;
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 760, 40, 20) });
    try {
      const user = userEvent.setup();
      renderApp();
      const search = await screen.findByRole("searchbox", { name: "Search memos" });
      expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();

      await user.type(search, "kumquat");
      await waitFor(() => {
        const highlight = registry.get("search-hit") as FakeHighlight | undefined;
        expect(highlight?.ranges.map((range) => range.toString())).toEqual(["kumquat"]);
      });
      expect(await screen.findByRole("button", { name: "Show more · 1 match" })).toBeTruthy();

      await user.clear(search);
      expect(await screen.findByRole("button", { name: "Show more" })).toBeTruthy();
    } finally {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    }
  });
});

describe("creating under a lens", () => {
  it("says when the current search hides the new memo and reveals it on request", async () => {
    const user = userEvent.setup();
    const created = memo(9, "Tomorrow: call the plumber");
    mocks.createMemo.mockResolvedValue({ memo: created });
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));

    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "Tomorrow: call the plumber");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Saved the memo — this view hides it")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(screen.getByText("Tomorrow: call the plumber")).toBeTruthy());
    expect((search as HTMLInputElement).value).toBe("");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("lifts only the day that hides the new memo, keeping a query it matches", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const stamp = today.toISOString();
    const todays: Memo = { ...memo(5, "Fruit bowl today"), createdAt: stamp, updatedAt: stamp };
    mocks.bootstrap.mockResolvedValue({
      memos: [...NOTEBOOK, todays],
      tags: [],
      cursor: NOTEBOOK.length + 1,
      syncEpoch: "epoch-a",
      serverTime: stamp,
      hasMore: false,
      nextAfter: null
    });
    // The server stamps the new memo on an earlier day than the one picked.
    mocks.createMemo.mockResolvedValue({ memo: memo(9, "More fruit") });
    const user = userEvent.setup();
    renderApp();
    await screen.findAllByRole("article");
    const todayCell = document.querySelector<HTMLButtonElement>(".heat-cell.is-today");
    if (!todayCell) throw new Error("today's heatmap cell missing");
    await user.click(todayCell);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    const search = screen.getByRole("searchbox", { name: "Search memos" });
    await user.type(search, "fruit");
    expect(await screen.findByText("Found 1 memo within the current filters", { selector: ".search-summary > .sr-only" })).toBeTruthy();

    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "More fruit");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Saved the memo — this view hides it")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show" }));
    // The day is gone; the query that the memo matches stays.
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
    expect((search as HTMLInputElement).value).toBe("fruit");
    expect(screen.getByText("More fruit")).toBeTruthy();
    expect(document.querySelector(".heat-cell.is-active")).toBeNull();
  });

  it("says when the new memo lands past the rendered part of an oldest-first feed", async () => {
    localStorage.setItem("memo-sort", "created-asc");
    const long = Array.from({ length: 85 }, (_, index) => memo(index, `Note ${index}`));
    mocks.bootstrap.mockResolvedValue({
      memos: long,
      tags: [],
      cursor: long.length,
      syncEpoch: "epoch-a",
      serverTime: "2026-01-01T00:02:00.000Z",
      hasMore: false,
      nextAfter: null
    });
    mocks.createMemo.mockResolvedValue({ memo: memo(200, "The newest note") });
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(80));
    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "The newest note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Saved the memo — it's further down this list", { selector: ".toast *" })).toBeTruthy();
    expect(screen.queryByText("The newest note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
  });

  it("stays quiet when the new memo shows in the current view", async () => {
    const user = userEvent.setup();
    mocks.createMemo.mockResolvedValue({ memo: memo(9, "More fruit") });
    renderApp();
    const search = await screen.findByRole("searchbox", { name: "Search memos" });
    await user.type(search, "fruit");
    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "More fruit");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(screen.queryByText("Saved the memo — this view hides it")).toBeNull();
  });
});
