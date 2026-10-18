// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { LIVE_REGION_ATTR } from "../src/lib/liveAnnouncer";
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

function spoken(): string {
  return document.querySelector(`[${LIVE_REGION_ATTR}] [role="status"]`)?.textContent ?? "";
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
  // The feed's motion layer plays entrances through Web Animations, to the
  // cards it finds on screen.
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => ({ finished: new Promise(() => undefined), cancel: () => undefined }))
  });
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (!this.classList.contains("memo-slot")) return rect.call(this);
    return { top: 0, bottom: 100, left: 0, right: 600, width: 600, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
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
  delete (Element.prototype as Partial<Element>).animate;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("sending a memo", () => {
  it("lands the card in a morph around the feed's change, naming only the morph's parts", async () => {
    const seen: Array<{ composer: string; cards: number; marked: boolean; field: string; slots: string[] }> = [];
    const field = () => screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    const nameOf = (element: Element | null) => (element as HTMLElement | null)?.style.viewTransitionName ?? "";
    const snapshot = () => ({
      composer: field().value,
      cards: screen.queryAllByRole("article").length,
      marked: document.documentElement.dataset.vtCreate !== undefined,
      field: nameOf(document.querySelector(".composer .editor-field")),
      slots: Array.from(document.querySelectorAll(".memo-slot"), nameOf).filter(Boolean)
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
    const animate = vi.mocked(Element.prototype.animate);
    animate.mockClear();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    const [before, after] = seen.slice(-2);
    // Old capture: the draft still in the composer, carrying the new card's
    // name; the root marked, so the composer and the bar are captured too;
    // no card named.
    expect(before).toEqual({ composer: "Fresh thought", cards: 2, marked: true, field: "memo-memo-9", slots: [] });
    // New state, in the same update: card in and named — the morph's other
    // half — the composer empty.
    expect(after).toEqual({ composer: "", cards: 3, marked: true, field: "", slots: ["memo-memo-9"] });
    const landed = screen.getByText("Fresh thought").closest(".memo-slot");
    expect(landed).toBeTruthy();
    // The morph plays its arrival; the feed's motion layer does not.
    expect(animate.mock.contexts).not.toContain(landed);
    // The card says it to the eye; a screen reader hears it.
    expect(spoken()).toBe("Sent");
    await waitFor(() => expect(document.documentElement.dataset.vtCreate).toBeUndefined());
    expect(nameOf(landed)).toBe("");
  });

  it("starts no morph under reduced motion: the card fades in as the composer hands over", async () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList
    );
    const start = vi.fn();
    document.startViewTransition = start as unknown as typeof document.startViewTransition;
    mocks.createMemo.mockResolvedValue({ memo: memo(9, "Quiet thought") });
    const field = () => screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Quiet thought");
    const animate = vi.mocked(Element.prototype.animate);
    animate.mockClear();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.vtCreate).toBeUndefined();
    const played = (target: Element | null) => animate.mock.calls.filter((_call, index) => animate.mock.contexts[index] === target);
    const landed = Array.from(document.querySelectorAll(".memo-slot")).find((slot) => slot.textContent?.includes("Quiet thought")) ?? null;
    const [arrival] = played(landed);
    expect(arrival[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect((arrival[1] as KeyframeAnimationOptions).duration).toBeLessThanOrEqual(150);
    // The composer's typed look fades out over the emptied one fading in.
    const [composerIn] = played(document.querySelector(".composer:not([data-motion-ghost])"));
    expect(composerIn[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(document.querySelector("[data-motion-ghost] textarea")?.textContent).toBe("Quiet thought");
    expect(field().value).toBe("");
  });

  it("stops a send on Esc, keeps the draft and says so", async () => {
    let signal: AbortSignal | undefined;
    mocks.createMemo.mockImplementation(
      (_clientId: string, _content: string, _images: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("The send was stopped.", "AbortError")));
        })
    );
    const field = () => screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Second thoughts");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(await screen.findByText("Stopped sending the memo", { selector: ".toast-text" })).toBeTruthy();
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(field().value).toBe("Second thoughts");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    // A stop, not a failure: nothing in the composer's error line.
    expect(document.querySelector(".editor-note.is-open .editor-error")).toBeNull();
  });
});
