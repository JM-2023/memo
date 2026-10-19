// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { ApiError } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import { LIVE_REGION_ATTR } from "../src/lib/liveAnnouncer";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  createMemo: vi.fn(),
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

function spoken(tone: "status" | "alert" = "status"): string {
  return document.querySelector(`[${LIVE_REGION_ATTR}] [role="${tone}"]`)?.textContent ?? "";
}

function field(): HTMLTextAreaElement {
  return screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
}

/** The server as it is: it stores the memo under the id the client sent. */
function stores(id: string, content: string): Promise<{ memo: Memo }> {
  return Promise.resolve({ memo: { ...memo(9, content), id } });
}

const startViewTransition = document.startViewTransition;

/** The browser's word on the connection, and sync's with it. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  mocks.syncApi.status = { online, degraded: false };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "");
  mocks.syncApi.status = { online: true, degraded: false };
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
  delete (navigator as Partial<Navigator>).vibrate;
  delete (navigator as { onLine?: boolean }).onLine;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("sending a memo", () => {
  it("lands the card in a morph around the feed's change, naming only the morph's parts", async () => {
    const seen: Array<{ composer: string; cards: number; marked: boolean; field: string; slots: string[] }> = [];
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
    mocks.createMemo.mockImplementation(stores);

    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Fresh thought");
    seen.length = 0;
    const animate = vi.mocked(Element.prototype.animate);
    animate.mockClear();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    const landed = screen.getByText("Fresh thought").closest<HTMLElement>(".memo-slot");
    expect(landed).toBeTruthy();
    // The card is keyed by the composer's clientId, the id the send goes out under.
    const key = landed?.dataset.vt ?? "";
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    expect(`memo-${mocks.createMemo.mock.calls[0][0]}`).toBe(key);
    const [before, after] = seen.slice(-2);
    // Old capture: the draft still in the composer, carrying the new card's
    // name; the root marked, so the composer and the bar are captured too;
    // no card named.
    expect(before).toEqual({ composer: "Fresh thought", cards: 2, marked: true, field: key, slots: [] });
    // New state, in the same update: card in and named — the morph's other
    // half — the composer empty.
    expect(after).toEqual({ composer: "", cards: 3, marked: true, field: "", slots: [key] });
    // The morph plays its arrival; the feed's motion layer does not, nor
    // when the server's answer takes the card's place.
    await waitFor(() => expect(spoken()).toBe("Sent"));
    expect(screen.getByText("Fresh thought").closest(".memo-slot")).toBe(landed);
    expect(animate.mock.contexts).not.toContain(landed);
    await waitFor(() => expect(document.documentElement.dataset.vtCreate).toBeUndefined());
    expect(nameOf(landed)).toBe("");
  });

  it("starts no morph under reduced motion: the card fades in as the composer hands over", async () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList
    );
    const start = vi.fn();
    document.startViewTransition = start as unknown as typeof document.startViewTransition;
    mocks.createMemo.mockImplementation(stores);

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

  it("lands the card at the press, frees the composer, and confirms in the same card once the server answers", async () => {
    let answer: () => void = () => undefined;
    mocks.createMemo.mockImplementation(
      (id: string, content: string) =>
        new Promise((resolve) => {
          answer = () => resolve({ memo: { ...memo(9, content), id } });
        })
    );
    // A touch screen: the card lands with a small knock.
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList
    );
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Quick thought");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // No answer yet, and the card is in, the composer empty and writable.
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    expect(field().value).toBe("");
    expect(field().readOnly).toBe(false);
    expect(vibrate).toHaveBeenCalledWith(8);
    const card = screen.getByText("Quick thought").closest("article")!;
    const slot = card.closest(".memo-slot");
    expect(card.classList.contains("is-unsent")).toBe(true);
    // Where the time will stand: the send's state (CSS holds it back for
    // the busy beat), with the way to take it back; no progress bar.
    expect(within(card).getByText("Sending…").closest(".memo-send-state")?.classList.contains("is-sending")).toBe(true);
    expect(within(card).getByRole("button", { name: "Take back" })).toBeTruthy();
    expect(card.querySelector("time")).toBeNull();
    expect(card.querySelector(".send-progress")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();

    await act(async () => answer());
    await waitFor(() => expect(card.querySelector("time")).not.toBeNull());
    // The same card in the same slot: nothing entered twice.
    expect(screen.getByText("Quick thought").closest(".memo-slot")).toBe(slot);
    expect(card.classList.contains("is-unsent")).toBe(false);
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(memo(9, "").createdAt);
    expect(within(card).queryByRole("button", { name: "Take back" })).toBeNull();
    await waitFor(() => expect(spoken()).toBe("Sent"));
    expect(mocks.createMemo).toHaveBeenCalledTimes(1);
  });

  it("takes a memo still sending back into the composer, text and caret, and stops its request", async () => {
    let signal: AbortSignal | undefined;
    mocks.createMemo.mockImplementation(
      (_clientId: string, _content: string, _images: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("The send was stopped.", "AbortError")));
        })
    );
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Second thoughts");
    field().setSelectionRange(3, 9);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    expect(field().value).toBe("");

    await user.click(screen.getByRole("button", { name: "Take back" }));
    expect(signal?.aborted).toBe(true);
    expect(field().value).toBe("Second thoughts");
    expect([field().selectionStart, field().selectionEnd]).toEqual([3, 9]);
    expect(document.activeElement).toBe(field());
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(spoken()).toBe("Took the memo back into the composer");
    // A taking back, not a failure.
    expect(document.querySelector(".editor-note.is-open .editor-error")).toBeNull();
    expect(screen.queryByText(/Not sent/)).toBeNull();
  });

  it("won't take a memo back over a draft: send or clear the composer first", async () => {
    mocks.createMemo.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "First go");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    await user.type(field(), "Draft in progress");

    const takeBack = screen.getByRole("button", { name: "Take back" });
    await waitFor(() => expect(takeBack.getAttribute("aria-disabled")).toBe("true"));
    await user.click(takeBack);
    expect(await screen.findByText("Send or clear what’s in the composer first", { selector: ".toast-text" })).toBeTruthy();
    expect(field().value).toBe("Draft in progress");
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("keeps a card that couldn't be sent, says so, and sends it under the same id when the connection returns", async () => {
    mocks.createMemo
      .mockImplementationOnce(async () => {
        throw new ApiError("NETWORK_ERROR", 0, "The server could not be reached. Check your connection and try again.");
      })
      .mockImplementation(stores);
    setOnline(false);
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Offline thought");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("Offline thought").closest("article")?.classList.contains("is-send-failed")).toBe(true));
    const card = screen.getByText("Offline thought").closest("article")!;
    expect(within(card).getByText("Not sent · will retry when you’re online")).toBeTruthy();
    expect(card.querySelector(".memo-send-dot")).not.toBeNull();
    expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(spoken("alert")).toBe("Not sent · will retry when you’re online");
    // The composer was free for the next memo all along.
    expect(field().value).toBe("");

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(2));
    // The same id: a first request that got through after all is found, not doubled.
    expect(mocks.createMemo.mock.calls[1][0]).toBe(mocks.createMemo.mock.calls[0][0]);
    await waitFor(() => expect(card.querySelector("time")).not.toBeNull());
    expect(card.classList.contains("is-send-failed")).toBe(false);
    expect(screen.getAllByRole("article")).toHaveLength(3);
    await waitFor(() => expect(spoken()).toBe("Sent"));
  });

  it("takes a just-confirmed send back on ⌘Z in the untouched composer: the memo to Trash, its text back", async () => {
    mocks.createMemo.mockImplementation(stores);
    mocks.trashMemo.mockImplementation(async (id: string) => ({
      ok: true,
      memo: { ...memo(9, "Oops"), id, seq: 11, deletedAt: "2026-01-01T00:05:00.000Z" }
    }));
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.type(field(), "Oops");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(spoken()).toBe("Sent"));
    const id = mocks.createMemo.mock.calls[0][0] as string;

    // Prevented: the field's own undo history is not what this ⌘Z means.
    expect(fireEvent.keyDown(field(), { key: "z", ctrlKey: true })).toBe(false);
    expect(field().value).toBe("Oops");
    expect(spoken()).toBe("Took the memo back into the composer");
    await waitFor(() => expect(mocks.trashMemo).toHaveBeenCalledWith(id, memo(9, "").seq));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
  });
});

describe("a send still on its way", () => {
  /** A send whose answer waits for the test: `answer()` stores it, `fail()` turns it down. */
  function heldSends() {
    const held = { answer: () => undefined as void, fail: (_cause: unknown) => undefined as void };
    mocks.createMemo.mockImplementation(
      (id: string, content: string) =>
        new Promise((resolve, reject) => {
          held.answer = () => resolve({ memo: { ...memo(9, content), id } });
          held.fail = reject;
        })
    );
    return held;
  }

  async function sendOne(user: ReturnType<typeof userEvent.setup>, text: string): Promise<HTMLElement> {
    await user.type(field(), text);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(text).closest("article")).toBeTruthy());
    return screen.getByText(text).closest("article") as HTMLElement;
  }

  it("lets the sends behind one the server keeps failing through, and says that one is retrying", async () => {
    let fail: () => void = () => undefined;
    mocks.createMemo.mockImplementation((id: string, content: string) =>
      content === "Stuck thought"
        ? new Promise((_resolve, reject) => {
            fail = () => reject(new ApiError("INTERNAL_ERROR", 503, "The server is having trouble."));
          })
        : stores(id, content)
    );
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const stuck = await sendOne(user, "Stuck thought");
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    const next = await sendOne(user, "Next thought");

    await act(async () => fail());
    // The one behind it goes out on its own and is confirmed in its card…
    await waitFor(() => expect(next.querySelector("time")).not.toBeNull());
    expect(mocks.createMemo).toHaveBeenCalledTimes(2);
    // …while the failed one says it is trying again, not waiting for a connection that is there.
    expect(within(stuck).getByText("Not sent · retrying")).toBeTruthy();
    expect(within(stuck).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(spoken("alert")).toBe("Not sent · retrying");
  });

  it("keeps the selection through a long press on a card still sending", async () => {
    heldSends();
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const pending = await sendOne(user, "Pending thought");
    await user.click(screen.getByRole("button", { name: "All memos" }));
    await user.click(await screen.findByRole("menuitem", { name: "Select memos" }));
    const first = screen.getByText("First note").closest("article") as HTMLElement;
    await user.click(within(first).getByRole("button", { name: "Select this memo" }));
    expect(first.classList.contains("is-selected")).toBe(true);

    const line = pending.querySelector(".memo-content p") as HTMLElement;
    const finger = { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: 40, clientY: 40 };
    fireEvent.pointerDown(line, finger);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    fireEvent.pointerUp(line, finger);

    expect(screen.getByRole("button", { name: "Cancel selection" })).toBeTruthy();
    expect(first.classList.contains("is-selected")).toBe(true);
    expect(screen.queryByText(/Selection cleared/)).toBeNull();
  });

  it("leaves a right-click on it to the platform, with no unseen ⋯ menu to pop up later", async () => {
    const held = heldSends();
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const card = await sendOne(user, "Pending thought");
    const line = () => card.querySelector(".memo-content p") as HTMLElement;
    expect(fireEvent.contextMenu(line())).toBe(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByRole("menu")).toBeNull();

    await act(async () => held.answer());
    await waitFor(() => expect(card.querySelector("time")).not.toBeNull());
    expect(screen.queryByRole("menu")).toBeNull();
    // Sent, it has its ⋯ again, and a right-click opens it.
    expect(fireEvent.contextMenu(line())).toBe(false);
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("stays, and is confirmed, when its answer comes back while the passcode dialog is open", async () => {
    const held = heldSends();
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const card = await sendOne(user, "Mid-change thought");
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /My MEMO/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Change Passcode/ }));
    await screen.findByRole("dialog", { name: "Change passcode" });

    await act(async () => held.answer());
    await waitFor(() => expect(card.querySelector("time")).not.toBeNull());
    expect(card.isConnected).toBe(true);
    expect(card.classList.contains("is-unsent")).toBe(false);
  });

  it("is named before a logout drops it", async () => {
    heldSends();
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await sendOne(user, "Unsent thought");
    await user.click(screen.getByRole("button", { name: /My MEMO/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Log Out" }));
    const dialog = await screen.findByRole("dialog", { name: "Log out of this device?" });
    expect(within(dialog).getByText("1 memo not sent yet will be discarded.")).toBeTruthy();
    expect(dialog.textContent).toContain("sidebar layout");
  });
});
