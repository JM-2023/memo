// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { ApiError } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import { SCROLL_JUMP_EVENT } from "../src/lib/navHistory";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  createMemo: vi.fn(),
  trashMemo: vi.fn(),
  // The ranked map a semantic query would hand back (null: no ranking).
  semanticResults: null as ReadonlyMap<string, number> | null,
  // The ranking was made for an earlier query (held while this one ranks).
  semanticStale: false,
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
    createMemo: mocks.createMemo,
    trashMemo: mocks.trashMemo
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
    stale: enabled && query.trim() && mocks.semanticResults ? mocks.semanticStale : false,
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
  mocks.semanticStale = false;
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
  Reflect.deleteProperty(window, "visualViewport");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("search box", () => {
  it("is a named search field that keeps phone keyboards from rewriting keywords", async () => {
    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
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

  it("closes its list on Escape, then clears, then lets go of focus", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(search.getAttribute("aria-expanded")).toBe("true");
    // The list first, as its foot says (esc close); the query stays.
    await user.keyboard("{Escape}");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect((search as HTMLInputElement).value).toBe("fruit");
    expect(document.activeElement).toBe(search);
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
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    expect(await screen.findByText("Found 2 memos", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".search-sr[role='status']")?.textContent).toBe("Found 2 memos"), { timeout: 1500 });
  });

  it("does not filter on the pinyin while an IME is composing", async () => {
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
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
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
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

  it("waits out an IME composition in the Trash search too, without filtering or scrolling", async () => {
    const deletedAt = "2026-01-01T00:01:00.000Z";
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0, "Window seat"), deletedAt }, { ...memo(1, "Fruit salad"), deletedAt }, memo(2, "Plain note")],
      tags: [],
      cursor: 3,
      syncEpoch: "epoch-a",
      serverTime: "2026-01-01T00:02:00.000Z",
      hasMore: false,
      nextAfter: null
    });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Trash/ }));
    const search = (await screen.findByRole("searchbox", { name: "Search Trash" })) as HTMLInputElement;
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    vi.mocked(window.scrollTo).mockClear();
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: "chuang" } });
    expect(search.value).toBe("chuang");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByText("No matching memos in Trash")).toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: "Window" } });
    fireEvent.compositionEnd(search);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(search.value).toBe("Window");
  });

  it("clears the query on Escape without also leaving select mode", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "All memos" }));
    await user.click(await screen.findByRole("menuitem", { name: "Select memos" }));
    const exit = await screen.findByRole("button", { name: "Cancel selection" });
    expect(exit).toBeTruthy();
    search.focus();
    // The list closes first; neither press backs out of select mode.
    await user.keyboard("{Escape}");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Cancel selection" })).toBeTruthy();
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
    await user.type(await screen.findByRole("combobox", { name: "Search by meaning" }), "fruit");
    expect(await screen.findByText("Found 3 memos · 1 related by meaning", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".search-sr[role='status']")?.textContent).toBe("Found 3 memos · 1 related by meaning"), { timeout: 1500 });
  });

  it("badges what meaning alone found and heads its run with a heading row", async () => {
    localStorage.setItem("memo:semantic-search", "1");
    // memo-0 and memo-1 match "fruit" literally; memo-2 only by meaning.
    mocks.semanticResults = new Map([
      ["memo-0", 0.9],
      ["memo-2", 0.8]
    ]);
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("combobox", { name: "Search by meaning" }), "fruit");
    await screen.findByText("Found 3 memos · 1 related by meaning", { selector: ".search-summary > .sr-only" });

    const related = screen.getByText("Window seat").closest(".memo-slot") as HTMLElement;
    const lead = screen.getByRole("heading", { level: 2, name: "Related by meaning — these don’t contain “fruit”" });
    expect(lead.classList.contains("feed-lead")).toBe(true);
    expect(lead.classList.contains("is-related")).toBe(true);
    expect(lead.closest(".memo-slot")).toBeNull();
    expect(lead.nextElementSibling).toBe(related);
    expect(within(related.querySelector("article")!).getByText("Related").classList.contains("memo-related")).toBe(true);
    // The keyword hits carry neither, and the line heads the run once.
    const hit = screen.getByText("Fruit salad").closest(".memo-slot") as HTMLElement;
    expect(hit.querySelector(".memo-related")).toBeNull();
    expect(document.querySelectorAll(".feed-lead")).toHaveLength(1);
    // A search's own count stands above the results: no foot under them.
    expect(document.querySelector(".feed-foot")).toBeNull();
  });

  it("says the count may still grow while meaning is on its way, and rolls it", async () => {
    localStorage.setItem("memo:semantic-search", "1");
    // A live index with no ranking back yet: the keyword tier has answered.
    mocks.semanticResults = null;
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("combobox", { name: "Search by meaning" }), "fruit");
    expect(await screen.findByText("Found 2 memos · looking for related…", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    const line = document.querySelector(".search-summary > [aria-hidden='true']");
    expect(line?.querySelector(".search-summary-pending")?.textContent).toBe(" · looking for related…");
    expect(line?.querySelector(".roll")).toBeTruthy();
    // The live region waits for the settled answer.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector(".search-sr[role='status']")?.textContent).toBe("");
  });

  it("keeps the previous ranking's rows in place, dimmed and uncounted, until the new one lands", async () => {
    localStorage.setItem("memo:semantic-search", "1");
    // Ranked for the text before this one: memo-2 is only there by meaning.
    mocks.semanticResults = new Map([
      ["memo-0", 0.9],
      ["memo-2", 0.8]
    ]);
    mocks.semanticStale = true;
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("combobox", { name: "Search by meaning" }), "fruit");
    expect(await screen.findByText("Found 2 memos · looking for related…", { selector: ".search-summary > .sr-only" })).toBeTruthy();
    const slotOf = (text: string) => screen.getByText(text, { exact: false }).closest(".memo-slot");
    expect(slotOf("Window seat")?.hasAttribute("data-stale")).toBe(true);
    expect(slotOf("Fruit salad")?.hasAttribute("data-stale")).toBe(false);
    expect(slotOf("Green apple")?.hasAttribute("data-stale")).toBe(false);
    // The keyword tier keeps the held order: memo-0's old score still leads.
    const order = [...document.querySelectorAll<HTMLElement>(".memo-feed > .memo-slot")].map((slot) => slot.dataset.vt);
    expect(order).toEqual(["memo-memo-0", "memo-memo-1", "memo-memo-2"]);
    // Nothing is announced until the answer settles.
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
    await user.type(await screen.findByRole("combobox", { name: "按意思搜索" }), "fruit");
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

    const search = screen.getByRole("combobox", { name: "Search in #journal" });
    await user.type(search, "salad");
    expect(await screen.findByText("No matching memos in #journal")).toBeTruthy();
    expect(screen.getByText("1 memo outside this view matches.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Search all memos" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(screen.getByRole("combobox", { name: "Search memos" })).toHaveProperty("value", "salad");
    expect(screen.getByText("Found 1 memo", { selector: ".search-summary > .sr-only" })).toBeTruthy();
  });

  it("says the scope in the result line", async () => {
    const user = userEvent.setup();
    renderApp();
    const cards = await screen.findAllByRole("article");
    const journalCard = cards.find((card) => card.textContent?.includes("Window seat"));
    if (!journalCard) throw new Error("journal memo missing");
    await user.click(within(journalCard).getByRole("button", { name: "#journal" }));
    await user.type(screen.getByRole("combobox", { name: "Search in #journal" }), "fruit");
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
    const search = await screen.findByRole("combobox", { name: "Search memos" });
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
      const search = await screen.findByRole("combobox", { name: "Search memos" });
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
  it("says when the current search hides the new memo, skips the Sending toast on fast sends, and reveals + focuses the card on Show", async () => {
    const user = userEvent.setup();
    const created = memo(9, "Tomorrow: call the plumber");
    // The server stores the memo under the id the client sent.
    mocks.createMemo.mockImplementation(async (id: string) => ({ memo: { ...created, id } }));
    const jumps: Event[] = [];
    window.addEventListener(SCROLL_JUMP_EVENT, (event) => jumps.push(event));
    const scrollTo = vi.mocked(window.scrollTo);
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    const rectOrig = Element.prototype.getBoundingClientRect;
    let slotTop = 900;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("memo-slot") && this.textContent?.includes("Tomorrow: call the plumber")) {
        return { top: slotTop, bottom: slotTop + 100, left: 0, right: 600, width: 600, height: 100, x: 0, y: slotTop, toJSON: () => ({}) } as DOMRect;
      }
      return rectOrig.call(this);
    });

    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));

    const composer = screen.getByRole("combobox", { name: "Memo content" });
    await user.type(composer, "Tomorrow: call the plumber");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    // Fast round trip: goes straight to Sent without flashing Sending….
    expect(await screen.findByText("Sent — this view hides it")).toBeTruthy();
    expect(screen.queryByText("Sending… — this view hides it")).toBeNull();

    scrollTo.mockClear();
    focusSpy.mockClear();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    await user.click(screen.getByRole("button", { name: "Show" }));
    const card = (await screen.findByText("Tomorrow: call the plumber")).closest("article") as HTMLElement;
    expect((search as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(card));
    // Focus moved to the revealed card (never back to the composer) with preventScroll: true.
    expect(document.activeElement).not.toBe(composer);
    expect(focusSpy.mock.calls.some(([options], index) => focusSpy.mock.contexts[index] === card && (options as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
    // Controlled re-aiming scroll (window.scrollTo + SCROLL_JUMP_EVENT), never native scrollIntoView.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(jumps.length).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    // Simulate layout drift (content-visibility settling): re-aim tracks the new top.
    const callsBeforeDrift = scrollTo.mock.calls.length;
    slotTop = 1040;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
    expect(scrollTo.mock.calls.length).toBeGreaterThan(callsBeforeDrift);
  });

  it("hands focus back to where it was when Show finds no card to take it, instead of dropping it to <body>", async () => {
    const user = userEvent.setup();
    const created = memo(9, "Unreachable plumber note");
    mocks.createMemo.mockImplementation(async (id: string) => ({ memo: { ...created, id } }));
    // The revealed card can't take focus (as when it lands past the rendered
    // window and no card ever shows): the reveal has missed.
    const realFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.classList.contains("memo-card")) return;
      realFocus.call(this, options);
    });

    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const composer = screen.getByRole("combobox", { name: "Memo content" });
    await user.type(composer, "Unreachable plumber note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent — this view hides it")).toBeTruthy();
    composer.focus();
    expect(document.activeElement).toBe(composer);

    await user.click(screen.getByRole("button", { name: "Show" }));
    await screen.findByText("Unreachable plumber note");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("glides to a revealed card under full motion using controlled per-frame scrollTo and yields on reader input", async () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn()
        }) as unknown as MediaQueryList
    );
    const user = userEvent.setup();
    const created = memo(9, "Glide target memo");
    mocks.createMemo.mockImplementation(async (id: string) => ({ memo: { ...created, id } }));
    const scrollTo = vi.mocked(window.scrollTo);
    const rectOrig = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("memo-slot") && this.textContent?.includes("Glide target memo")) {
        return { top: 900, bottom: 1000, left: 0, right: 600, width: 600, height: 100, x: 0, y: 900, toJSON: () => ({}) } as DOMRect;
      }
      return rectOrig.call(this);
    });

    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "Glide target memo");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent — this view hides it")).toBeTruthy();

    scrollTo.mockClear();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    await user.click(screen.getByRole("button", { name: "Show" }));
    const card = (await screen.findByText("Glide target memo")).closest("article") as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(card));
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    // Reader input cancels the controlled glide immediately.
    window.dispatchEvent(new Event("wheel"));
    const afterWheel = scrollTo.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    });
    expect(scrollTo.mock.calls.length).toBe(afterWheel);
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
    // The server stamps the new memo on an earlier day than the one picked
    // (a send that waited out a connection): the card lands in the day, and
    // leaves it once the server's time arrives.
    mocks.createMemo.mockImplementation(async (id: string) => ({ memo: { ...memo(9, "More fruit"), id } }));
    const user = userEvent.setup();
    renderApp();
    await screen.findAllByRole("article");
    const todayCell = document.querySelector<HTMLButtonElement>(".heat-cell.is-today");
    if (!todayCell) throw new Error("today's heatmap cell missing");
    await user.click(todayCell);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    const search = screen.getByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    expect(await screen.findByText("Found 1 memo within the current filters", { selector: ".search-summary > .sr-only" })).toBeTruthy();

    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "More fruit");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent — this view hides it")).toBeTruthy();
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
    mocks.createMemo.mockImplementation(async (id: string) => ({ memo: { ...memo(200, "The newest note"), id } }));
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(80));
    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "The newest note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent — it’s further down this list", { selector: ".toast *" })).toBeTruthy();
    expect(screen.queryByText("The newest note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
  });

  it("waits out the 150ms hold before showing a hidden Sending toast, uses calm info tone for retrying and error tone only for refused", async () => {
    let fail: (err: Error) => void = () => undefined;
    mocks.createMemo.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    );
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "Tomorrow: call the plumber");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // Immediately inside the 150ms hold, no Sending toast has flashed yet.
    expect(screen.queryByText("Sending… — this view hides it")).toBeNull();
    // After the 150ms hold, Sending… appears through the shared <SendStatus>.
    expect(await screen.findByText("Sending… — this view hides it")).toBeTruthy();
    expect(screen.queryByText("Sent — this view hides it")).toBeNull();

    await act(async () => fail(new ApiError("INTERNAL_ERROR", 503, "The server is having trouble.")));
    // The same toast transitions in place with calm neutral tone (no red error styling for retrying).
    expect(await screen.findByText("Not sent · retrying — this view hides it")).toBeTruthy();
    const toast = document.querySelector(".toast") as HTMLElement;
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    expect(toast.classList.contains("is-error")).toBe(false);
    expect(toast.querySelector(".toast-mark")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show" }));
    const card = (await screen.findByText("Tomorrow: call the plumber")).closest("article") as HTMLElement;
    expect(within(card).getByText("Not sent · retrying")).toBeTruthy();
    expect(card.classList.contains("is-send-refused")).toBe(false);
  });

  it("uses error tone on the hidden-view toast when the server refuses the send, and revises a hidden Sent toast on ⌘Z", async () => {
    const user = userEvent.setup();
    mocks.createMemo
      .mockImplementationOnce(async () => {
        throw new ApiError("STORAGE_FULL", 507, "The database is full.");
      })
      .mockImplementationOnce(async (id: string, content: string) => ({ memo: { ...memo(9, content), id } }));
    mocks.trashMemo.mockImplementation(async (id: string) => ({
      ok: true,
      memo: { ...memo(9, "Hidden oops"), id, seq: 11, deletedAt: "2026-01-01T00:05:00.000Z" }
    }));
    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));

    const composer = screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    await user.type(composer, "Rejected hidden note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Not sent · the server refused it — this view hides it")).toBeTruthy();
    const refusedToast = screen.getByText("Not sent · the server refused it — this view hides it").closest(".toast") as HTMLElement;
    expect(refusedToast.classList.contains("is-error")).toBe(true);
    expect(refusedToast.querySelector(".toast-mark")).not.toBeNull();

    // Dismiss the refused toast, then send a second hidden memo that succeeds and press ⌘Z within 6s.
    await user.click(within(refusedToast).getByRole("button", { name: "Dismiss" }));
    await user.type(composer, "Hidden oops");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const sentToast = (await screen.findByText("Sent — this view hides it")).closest(".toast") as HTMLElement;
    expect(sentToast).not.toBeNull();

    expect(fireEvent.keyDown(composer, { key: "z", ctrlKey: true })).toBe(false);
    expect(composer.value).toBe("Hidden oops");
    // The hidden "Sent" toast is revised in place to explain that the sent copy moved to Trash.
    const undoneNode = await screen.findByText("Back in the composer — the sent copy moved to Trash", { selector: ".toast *" });
    expect(undoneNode.closest(".toast")).toBe(sentToast);
    expect(document.querySelectorAll(".toast:not(.is-leaving)")).toHaveLength(1);
    expect(within(sentToast).queryByRole("button", { name: "Show" })).toBeNull();
    await waitFor(() => expect(mocks.trashMemo).toHaveBeenCalledTimes(1));
  });

  it("stays quiet when the new memo shows in the current view", async () => {
    const user = userEvent.setup();
    mocks.createMemo.mockImplementation(async (id: string) => ({ memo: { ...memo(9, "More fruit"), id } }));
    renderApp();
    const search = await screen.findByRole("combobox", { name: "Search memos" });
    await user.type(search, "fruit");
    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "More fruit");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(screen.queryByText("Sent — this view hides it")).toBeNull();
  });
});

