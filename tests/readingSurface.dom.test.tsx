// @vitest-environment jsdom

// The reading surface inside the app: a cold load that is honest about
// what has not arrived yet, an empty search's way out, and keyboard focus
// that stays at the reader's place when a pin carries a card away.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { ApiError, type BootstrapResponse } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  updateMemo: vi.fn(),
  // Where the feed's motion layer says a named card went, by `${intent}:${id}`.
  departures: new Map<string, "removed" | "up" | "down">(),
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
  return { ...actual, getAuthStatus: mocks.getAuthStatus, bootstrap: mocks.bootstrap, syncSince: mocks.syncSince, updateMemo: mocks.updateMemo };
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

// jsdom lays nothing out, so the motion layer could never see a card leave
// the screen: it commits the change and reports what the test scripted.
vi.mock("../src/lib/feedMotion", () => ({
  createFeedMotion: () => ({
    run(intent: string, ids: Iterable<string>, commit: () => void) {
      commit();
      const departed = new Map<string, string>();
      for (const id of ids) {
        const where = mocks.departures.get(`${intent}:${id}`);
        if (where) departed.set(id, where);
      }
      return { departed };
    },
    settle() {},
    observe() {},
    claim() {},
    attach: () => () => undefined
  })
}));

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function memo(index: number, overrides: Partial<Memo> = {}): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `memo-${index}`,
    content: `memo-${index} body`,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    deletedAt: null,
    seq: index + 1,
    images: [],
    ...overrides
  };
}

function page(memos: Memo[], overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    memos,
    tags: [],
    cursor: 10,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
    hasMore: false,
    nextAfter: null,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderApp() {
  return render(
    <Providers>
      <App />
    </Providers>
  );
}

const feed = () => document.querySelector<HTMLElement>(".memo-feed")!;
const feedEnd = () => document.querySelector<HTMLElement>(".feed-end");
const empty = () => document.querySelector<HTMLElement>(".feed-empty");
const triggerOf = (text: string) => screen.getByText(text).closest("article")!.querySelector<HTMLElement>(".memo-menu-trigger")!;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "");
  mocks.departures.clear();
  mocks.updateMemo.mockReset();
  mocks.bootstrap.mockReset();
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 10, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z" });
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
  vi.restoreAllMocks();
});

