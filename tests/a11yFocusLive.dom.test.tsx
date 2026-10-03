// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Menu } from "../src/components/Menu";
import { RollingText } from "../src/components/RollingText";
import { TipProvider, useTip, withFocus } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { announce, LIVE_REGION_ATTR, mountLiveRegions } from "../src/lib/liveAnnouncer";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  trashMemo: vi.fn(),
  restoreMemo: vi.fn(),
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
    trashMemo: mocks.trashMemo,
    restoreMemo: mocks.restoreMemo
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

function memo(index: number): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `memo-${index}`,
    content: `memo-${index} body`,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    deletedAt: null,
    seq: index + 1,
    images: []
  };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function liveText(role: "status" | "alert"): string {
  return document.querySelector(`[${LIVE_REGION_ATTR}] [role='${role}']`)?.textContent ?? "";
}

let reduceMotion = false;

beforeEach(() => {
  localStorage.clear();
  reduceMotion = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: reduceMotion && query.includes("prefers-reduced-motion"),
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
});

/** A ⋯ menu whose item opens a dialog, the way the card and tag menus do. */
function MenuDialogFixture({ dropOpener = false }: { dropOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openerShown, setOpenerShown] = useState(true);
  return (
    <>
      <button type="button">Before</button>
      {openerShown ? (
        <Menu
          trigger={() => (
            <button type="button" aria-haspopup="menu">
              More
            </button>
          )}
        >
          {(close) => (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                setOpen(true);
              }}
            >
              Rename
            </button>
          )}
        </Menu>
      ) : null}
      <button type="button">After</button>
      {open ? (
        <ConfirmDialog
          title="Rename?"
          body="Rename it"
          confirmLabel="Rename"
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            // A renamed tag's row is re-keyed in the same commit that closes
            // the dialog: its ⋯ trigger is gone.
            setOpen(false);
            if (dropOpener) setOpenerShown(false);
          }}
        />
      ) : null}
    </>
  );
}

describe("focus after a dialog opened from a menu", () => {
  beforeEach(() => {
    // jsdom lets inert elements take focus; browsers do not, and that is the
    // whole failure — a late focus() on the inert trigger does nothing.
    const realFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) if (node.inert) return;
      realFocus.call(this, options);
    });
  });

  it("returns to the menu trigger, not <body>", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <MenuDialogFixture />
      </Providers>
    );
    const trigger = screen.getByRole("button", { name: "More" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Rename?" })).toBeTruthy();
    // The menu's exit beat ends under the open dialog.
    await new Promise((resolve) => setTimeout(resolve, 160));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename?" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("lands beside the opener when the opener left while the dialog was up", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <MenuDialogFixture dropOpener />
      </Providers>
    );
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await user.click(within(screen.getByRole("dialog", { name: "Rename?" })).getByRole("button", { name: "Rename" }));
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename?" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });
});

describe("standing live regions", () => {
  it("exist before anything is said, re-announce repeats and stay outside modal isolation", () => {
    const unmount = mountLiveRegions();
    try {
      const root = document.querySelector<HTMLElement>(`[${LIVE_REGION_ATTR}]`);
      expect(root).not.toBeNull();
      expect(liveText("status")).toBe("");
      announce("Copied to clipboard");
      const first = root?.querySelector("[role='status'] > div");
      announce("Copied to clipboard");
      expect(liveText("status")).toBe("Copied to clipboard");
      expect(root?.querySelector("[role='status'] > div")).not.toBe(first);
      announce("Couldn’t copy", "assertive");
      expect(liveText("alert")).toBe("Couldn’t copy");

      render(
        <Providers>
          <ConfirmDialog title="Remove?" body="Remove it" confirmLabel="Remove" onCancel={vi.fn()} onConfirm={vi.fn()} />
        </Providers>
      );
      expect(root?.inert).toBeFalsy();
      expect(root?.getAttribute("aria-hidden")).toBeNull();
    } finally {
      unmount();
    }
    expect(document.querySelector(`[${LIVE_REGION_ATTR}]`)).toBeNull();
  });
});

describe("rolling numbers for screen readers", () => {
  it("speak the value as real text instead of a WebKit-only role", () => {
    const view = render(
      <LanguageProvider>
        <RollingText value={12} />
      </LanguageProvider>
    );
    const roll = view.container.querySelector(".roll");
    expect(roll?.getAttribute("role")).toBeNull();
    expect(roll?.getAttribute("aria-label")).toBeNull();
    expect(roll?.querySelector(".sr-only")?.textContent).toBe("12");
    expect(roll?.querySelector(".roll-inner")?.getAttribute("aria-hidden")).toBe("true");
  });
});

function TipFixture() {
  const tip = useTip();
  return (
    <button type="button" aria-label="Bold" {...tip.bind({ text: "Bold (⌘B)" })}>
      B
    </button>
  );
}

describe("tips beyond the mouse", () => {
  it("show for keyboard focus, skip a touch, and close on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <TipFixture />
      </Providers>
    );
    const button = screen.getByRole("button", { name: "Bold" });
    const bubble = () => document.querySelector(".tip");

    fireEvent.pointerEnter(button, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bubble()?.className).not.toContain("is-show");

    await user.tab();
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(bubble()?.className).toContain("is-show"));
    expect(bubble()?.textContent).toBe("Bold (⌘B)");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(bubble()?.className).not.toContain("is-show"));
  });
});

