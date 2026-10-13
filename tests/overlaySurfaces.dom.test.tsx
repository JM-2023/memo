// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { BulkTagDialog } from "../src/components/BulkTagDialog";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Menu } from "../src/components/Menu";
import { PromptDialog } from "../src/components/PromptDialog";
import { TipProvider } from "../src/components/Tip";
import { MODAL_EXEMPT_ATTR } from "../src/hooks/useModalA11y";
import { afterExit, continueFrom } from "../src/hooks/useOverlayExit";
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

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

const now = new Date();

function memo(id: string, content: string): Memo {
  const timestamp = now.toISOString();
  return { id, content, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq: 1, images: [] };
}

let reducedMotion = true;
let sheet = false;

function stubMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: (reducedMotion && query.includes("prefers-reduced-motion")) || (sheet && query.includes("max-width: 560px")),
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

const sleep = (ms: number) => act(() => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
/** MutationObserver callbacks (the focus floor) run as microtasks. */
const flush = () => act(async () => undefined);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  reducedMotion = true;
  sheet = false;
  stubMatchMedia();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
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
  vi.clearAllMocks();
});

describe("toasts over an open dialog", () => {
  function Fixture({ onUndo, onCancel }: { onUndo: () => void; onCancel: () => void }) {
    return (
      <LanguageProvider>
        <div data-testid="page">
          <button type="button">Page button</button>
        </div>
        <div data-testid="stack" {...{ [MODAL_EXEMPT_ATTR]: "" }}>
          <button type="button" onClick={onUndo}>
            Undo
          </button>
        </div>
        <ConfirmDialog title="Remove?" body="Removes it" confirmLabel="Remove" onCancel={onCancel} onConfirm={vi.fn()} />
      </LanguageProvider>
    );
  }

  it("stay live: not inert, focusable, clickable, and their Escape is their own", () => {
    const onUndo = vi.fn();
    const onCancel = vi.fn();
    render(<Fixture onUndo={onUndo} onCancel={onCancel} />);
    const stack = screen.getByTestId("stack");
    expect(stack.inert).toBeFalsy();
    expect(stack.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByTestId("page").inert).toBe(true);

    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => undo.focus());
    // The trap lets focus rest on a toast (F6 lands there).
    expect(document.activeElement).toBe(undo);
    fireEvent.keyDown(undo, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("the dialog focus floor", () => {
  it("parks focus on the dialog while its action is busy, and hands it back after a failure", async () => {
    let answer!: (ok: boolean) => void;
    function Fixture() {
      const [busy, setBusy] = useState(false);
      return (
        <LanguageProvider>
          <ConfirmDialog
            title="Import?"
            body="Imports it"
            confirmLabel="Import"
            busyLabel="Importing…"
            busy={busy}
            tone="accent"
            onCancel={vi.fn()}
            onConfirm={() => {
              setBusy(true);
              return new Promise<boolean>((resolve) => {
                answer = (ok) => {
                  setBusy(false);
                  resolve(ok);
                };
              });
            }}
          />
        </LanguageProvider>
      );
    }
    render(<Fixture />);
    const overlay = screen.getByRole("dialog", { name: "Import?" });
    const action = screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    act(() => action.focus());
    fireEvent.click(action);
    await flush();
    expect(action.disabled).toBe(true);
    // The busy action wears the one busy look.
    expect(action.className).toContain("is-busy");
    expect(action.querySelector(".busy-spinner")).not.toBeNull();
    // Not stranded on <body>, outside the trap.
    expect(document.activeElement).toBe(overlay);

    await act(async () => answer(false));
    await flush();
    expect(action.disabled).toBe(false);
    expect(document.activeElement).toBe(action);
  });
});

describe("Back over a dialog (closeSignal)", () => {
  it("closes an idle dialog as Cancel would, and a busy one holds", async () => {
    const onCancel = vi.fn();
    const view = render(
      <LanguageProvider>
        <ConfirmDialog title="Log out?" body="b" confirmLabel="Log Out" busy onCancel={onCancel} onConfirm={vi.fn()} closeSignal={0} />
      </LanguageProvider>
    );
    view.rerender(
      <LanguageProvider>
        <ConfirmDialog title="Log out?" body="b" confirmLabel="Log Out" busy onCancel={onCancel} onConfirm={vi.fn()} closeSignal={1} />
      </LanguageProvider>
    );
    expect(onCancel).not.toHaveBeenCalled();
    view.rerender(
      <LanguageProvider>
        <ConfirmDialog title="Log out?" body="b" confirmLabel="Log Out" onCancel={onCancel} onConfirm={vi.fn()} closeSignal={2} />
      </LanguageProvider>
    );
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("closes the dialog in the app and leaves the lens behind it alone", async () => {
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
    mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
    mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 0, syncEpoch: "epoch-a", serverTime: now.toISOString() });
    const memos = [memo("a", "alpha note #alpha"), memo("b", "beta note #beta")];
    mocks.bootstrap.mockResolvedValue({ memos, tags: [], cursor: 2, syncEpoch: "epoch-a", serverTime: now.toISOString(), hasMore: false, nextAfter: null });
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );
    await screen.findByText(/beta note/);
    await user.click(screen.getAllByRole("button", { name: /^alpha/ })[0]);
    await waitFor(() => expect(screen.queryByText(/beta note/)).toBeNull());
    const depth = window.history.length;

    const card = screen.getByText(/alpha note/).closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Add tag" }));
    await screen.findByRole("dialog");

    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await sleep(150);
    // Still inside #alpha: Back did one thing, and the entry it stepped off
    // is back on top.
    expect(screen.queryByText(/beta note/)).toBeNull();
    expect(screen.getByText(/alpha note/)).toBeTruthy();
    expect(window.history.length).toBe(depth);
  });
});

describe("a refused submit", () => {
  function renderPrompt() {
    render(
      <LanguageProvider>
        <PromptDialog
          title="Rename tag #work"
          initialValue="work"
          confirmLabel="Rename"
          validate={(value) => (value === "work" ? "The new name is unchanged" : null)}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </LanguageProvider>
    );
    return screen.getByRole("textbox");
  }

  it("nudges the field on Enter", () => {
    reducedMotion = false;
    const input = renderPrompt();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.classList.contains("is-refused")).toBe(true);
    fireEvent.animationEnd(input);
    expect(input.classList.contains("is-refused")).toBe(false);
  });

  it("stays still under reduced motion", () => {
    const input = renderPrompt();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.classList.contains("is-refused")).toBe(false);
  });

  it("nudges the tag field when there is nothing to add", () => {
    reducedMotion = false;
    render(
      <LanguageProvider>
        <BulkTagDialog selectedCount={2} knownTags={[]} onApply={vi.fn()} onDismiss={vi.fn()} onApplied={vi.fn()} />
      </LanguageProvider>
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.closest("label")?.classList.contains("is-refused")).toBe(true);
  });
});

describe("a sheet pulled down", () => {
  function pointer(target: EventTarget, type: string, y: number, t: number) {
    const Constructor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
    const event = new Constructor(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y });
    const fields: Record<string, unknown> = { pointerId: 7, pointerType: "touch", isPrimary: true, timeStamp: t };
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { configurable: true, value });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  it("thins the scrim with the pull and leaves at the flick's pace", async () => {
    reducedMotion = false;
    sheet = true;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    const onCancel = vi.fn();
    render(
      <LanguageProvider>
        <ConfirmDialog title="Remove?" body="Removes it" confirmLabel="Remove" onCancel={onCancel} onConfirm={vi.fn()} />
      </LanguageProvider>
    );
    const overlay = screen.getByRole("dialog", { name: "Remove?" });
    const title = screen.getByRole("heading", { name: "Remove?" });
    pointer(title, "pointerdown", 100, 1000);
    pointer(window, "pointermove", 120, 1020);
    pointer(window, "pointermove", 200, 1040);
    expect(overlay.style.getPropertyValue("--sheet-pull")).toBe("0.250");
    pointer(window, "pointermove", 260, 1050);
    pointer(window, "pointerup", 260, 1060);
    // 240px left to go at ~2.7px/ms is under 100ms: the quickest exit allowed.
    expect(overlay.style.getPropertyValue("--sheet-exit")).toBe("100ms");
    expect(overlay.className).toContain("is-closing");
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("springs back, scrim and all, when let go short of the line", () => {
    sheet = true;
    reducedMotion = false;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    render(
      <LanguageProvider>
        <ConfirmDialog title="Remove?" body="Removes it" confirmLabel="Remove" onCancel={vi.fn()} onConfirm={vi.fn()} />
      </LanguageProvider>
    );
    const overlay = screen.getByRole("dialog", { name: "Remove?" });
    const title = screen.getByRole("heading", { name: "Remove?" });
    pointer(title, "pointerdown", 100, 1000);
    pointer(window, "pointermove", 140, 1100);
    pointer(window, "pointerup", 140, 1400);
    expect(overlay.className).not.toContain("is-closing");
    expect(overlay.style.getPropertyValue("--sheet-pull")).toBe("0");
    expect(overlay.style.transition).toContain("--sheet-pull");
  });
});

describe("menus", () => {
  function MenuFixture() {
    return (
      <Menu trigger={(open) => <button type="button" aria-expanded={open}>Actions</button>}>
        {(close) => (
          <button type="button" role="menuitem" onClick={close}>
            Edit
          </button>
        )}
      </Menu>
    );
  }

  it("re-opened mid-exit stays open instead of finishing the close", async () => {
    reducedMotion = false;
    const user = userEvent.setup();
    render(<MenuFixture />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    await user.click(trigger);
    expect(document.querySelector(".action-menu")?.className).toContain("is-closing");
    await user.click(trigger);
    await sleep(200);
    const panel = document.querySelector(".action-menu");
    expect(panel).not.toBeNull();
    expect(panel!.className).not.toContain("is-closing");
  });
});

describe("overlay exits", () => {
  interface FakeAnimation {
    animationName: string;
    playState: string;
    currentTime: number;
    playbackRate: number;
    effect: unknown;
    finished: Promise<unknown>;
  }

  function watched(animations: FakeAnimation[], extra: Record<string, unknown> = {}) {
    return Object.assign(document.createElement("div"), { getAnimations: () => animations }, extra);
  }

  function running(effect: unknown, finished: Promise<unknown> = new Promise(() => undefined)): FakeAnimation {
    return { animationName: "fade-out", playState: "running", currentTime: 40, playbackRate: 1, effect, finished };
  }

  it("end when the surface's own exit does, and not before", async () => {
    let end!: () => void;
    const finished = new Promise<void>((resolve) => {
      end = resolve;
    });
    const element = watched([running({ getComputedTiming: () => ({ endTime: 160, duration: 160 }) }, finished)]);
    const done = vi.fn();
    afterExit([element], 170, done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    end();
    // A task later every promise in the chain has settled; the safety
    // timer (120ms left + 100) is still far off.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("end at once when nothing runs, and on the fallback where nothing can be watched", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    afterExit([watched([])], 170, done);
    expect(done).toHaveBeenCalledTimes(1);

    const blind = vi.fn();
    afterExit([document.createElement("div")], 170, blind);
    expect(blind).not.toHaveBeenCalled();
    vi.advanceTimersByTime(170);
    expect(blind).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const cancel = afterExit([document.createElement("div")], 170, cancelled);
    cancel();
    vi.advanceTimersByTime(400);
    expect(cancelled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("carry a swapped animation on from the painted frame (opacity only when reduced)", () => {
    class FakeKeyframeEffect {
      getComputedTiming() {
        return { endTime: 120, duration: 120 };
      }
      getKeyframes() {
        return [
          { offset: 0, easing: "ease", opacity: "1", transform: "none" },
          { offset: 1, easing: "ease", opacity: "0", transform: "translateY(-4px) scale(0.94)" }
        ];
      }
    }
    vi.stubGlobal("KeyframeEffect", FakeKeyframeEffect);
    const animate = vi.fn();
    const element = watched([running(new FakeKeyframeEffect())], { animate });
    continueFrom(element, { opacity: "0.4", transform: "scale(0.95)" }, false);
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: "0.4", transform: "scale(0.95)" },
        { opacity: "0", transform: "translateY(-4px) scale(0.94)" }
      ],
      { duration: 120, easing: "ease" }
    );
    animate.mockClear();
    continueFrom(element, { opacity: "0.4", transform: "scale(0.95)" }, true);
    expect(animate).toHaveBeenCalledWith([{ opacity: "0.4" }, { opacity: "0" }], { duration: 120, easing: "ease" });
  });
});
