// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { Editor } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { ApiError } from "../src/lib/api";
import { formatTime } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo, MemoImage, NewImagePayload } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  updateMemo: vi.fn(),
  batchMemos: vi.fn(),
  trashMemo: vi.fn(),
  restoreMemo: vi.fn(),
  compressImage: vi.fn(),
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
    updateMemo: mocks.updateMemo,
    batchMemos: mocks.batchMemos,
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

vi.mock("../src/lib/images", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/images")>("../src/lib/images");
  return { ...actual, compressImage: mocks.compressImage };
});

vi.mock("../src/lib/useSync", () => ({
  useSync: () => mocks.syncApi
}));

interface TestIntersectionObserverInstance {
  trigger: () => void;
}

let intersectionObservers: TestIntersectionObserverInstance[] = [];

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function memo(index: number): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `memo-${index}`,
    content: `memo-${index} original`,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    deletedAt: null,
    seq: index + 1,
    images: []
  };
}

function storedImage(index: number): MemoImage {
  return { id: `stored-${index}`, mime: "image/webp", width: 120, height: 90, bytes: 128 };
}

function pendingImage(id: string): NewImagePayload {
  return {
    id,
    dataBase64: "AA==",
    mime: "image/webp",
    width: 120,
    height: 90,
    previewUrl: `blob:${id}`
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

beforeEach(() => {
  localStorage.clear();
  // A lens left in session history by an earlier test would be restored
  // like a reload in the same tab.
  sessionStorage.clear();
  window.history.replaceState(null, "");
  intersectionObservers = [];
  mocks.updateMemo.mockReset();
  mocks.batchMemos.mockReset();
  mocks.trashMemo.mockReset();
  mocks.restoreMemo.mockReset();
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos: Array.from({ length: 82 }, (_, index) => memo(index)),
    tags: [],
    cursor: 82,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({
    memos: [],
    purged: [],
    tags: [],
    cursor: 82,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z"
  });

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
  // The sidebar tag list cancels in-flight FLIP animations on every commit.
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly callback: IntersectionObserverCallback;

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        intersectionObservers.push({
          trigger: () => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
        });
      }

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

describe("App editor lifecycle", () => {
  it("opens a normal memo editor on a non-interactive double-click", async () => {
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content: "Double-click this memo" }],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: memo(0).createdAt,
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    const content = await screen.findByText(/Double-click this memo/);
    const card = content.closest("article");
    if (!card) throw new Error("Memo card was not rendered");

    fireEvent.doubleClick(within(card).getByRole("button", { name: /^Memo actions/ }));
    expect(within(card).queryByRole("combobox")).toBeNull();

    fireEvent.doubleClick(content);
    const editor = await within(card).findByRole("combobox");
    expect((editor as HTMLTextAreaElement).value).toBe("Double-click this memo");
  });

  it("opens a double-clicked memo with the caret after the clicked word", async () => {
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content: "first line\nalpha beta gamma\nlast line" }],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: memo(0).createdAt,
      hasMore: false,
      nextAfter: null
    });
    render(
      <Providers>
        <App />
      </Providers>
    );
    const row = await screen.findByText("alpha beta gamma");
    const card = row.closest("article")!;
    // What a real double-click leaves behind: the word under the pointer selected.
    const text = row.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.doubleClick(row);
    const editor = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    expect(editor.selectionStart).toBe("first line\nalpha beta".length);

    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(within(card).queryByRole("combobox")).toBeNull());
    window.getSelection()!.removeAllRanges();
    fireEvent.doubleClick(await within(card).findByText("last line"));
    const reopened = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    // No word selection: the end of the clicked line (here also the end).
    expect(reopened.selectionStart).toBe(reopened.value.length);
  });

  it("maps a double-click on display-rewritten rows back to the source line", async () => {
    // Row 0 renders with its reference resolved; the table rows render with a
    // "| " the source does not have. Offsets must come from the source.
    const content = "See [docs][1] for detail\nnext line\n\n[1]: https://example.com/a/very/long/path/to/docs\na | b\n--- | ---\n1 | 2\nafter";
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content }],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: memo(0).createdAt,
      hasMore: false,
      nextAfter: null
    });
    render(
      <Providers>
        <App />
      </Providers>
    );
    const card = (await screen.findByText("docs")).closest("article")!;
    const rows = () => Array.from(card.querySelector(".memo-content")!.children);
    const first = rows()[0];
    const tail = first.lastChild!;
    expect(tail.textContent).toBe(" for detail");
    const range = document.createRange();
    range.setStart(tail, 5);
    range.setEnd(tail, 11);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.doubleClick(first);
    const editor = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    expect(editor.selectionStart).toBe("See [docs][1] for detail".length);

    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(within(card).queryByRole("combobox")).toBeNull());
    window.getSelection()!.removeAllRanges();
    const bodyRow = rows().find((row) => row.textContent?.replace(/\s/g, "") === "12")!;
    fireEvent.doubleClick(bodyRow);
    const reopened = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    expect(reopened.selectionStart).toBe(content.indexOf("1 | 2") + "1 | 2".length);
  });

  it("closes an untouched edit silently, and offers Undo for a discarded one", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );
    const content = await screen.findByText("memo-81 original");
    const card = content.closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    let draft = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(card).queryByRole("combobox")).toBeNull());
    expect(screen.queryByText("Discarded your edits")).toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    draft = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    await user.type(draft, " with a long rewrite");
    draft.setSelectionRange(3, 7);
    fireEvent.keyDown(draft, { key: "Escape" });
    await waitFor(() => expect(within(card).queryByRole("combobox")).toBeNull());
    expect(screen.getByText("memo-81 original")).not.toBeNull();

    await screen.findByText("Discarded your edits");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    const reopened = (await within(card).findByRole("combobox")) as HTMLTextAreaElement;
    expect(reopened.value).toBe("memo-81 original with a long rewrite");
    expect([reopened.selectionStart, reopened.selectionEnd]).toEqual([3, 7]);
    expect(mocks.updateMemo).not.toHaveBeenCalled();
  });

  it("keeps the live draft mounted when the render cap grows and refuses to replace it with another editor", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <App />
      </Providers>
    );

    const firstContent = await screen.findByText("memo-81 original");
    const firstCard = firstContent.closest("article");
    if (!firstCard) throw new Error("First memo card was not rendered");
    await user.click(within(firstCard).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));

    const draft = await within(firstCard).findByRole("combobox");
    await user.clear(draft);
    await user.type(draft, "draft survives feed updates");

    expect(screen.queryByText("memo-0 original")).toBeNull();
    expect(intersectionObservers.length).toBeGreaterThan(0);
    act(() => {
      for (const observer of intersectionObservers) observer.trigger();
    });
    await screen.findByText("memo-0 original");
    expect(within(firstCard).getByRole("combobox")).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("draft survives feed updates");

    const secondContent = screen.getByText("memo-80 original");
    const secondCard = secondContent.closest("article");
    if (!secondCard) throw new Error("Second memo card was not rendered");
    await user.click(within(secondCard).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(within(firstCard).getByRole("combobox")).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("draft survives feed updates");
    expect(within(secondCard).queryByRole("combobox")).toBeNull();
    expect(await screen.findByText("Save or cancel the open edit before editing another memo.", { selector: ".toast-text" })).not.toBeNull();
  });
});

