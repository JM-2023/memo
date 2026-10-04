// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { isLayerState } from "../src/lib/navHistory";
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

/** matchMedia whose answers can change, firing `change` like a rotation. */
function controllableMedia(initial: (query: string) => boolean) {
  let matching = initial;
  const lists: { query: string; listeners: Set<() => void>; list: { matches: boolean } }[] = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => {
      const listeners = new Set<() => void>();
      const list = {
        get matches() {
          return matching(query);
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
        dispatchEvent: vi.fn()
      };
      lists.push({ query, listeners, list });
      return list;
    })
  });
  return {
    set(next: (query: string) => boolean) {
      matching = next;
      for (const entry of lists) for (const listener of [...entry.listeners]) listener();
    }
  };
}

let media: ReturnType<typeof controllableMedia>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState(null, "");
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 0, syncEpoch: "epoch-a", serverTime: now.toISOString() });
  serve([memo("a", "alpha note #alpha"), memo("b", "beta note #beta")]);
  media = controllableMedia((query) => query.includes("prefers-reduced-motion") || query.includes("max-width: 900px"));
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

function sidebar() {
  return document.getElementById("app-sidebar")!;
}

async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open sidebar" }));
  await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(true));
  // The layer's own history entry lands from an effect.
  await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));
}

describe("drawer and viewport", () => {
  it("lets go of the drawer at once when the viewport widens past 900px", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    await openDrawer(user);
    const main = document.getElementById("main-content")!;
    expect(document.body.style.overflow).toBe("hidden");
    expect(main.closest("[inert]") ?? (main.inert ? main : null)).toBeTruthy();

    act(() => media.set((query) => query.includes("prefers-reduced-motion")));
    await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(false));
    expect(sidebar().classList.contains("is-closing")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(main.closest("[inert]")).toBeNull();
    expect(document.querySelector(".drawer-backdrop")).toBeNull();
  });
});

describe("Back closes the topmost layer", () => {
  it("closes the drawer and leaves the lens behind it alone", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());
    const inTag = window.history.length;

    await openDrawer(user);
    expect(window.history.length).toBe(inTag + 1);
    act(() => window.history.back());
    await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(false));
    // Still inside #alpha: Back did one thing.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(/beta note/)).toBeNull();
    expect(screen.getByText(/alpha note/)).toBeTruthy();
    expect(isLayerState(window.history.state)).toBe(false);
  });

  it("at the root, Back closes the drawer instead of leaving the app", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const start = window.history.state;
    await openDrawer(user);
    act(() => window.history.back());
    await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(false));
    expect(window.history.state).toEqual(start);
    expect(screen.getByText(/alpha note/)).toBeTruthy();
    expect(screen.getByText(/beta note/)).toBeTruthy();
  });

  it("steps off the drawer's entry when it closes from the UI", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const start = window.history.state;
    await openDrawer(user);
    fireEvent.click(document.querySelector(".drawer-backdrop")!);
    await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(false));
    await waitFor(() => expect(window.history.state).toEqual(start));
    // That step was the app's own: nothing else moved.
    expect(screen.getByText(/beta note/)).toBeTruthy();
  });

  it("gives a pick made in the drawer the drawer's entry: one Back returns", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const before = window.history.length;
    await openDrawer(user);
    await user.click(within(sidebar()).getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());
    await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(window.history.length).toBe(before + 1);
    expect(isLayerState(window.history.state)).toBe(false);

    act(() => window.history.back());
    await screen.findByText(/beta note/);
  });

  it("closes Statistics without moving the feed", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());

    await user.click(screen.getAllByRole("button", { name: /^2\s*Memos/ })[0]);
    await screen.findByRole("dialog", { name: /statistics/i });
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /statistics/i })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(/beta note/)).toBeNull();
  });

  it("closes the lightbox without moving the feed", async () => {
    const user = userEvent.setup();
    serve([
      memo("a", "alpha note #alpha", { images: [{ id: "img-a", mime: "image/webp", width: 10, height: 10, bytes: 1 }] }),
      memo("b", "beta note #beta")
    ]);
    renderApp();
    await screen.findByText(/beta note/);
    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());

    await user.click(screen.getByRole("button", { name: /^View image/ }));
    await screen.findByRole("dialog", { name: "View image" });
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "View image" })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(/beta note/)).toBeNull();
  });
});

