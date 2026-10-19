// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { ApiError } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  renameTag: vi.fn(),
  batchMemos: vi.fn(),
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
  return {
    ...actual,
    getAuthStatus: mocks.getAuthStatus,
    bootstrap: mocks.bootstrap,
    syncSince: mocks.syncSince,
    renameTag: mocks.renameTag,
    batchMemos: mocks.batchMemos,
    createMemo: mocks.createMemo
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

// The applyChanges hook lets a test deliver a sync page mid-action.
let applySync: ((memos: Memo[], purged: [], tags: []) => void) | null = null;
vi.mock("../src/lib/useSync", () => ({
  useSync: (options: { applyChanges: typeof applySync }) => {
    applySync = options.applyChanges;
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

function memo(id: string, content: string, seq: number): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return { id, content, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, deletedAt: null, seq, images: [] };
}

const WORK = memo("m-work", "alpha #work", 1);
const LIFE = memo("m-life", "beta #life", 2);

function renameResult(memos: Memo[]) {
  return { memos, tags: [], updated: memos.length, hasMore: false, nextAfter: null };
}

async function openRename(user: ReturnType<typeof userEvent.setup>, path: string) {
  await user.click(await screen.findByRole("button", { name: `Actions for tag ${path}` }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog", { name: `Rename tag #${path}` });
  const input = within(dialog).getByRole("textbox");
  await user.clear(input);
  return { dialog, input };
}

beforeEach(() => {
  localStorage.clear();
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos: [WORK, LIFE],
    tags: [],
    cursor: 2,
    syncEpoch: "epoch-a",
    serverTime: LIFE.createdAt,
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 2, syncEpoch: "epoch-a", serverTime: LIFE.createdAt });
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
  delete (navigator as { onLine?: boolean }).onLine;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("tag rename follow-ups", () => {
  it("offers Undo for a plain rename and carries presets and the review scope along", async () => {
    localStorage.setItem(
      "memo-saved-filters",
      JSON.stringify([{ id: "f1", name: "Work", query: "", tag: "work", day: null, filters: {} }])
    );
    localStorage.setItem("memo-review-settings", JSON.stringify({ scope: "include", tags: ["work"], range: "all", count: 10 }));
    const renamed = { ...WORK, content: "alpha #job", seq: 3 };
    mocks.renameTag.mockResolvedValueOnce(renameResult([renamed])).mockResolvedValueOnce(renameResult([{ ...WORK, seq: 4 }]));
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );

    const { dialog, input } = await openRename(user, "work");
    await user.type(input, "job");
    expect(within(dialog).queryByText(/can’t be undone/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(await screen.findByText("Renamed #work to #job in 1 memo")).not.toBeNull();
    expect(mocks.renameTag).toHaveBeenCalledWith("work", "job", expect.any(Function));
    expect(JSON.parse(localStorage.getItem("memo-saved-filters") ?? "[]")[0].tag).toBe("job");
    expect(JSON.parse(localStorage.getItem("memo-review-settings") ?? "{}").tags).toEqual(["job"]);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.renameTag).toHaveBeenLastCalledWith("job", "work", undefined));
    expect(await screen.findByText("Renamed #job back to #work", { selector: ".toast *" })).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("memo-review-settings") ?? "{}").tags).toEqual(["work"]);
  });

  it("warns in words before a merge and leaves no Undo afterwards", async () => {
    mocks.renameTag.mockResolvedValueOnce(renameResult([{ ...WORK, content: "alpha #life", seq: 3 }]));
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );

    const { dialog, input } = await openRename(user, "work");
    await user.type(input, "life");
    // Said once typing pauses, in the note row's strong voice.
    const warning = await within(dialog).findByText("#life already exists. Merging the two tags can’t be undone.");
    expect(warning.closest(".prompt-note")?.classList.contains("is-strong")).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));

    expect(await screen.findByText("Merged #work into #life in 1 memo", { selector: ".toast *" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("carries a rename into a send still waiting, and counts its tags as in use", async () => {
    let online = false;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
    mocks.createMemo
      .mockImplementationOnce(async () => {
        throw new ApiError("NETWORK_ERROR", 0, "The server could not be reached.");
      })
      .mockImplementation(async (id: string, content: string) => ({ memo: { ...memo(id, content, 5) } }));
    mocks.renameTag.mockResolvedValueOnce(renameResult([{ ...WORK, content: "alpha #job", seq: 3 }]));
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );
    await screen.findByText("alpha");
    fireEvent.change(screen.getByRole("combobox", { name: "Memo content" }), { target: { value: "gamma #fresh #work" } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("gamma").closest("article")?.classList.contains("is-send-failed")).toBe(true));

    // Only the unsent memo carries #fresh: renaming onto it would merge.
    const { dialog, input } = await openRename(user, "work");
    await user.type(input, "fresh");
    expect(await within(dialog).findByText("#fresh already exists. Merging the two tags can’t be undone.")).toBeTruthy();
    await user.clear(input);
    await user.type(input, "job");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Renamed #work to #job in 1 memo", { selector: ".toast *" })).not.toBeNull();
    // Its card, and what goes to the server once the connection is back.
    const card = screen.getByText("gamma").closest("article") as HTMLElement;
    expect(card.textContent).toContain("gamma #fresh #job");
    online = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(mocks.createMemo).toHaveBeenCalledTimes(2));
    expect(mocks.createMemo.mock.calls[1][1]).toBe("gamma #fresh #job");
  });

  it("refuses a saved filter whose tag no longer exists instead of widening to every memo", async () => {
    localStorage.setItem(
      "memo-saved-filters",
      JSON.stringify([{ id: "f1", name: "Reading", query: "", tag: "reading", day: null, filters: {} }])
    );
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );

    await user.click(await screen.findByRole("button", { name: "Filter memos" }));
    await user.click(await screen.findByRole("button", { name: "Reading" }));
    expect(await screen.findByText("Couldn’t apply “Reading”: #reading no longer exists", { selector: ".toast *" })).not.toBeNull();
  });

  it("follows another tab's saved-filter changes", async () => {
    render(
      <Providers>
        <App />
      </Providers>
    );
    await screen.findByText("alpha");
    const next = JSON.stringify([{ id: "f2", name: "Life", query: "", tag: "life", day: null, filters: {} }]);
    localStorage.setItem("memo-saved-filters", next);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "memo-saved-filters", newValue: next }));
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    expect(await screen.findByRole("button", { name: "Life" })).not.toBeNull();
  });
});

