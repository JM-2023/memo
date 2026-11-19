// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { BulkTagDialog } from "../src/components/BulkTagDialog";
import { MemoCard } from "../src/components/MemoCard";
import { ScrollTopButton } from "../src/components/ScrollTopButton";
import { ShortcutsSheet } from "../src/components/ShortcutsSheet";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { layerCount } from "../src/lib/layerStack";
import { isLayerState } from "../src/lib/navHistory";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  trashMemo: vi.fn(),
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

function stubMatchMedia(matching: (query: string) => boolean) {
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

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-scroll-top-shown");
  window.history.pushState(null, "");
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 0, syncEpoch: "epoch-a", serverTime: now.toISOString() });
  mocks.trashMemo.mockResolvedValue({ memo: memo("a", "alpha note #alpha", { deletedAt: now.toISOString() }), cursor: 3 });
  serve([memo("a", "alpha note #alpha"), memo("b", "beta note #beta")]);
  stubMatchMedia((query) => query.includes("prefers-reduced-motion"));
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
  document.documentElement.removeAttribute("data-scroll-top-shown");
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unified layer stack (useLayer) and Back navigation", () => {
  it("keeps Back inside MEMO at root over a dialog (ShortcutsSheet) right after launch", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const rootState = window.history.state;
    expect(isLayerState(rootState)).toBe(false);

    await user.keyboard("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));

    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
    // Landed squarely back on the root entry (never stepped off it / left MEMO).
    expect(window.history.state).toEqual(rootState);
    expect(isLayerState(window.history.state)).toBe(false);
    expect(screen.getByText(/alpha note/)).toBeTruthy();
    expect(screen.getByText(/beta note/)).toBeTruthy();
  });

  it("keeps Back inside MEMO at root over a dirty BulkTagDialog and preserves the layer entry until Cancel", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const rootState = window.history.state;

    const card = screen.getByText(/alpha note/).closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Add tag" }));
    const dialog = await screen.findByRole("dialog", { name: "Add tag to this memo" });
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));

    // Type a draft: Back must resist, stay on the layer entry, and never leave MEMO.
    const input = within(dialog).getByRole("textbox", { name: "Tag" });
    await user.type(input, "work");
    act(() => window.history.back());
    await sleep(30);
    expect(screen.getByRole("dialog", { name: "Add tag to this memo" })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("work");
    expect(isLayerState(window.history.state)).toBe(true);

    // A second Back still resists and never leaves the root entry.
    act(() => window.history.back());
    await sleep(30);
    expect(screen.getByRole("dialog", { name: "Add tag to this memo" })).toBeTruthy();
    expect(isLayerState(window.history.state)).toBe(true);

    // Explicit Cancel closes the dialog and steps off the layer entry cleanly.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add tag to this memo" })).toBeNull());
    await waitFor(() => expect(window.history.state).toEqual(rootState));
  });

  it("closes an open menu on Back without switching the lens behind it", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());
    const tagState = window.history.state;

    await user.click(screen.getByRole("button", { name: /^alpha/, expanded: false }));
    await screen.findByRole("menu");
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));

    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(window.history.state).toEqual(tagState);
    // Still in #alpha; Back did not navigate to All memos behind the menu.
    expect(screen.queryByText(/beta note/)).toBeNull();
    expect(screen.getByText(/alpha note/)).toBeTruthy();
  });

  it("closes the filter panel on Back while preserving facets toggled inside it", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);

    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    await screen.findByRole("dialog", { name: "Search filters" });
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));

    // Toggle a facet while the panel stays open: the filter panel keeps its
    // own Back step above the new facet lens.
    await user.click(screen.getByRole("button", { name: /With images/ }));
    await screen.findByText("No memos with images");
    expect(screen.getByRole("dialog", { name: "Search filters" })).toBeTruthy();
    expect(isLayerState(window.history.state)).toBe(true);

    // Back #1 closes only the filter panel; the facet remains active.
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search filters" })).toBeNull());
    expect(screen.getByText("No memos with images")).toBeTruthy();
    expect(isLayerState(window.history.state)).toBe(false);

    // Back #2 clears the facet and returns to All memos.
    act(() => window.history.back());
    await screen.findByText(/beta note/);
  });

  it("closes only the topmost stacked layer on Back (menu over mobile drawer)", async () => {
    stubMatchMedia((query) => query.includes("prefers-reduced-motion") || query.includes("max-width: 900px"));
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const rootState = window.history.state;

    await user.click(screen.getByRole("button", { name: "Open sidebar" }));
    const sidebar = document.getElementById("app-sidebar")!;
    await waitFor(() => expect(sidebar.classList.contains("is-open")).toBe(true));
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));

    // Open a tag's ⋯ menu on top of the drawer.
    await user.click(within(sidebar).getByRole("button", { name: "Actions for tag alpha" }));
    await screen.findByRole("menu");

    // Back #1 closes ONLY the menu, leaving the drawer open and the layer entry intact.
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(sidebar.classList.contains("is-open")).toBe(true);
    expect(isLayerState(window.history.state)).toBe(true);

    // Back #2 closes the drawer and returns to the root entry.
    act(() => window.history.back());
    await waitFor(() => expect(sidebar.classList.contains("is-open")).toBe(false));
    expect(window.history.state).toEqual(rootState);
  });

  it("steps back over a stale layer entry on Forward and blocks global/select shortcuts while a menu is up", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);
    const rootState = window.history.state;

    // Open and close a menu from the UI so a stale layer entry sits ahead in history.
    const trigger = screen.getByRole("button", { name: /All memos/, expanded: false });
    await user.click(trigger);
    await screen.findByRole("menu");
    await waitFor(() => expect(isLayerState(window.history.state)).toBe(true));

    // While the menu is on the layer stack, ? does not open ShortcutsSheet.
    expect(layerCount()).toBeGreaterThan(0);
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(window.history.state).toEqual(rootState));

    // Forward onto that stale layer entry steps right back over it.
    act(() => window.history.forward());
    await waitFor(() => expect(window.history.state).toEqual(rootState));
    expect(isLayerState(window.history.state)).toBe(false);
  });
});