describe("App task flip queue", () => {
  it("bases a queued second batch on the first response before React commits a render", async () => {
    const user = userEvent.setup();
    const initial = { ...memo(0), content: "- [ ] alpha\n- [ ] beta", seq: 1 };
    const firstResult = { ...initial, content: "- [x] alpha\n- [ ] beta", seq: 2, updatedAt: "2026-01-01T00:00:10.000Z" };
    const secondResult = { ...firstResult, content: "- [x] alpha\n- [x] beta", seq: 3, updatedAt: "2026-01-01T00:00:11.000Z" };
    const firstRequest = deferred<{ memo: Memo }>();
    mocks.bootstrap.mockResolvedValue({
      memos: [initial],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: initial.createdAt,
      hasMore: false,
      nextAfter: null
    });
    mocks.updateMemo.mockImplementationOnce(() => firstRequest.promise).mockResolvedValueOnce({ memo: secondResult });

    render(
      <Providers>
        <App />
      </Providers>
    );

    await user.click(await screen.findByRole("checkbox", { name: "alpha" }));
    await waitFor(() =>
      expect(mocks.updateMemo).toHaveBeenNthCalledWith(1, initial.id, {
        expectedSeq: 1,
        content: "- [x] alpha\n- [ ] beta"
      })
    );
    await user.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(mocks.updateMemo).toHaveBeenCalledTimes(1);

    await act(async () => firstRequest.resolve({ memo: firstResult }));

    await waitFor(() =>
      expect(mocks.updateMemo).toHaveBeenNthCalledWith(2, initial.id, {
        expectedSeq: 2,
        content: "- [x] alpha\n- [x] beta"
      })
    );
  });

  it("stops safely on a version conflict instead of replaying a stale line index", async () => {
    const user = userEvent.setup();
    const initial = { ...memo(0), content: "- [ ] alpha\nbase", seq: 1 };
    const current = { ...initial, content: "- [ ] alpha\nremote edit", seq: 2, updatedAt: "2026-01-01T00:00:10.000Z" };
    mocks.bootstrap.mockResolvedValue({
      memos: [initial],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: initial.createdAt,
      hasMore: false,
      nextAfter: null
    });
    mocks.updateMemo.mockRejectedValueOnce(new ApiError("VERSION_CONFLICT", 409, "changed", undefined, current));

    render(
      <Providers>
        <App />
      </Providers>
    );

    await user.click(await screen.findByRole("checkbox", { name: "alpha" }));

    await screen.findByText("remote edit");
    expect(mocks.updateMemo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "alpha" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("This memo changed elsewhere. The latest version is now shown.", { selector: ".toast-text" })).not.toBeNull();
  });
});