describe("select-mode keys and ranges", () => {
  async function enterSelect(user: ReturnType<typeof userEvent.setup>) {
    render(
      <Providers>
        <App />
      </Providers>
    );
    await screen.findByText("alpha");
    await user.click(document.querySelector<HTMLButtonElement>(".loc-trigger")!);
    await user.click(await screen.findByRole("menuitem", { name: "Select memos" }));
    await screen.findByRole("button", { name: "Cancel selection" });
  }

  it("takes every memo in the list on ⌘/Ctrl+A, and only arms the batch delete on Delete", async () => {
    const user = userEvent.setup();
    await enterSelect(user);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(() => expect(document.querySelectorAll(".memo-card.is-selected")).toHaveLength(2));

    fireEvent.keyDown(window, { key: "Delete" });
    // Armed, with focus on the pill (Enter confirms there, leaving it disarms) — nothing deleted yet.
    const armed = await screen.findByRole("button", { name: "Move 2 memos to Trash?" });
    expect(document.activeElement).toBe(armed);
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(mocks.batchMemos).not.toHaveBeenCalled();
  });

  it("leaves ⌘/Ctrl+A to a text field", async () => {
    const user = userEvent.setup();
    await enterSelect(user);
    const search = screen.getByRole("combobox", { name: "Search memos" });
    const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      search.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelectorAll(".memo-card.is-selected")).toHaveLength(0);
  });

  it("selects the range from the last pick on a shift-click", async () => {
    mocks.bootstrap.mockResolvedValue({
      memos: [WORK, LIFE, memo("m-third", "gamma", 3), memo("m-fourth", "delta", 4)],
      tags: [],
      cursor: 4,
      syncEpoch: "epoch-a",
      serverTime: LIFE.createdAt,
      hasMore: false,
      nextAfter: null
    });
    const user = userEvent.setup();
    await enterSelect(user);
    const overlays = () => screen.getAllByRole("button", { name: /^(Select|Deselect) this memo$/ });
    expect(overlays()).toHaveLength(4);
    await user.click(overlays()[0]);
    fireEvent.click(overlays()[2], { shiftKey: true });
    const picked = () => Array.from(document.querySelectorAll(".memo-card")).map((card) => card.classList.contains("is-selected"));
    expect(picked()).toEqual([true, true, true, false]);
    // From that pick, a shift-click on a picked card takes the range back out.
    fireEvent.click(overlays()[1], { shiftKey: true });
    expect(picked()).toEqual([true, false, false, false]);
  });
});

describe("select-mode batch actions", () => {
  it("trashes the whole selection through the batch endpoint, unshaken by a sync mid-batch, and offers Undo", async () => {
    let settle!: (value: unknown) => void;
    mocks.batchMemos.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );
    await screen.findByText("alpha");
    await user.click(document.querySelector<HTMLButtonElement>(".loc-trigger")!);
    await user.click(await screen.findByRole("menuitem", { name: "Select memos" }));
    await user.click(await screen.findByRole("button", { name: "Select all memos" }));
    const trash = screen.getByRole("button", { name: "Move selected memos to Trash" });
    // Small selections trash at once (Undo instead of a confirm; feed-cards #112).
    await user.click(trash);

    expect(mocks.batchMemos).toHaveBeenCalledTimes(1);
    const [op, items] = mocks.batchMemos.mock.calls[0] as [string, { id: string; expectedSeq: number }[]];
    expect(op).toBe("trash");
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        { id: LIFE.id, expectedSeq: LIFE.seq },
        { id: WORK.id, expectedSeq: WORK.seq }
      ])
    );
    // The first chunk's commit arrives through sync before the batch returns.
    const deletedAt = "2026-01-02T00:00:00.000Z";
    act(() => applySync?.([{ ...WORK, deletedAt, seq: 10 }], [], []));
    expect(screen.queryByText(/left the selection/)).toBeNull();

    await act(async () => {
      settle({
        patches: [
          { id: WORK.id, deletedAt, seq: 10 },
          { id: LIFE.id, deletedAt, seq: 11 }
        ],
        memos: [],
        purged: [],
        unchanged: [],
        failed: []
      });
    });
    expect(await screen.findByText("Moved 2 memos to Trash")).not.toBeNull();
    expect(screen.queryByText(/left the selection|Selection cleared/)).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).not.toBeNull();
  });
});