describe("drawer swipe", () => {
  /** A touch pointer event at a chosen time (velocity reads timeStamp). */
  function pointer(target: Element, type: string, x: number, y: number, t: number) {
    const Constructor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
    const event = new Constructor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    const fields: Record<string, unknown> = { pointerId: 3, pointerType: "touch", isPrimary: true, timeStamp: t };
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { configurable: true, value });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  /** A swipe of four moves, 40ms apart: (to − from) / 160ms. */
  function swipe(target: Element, from: [number, number], to: [number, number]) {
    let t = 1000;
    pointer(target, "pointerdown", from[0], from[1], t);
    for (let step = 1; step <= 4; step += 1) {
      t += 40;
      pointer(target, "pointermove", from[0] + ((to[0] - from[0]) * step) / 4, from[1] + ((to[1] - from[1]) * step) / 4, t);
    }
    pointer(target, "pointerup", to[0], to[1], t);
  }

  it("closes on a leftward swipe and keeps a vertical one for scrolling", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    await openDrawer(user);
    vi.spyOn(sidebar(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 800));

    // Mostly down: the sidebar's scroll, not the drawer's.
    swipe(sidebar(), [150, 200], [130, 420]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sidebar().classList.contains("is-open")).toBe(true);

    // A short sideways nudge springs back.
    swipe(sidebar(), [200, 300], [150, 302]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sidebar().classList.contains("is-open")).toBe(true);

    // Past a third of the drawer: shut.
    swipe(sidebar(), [250, 300], [80, 310]);
    await waitFor(() => expect(sidebar().classList.contains("is-open")).toBe(false));
  });
});

describe("tab title", () => {
  it("names the lens without leaking tag paths into browser history", async () => {
    const user = userEvent.setup();
    serve([memo("a", "alpha note #work/projects"), memo("b", "beta note #beta"), memo("t", "gone", { deletedAt: now.toISOString() })]);
    renderApp();
    await screen.findByText(/beta note/);
    expect(document.title).toBe("MEMO");

    await user.click(screen.getByRole("button", { name: "Expand tag work" }));
    await user.click(screen.getByRole("button", { name: /^projects/ }));
    await waitFor(() => expect(document.title).toBe("Tag · MEMO"));
    expect(document.title).not.toContain("work");

    await user.click(screen.getByRole("button", { name: /^Trash/ }));
    await waitFor(() => expect(document.title).toBe("Trash · MEMO"));

    act(() => window.history.back());
    await waitFor(() => expect(document.title).toBe("Tag · MEMO"));
  });
});

describe("saved filters", () => {
  it("puts a deleted preset back where it stood on Undo", async () => {
    const user = userEvent.setup();
    const empty = { noTags: false, hasImage: false, hasLink: false, hasOpenTask: false, dateFrom: null, dateTo: null };
    localStorage.setItem(
      "memo-saved-filters",
      JSON.stringify([
        { id: "s1", name: "First", query: "alpha", tag: null, day: null, filters: empty },
        { id: "s2", name: "Second", query: "beta", tag: null, day: null, filters: empty },
        { id: "s3", name: "Third", query: "note", tag: null, day: null, filters: empty }
      ])
    );
    renderApp();
    await screen.findByText(/beta note/);
    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await user.click(screen.getByRole("button", { name: "Delete saved filter “Second”" }));
    await waitFor(() => expect([...document.querySelectorAll(".saved-name")].map((node) => node.textContent)).toEqual(["First", "Third"]));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    // The toast sits outside the panel, so pressing it closed the panel.
    if (!document.querySelector(".saved-name")) await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await waitFor(() => expect([...document.querySelectorAll(".saved-name")].map((node) => node.textContent)).toEqual(["First", "Second", "Third"]));
  });
});