describe("App stats drilldown search", () => {
  it("drops the pre-drilldown query, resets an expanded feed for a new query, and filters by new input", async () => {
    const user = userEvent.setup();
    const year = new Date().getFullYear();
    const many = Array.from({ length: 82 }, (_, index) => ({
      ...memo(index),
      content: index === 81 ? "shared target-only" : `shared memo-${index}`,
      createdAt: new Date(year, 0, 1, 0, 0, index).toISOString(),
      updatedAt: new Date(year, 0, 1, 0, 0, index).toISOString()
    }));
    mocks.bootstrap.mockResolvedValue({
      memos: many,
      tags: [],
      cursor: 82,
      syncEpoch: "epoch-a",
      serverTime: many.at(-1)!.createdAt,
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    const search = await screen.findByPlaceholderText("Search memos");
    await user.type(search, "target-only");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));

    const stats = screen.getByRole("region", { name: "Statistics" });
    await user.click(within(stats).getAllByRole("button")[0]);
    await user.click(await screen.findByRole("button", { name: `Show 82 memos from ${year}` }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(80));

    act(() => intersectionObservers.at(-1)?.trigger());
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(82));

    await user.type(screen.getByPlaceholderText("Search memos"), "shared");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(80));

    await user.type(screen.getByPlaceholderText("Search memos"), " target-only");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(screen.getByText("shared target-only")).not.toBeNull();
  });
});

describe("Memo menu metadata", () => {
  it("keeps the original card time while showing the word count and latest edit time in the menu", async () => {
    const user = userEvent.setup();
    const createdAt = "2026-01-02T03:04:00.000Z";
    const updatedAt = "2026-02-03T04:05:00.000Z";
    mocks.bootstrap.mockResolvedValue({
      memos: [
        {
          ...memo(0),
          content: "hello world https://example.com",
          createdAt,
          updatedAt
        }
      ],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: updatedAt,
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    const content = await screen.findByText(/hello world/);
    const card = content.closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    expect(within(card).getByText(formatTime(createdAt, "en-US"))).not.toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("10 characters")).not.toBeNull();
    const edited = within(menu).getByText(`Edited ${formatTime(updatedAt, "en-US")}`);
    expect(edited.getAttribute("datetime")).toBe(updatedAt);
    expect(within(card).getByText(formatTime(createdAt, "en-US"))).not.toBeNull();
  });

  it("shows the word count but no edited time for a memo that was never edited", async () => {
    const user = userEvent.setup();
    const sentAt = "2026-01-02T03:04:00.000Z";
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content: "hello world https://example.com", createdAt: sentAt, updatedAt: sentAt }],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: sentAt,
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    const content = await screen.findByText(/hello world/);
    const card = content.closest("article");
    if (!card) throw new Error("Memo card was not rendered");

    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("10 characters")).not.toBeNull();
    expect(within(menu).queryByText(/^Edited/)).toBeNull();
  });

  it("retires the meta footer while a permanent-delete confirmation is showing", async () => {
    const user = userEvent.setup();
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content: "hello world", deletedAt: "2026-01-01T00:05:00.000Z" }],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: memo(0).createdAt,
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    await user.click(await screen.findByRole("button", { name: /^Trash/ }));
    const content = await screen.findByText(/hello world/);
    const card = content.closest("article");
    if (!card) throw new Error("Memo card was not rendered");

    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    expect(within(screen.getByRole("menu")).getByText("10 characters")).not.toBeNull();

    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete permanently" }));
    const confirmMenu = screen.getByRole("menu");
    const confirm = within(confirmMenu).getByRole("menuitem", { name: "Delete forever" });
    // The consequence is the confirm item's description, and focus starts on
    // Cancel so a second Enter backs out.
    expect(confirm.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Delete forever? This can’t be undone.");
    await waitFor(() => expect(document.activeElement).toBe(within(confirmMenu).getByRole("menuitem", { name: "Cancel" })));
    expect(within(confirmMenu).queryByText("10 characters")).toBeNull();
  });
});

