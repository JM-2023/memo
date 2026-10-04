// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Menu } from "../src/components/Menu";
import { PasscodePad } from "../src/components/PasscodePad";
import { PromptDialog } from "../src/components/PromptDialog";
import { SyncNotice, type SyncNoticeContent } from "../src/components/SyncNotice";
import { TipProvider, useTip } from "../src/components/Tip";
import type { BootstrapResponse } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import { applyTheme } from "../src/lib/theme";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  emptyTrash: vi.fn(),
  batchMemos: vi.fn(),
  login: vi.fn(),
  syncOptions: null as null | { onAuthLost: (revoked: boolean) => void },
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
    emptyTrash: mocks.emptyTrash,
    batchMemos: mocks.batchMemos,
    login: mocks.login
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
  useSync: (options: { onAuthLost: (revoked: boolean) => void }) => {
    mocks.syncOptions = options;
    return mocks.syncApi;
  }
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
    content: `memo-${index} original`,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    deletedAt: null,
    seq: index + 1,
    images: [],
    ...overrides
  };
}

function page(memos: Memo[]): BootstrapResponse {
  return { memos, tags: [], cursor: 10, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z", hasMore: false, nextAfter: null };
}

let reducedMotion = true;

function stubMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // A previous test's view (Trash) must not be restored from history.
  window.history.replaceState(null, "", "/");
  reducedMotion = true;
  mocks.syncOptions = null;
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false, setupAllowed: true });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 10, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z" });
  mocks.login.mockResolvedValue({ ok: true });
  stubMatchMedia();
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
  vi.useRealTimers();
});

describe("irreversible deletes need a deliberate second click", () => {
  const trashed = { deletedAt: "2026-01-02T00:00:00.000Z" };

  async function openTrash() {
    mocks.bootstrap.mockResolvedValue(page([memo(2, trashed), memo(1, trashed)]));
    render(
      <Providers>
        <App />
      </Providers>
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Trash/ }));
    await screen.findByText("memo-2 original");
  }

  it("ignores a double-click and a too-quick click on an armed Empty Trash", async () => {
    mocks.emptyTrash.mockResolvedValue({ ok: true, purged: [{ id: "memo-1", seq: 20 }, { id: "memo-2", seq: 21 }] });
    await openTrash();

    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }), { detail: 1 });
    const armed = screen.getByRole("button", { name: "Delete 2 memos forever?" });
    // The double-click's second click lands on the live confirm at once.
    fireEvent.click(armed, { detail: 2 });
    fireEvent.click(armed, { detail: 1 });
    expect(mocks.emptyTrash).not.toHaveBeenCalled();

    await sleep(470);
    fireEvent.click(armed, { detail: 2 });
    expect(mocks.emptyTrash).not.toHaveBeenCalled();
    // A fresh click (or Enter: detail 0) after the beat confirms.
    fireEvent.click(armed, { detail: 0 });
    await waitFor(() => expect(mocks.emptyTrash).toHaveBeenCalledTimes(1));
  });

  it("does the same for select mode's Delete forever", async () => {
    mocks.batchMemos.mockResolvedValue({ patches: [], memos: [], purged: [{ id: "memo-2", seq: 20 }], unchanged: [], failed: [] });
    await openTrash();
    fireEvent.click(screen.getByRole("button", { name: "Select memos" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Select this memo" })[0]);

    fireEvent.click(screen.getByRole("button", { name: "Delete selected memos forever" }), { detail: 1 });
    const armed = screen.getByRole("button", { name: "Delete 1 memo forever?" });
    fireEvent.click(armed, { detail: 2 });
    expect(mocks.batchMemos).not.toHaveBeenCalled();

    await sleep(470);
    fireEvent.click(armed, { detail: 1 });
    await waitFor(() => expect(mocks.batchMemos).toHaveBeenCalledWith("purge", expect.any(Array), expect.any(Object)));
  });
});

describe("the session-expired toast", () => {
  it("is dismissed once the passcode unlocks, and the stack is not remounted", async () => {
    mocks.bootstrap.mockResolvedValue(page([memo(1)]));
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );
    await screen.findByText("memo-1 original");
    act(() => mocks.syncOptions!.onAuthLost(false));
    const toast = await screen.findByText("Your session has expired. Enter your passcode again.", { selector: ".toast *" });
    const stack = toast.closest(".toast-stack");

    await screen.findByRole("button", { name: "Confirm" });
    await user.keyboard("2468{Enter}");
    expect(mocks.login).toHaveBeenCalledWith("2468");
    await waitFor(() => expect(document.querySelector(".app-shell")).not.toBeNull());
    // One stack across the gate → notebook swap (no remount, no replayed
    // entrance), and the toast has left it.
    expect(document.querySelector(".toast-stack")).toBe(stack);
    await waitFor(() => expect(screen.queryByText("Your session has expired. Enter your passcode again.", { selector: ".toast *" })).toBeNull());
  });
});

