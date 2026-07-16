// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { Editor } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { formatTime } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo, MemoImage, NewImagePayload } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  compressImage: vi.fn(),
  syncApi: {
    setCursor: vi.fn(),
    setSyncEpoch: vi.fn(),
    runSync: vi.fn(async () => undefined),
    notifyPeers: vi.fn(),
    notifyLogout: vi.fn()
  }
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getAuthStatus: mocks.getAuthStatus,
    bootstrap: mocks.bootstrap,
    syncSince: mocks.syncSince
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
  intersectionObservers = [];
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

    fireEvent.doubleClick(within(card).getByRole("button", { name: "Memo actions" }));
    expect(within(card).queryByRole("combobox")).toBeNull();

    fireEvent.doubleClick(content);
    const editor = await within(card).findByRole("combobox");
    expect((editor as HTMLTextAreaElement).value).toBe("Double-click this memo");
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
    await user.click(within(firstCard).getByRole("button", { name: "Memo actions" }));
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
    await user.click(within(secondCard).getByRole("button", { name: "Memo actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(within(firstCard).getByRole("combobox")).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("draft survives feed updates");
    expect(within(secondCard).queryByRole("combobox")).toBeNull();
    expect(await screen.findByText("Save or cancel the open edit before editing another memo.")).not.toBeNull();
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

    await user.click(within(card).getByRole("button", { name: "Memo actions" }));
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

    await user.click(within(card).getByRole("button", { name: "Memo actions" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("10 characters")).not.toBeNull();
    expect(within(menu).queryByText(/^Edited/)).toBeNull();
  });

  it("retires the meta footer while a delete confirmation is showing", async () => {
    const user = userEvent.setup();
    mocks.bootstrap.mockResolvedValue({
      memos: [{ ...memo(0), content: "hello world" }],
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

    const content = await screen.findByText(/hello world/);
    const card = content.closest("article");
    if (!card) throw new Error("Memo card was not rendered");

    await user.click(within(card).getByRole("button", { name: "Memo actions" }));
    expect(within(screen.getByRole("menu")).getByText("10 characters")).not.toBeNull();

    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }));
    const confirmMenu = screen.getByRole("menu");
    expect(within(confirmMenu).getByText("Delete this memo?")).not.toBeNull();
    expect(within(confirmMenu).queryByText("10 characters")).toBeNull();
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