describe("right-click context menu on long cards", () => {
  type CardProps = Parameters<typeof MemoCard>[0];
  function renderCardWithTopbar(overrides: Partial<CardProps> = {}) {
    const baseMemo = memo("long-1", "First line\nSecond line\nThird line");
    const props: CardProps = {
      memo: baseMemo,
      variant: "normal",
      knownTags: [],
      editing: false,
      savingEdit: false,
      editConflict: false,
      selecting: false,
      selected: false,
      onToggleSelect: vi.fn(),
      onStartEdit: vi.fn(),
      onCancelEdit: vi.fn(),
      onSaveEdit: vi.fn(async () => true),
      onAcceptEditConflict: vi.fn(),
      onTogglePin: vi.fn(),
      onAddTag: vi.fn(),
      onCopy: vi.fn(),
      onShare: vi.fn(),
      onDelete: vi.fn(),
      onRestore: vi.fn(),
      onPurge: vi.fn(),
      onPickTag: vi.fn(),
      onOpenImage: vi.fn(),
      onToggleTask: vi.fn(),
      ...overrides
    };
    return render(
      <Providers>
        <div className="main-column">
          <header className="topbar" />
          <MemoCard {...props} />
        </div>
      </Providers>
    );
  }

  it("portals at pointer coordinates clamped below the sticky topbar when ⋯ is scrolled off-screen", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 180 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 200 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("topbar")) return new DOMRect(0, 0, 1024, 72);
      // ⋯ is scrolled far above the viewport; the card spans -320..600.
      if (this.classList.contains("memo-menu-trigger") || this.classList.contains("menu-root")) return new DOMRect(700, -300, 26, 26);
      if (this.classList.contains("memo-card")) return new DOMRect(100, -320, 640, 920);
      return new DOMRect(120, 340, 500, 24);
    });

    const { container } = renderCardWithTopbar();
    const line = container.querySelector(".memo-content p")!;

    // Right-click mid-card at (320, 350): menu opens in a portal at (320, 350), not at -300.
    fireEvent.contextMenu(line, { clientX: 320, clientY: 350 });
    const menu = await screen.findByRole("menu");
    expect(menu.classList.contains("is-portal")).toBe(true);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.left).toBe("320px");
    expect(menu.style.top).toBe("350px");

    // Right-click near the sticky topbar (y=40 < 72): clamped below topbar (72 + 8 = 80px).
    fireEvent.contextMenu(line, { clientX: 320, clientY: 40 });
    await waitFor(() => expect(menu.style.top).toBe("80px"));

    // Right-click near bottom-right corner (980, 720): flips left & upward inside viewport.
    fireEvent.contextMenu(line, { clientX: 980, clientY: 720 });
    await waitFor(() => {
      expect(menu.style.left).toBe("800px");
      expect(menu.style.bottom).toBe("48px");
      expect(menu.style.top).toBe("auto");
    });
  });

  it("anchors keyboard Shift+F10 / ContextMenu (0,0) on a visible part of the card below the topbar", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 180 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 200 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("topbar")) return new DOMRect(0, 0, 1024, 72);
      // ⋯ is hidden behind the topbar (y = 20 < 72).
      if (this.classList.contains("memo-menu-trigger")) return new DOMRect(700, 20, 26, 26);
      if (this.classList.contains("memo-card")) return new DOMRect(100, -100, 640, 700);
      // Focused paragraph inside the visible slice of the card.
      if (this.tagName === "P") return new DOMRect(120, 220, 500, 24);
      return new DOMRect(0, 0, 0, 0);
    });

    const { container } = renderCardWithTopbar();
    const line = container.querySelector(".memo-content p")!;
    fireEvent.contextMenu(line, { clientX: 0, clientY: 0 });
    const menu = await screen.findByRole("menu");
    expect(menu.classList.contains("is-portal")).toBe(true);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(80);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);

    // Closing and clicking ⋯ directly returns to normal in-flow (non-portaled) menu.
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Memo actions/ }));
    const inFlow = await screen.findByRole("menu");
    expect(inFlow.classList.contains("is-portal")).toBe(false);
  });

  it("hands focus back to what held it at the open when ⋯ is out of sight, and to ⋯ when it can be seen", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    let triggerTop = -300;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("topbar")) return new DOMRect(0, 0, 1024, 72);
      if (this.classList.contains("memo-menu-trigger")) return new DOMRect(700, triggerTop, 26, 26);
      if (this.classList.contains("memo-card")) return new DOMRect(100, -320, 640, 920);
      return new DOMRect(120, 340, 500, 24);
    });
    const { container } = render(
      <Providers>
        <div className="main-column">
          <header className="topbar" />
          <button type="button">Elsewhere</button>
          <MemoCard
            memo={memo("long-2", "First line\nSecond line")}
            variant="normal"
            knownTags={[]}
            editing={false}
            savingEdit={false}
            editConflict={false}
            selecting={false}
            selected={false}
            onToggleSelect={vi.fn()}
            onStartEdit={vi.fn()}
            onCancelEdit={vi.fn()}
            onSaveEdit={vi.fn(async () => true)}
            onAcceptEditConflict={vi.fn()}
            onTogglePin={vi.fn()}
            onAddTag={vi.fn()}
            onCopy={vi.fn()}
            onShare={vi.fn()}
            onDelete={vi.fn()}
            onRestore={vi.fn()}
            onPurge={vi.fn()}
            onPickTag={vi.fn()}
            onOpenImage={vi.fn()}
            onToggleTask={vi.fn()}
          />
        </div>
      </Providers>
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    const trigger = screen.getByRole("button", { name: /^Memo actions/ });
    const line = container.querySelector(".memo-content p")!;

    // ⋯ scrolled off above: Esc leaves focus where it was before the right-click.
    elsewhere.focus();
    fireEvent.contextMenu(line, { clientX: 320, clientY: 350 });
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(elsewhere);

    // ⋯ in sight: it takes focus back as before.
    triggerTop = 300;
    elsewhere.focus();
    fireEvent.contextMenu(line, { clientX: 320, clientY: 350 });
    const again = await screen.findByRole("menu");
    await waitFor(() => expect(again.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe("toast clearance above/below Back to top and phone bottom-sheet motion", () => {
  it("marks documentElement with data-scroll-top-shown when ScrollTopButton is visible and clears it at top/unmount", () => {
    const composer = document.createElement("div");
    composer.className = "composer";
    document.body.appendChild(composer);
    let composerBottom = 200;
    vi.spyOn(composer, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, composerBottom - 100, 600, 100));

    const view = render(
      <Providers>
        <ScrollTopButton />
      </Providers>
    );
    expect(document.documentElement.hasAttribute("data-scroll-top-shown")).toBe(false);

    // Scroll down past the composer: button shows and root attribute turns on.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 500 });
    composerBottom = -40;
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(view.container.querySelector(".scroll-top-slot")?.classList.contains("is-shown")).toBe(true);
    expect(document.documentElement.hasAttribute("data-scroll-top-shown")).toBe(true);

    // Scroll back to top: attribute clears.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    composerBottom = 200;
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(document.documentElement.hasAttribute("data-scroll-top-shown")).toBe(false);

    // Scroll down again then unmount: cleanup clears attribute.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 500 });
    composerBottom = -40;
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(document.documentElement.hasAttribute("data-scroll-top-shown")).toBe(true);
    view.unmount();
    expect(document.documentElement.hasAttribute("data-scroll-top-shown")).toBe(false);
    composer.remove();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("glides (or dissolves under reduced motion) phone toasts between bottom and top edges without remounting or switching animation-name", async () => {
    stubMatchMedia((query) => query.includes("max-width: 560px"));
    const played: Array<{ target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        played.push({ target: this, keyframes, options });
        return { cancel: vi.fn() } as unknown as Animation;
      })
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("toast-stack")) {
        return (this as HTMLElement).dataset.edge === "top" ? new DOMRect(16, 16, 340, 44) : new DOMRect(16, 720, 340, 44);
      }
      return new DOMRect(0, 0, 20, 20);
    });

    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);

    // Raise a toast (trash a memo).
    const card = screen.getByText(/alpha note/).closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    const toast = (await screen.findByRole("button", { name: "Undo" })).closest(".toast")!;
    const stack = toast.closest<HTMLElement>(".toast-stack")!;
    expect(stack.dataset.edge).toBe("bottom");

    // Open a bottom-sheet dialog (?): stack flips to top and glides via WAAPI translate
    // without replacing the toast element.
    played.length = 0;
    await user.keyboard("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(stack.dataset.edge).toBe("top");
    expect(toast.isConnected).toBe(true);
    const toTop = played.find((entry) => entry.target === stack);
    expect(toTop?.keyframes).toEqual([{ translate: "0 704px" }, { translate: "0 0px" }]);

    // Close the dialog: stack glides back down to bottom.
    played.length = 0;
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
    expect(stack.dataset.edge).toBe("bottom");
    expect(toast.isConnected).toBe(true);
    const toBottom = played.find((entry) => entry.target === stack);
    expect(toBottom?.keyframes).toEqual([{ translate: "0 -704px" }, { translate: "0 0px" }]);
  });

  it("dissolves phone toast edge flips under prefers-reduced-motion and never switches toast animation-name in CSS", async () => {
    stubMatchMedia((query) => query.includes("max-width: 560px") || query.includes("prefers-reduced-motion"));
    const played: Array<{ target: Element; keyframes: Keyframe[] }> = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
        played.push({ target: this, keyframes });
        return { cancel: vi.fn() } as unknown as Animation;
      })
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("toast-stack")) {
        return (this as HTMLElement).dataset.edge === "top" ? new DOMRect(16, 16, 340, 44) : new DOMRect(16, 720, 340, 44);
      }
      return new DOMRect(0, 0, 20, 20);
    });

    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);

    const card = screen.getByText(/alpha note/).closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    const stack = (await screen.findByRole("button", { name: "Undo" })).closest<HTMLElement>(".toast-stack")!;
    played.length = 0;

    await user.keyboard("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(stack.dataset.edge).toBe("top");
    const dissolve = played.find((entry) => entry.target === stack);
    expect(dissolve?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);

    // Verify CSS invariants directly: wide-screen clearance for ScrollTopButton
    // and single toast-in/toast-out animation names (no toast-in-up switch).
    const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
    expect(css).toContain(":root[data-scroll-top-shown] .toast-stack");
    expect(css).toContain("--toast-top-clearance: 54px");
    expect(css).not.toContain("animation-name: toast-in-up");
    expect(css).not.toContain("animation-name: toast-out-down");
    expect(css).toContain(".toast-stack[data-edge=\"top\"]");
  });

  it("keeps phone toast at the bottom edge when Lightbox opens", async () => {
    stubMatchMedia((query) => query.includes("max-width: 560px") || query.includes("prefers-reduced-motion"));
    serve([
      memo("a", "alpha note #alpha"),
      memo("b", "beta note #beta", { images: [{ id: "img-b", mime: "image/webp", width: 10, height: 10, bytes: 1 }] })
    ]);
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/beta note/);

    const card = screen.getByText(/alpha note/).closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    const stack = (await screen.findByRole("button", { name: "Undo" })).closest<HTMLElement>(".toast-stack")!;
    expect(stack.dataset.edge).toBe("bottom");

    await user.click(screen.getByRole("button", { name: /^View image/ }));
    await screen.findByRole("dialog", { name: "View image" });
    expect(stack.dataset.edge).toBe("bottom");
  });
});