describe("backdrop dismissal", () => {
  function renderPrompt(onCancel = vi.fn()) {
    render(
      <LanguageProvider>
        <PromptDialog title="Rename" initialValue="work" confirmLabel="Rename" validate={() => null} onCancel={onCancel} onConfirm={vi.fn()} />
      </LanguageProvider>
    );
    return { onCancel, overlay: screen.getByRole("dialog", { name: "Rename" }) };
  }

  it("keeps the dialog when a text drag from the field is released on the backdrop", () => {
    const { onCancel, overlay } = renderPrompt();
    fireEvent.pointerDown(screen.getByRole("textbox"));
    fireEvent.click(overlay);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes on a press and release that both land on the backdrop", () => {
    const { onCancel, overlay } = renderPrompt();
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("works the same for ConfirmDialog", () => {
    const onCancel = vi.fn();
    render(
      <LanguageProvider>
        <ConfirmDialog title="Remove?" body="Removes it" confirmLabel="Remove" onCancel={onCancel} onConfirm={vi.fn()} />
      </LanguageProvider>
    );
    const overlay = screen.getByRole("dialog", { name: "Remove?" });
    fireEvent.pointerDown(screen.getByText("Removes it"));
    fireEvent.click(overlay);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("dialogs leave on success too", () => {
  it("holds the busy look through the exit, then calls onDone", async () => {
    reducedMotion = false;
    stubMatchMedia();
    let finish!: (ok: boolean) => void;
    const onDone = vi.fn();
    const onCancel = vi.fn();
    function Fixture() {
      const [busy, setBusy] = useState(false);
      return (
        <ConfirmDialog
          title="Log out?"
          body="Forget this device"
          confirmLabel="Log Out"
          busyLabel="Logging out…"
          busy={busy}
          onCancel={onCancel}
          onConfirm={() => {
            setBusy(true);
            return new Promise<boolean>((resolve) => {
              finish = (ok) => {
                setBusy(false);
                resolve(ok);
              };
            });
          }}
          onDone={onDone}
        />
      );
    }
    render(
      <LanguageProvider>
        <Fixture />
      </LanguageProvider>
    );
    const overlay = screen.getByRole("dialog", { name: "Log out?" });
    fireEvent.click(screen.getByRole("button", { name: "Log Out" }));
    expect(screen.getByRole("button", { name: "Logging out…" })).toBeTruthy();

    await act(async () => finish(true));
    // The parent dropped busy, but the dialog still says what it was doing.
    expect(overlay.className).toContain("is-closing");
    expect((screen.getByRole("button", { name: "Logging out…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps idle and busy labels in one cell so the button never changes width", () => {
    render(
      <LanguageProvider>
        <ConfirmDialog title="Log out?" body="b" confirmLabel="Log Out" busyLabel="Logging out…" onCancel={vi.fn()} onConfirm={vi.fn()} />
      </LanguageProvider>
    );
    const button = screen.getByRole("button", { name: "Log Out" });
    const labels = button.querySelectorAll(".busy-swap > span");
    expect([...labels].map((label) => label.textContent)).toEqual(["Log Out", "Logging out…"]);
    expect(labels[1].getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the prompt's note", () => {
  function RenameFixture({ onConfirm = vi.fn() }: { onConfirm?: (value: string) => void }) {
    return (
      <LanguageProvider>
        <PromptDialog
          title="Rename tag #work"
          initialValue="work"
          confirmLabel="Rename"
          validate={(value) => (value === "work" ? "The new name is unchanged" : value.endsWith("/") ? "Use / between levels" : null)}
          hint={(value) => (value === "life" ? { text: "#life already exists.", strong: true, confirmLabel: "Merge" } : null)}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </LanguageProvider>
    );
  }

  it("opens without an error: an unchanged name only disables the button", () => {
    render(<RenameFixture />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("The new name is unchanged")).toBeNull();
    expect((screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true);
    // The note row is reserved even while empty.
    expect(document.querySelector(".prompt-note")).not.toBeNull();
  });

  it("waits for a pause before a format error, and clears it as soon as it no longer holds", async () => {
    const user = userEvent.setup();
    render(<RenameFixture />);
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "job/");
    expect(screen.queryByText("Use / between levels")).toBeNull();
    expect(await screen.findByText("Use / between levels")).toBeTruthy();
    await user.type(input, "x");
    expect(screen.queryByText("Use / between levels")).toBeNull();
  });

  it("shows a pending merge warning on Enter instead of merging unseen", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<RenameFixture onConfirm={onConfirm} />);
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "life{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("#life already exists.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledWith("life");
  });
});

describe("a refused passcode", () => {
  it("keeps its red dots through the shake, and the next key starts afresh", async () => {
    reducedMotion = false;
    stubMatchMedia();
    const onComplete = vi.fn();
    function Fixture() {
      const [error, setError] = useState(false);
      const [entryKey, setEntryKey] = useState(0);
      return (
        <PasscodePad
          icon={null}
          title="Unlock"
          subtitle="Enter passcode"
          error={error}
          entryKey={entryKey}
          onInput={() => setError(false)}
          onComplete={(pin) => {
            onComplete(pin);
            setError(true);
            setEntryKey((value) => value + 1);
          }}
        />
      );
    }
    render(
      <LanguageProvider>
        <Fixture />
      </LanguageProvider>
    );
    const dots = () => document.querySelectorAll(".pin-dots span").length;
    for (const key of ["1", "1", "1", "1"]) fireEvent.click(screen.getByRole("button", { name: key }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onComplete).toHaveBeenCalledWith("1111");
    expect(dots()).toBe(4);
    expect(document.querySelector(".pin-dots")?.className).toContain("error");
    expect(document.querySelector(".pin-pad")?.className).toContain("shake");

    // Typing during the hold drops the refused entry and starts a new one.
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(dots()).toBe(1);

    // Left alone, a refused entry fades and clears on its own.
    for (const key of ["2", "2", "2"]) fireEvent.click(screen.getByRole("button", { name: key }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(dots()).toBe(4);
    await waitFor(() => expect(document.querySelector(".pin-dots")?.className).toContain("is-clearing"));
    await waitFor(() => expect(dots()).toBe(0));
  });

  it("echoes hardware digits on the on-screen key", () => {
    render(
      <LanguageProvider>
        <PasscodePad icon={null} title="Unlock" subtitle="Enter passcode" onComplete={vi.fn()} />
      </LanguageProvider>
    );
    fireEvent.keyDown(window, { key: "7" });
    expect(screen.getByRole("button", { name: "7" }).className).toContain("is-pressed");
  });
});

describe("the sync line", () => {
  const unreachable = (onRetry: SyncNoticeContent["onRetry"]): SyncNoticeContent => ({
    kind: "unreachable",
    text: "Can’t reach the server",
    failedText: "Still can’t reach the server",
    onRetry
  });

  it("shows a retry running for at least a beat and says when it didn't help", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <SyncNotice notice={unreachable(async () => false)} />
      </LanguageProvider>
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const running = screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    await sleep(300);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeTruthy();
    expect(await screen.findByText("Still can’t reach the server", {}, { timeout: 1_500 })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says Back online, then folds away", async () => {
    reducedMotion = false;
    stubMatchMedia();
    const view = render(
      <LanguageProvider>
        <SyncNotice notice={unreachable(undefined)} />
      </LanguageProvider>
    );
    view.rerender(
      <LanguageProvider>
        <SyncNotice notice={null} />
      </LanguageProvider>
    );
    expect(screen.getByText("Back online")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".sync-notice-slot")?.className).toContain("is-leaving"), { timeout: 2_500 });
    await waitFor(() => expect(document.querySelector(".sync-notice-slot")).toBeNull());
  });

  it("folds a finished loading line instead of dropping it", async () => {
    reducedMotion = false;
    stubMatchMedia();
    const view = render(
      <LanguageProvider>
        <SyncNotice notice={{ kind: "loading", text: "Loading memos · 1 of 3" }} />
      </LanguageProvider>
    );
    view.rerender(
      <LanguageProvider>
        <SyncNotice notice={null} />
      </LanguageProvider>
    );
    expect(document.querySelector(".sync-notice-slot")?.className).toContain("is-leaving");
    expect(screen.getByText("Loading memos · 1 of 3")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".sync-notice-slot")).toBeNull());
  });
});

describe("menus", () => {
  function MenuFixture() {
    return (
      <Menu trigger={(open) => <button type="button" aria-expanded={open}>Actions</button>}>
        {(close) => (
          <>
            {["Edit", "Pin", "Share", "Delete"].map((label) => (
              <button key={label} type="button" role="menuitem" onClick={close}>
                {label}
              </button>
            ))}
          </>
        )}
      </Menu>
    );
  }

  it("jumps by first letter and cycles on a repeated letter", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.keyboard("d");
    expect(document.activeElement?.textContent).toBe("Delete");
    await sleep(520);
    await user.keyboard("p");
    expect(document.activeElement?.textContent).toBe("Pin");
  });

  it("moves focus with the pointer so only one row is lit", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const share = screen.getByRole("menuitem", { name: "Share" });
    fireEvent.pointerMove(share, { pointerType: "mouse" });
    expect(document.activeElement).toBe(share);
  });
});

describe("tooltips", () => {
  function TipPair() {
    const tip = useTip();
    return (
      <>
        <button type="button" {...tip.bind({ text: "First" })}>
          A
        </button>
        <button type="button" {...tip.bind({ text: "Second" })}>
          B
        </button>
        <button type="button" {...tip.bind({ text: "Fast" }, { delay: 0 })}>
          C
        </button>
      </>
    );
  }

  it("wait for hover intent first, then show neighbours at once", () => {
    vi.useFakeTimers();
    render(
      <TipProvider>
        <TipPair />
      </TipProvider>
    );
    const bubble = () => document.querySelector(".tip")!;
    fireEvent.pointerEnter(screen.getByRole("button", { name: "A" }), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(150));
    expect(bubble().className).not.toContain("is-show");
    act(() => vi.advanceTimersByTime(300));
    expect(bubble().className).toContain("is-show");

    fireEvent.pointerLeave(screen.getByRole("button", { name: "A" }), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(bubble().className).not.toContain("is-show");
    // Within the skip-delay window the next anchor needs no pause.
    fireEvent.pointerEnter(screen.getByRole("button", { name: "B" }), { pointerType: "mouse" });
    expect(bubble().className).toContain("is-show");
    expect(bubble().textContent).toBe("Second");
  });

  it("let a binding ask for a shorter first delay", () => {
    vi.useFakeTimers();
    render(
      <TipProvider>
        <TipPair />
      </TipProvider>
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "C" }), { pointerType: "mouse" });
    expect(document.querySelector(".tip")!.className).toContain("is-show");
  });
});

describe("switching theme", () => {
  it("turns transitions off for the frames around the flip", async () => {
    applyTheme("light");
    await sleep(40);
    const root = document.documentElement;
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
    applyTheme("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    await waitFor(() => expect(root.hasAttribute("data-theme-switching")).toBe(false));
    applyTheme("light");
    localStorage.clear();
  });
});