describe("search and jump", () => {
  it("opens empty on recent searches and saved filters, and applies one with the arrows", async () => {
    localStorage.setItem("memo:recent-searches", JSON.stringify(["window"]));
    localStorage.setItem(
      "memo-saved-filters",
      JSON.stringify([{ id: "s1", name: "Ideas", query: "", tag: "ideas", day: null, filters: { noTags: false, hasImage: false, hasLink: false, hasOpenTask: false, dateFrom: null, dateTo: null } }])
    );
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    await user.click(search);
    expect(search.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", { name: "Search suggestions" });
    expect(search.getAttribute("aria-controls")).toBe(list.id);
    expect(within(list).getByRole("group", { name: "Recent searches" })).toBeTruthy();
    expect(within(list).getByRole("option", { name: "Ideas, #ideas" })).toBeTruthy();
    const recent = within(list).getByRole("option", { name: "window" });
    // Nothing is active until the arrows say so: Enter on an empty box applies nothing.
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    await user.keyboard("{ArrowDown}");
    expect(search.getAttribute("aria-activedescendant")).toBe(recent.id);
    await user.keyboard("{Enter}");
    expect(search.value).toBe("window");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(search);
  });

  it("offers the tags it matches, completes one with Tab and jumps to it with Enter", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    await user.type(search, "jour");
    const list = screen.getByRole("listbox", { name: "Search suggestions" });
    const tag = within(list).getByRole("option", { name: "Go to #journal, 2 memos" });
    expect(tag.querySelector(".jump-hit")?.textContent).toBe("jour");
    expect(tag.textContent).toContain("Tab");
    // Enter still means "search": the search row is the one in hand.
    const searchRow = within(list).getByRole("option", { name: /^Search “jour”/ });
    expect(search.getAttribute("aria-activedescendant")).toBe(searchRow.id);
    // The row says what the feed beneath it shows.
    const shown = screen.getAllByRole("article").length;
    await waitFor(() => expect(searchRow.getAttribute("aria-label")).toBe(`Search “jour”, ${shown} memo${shown === 1 ? "" : "s"}`));
    await user.keyboard("{Tab}");
    expect(search.value).toBe("#journal");
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("aria-activedescendant")).toBe(within(list).getByRole("option", { name: "Go to #journal, 2 memos" }).id);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(search.value).toBe(""));
    expect(screen.getByRole("combobox", { name: "Search in #journal" })).toBe(search);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(document.activeElement).not.toBe(search);
  });

  it("files a search on Enter, keeps it for next time, and folds away when the page is scrolled", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    await user.type(search, "fruit");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    fireEvent.wheel(document.body);
    expect(search.getAttribute("aria-expanded")).toBe("false");
    // The next key brings it back.
    await user.keyboard("{ArrowDown}");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("memo:recent-searches") ?? "[]")).toEqual(["fruit"]));
    // Esc clears the text; the arrows open the list on what was searched.
    await user.keyboard("{Escape}");
    expect(search.value).toBe("");
    await user.keyboard("{ArrowDown}");
    expect(within(screen.getByRole("listbox", { name: "Search suggestions" })).getByRole("option", { name: "fruit" })).toBeTruthy();
  });

  it("holds the suggestion list steady while an IME composes pinyin and re-ranks once on commit", async () => {
    const chineseNotebook = [
      memo(0, "读书笔记 #zhongwen #中文"),
      memo(1, "周记 #zhou #journal"),
      memo(2, "Fruit salad #ideas")
    ];
    mocks.bootstrap.mockResolvedValue({
      memos: chineseNotebook,
      tags: [],
      cursor: chineseNotebook.length,
      syncEpoch: "epoch-a",
      serverTime: "2026-01-01T00:02:00.000Z",
      hasMore: false,
      nextAfter: null
    });
    localStorage.setItem("memo:recent-searches", JSON.stringify(["window"]));
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");

    fireEvent.focus(search);
    const list = screen.getByRole("listbox", { name: "Search suggestions" });
    expect(within(list).getByRole("option", { name: "window" })).toBeTruthy();

    // Typing pinyin "z" -> "zh" -> "zho" -> "zhong" must hold the pre-composition list.
    fireEvent.compositionStart(search);
    for (const pinyin of ["z", "zh", "zho", "zhon", "zhong"]) {
      fireEvent.change(search, { target: { value: pinyin } });
      expect(search.value).toBe(pinyin);
      expect(within(list).getByRole("option", { name: "window" })).toBeTruthy();
      expect(within(list).queryByRole("option", { name: /#zhongwen/ })).toBeNull();
      expect(within(list).queryByRole("option", { name: /#zhou/ })).toBeNull();
      expect(within(list).queryByRole("option", { name: /^Search “z/ })).toBeNull();
    }

    // Committing "中文" updates the suggestion list once, for the composed text.
    fireEvent.change(search, { target: { value: "中文" } });
    fireEvent.compositionEnd(search);
    await waitFor(() => expect(within(list).getByRole("option", { name: "Go to #中文, 1 memo" })).toBeTruthy());
    expect(within(list).getByRole("option", { name: /^Search “中文”/ })).toBeTruthy();
    expect(within(list).queryByRole("option", { name: "window" })).toBeNull();

    // Composing after existing text also holds the current tag matches until commit (WebKit order).
    fireEvent.change(search, { target: { value: "jour" } });
    await waitFor(() => expect(within(list).getByRole("option", { name: "Go to #journal, 1 memo" })).toBeTruthy());
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: "jour zh" } });
    expect(within(list).getByRole("option", { name: "Go to #journal, 1 memo" })).toBeTruthy();
    expect(within(list).queryByRole("option", { name: /#zhongwen/ })).toBeNull();
    // WebKit order: compositionend then plain input with the committed word.
    fireEvent.compositionEnd(search);
    fireEvent.change(search, { target: { value: "jour 中文" } });
    await waitFor(() => expect(within(list).getByRole("option", { name: "Go to #中文, 1 memo" })).toBeTruthy());
  });

  it("shrinks its max-height above a phone's virtual keyboard via --kb-inset", async () => {
    localStorage.setItem("memo:recent-searches", JSON.stringify(["window", "fruit"]));
    const listeners = new Map<string, Set<() => void>>();
    const viewport = {
      height: 500,
      offsetTop: 0,
      scale: 1,
      addEventListener: (type: string, fn: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      }
    };
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      renderApp();
      const search = await screen.findByRole("combobox", { name: "Search memos" });
      await screen.findAllByRole("article");
      fireEvent.focus(search);
      const pop = document.querySelector<HTMLElement>(".search-jump-pop");
      expect(pop).not.toBeNull();
      expect(pop?.style.getPropertyValue("--kb-inset")).toBe("300px");

      // Keyboard resizes dynamically.
      viewport.height = 460;
      act(() => listeners.get("resize")?.forEach((fn) => fn()));
      await waitFor(() => expect(pop?.style.getPropertyValue("--kb-inset")).toBe("340px"));

      // Pinch zoom is not a keyboard: inset drops to 0px.
      viewport.scale = 2;
      act(() => listeners.get("resize")?.forEach((fn) => fn()));
      await waitFor(() => expect(pop?.style.getPropertyValue("--kb-inset")).toBe("0px"));

      const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
      expect(css).toMatch(/\.search-jump-list \{[^}]*max-height:[^;]*var\(--kb-inset, 0px\)/);
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("removes a single recent search by button or Delete/Shift+Backspace and persists the change", async () => {
    localStorage.setItem("memo:recent-searches", JSON.stringify(["window", "fruit", "apple"]));
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    await user.click(search);
    const list = screen.getByRole("listbox", { name: "Search suggestions" });

    // Pointer ✕ removes only that entry, keeps focus, hands highlight to the next row, and does not apply the search.
    const removeFruit = within(list).getByRole("button", { name: "Remove “fruit” from recent searches" });
    await user.click(removeFruit);
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(within(list).queryByRole("option", { name: "fruit" })).toBeNull();
    const appleRow = within(list).getByRole("option", { name: "apple" });
    const windowRow = within(list).getByRole("option", { name: "window" });
    expect(search.getAttribute("aria-activedescendant")).toBe(appleRow.id);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("memo:recent-searches") ?? "[]")).toEqual(["window", "apple"]));
    expect(document.querySelector('[data-live-region] [role="status"]')?.textContent).toBe("Removed “fruit” from recent searches");

    // Keyboard navigation highlights a recent row and Delete removes it, handing highlight to the neighbour.
    await user.keyboard("{ArrowUp}");
    expect(search.getAttribute("aria-activedescendant")).toBe(windowRow.id);
    expect(windowRow.getAttribute("aria-keyshortcuts")).toContain("Delete");
    expect(document.querySelector(".search-jump-foot")?.textContent).toContain("remove");

    // Plain Backspace must not delete a recent search.
    await user.keyboard("{Backspace}");
    expect(within(list).getByRole("option", { name: "window" })).toBeTruthy();

    await user.keyboard("{Delete}");
    expect(within(list).queryByRole("option", { name: "window" })).toBeNull();
    expect(search.getAttribute("aria-activedescendant")).toBe(within(list).getByRole("option", { name: "apple" }).id);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("memo:recent-searches") ?? "[]")).toEqual(["apple"]));

    // Shift+Backspace also removes the active recent row (for laptop keyboards without forward-delete).
    await user.keyboard("{Shift>}{Backspace}{/Shift}");
    await waitFor(() => expect(localStorage.getItem("memo:recent-searches")).toBeNull());
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(search);
  });

  it("clears all recent searches by click or keyboard while keeping other sections open", async () => {
    localStorage.setItem("memo:recent-searches", JSON.stringify(["window", "fruit"]));
    localStorage.setItem(
      "memo-saved-filters",
      JSON.stringify([{ id: "s1", name: "Ideas", query: "", tag: "ideas", day: null, filters: { noTags: false, hasImage: false, hasLink: false, hasOpenTask: false, dateFrom: null, dateTo: null } }])
    );
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    await user.click(search);
    const list = screen.getByRole("listbox", { name: "Search suggestions" });

    // Reach Clear via arrow keys and Enter.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    const clearRow = within(list).getByRole("option", { name: "Clear recent searches" });
    expect(search.getAttribute("aria-activedescendant")).toBe(clearRow.id);
    await user.keyboard("{Enter}");

    expect(within(list).queryByRole("group", { name: "Recent searches" })).toBeNull();
    expect(within(list).getByRole("option", { name: "Ideas, #ideas" })).toBeTruthy();
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search);
    await waitFor(() => expect(localStorage.getItem("memo:recent-searches")).toBeNull());
    expect(document.querySelector('[data-live-region] [role="status"]')?.textContent).toBe("Recent searches cleared");
  });

  it("uses Chinese accessible names and announcements for recent search deletion and clear", async () => {
    localStorage.setItem("memo:language", "zh-CN");
    localStorage.setItem("memo:recent-searches", JSON.stringify(["窗户", "水果"]));
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "搜索笔记" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    await user.click(search);
    const list = screen.getByRole("listbox", { name: "搜索建议" });

    await user.click(within(list).getByRole("button", { name: "从最近搜索中删除「窗户」" }));
    expect(document.querySelector('[data-live-region] [role="status"]')?.textContent).toBe("已从最近搜索中删除「窗户」");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("memo:recent-searches") ?? "[]")).toEqual(["水果"]));

    await user.click(within(list).getByRole("option", { name: "清空最近搜索" }));
    expect(document.querySelector('[data-live-region] [role="status"]')?.textContent).toBe("已清空最近搜索");
    await waitFor(() => expect(localStorage.getItem("memo:recent-searches")).toBeNull());
    expect(search.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("app shortcuts", () => {
  it("reaches search with / and ⌘K from anywhere but a text field, and lists the keys on ?", async () => {
    const user = userEvent.setup();
    renderApp();
    const search = (await screen.findByRole("combobox", { name: "Search memos" })) as HTMLInputElement;
    await screen.findAllByRole("article");
    act(() => (document.querySelector(".loc-trigger") as HTMLElement).focus());
    await user.keyboard("/");
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("");
    act(() => search.blur());
    await user.keyboard("{Control>}k{/Control}");
    expect(document.activeElement).toBe(search);
    // Inside the composer, / is a character.
    const composer = screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    await user.click(composer);
    await user.keyboard("/");
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("/");
    act(() => composer.blur());
    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("New memo")).toBeTruthy();
    // A dialog's keys are its own: / does not leave it for the search box.
    await user.keyboard("/");
    expect(sheet.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
  });

  it("puts the caret in the composer on N", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findAllByRole("article");
    act(() => (document.querySelector(".loc-trigger") as HTMLElement).focus());
    await user.keyboard("n");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Memo content" }));
    expect((document.activeElement as HTMLTextAreaElement).value).toBe("");
  });

  it("unfolds the composer a search folded away before the caret goes in, and lets it fold once left", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByRole("combobox", { name: "Search memos" }), "fruit");
    const location = document.querySelector(".loc-trigger") as HTMLElement;
    act(() => location.focus());
    const composer = document.querySelector(".composer") as HTMLElement;
    expect(composer.hasAttribute("data-searching")).toBe(true);
    expect(composer.hasAttribute("data-summoned")).toBe(false);
    await user.keyboard("n");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Memo content" }));
    expect(composer.hasAttribute("data-summoned")).toBe(true);
    act(() => location.focus());
    expect(composer.hasAttribute("data-summoned")).toBe(false);
  });

  it("runs the newest toast's Undo on ⌘Z, and nothing else", async () => {
    localStorage.setItem(
      "memo-saved-filters",
      JSON.stringify([{ id: "s1", name: "First", query: "fruit", tag: null, day: null, filters: { noTags: false, hasImage: false, hasLink: false, hasOpenTask: false, dateFrom: null, dateTo: null } }])
    );
    renderApp();
    await screen.findAllByRole("article");
    fireEvent.click(screen.getByRole("button", { name: "Filter memos" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete saved filter “First”" }));
    await screen.findByRole("button", { name: "Undo" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".action-menu")).toBeNull());
    await waitFor(() => expect(JSON.parse(localStorage.getItem("memo-saved-filters") ?? "[]")).toHaveLength(0));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("memo-saved-filters") ?? "[]")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
  });
});

describe("clearing the lenses", () => {
  it("offers one Clear for two or more chips, keeping the tag and the search", async () => {
    const user = userEvent.setup();
    renderApp();
    const cards = await screen.findAllByRole("article");
    const journalCard = cards.find((card) => card.textContent?.includes("Window seat"));
    if (!journalCard) throw new Error("journal memo missing");
    await user.click(within(journalCard).getByRole("button", { name: "#journal" }));
    await user.type(screen.getByRole("combobox", { name: "Search in #journal" }), "seat");
    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await user.click(await screen.findByRole("button", { name: "With images" }));
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "With links" }));
    const clear = await screen.findByRole("button", { name: "Clear all filters" });
    expect(clear.textContent).toBe("Clear");
    await user.click(clear);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear “With images” filter" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
    const search = screen.getByRole("combobox", { name: "Search in #journal" }) as HTMLInputElement;
    expect(search.value).toBe("seat");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  });
});
