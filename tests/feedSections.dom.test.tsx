// @vitest-environment jsdom

// The feed's sections: the pinned run's overline and the beat after it, the
// list's foot once it has all arrived (and its way back to the first day),
// and a tag chip's count on hover.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  updateMemo: vi.fn(),
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
    updateMemo: mocks.updateMemo
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

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function memo(index: number, content: string, extra: Partial<Memo> = {}): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return { id: `memo-${index}`, content, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq: index + 1, images: [], ...extra };
}

// Newest first, the pinned one ahead of them all.
const NOTEBOOK = [
  memo(0, "oldest #journal"),
  memo(1, "second #journal"),
  memo(2, "pinned note", { pinnedAt: "2026-01-02T00:00:00.000Z" }),
  memo(3, "newest #life/cooking")
];

function boot(memos: Memo[]) {
  mocks.bootstrap.mockResolvedValue({
    memos,
    tags: [],
    cursor: memos.length,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
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

const slots = () => Array.from(document.querySelectorAll<HTMLElement>(".memo-feed > .memo-slot"));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "");
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  boot(NOTEBOOK);
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
  vi.restoreAllMocks();
});

describe("the pinned run", () => {
  it("opens under a real heading row counting it before its first slot, and ends a beat before the rest", async () => {
    renderApp();
    await screen.findByText("pinned note");
    const [first, second] = slots();
    expect(within(first).getByText("pinned note")).toBeTruthy();
    const lead = screen.getByRole("heading", { level: 2, name: "Pinned · 1" });
    expect(lead.classList.contains("feed-lead")).toBe(true);
    expect(lead.classList.contains("is-pinned")).toBe(true);
    // Its own feed row before the first pinned card, not inside the card's slot.
    expect(lead.closest(".memo-slot")).toBeNull();
    expect(lead.parentElement?.classList.contains("memo-feed")).toBe(true);
    expect(lead.nextElementSibling).toBe(first);
    expect(first.hasAttribute("data-pin-end")).toBe(true);
    expect(second.hasAttribute("data-pin-end")).toBe(false);
    // The rest of the list is a named group too, its own row before its
    // first card, so the beat between them reads as two groups.
    const rest = screen.getByRole("heading", { level: 2, name: `Others · ${slots().length - 1}` });
    expect(rest.classList.contains("is-rest")).toBe(true);
    expect(rest.previousElementSibling).toBe(first);
    expect(rest.nextElementSibling).toBe(second);
  });

  it("keeps the same heading row and rolls its count when another card is pinned from mid-feed", async () => {
    const user = userEvent.setup();
    mocks.updateMemo.mockResolvedValue({
      memoPatch: { id: "memo-1", pinnedAt: "2026-01-03T00:00:00.000Z", seq: 10 }
    });
    renderApp();
    await screen.findByText("pinned note");
    const lead = screen.getByRole("heading", { level: 2, name: "Pinned · 1" });

    // Pin a card from the middle of the list.
    const card = screen.getByText("second").closest("article")!;
    await user.click(card.querySelector<HTMLElement>(".memo-menu-trigger")!);
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));

    const updated = await screen.findByRole("heading", { level: 2, name: "Pinned · 2" });
    // Same DOM heading element: it stays put while cards glide underneath.
    expect(updated).toBe(lead);
    // Its figure rolled via RollingText (1 out, 2 in).
    expect(lead.querySelector(".roll-char-out")?.textContent).toBe("1");
    expect(lead.querySelector(".roll-char-in")?.textContent).toBe("2");
  });

  it("has no line where every memo is pinned, nor where none is", async () => {
    boot([memo(0, "only one", { pinnedAt: "2026-01-02T00:00:00.000Z" })]);
    renderApp();
    await screen.findByText("only one");
    expect(document.querySelector(".feed-lead")).toBeNull();
    cleanup();
    boot([memo(0, "plain")]);
    renderApp();
    await screen.findByText("plain");
    expect(document.querySelector(".feed-lead")).toBeNull();
    expect(document.querySelector("[data-pin-end]")).toBeNull();
  });
});

describe("the list's foot", () => {
  it("counts the notebook once it has all arrived, and goes back to its first day", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("oldest");
    const since = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(NOTEBOOK[0].createdAt));
    const foot = document.querySelector<HTMLElement>(".feed-foot");
    if (!foot) throw new Error("No foot under the list");
    // After the list, not in it: only slots ride the feed's motion.
    expect(foot.closest(".memo-feed")).toBeNull();
    expect(foot.textContent).toBe(`4 memos · since ${since}`);
    await user.click(within(foot).getByRole("button", { name: new RegExp(`^${since}`) }));
    // That day's list is a lens: its count is the chip's to say, not the foot's.
    await waitFor(() => expect(document.querySelector(".feed-foot")).toBeNull());
    expect(screen.getByText("oldest")).toBeTruthy();
  });

  it("counts a tag's own list", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click((await screen.findAllByRole("button", { name: "#journal" }))[0]);
    await waitFor(() => expect(document.querySelector(".feed-foot")?.textContent).toBe("All 2 in #journal"));
  });

  it("says a tag's lone memo plainly in Chinese", async () => {
    localStorage.setItem("memo:language", "zh-CN");
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "#life/cooking" }));
    await waitFor(() => expect(document.querySelector(".feed-foot")?.textContent).toBe("#life/cooking 下只有这 1 条"));
  });
});

describe("tag chips", () => {
  it("say how many memos carry the tag on hover, its subtree's included", async () => {
    boot([...NOTEBOOK, memo(4, "a nested one #journal/travel")]);
    renderApp();
    const chip = (await screen.findAllByRole("button", { name: "#journal" }))[0];
    fireEvent.pointerOver(chip, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector(".tip.is-show")?.textContent).toBe("3 memos"));
    fireEvent.pointerOut(chip, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector(".tip.is-show")).toBeNull());

    // A touch's tap is the pick: no tip for it.
    const nested = screen.getByRole("button", { name: "#journal/travel" });
    fireEvent.pointerOver(nested, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector(".tip.is-show")).toBeNull();
  });
});
