// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  return { ...actual, getAuthStatus: mocks.getAuthStatus, bootstrap: mocks.bootstrap, syncSince: mocks.syncSince, createMemo: mocks.createMemo };
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

function memo(index: number, content: string): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return { id: `memo-${index}`, content, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq: index + 1, images: [] };
}

function renderApp(): void {
  render(
    <LanguageProvider>
      <TipProvider>
        <App />
      </TipProvider>
    </LanguageProvider>
  );
}

const startViewTransition = document.startViewTransition;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "");
  const notebook = [memo(0, "First note"), memo(1, "Second note")];
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos: notebook,
    tags: [],
    cursor: notebook.length,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: notebook.length, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z" });
  // Motion allowed, so the create rides a view transition.
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
  document.startViewTransition = startViewTransition;
  delete document.documentElement.dataset.vtCreate;
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sending a memo", () => {
  it("lands the card and empties the composer in one view transition", async () => {
    const seen: Array<{ composer: string; cards: number; marked: boolean; slotClass: string | null }> = [];
    const field = () => screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    const snapshot = () => ({
      composer: field().value,
      cards: screen.queryAllByRole("article").length,
      marked: document.documentElement.dataset.vtCreate !== undefined,
      slotClass: document.querySelector(".memo-slot")?.className ?? null
    });
    document.startViewTransition = ((update: () => void) => {
      // The browser captures the old state, then runs the update.
      const ready = Promise.resolve().then(() => {
        seen.push(snapshot());
        update();
        seen.push(snapshot());
      });
      return { ready, finished: ready, updateCallbackDone: ready, skipTransition: () => undefined };
    }) as unknown as typeof document.startViewTransition;
    mocks.createMemo.mockResolvedValue({ memo: memo(9, "Fresh thought") });

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Fresh thought");
    seen.length = 0;
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    const [before, after] = seen.slice(-2);
    // Old capture: the draft still in the composer, no new card yet.
    expect(before).toMatchObject({ composer: "Fresh thought", cards: 2, marked: false });
    // New state, in the same update: card in, composer empty, the drop-in
    // entrance marked for the snapshot and the slot's own rise-in held back.
    expect(after).toMatchObject({ composer: "", cards: 3, marked: true });
    expect(after.slotClass).toContain("no-enter");
    expect(screen.getByText("Fresh thought")).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.vtCreate).toBeUndefined());
  });
});