function QuietTipFixture({ onFocused }: { onFocused: () => void }) {
  const tip = useTip();
  return (
    <>
      <button type="button" {...withFocus(tip.bind({ text: "Day" }), onFocused)}>
        Cell
      </button>
      <button type="button" {...tip.bind(() => null)}>
        Quiet
      </button>
    </>
  );
}

describe("tip bindings", () => {
  it("say nothing when the content is null, and keep the anchor's own focus handler", async () => {
    const user = userEvent.setup();
    const onFocused = vi.fn();
    // jsdom's :focus-visible heuristic depends on earlier tests' events.
    const matches = Element.prototype.matches;
    const spy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? this === document.activeElement : matches.call(this, selector);
    });
    render(
      <Providers>
        <QuietTipFixture onFocused={onFocused} />
      </Providers>
    );
    const bubble = () => document.querySelector(".tip");
    // Keyboard focus runs the anchor's handler and shows the tip.
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Cell");
    expect(onFocused).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(bubble()?.className).toContain("is-show"));
    expect(bubble()?.textContent).toBe("Day");
    // Leaving it, then a mouse over an anchor with nothing to say: no bubble.
    act(() => (document.activeElement as HTMLElement).blur());
    await waitFor(() => expect(bubble()?.className).not.toContain("is-show"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Quiet" }), { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bubble()?.className).not.toContain("is-show");
    spy.mockRestore();
  });
});

/** Boots the real App over the given memos. */
async function bootApp(memos: Memo[]) {
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos,
    tags: [],
    cursor: memos.length,
    syncEpoch: "epoch-a",
    serverTime: memos.at(-1)?.createdAt,
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: memos.length, syncEpoch: "epoch-a", serverTime: memos.at(-1)?.createdAt });
  render(
    <Providers>
      <App />
    </Providers>
  );
  await screen.findByText(memos[0].content);
}

function cardTrigger(text: string): HTMLElement {
  const trigger = screen.getByText(text).closest("article")?.querySelector<HTMLElement>(".memo-menu-trigger");
  if (!trigger) throw new Error(`No card for ${text}`);
  return trigger;
}

describe("card menu items and focus", () => {
  beforeEach(() => {
    // Inert subtrees refuse focus, as in browsers (see above).
    const realFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) if (node.inert) return;
      realFocus.call(this, options);
    });
  });

  it("returns to the card's ⋯ after Add tag's dialog closes", async () => {
    reduceMotion = true;
    await bootApp([memo(0), memo(1), memo(2)]);
    const user = userEvent.setup();
    const trigger = cardTrigger("memo-1 body");
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: "Add tag" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves focus in the editor opened from the menu once the menu has gone", async () => {
    await bootApp([memo(0), memo(1), memo(2)]);
    const user = userEvent.setup();
    act(() => cardTrigger("memo-1 body").focus());
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const area = await screen.findByDisplayValue("memo-1 body");
    expect(document.activeElement).toBe(area);
    // Past the menu's exit beat, which used to hand focus back to ⋯.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(document.activeElement).toBe(area);
  });
});

describe("removing a memo from the keyboard", () => {
  it("moves focus to the next card, announces the toast and reaches Undo with F6", async () => {
    reduceMotion = true;
    const memos = [memo(0), memo(1), memo(2)];
    mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
    mocks.bootstrap.mockResolvedValue({
      memos,
      tags: [],
      cursor: 3,
      syncEpoch: "epoch-a",
      serverTime: memos[2].createdAt,
      hasMore: false,
      nextAfter: null
    });
    mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 3, syncEpoch: "epoch-a", serverTime: memos[2].createdAt });
    const trashed = { ...memos[1], deletedAt: "2026-01-02T00:00:00.000Z", seq: 10 };
    mocks.trashMemo.mockResolvedValue({ ok: true, memo: trashed });
    mocks.restoreMemo.mockResolvedValue({ memo: { ...memos[1], seq: 11 } });

    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );

    const card = (await screen.findByText("memo-1 body")).closest("article");
    const nextCard = screen.getByText("memo-0 body").closest("article");
    const trigger = card?.querySelector<HTMLElement>(".memo-menu-trigger");
    const nextTrigger = nextCard?.querySelector<HTMLElement>(".memo-menu-trigger");
    if (!card || !trigger || !nextTrigger) throw new Error("Memo cards were not rendered");

    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    await user.keyboard("{End}{Enter}");
    // A second confirm step, when the menu asks for one.
    if (screen.queryByRole("menuitem", { name: "Move to Trash" })) await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.queryByText("memo-1 body")).toBeNull());
    expect(mocks.trashMemo).toHaveBeenCalledWith("memo-1", 2);
    expect(document.activeElement).toBe(nextTrigger);
    expect(liveText("status")).toBe("Moved to Trash. Press F6 to undo.");
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getByText("Moved to Trash")).toBeTruthy();

    await user.keyboard("{F6}");
    const undo = within(region).getByRole("button", { name: "Undo" });
    expect(document.activeElement).toBe(undo);
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(nextTrigger);

    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(undo);
    await user.keyboard("{Enter}");
    expect(mocks.restoreMemo).toHaveBeenCalledWith("memo-1", 10);
    expect(document.activeElement).toBe(nextTrigger);
    await screen.findByText("memo-1 body");
  });
});