describe("Optimistic memo actions", () => {
  function bootWith(memos: Memo[]) {
    mocks.bootstrap.mockResolvedValue({
      memos,
      tags: [],
      cursor: memos.length,
      syncEpoch: "epoch-a",
      serverTime: memos[0].createdAt,
      hasMore: false,
      nextAfter: null
    });
    render(
      <Providers>
        <App />
      </Providers>
    );
  }

  it("pins at the click, holds a second tap while the request is out, and offers Undo once it lands", async () => {
    const user = userEvent.setup();
    const target = { ...memo(0), content: "pin me" };
    bootWith([target]);
    const request = deferred<{ memoPatch: { id: string; pinnedAt: string; seq: number } }>();
    mocks.updateMemo.mockReturnValueOnce(request.promise);

    const card = (await screen.findByText("pin me")).closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));

    // Shown before the server answers…
    expect(await within(card).findByLabelText("Pinned")).not.toBeNull();
    // …and the reverse waits for it instead of racing a stale seq.
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    expect((screen.getByRole("menuitem", { name: "Unpin", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");

    await act(async () => request.resolve({ memoPatch: { id: target.id, pinnedAt: "2026-01-01T01:00:00.000Z", seq: 9 } }));
    expect(await screen.findByText("Pinned")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).not.toBeNull();
    expect(within(card).getByLabelText("Pinned")).not.toBeNull();
    expect(mocks.updateMemo).toHaveBeenCalledTimes(1);
    expect(mocks.updateMemo).toHaveBeenCalledWith(target.id, { expectedSeq: target.seq, pinned: true });
  });

  it("peels a failed pin back off and says so", async () => {
    const user = userEvent.setup();
    const target = { ...memo(0), content: "pin fails" };
    bootWith([target]);
    const request = deferred<never>();
    mocks.updateMemo.mockReturnValueOnce(request.promise);

    const card = (await screen.findByText("pin fails")).closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(await within(card).findByLabelText("Pinned")).not.toBeNull();

    await act(async () => request.reject(new ApiError("NETWORK", 503, "offline")));
    await waitFor(() => expect(within(card).queryByLabelText("Pinned")).toBeNull());
    expect(await screen.findByText("offline", { selector: ".toast *" })).not.toBeNull();
  });

  it("moves a memo to Trash in one tap, before the server answers", async () => {
    const user = userEvent.setup();
    const target = { ...memo(0), content: "trash me" };
    bootWith([target, { ...memo(1), content: "keep me" }]);
    const request = deferred<{ memo: Memo }>();
    mocks.trashMemo.mockReturnValueOnce(request.promise);

    const card = (await screen.findByText("trash me")).closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));

    await waitFor(() => expect(screen.queryByText("trash me")).toBeNull());
    expect(mocks.trashMemo).toHaveBeenCalledWith(target.id, target.seq);

    await act(async () => request.resolve({ memo: { ...target, deletedAt: "2026-01-01T02:00:00.000Z", seq: 11 } }));
    expect(await screen.findByText("Moved to Trash")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).not.toBeNull();
    expect(screen.queryByText("trash me")).toBeNull();
  });

  it("keeps the tag view when trashing its last memo fails", async () => {
    const user = userEvent.setup();
    const target = { ...memo(0), content: "solo memo #solo" };
    bootWith([target, { ...memo(1), content: "keep me" }]);
    const request = deferred<never>();
    mocks.trashMemo.mockReturnValueOnce(request.promise);

    const card = (await screen.findByText(/solo memo/)).closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    await user.click(within(card).getByRole("button", { name: "#solo" }));
    await waitFor(() => expect(screen.queryByText("keep me")).toBeNull());

    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    await waitFor(() => expect(screen.queryByText(/solo memo/)).toBeNull());

    await act(async () => request.reject(new ApiError("NETWORK", 503, "offline")));
    expect(await screen.findByText(/solo memo/)).not.toBeNull();
    // Still inside #solo: the guess never reset the filter.
    expect(screen.queryByText("keep me")).toBeNull();
  });
});