describe("BulkTagDialog dirty-input dismiss guard", () => {
  function pointer(target: EventTarget, type: string, y: number, t: number) {
    const Constructor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
    const event = new Constructor(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y });
    const fields: Record<string, unknown> = { pointerId: 9, pointerType: "touch", isPrimary: true, timeStamp: t };
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { configurable: true, value });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  it("resists backdrop click, sheet pull-down, and Back once input is typed, while Esc and Cancel still close", async () => {
    stubMatchMedia((query) => query.includes("max-width: 560px"));
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    const onDismiss = vi.fn();

    const view = render(
      <LanguageProvider>
        <BulkTagDialog selectedCount={2} knownTags={["work", "life"]} onApply={vi.fn()} onDismiss={onDismiss} onApplied={vi.fn()} closeSignal={0} />
      </LanguageProvider>
    );
    const overlay = screen.getByRole("dialog", { name: "Add tag to selected memos" });
    const input = screen.getByRole("textbox", { name: "Tag" }) as HTMLInputElement;

    // Type input: backdrop click boops instead of dismissing.
    fireEvent.change(input, { target: { value: "project/alpha" } });
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(input.value).toBe("project/alpha");
    expect(animate).toHaveBeenCalledWith([{ scale: "1" }, { scale: "1.012" }, { scale: "1" }], expect.objectContaining({ duration: 220 }));

    // Sheet pull-down on mobile rubber-bands and does not dismiss.
    const heading = screen.getByRole("heading", { name: "Add a tag" });
    pointer(heading, "pointerdown", 100, 1000);
    pointer(window, "pointermove", 360, 1060);
    pointer(window, "pointerup", 360, 1080);
    expect(overlay.className).not.toContain("is-closing");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(input.value).toBe("project/alpha");

    // Back (closeSignal) boops and keeps the draft.
    view.rerender(
      <LanguageProvider>
        <BulkTagDialog selectedCount={2} knownTags={["work", "life"]} onApply={vi.fn()} onDismiss={onDismiss} onApplied={vi.fn()} closeSignal={1} />
      </LanguageProvider>
    );
    expect(onDismiss).not.toHaveBeenCalled();
    expect(input.value).toBe("project/alpha");

    // Esc still closes explicitly.
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it("allows backdrop click to dismiss when empty or cleared back to empty", async () => {
    const onDismiss = vi.fn();
    render(
      <LanguageProvider>
        <BulkTagDialog selectedCount={2} knownTags={["work"]} onApply={vi.fn()} onDismiss={onDismiss} onApplied={vi.fn()} />
      </LanguageProvider>
    );
    const overlay = screen.getByRole("dialog", { name: "Add tag to selected memos" });
    const input = screen.getByRole("textbox", { name: "Tag" });

    fireEvent.change(input, { target: { value: "work" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });
});

describe("ShortcutsSheet missing entries (F6, select-mode ⌘A/Delete, Shift+F10)", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
  const originalUserAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");

  function setPlatform(platform: string, userAgent: string) {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  }

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(Navigator.prototype, "platform", originalPlatform);
    if (originalUserAgent) Object.defineProperty(Navigator.prototype, "userAgent", originalUserAgent);
  });

  function rowKeys(label: string): string[] {
    const dt = screen.getByText(label);
    const dd = dt.parentElement!.querySelector("dd")!;
    return [...dd.querySelectorAll("kbd")].map((node) => node.textContent ?? "");
  }

  it("shows F6, Shift+F10, and select mode Ctrl+A / Delete on non-Apple platforms", () => {
    setPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0)");
    render(
      <LanguageProvider>
        <ShortcutsSheet onClose={vi.fn()} />
      </LanguageProvider>
    );
    expect(screen.getByRole("heading", { name: "In select mode" })).toBeTruthy();
    expect(rowKeys("Jump to notification action")).toEqual(["F6"]);
    expect(rowKeys("Open menu")).toEqual(["Shift", "F10"]);
    expect(rowKeys("Select all")).toEqual(["Ctrl", "A"]);
    expect(rowKeys("Delete selected")).toEqual(["Delete"]);
    expect(rowKeys("Strikethrough")).toEqual(["Ctrl", "Shift", "S"]);
  });

  it("renders Apple modifier glyphs (⌘, ⇧, ⌫) on macOS", () => {
    setPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    render(
      <LanguageProvider>
        <ShortcutsSheet onClose={vi.fn()} />
      </LanguageProvider>
    );
    expect(rowKeys("Jump to notification action")).toEqual(["F6"]);
    expect(rowKeys("Open menu")).toEqual(["⇧", "F10"]);
    expect(rowKeys("Select all")).toEqual(["⌘", "A"]);
    expect(rowKeys("Delete selected")).toEqual(["⌫"]);
    expect(rowKeys("Strikethrough")).toEqual(["⌘", "⇧", "S"]);
  });

  it("renders natural Chinese descriptions for all new shortcuts", () => {
    localStorage.setItem("memo:language", "zh-CN");
    setPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    render(
      <LanguageProvider>
        <ShortcutsSheet onClose={vi.fn()} />
      </LanguageProvider>
    );
    expect(screen.getByRole("heading", { name: "选择模式中" })).toBeTruthy();
    expect(rowKeys("跳到通知操作")).toEqual(["F6"]);
    expect(rowKeys("打开菜单")).toEqual(["⇧", "F10"]);
    expect(rowKeys("全选")).toEqual(["⌘", "A"]);
    expect(rowKeys("删除所选")).toEqual(["⌫"]);
  });
});