describe("a cold load still in progress", () => {
  function startLoading(firstPage: Memo[], total = 3) {
    const rest = deferred<BootstrapResponse>();
    mocks.bootstrap.mockResolvedValueOnce(page(firstPage, { hasMore: true, nextAfter: "cursor-1", total })).mockReturnValueOnce(rest.promise);
    renderApp();
    return rest;
  }

  it("marks the list busy and says at its foot that older memos are still coming", async () => {
    const rest = startLoading([memo(3)]);
    await screen.findByText("memo-3 body");
    expect(feed().getAttribute("aria-busy")).toBe("true");
    expect(feedEnd()?.textContent).toContain("Loading older memos · 1 of 3");

    await act(async () => rest.resolve(page([memo(2), memo(1)])));
    await screen.findByText("memo-1 body");
    expect(feed().hasAttribute("aria-busy")).toBe(false);
    expect(feedEnd()).toBeNull();
  });

  it("does not call Trash empty before every page is in", async () => {
    const rest = startLoading([memo(3)]);
    await screen.findByText("memo-3 body");
    fireEvent.click(screen.getByRole("button", { name: /^Trash/ }));
    await waitFor(() => expect(empty()?.textContent).toContain("Still loading your memos…"));
    expect(empty()?.textContent).toContain("1 of 3 loaded so far, and none are in Trash yet.");
    expect(screen.queryByText("Trash is empty")).toBeNull();
    expect(within(empty()!).queryByRole("button")).toBeNull();

    await act(async () => rest.resolve(page([memo(2), memo(1)])));
    expect(await screen.findByText("Trash is empty")).toBeTruthy();
  });

  it("offers no way out of an empty search that more pages may yet fill", async () => {
    const user = userEvent.setup();
    const rest = startLoading([memo(3)]);
    await screen.findByText("memo-3 body");
    await user.type(screen.getByRole("combobox", { name: "Search memos" }), "zebra");
    await waitFor(() => expect(empty()?.textContent).toContain("Still loading your memos…"));
    expect(empty()?.textContent).toContain("1 of 3 loaded so far, and none match yet.");
    expect(within(empty()!).queryByRole("button")).toBeNull();

    await act(async () => rest.resolve(page([memo(2), memo(1)])));
    await waitFor(() => expect(empty()?.textContent).toContain("No matching memos"));
    expect(within(empty()!).getByRole("button", { name: "Clear search" })).toBeTruthy();
  });

  it("says at the foot when the rest keeps failing, leaving the Retry to the notice", async () => {
    mocks.bootstrap
      .mockResolvedValueOnce(page([memo(3)], { hasMore: true, nextAfter: "cursor-1", total: 3 }))
      .mockRejectedValueOnce(new ApiError("REQUEST_FAILED", 500, "boom"))
      .mockRejectedValueOnce(new ApiError("REQUEST_FAILED", 500, "boom"))
      .mockReturnValueOnce(new Promise(() => {}));
    renderApp();
    await screen.findByText("memo-3 body");
    await waitFor(() => expect(feedEnd()?.textContent).toContain("Couldn’t load the rest of your memos · 1 of 3 loaded"), { timeout: 3_000 });
    expect(within(feedEnd()!).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });
});

describe("an empty search", () => {
  it("clears itself from the empty list, as the search box's × does", async () => {
    const user = userEvent.setup();
    mocks.bootstrap.mockResolvedValue(page([memo(1), memo(0)]));
    renderApp();
    await screen.findByText("memo-1 body");
    const search = screen.getByRole("combobox", { name: "Search memos" }) as HTMLInputElement;
    await user.type(search, "zebra");
    const clear = await within(await waitFor(() => empty()!)).findByRole("button", { name: "Clear search" });

    await user.click(clear);
    await waitFor(() => expect(search.value).toBe(""));
    expect(await screen.findByText("memo-1 body")).toBeTruthy();
    expect(empty()).toBeNull();
    // The button went with the empty list; focus did not fall to <body>.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});

describe("pin and unpin", () => {
  function boot() {
    // Newest first: memo-2, memo-1, memo-0.
    mocks.bootstrap.mockResolvedValue(page([memo(2), memo(1), memo(0)]));
    renderApp();
  }

  async function pinFromMenu(user: ReturnType<typeof userEvent.setup>, text: string) {
    const trigger = triggerOf(text);
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));
  }

  it("keeps focus at the reader's place when the pin lifts the card off screen, and says where it went", async () => {
    const user = userEvent.setup();
    boot();
    await screen.findByText("memo-1 body");
    const request = deferred<{ memoPatch: { id: string; pinnedAt: string; seq: number } }>();
    mocks.updateMemo.mockReturnValueOnce(request.promise);
    mocks.departures.set("pin:memo-1", "up");
    const successor = triggerOf("memo-0 body");

    await pinFromMenu(user, "memo-1 body");
    // The card that took the pinned one's place has focus, so the next Tab
    // does not scroll the reader away to the top.
    await waitFor(() => expect(document.activeElement).toBe(successor));

    await act(async () => request.resolve({ memoPatch: { id: "memo-1", pinnedAt: "2026-01-01T01:00:00.000Z", seq: 9 } }));
    expect(await screen.findByText("Pinned — the memo moved to the top")).toBeTruthy();
    expect(document.activeElement).toBe(successor);
  });

  it("leaves focus on a card the pin keeps on screen, with the plain toast", async () => {
    const user = userEvent.setup();
    boot();
    await screen.findByText("memo-1 body");
    mocks.updateMemo.mockResolvedValueOnce({ memoPatch: { id: "memo-1", pinnedAt: "2026-01-01T01:00:00.000Z", seq: 9 } });
    const own = triggerOf("memo-1 body");

    await pinFromMenu(user, "memo-1 body");
    expect(await screen.findByText("Pinned")).toBeTruthy();
    expect(screen.queryByText(/moved to the top/)).toBeNull();
    expect(document.activeElement).toBe(own);
  });

  it("hands focus on when a failed pin carries the card back off screen", async () => {
    const user = userEvent.setup();
    boot();
    await screen.findByText("memo-1 body");
    const request = deferred<never>();
    mocks.updateMemo.mockReturnValueOnce(request.promise);
    const own = triggerOf("memo-1 body");

    await pinFromMenu(user, "memo-1 body");
    // Pinned in view: focus stays with the card, now at the top.
    expect(document.activeElement).toBe(own);
    // The revert sinks it back down past the screen's edge.
    mocks.departures.set("unpin:memo-1", "down");
    await act(async () => request.reject(new ApiError("NETWORK", 503, "offline")));
    await waitFor(() => expect(document.activeElement).toBe(triggerOf("memo-2 body")));
  });
});