describe("Memo menu tagging", () => {
  it("appends the picked tag to that memo alone", async () => {
    const user = userEvent.setup();
    const tagged = { ...memo(0), id: "memo-tagged", content: "alpha memo #work" };
    const target = { ...memo(1), id: "memo-target", content: "beta memo" };
    const updated = { ...target, content: "beta memo\n#work", seq: 9, updatedAt: "2026-01-01T00:03:00.000Z" };
    mocks.bootstrap.mockResolvedValue({
      memos: [tagged, target],
      tags: [],
      cursor: 2,
      syncEpoch: "epoch-a",
      serverTime: target.createdAt,
      hasMore: false,
      nextAfter: null
    });
    mocks.batchMemos.mockResolvedValue({ patches: [], memos: [updated], purged: [], unchanged: [], failed: [] });

    render(
      <Providers>
        <App />
      </Providers>
    );

    const card = (await screen.findByText("beta memo")).closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Add tag" }));

    const dialog = await screen.findByRole("dialog", { name: "Add tag to this memo" });
    await user.click(within(dialog).getByRole("button", { name: "#work" }));
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add tag to this memo" })).toBeNull());
    // The server appends the tag to its own copy; no memo text is uploaded.
    expect(mocks.batchMemos).toHaveBeenCalledTimes(1);
    expect(mocks.batchMemos).toHaveBeenCalledWith("tag", [{ id: "memo-target", expectedSeq: target.seq }], expect.objectContaining({ tag: "work" }));
    expect(mocks.updateMemo).not.toHaveBeenCalled();
    expect(within(card).getByRole("button", { name: "#work" })).not.toBeNull();
    expect(await screen.findByText("Added #work", { selector: ".toast-text" })).not.toBeNull();
  });

  it("refuses a tag the memo already carries, before any request", async () => {
    const user = userEvent.setup();
    const tagged = { ...memo(0), id: "memo-tagged", content: "alpha memo #work #work/client" };
    mocks.bootstrap.mockResolvedValue({
      memos: [tagged],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: tagged.createdAt,
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    const card = (await screen.findByText(/alpha memo/)).closest("article");
    if (!card) throw new Error("Memo card was not rendered");
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Add tag" }));

    const dialog = await screen.findByRole("dialog", { name: "Add tag to this memo" });
    expect(within(dialog).queryByRole("button", { name: "#work" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "#work/client" })).toBeNull();

    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "work");
    expect(within(dialog).getByText(/Already on this memo/)).not.toBeNull();
    expect((within(dialog).getByRole("button", { name: "Add tag" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.updateMemo).not.toHaveBeenCalled();
  });

  it("stays out of the trash menu", async () => {
    const user = userEvent.setup();
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content: "deleted memo", deletedAt: "2026-01-01T00:05:00.000Z" }],
      tags: [],
      cursor: 1,
      syncEpoch: "epoch-a",
      serverTime: "2026-01-01T00:05:00.000Z",
      hasMore: false,
      nextAfter: null
    });

    render(
      <Providers>
        <App />
      </Providers>
    );

    await user.click(await screen.findByRole("button", { name: /^Trash/ }));
    const card = (await screen.findByText("deleted memo")).closest("article");
    if (!card) throw new Error("Trashed memo card was not rendered");

    // Restore is on the card itself, always visible; the menu keeps the rest.
    expect(within(card).getByRole("button", { name: /^Restore memo deleted/ })).not.toBeNull();
    await user.click(within(card).getByRole("button", { name: /^Memo actions, deleted/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Restore" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Delete permanently" })).not.toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Add tag" })).toBeNull();
  });
});

describe("Editor attachment reservations", () => {
  it("releases the preview URL after a create is confirmed", async () => {
    const user = userEvent.setup();
    mocks.compressImage.mockResolvedValue(pendingImage("created"));
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const onSubmit = vi.fn(async () => true);

    const view = render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Image file input was not rendered");
    fireEvent.change(fileInput, {
      target: { files: [new File(["a"], "a.png", { type: "image/png" })] }
    });

    await screen.findByRole("button", { name: "Remove image" });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:created");
  });

  it("shows image upload progress on the send button and names a full database", async () => {
    const user = userEvent.setup();
    mocks.compressImage.mockResolvedValue(pendingImage("uploading"));
    const finish = deferred<void>();
    let reportProgress: ((fraction: number) => void) | undefined;
    const onSubmit = vi.fn(async (data: { onUploadProgress?: (fraction: number) => void }) => {
      reportProgress = data.onUploadProgress;
      await finish.promise;
      throw new ApiError("STORAGE_FULL", 507, "The D1 database is full.");
    });

    const view = render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Image file input was not rendered");
    fireEvent.change(fileInput, { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await screen.findByRole("button", { name: "Remove image" });

    // The idle chip already reserves the widest figure, so it does not widen
    // when the label turns into a percentage.
    const sendButton = screen.getByRole("button", { name: "Send" });
    const sizers = () => [...sendButton.querySelectorAll(".send-percent-sizer")].map((node) => node.textContent);
    expect(sizers()).toEqual(["99%"]);

    await user.click(sendButton);
    await waitFor(() => expect(reportProgress).toBeTypeOf("function"));
    expect(sizers()).toEqual(["Send", "99%"]);
    act(() => reportProgress?.(0.42));

    const progress = screen.getByRole("progressbar", { name: "Uploading images" });
    expect(progress.getAttribute("aria-valuenow")).toBe("42");
    // A button's children are presentational to assistive tech, so the
    // progressbar must live outside the send button to be announced.
    expect(progress.closest("button")).toBeNull();
    expect(screen.getByText("42%")).not.toBeNull();
    // Every byte sent is not the same as saved: hold short of 100 until the reply.
    act(() => reportProgress?.(1));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("99");

    await act(async () => finish.resolve());
    expect(await screen.findByText(/The D1 database is full, so nothing new can be saved/)).not.toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The draft and its attachment stay in the composer for a retry.
    expect(screen.getByRole("button", { name: "Remove image" })).not.toBeNull();
  });

  it("leaves text-only saves on fetch without an upload progress callback", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_data: { onUploadProgress?: (fraction: number) => void }) => true);
    render(
      <Providers>
        <Editor mode="create" initialContent="just words" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].onUploadProgress).toBeUndefined();
  });

  it("discards an in-flight compression result when a remote attachment consumes its slot", async () => {
    const first = deferred<NewImagePayload>();
    const second = deferred<NewImagePayload>();
    mocks.compressImage.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const onSubmit = vi.fn(async () => false);
    const initialImages = Array.from({ length: 7 }, (_, index) => storedImage(index));

    const view = render(
      <Providers>
        <Editor mode="edit" initialContent="draft" existingImages={initialImages} knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Image file input was not rendered");
    fireEvent.change(fileInput, {
      target: {
        files: [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })]
      }
    });
    await waitFor(() => expect(mocks.compressImage).toHaveBeenCalledTimes(1));

    view.rerender(
      <Providers>
        <Editor
          mode="edit"
          initialContent="draft"
          existingImages={[...initialImages, storedImage(7)]}
          knownTags={[]}
          busy={false}
          onSubmit={onSubmit}
        />
      </Providers>
    );

    await act(async () => first.resolve(pendingImage("first")));
    await waitFor(() => expect(mocks.compressImage).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(pendingImage("second")));

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove image" })).toHaveLength(9));
    expect(screen.getByText("You can add up to 9 images")).not.toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
  });
});
