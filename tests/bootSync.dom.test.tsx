// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import { ApiError, AuthRequiredError, type BootstrapResponse, type SyncResponse } from "../src/lib/api";
import type { SealedSnapshotHandle, Snapshot } from "../src/lib/cache";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo, TagMeta } from "../src/lib/types";
import type { PurgedMemo } from "../src/lib/syncState";

type ApplyChanges = (memos: readonly Memo[], purged: readonly PurgedMemo[], tags: readonly TagMeta[], cursor: number) => void;

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  readSealedSnapshot: vi.fn(),
  openSnapshot: vi.fn(),
  saveSnapshot: vi.fn(async () => undefined),
  invalidateSnapshot: vi.fn(async () => undefined),
  syncOptions: { current: null as null | { enabled: boolean; applyChanges: ApplyChanges } },
  semanticEnabled: [] as boolean[],
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
  invalidateSnapshot: mocks.invalidateSnapshot,
  openSnapshot: mocks.openSnapshot,
  readSealedSnapshot: mocks.readSealedSnapshot,
  saveSnapshot: mocks.saveSnapshot
}));

// Records what App asks of semantic search; the hook itself stays off, so no
// model or index store is touched.
vi.mock("../src/hooks/useSemanticSearch", async () => {
  const actual = await vi.importActual<typeof import("../src/hooks/useSemanticSearch")>("../src/hooks/useSemanticSearch");
  return {
    ...actual,
    useSemanticSearch: (enabled: boolean, ...rest: unknown[]) => {
      mocks.semanticEnabled.push(enabled);
      return (actual.useSemanticSearch as (...args: unknown[]) => ReturnType<typeof actual.useSemanticSearch>)(false, ...rest);
    }
  };
});

vi.mock("../src/lib/useSync", () => ({
  useSync: (options: { enabled: boolean; applyChanges: ApplyChanges }) => {
    mocks.syncOptions.current = options;
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

function page(memos: Memo[], overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    memos,
    tags: [],
    cursor: 10,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
    hasMore: false,
    nextAfter: null,
    ...overrides
  };
}

function syncResponse(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return { memos: [], purged: [], tags: [], cursor: 10, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z", ...overrides };
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

// The sync line is not a live region itself (the app's standing live
// regions speak it), so find it by its class.
function syncNotice(): HTMLElement {
  const notice = document.querySelector<HTMLElement>(".sync-notice");
  if (!notice) throw new Error("sync notice not rendered");
  return notice;
}

function renderApp() {
  return render(
    <Providers>
      <App />
    </Providers>
  );
}

const sealed = { v: 4, epoch: "tab-epoch", cursor: 7, shards: [], shardRecords: [] } as unknown as SealedSnapshotHandle;

beforeEach(() => {
  localStorage.clear();
  mocks.syncOptions.current = null;
  mocks.semanticEnabled.length = 0;
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.readSealedSnapshot.mockResolvedValue(null);
  mocks.openSnapshot.mockResolvedValue(null);
  mocks.syncSince.mockResolvedValue(syncResponse());
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cold start", () => {
  it("renders the first page at once, counts the rest in, and saves only the whole notebook", async () => {
    const rest = deferred<BootstrapResponse>();
    mocks.bootstrap
      .mockResolvedValueOnce(page([memo(3)], { hasMore: true, nextAfter: "cursor-1", total: 3 }))
      .mockReturnValueOnce(rest.promise);

    renderApp();
    expect(await screen.findByText("memo-3 original")).toBeTruthy();
    expect(syncNotice().textContent).toContain("Loading memos · 1 of 3");
    // Sync runs from the frozen cursor while pages are still arriving.
    expect(mocks.syncOptions.current?.enabled).toBe(true);
    expect(mocks.syncApi.setCursor).toHaveBeenCalledWith(10);
    expect(mocks.bootstrap).toHaveBeenLastCalledWith("cursor-1", 10);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();

    await act(async () => rest.resolve(page([memo(2), memo(1)])));
    expect(await screen.findByText("memo-1 original")).toBeTruthy();
    expect(screen.queryByText(/Loading memos/)).toBeNull();
    await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const saved = mocks.saveSnapshot.mock.calls[0] as unknown as [Snapshot];
    expect(saved[0].memos.map((item) => item.id).sort()).toEqual(["memo-1", "memo-2", "memo-3"]);
    expect(saved[0].cursor).toBe(10);
  });

  it("never lets a late page roll back a newer synced version or resurrect a purged memo", async () => {
    const rest = deferred<BootstrapResponse>();
    mocks.bootstrap
      .mockResolvedValueOnce(page([memo(3)], { hasMore: true, nextAfter: "cursor-1", total: 3 }))
      .mockReturnValueOnce(rest.promise);

    renderApp();
    await screen.findByText("memo-3 original");
    // The page was read before these changes committed; sync delivers them first.
    act(() => {
      mocks.syncOptions.current?.applyChanges([memo(2, { content: "memo-2 edited", seq: 11 })], [{ id: "memo-1", seq: 12 }], [], 12);
    });
    await act(async () => rest.resolve(page([memo(2), memo(1)])));

    expect(await screen.findByText("memo-2 edited")).toBeTruthy();
    expect(screen.queryByText("memo-2 original")).toBeNull();
    expect(screen.queryByText("memo-1 original")).toBeNull();
    await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalled(), { timeout: 2_000 });
    const saved = mocks.saveSnapshot.mock.calls.at(-1) as unknown as [Snapshot];
    expect(saved[0].cursor).toBe(12);
    expect(saved[0].purged).toEqual([{ id: "memo-1", seq: 12 }]);
  });

  it("resumes a failed load from the same cursor instead of starting over", async () => {
    mocks.bootstrap
      .mockResolvedValueOnce(page([memo(3)], { hasMore: true, nextAfter: "cursor-1", total: 3 }))
      .mockRejectedValueOnce(new ApiError("REQUEST_FAILED", 500, "boom"))
      .mockRejectedValueOnce(new ApiError("REQUEST_FAILED", 500, "boom"))
      .mockResolvedValueOnce(page([memo(2)], { hasMore: true, nextAfter: "cursor-2" }))
      .mockResolvedValueOnce(page([memo(1)]));

    renderApp();
    await screen.findByText("memo-3 original");
    // One retry runs on its own; the second miss is said out loud.
    const retry = await screen.findByRole("button", { name: "Retry" }, { timeout: 3_000 });
    expect(syncNotice().textContent).toContain("Couldn’t load the rest of your memos · 1 of 3 loaded");
    fireEvent.click(retry);

    expect(await screen.findByText("memo-1 original")).toBeTruthy();
    expect(mocks.bootstrap.mock.calls).toEqual([[], ["cursor-1", 10], ["cursor-1", 10], ["cursor-1", 10], ["cursor-2", 10]]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("while older pages are still loading", () => {
  function startLoading(firstPage: Memo[], total = 3) {
    const rest = deferred<BootstrapResponse>();
    mocks.bootstrap
      .mockResolvedValueOnce(page(firstPage, { hasMore: true, nextAfter: "cursor-1", total }))
      .mockReturnValueOnce(rest.promise);
    renderApp();
    return rest;
  }

  it("keeps Empty Trash disabled, since emptying purges trashed memos not loaded yet", async () => {
    const trashed = { deletedAt: "2026-01-02T00:00:00.000Z" };
    const rest = startLoading([memo(3, trashed)]);
    fireEvent.click(await screen.findByRole("button", { name: /^Trash/ }));
    await screen.findByText("memo-3 original");
    const empty = screen.getByRole("button", { name: "Empty Trash" }) as HTMLButtonElement;
    expect(empty.disabled).toBe(true);
    fireEvent.click(empty);
    expect(screen.queryByRole("button", { name: /forever/ })).toBeNull();

    await act(async () => rest.resolve(page([memo(2, trashed), memo(1)])));
    await waitFor(() => expect((screen.getByRole("button", { name: "Empty Trash" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    expect(screen.getByRole("button", { name: "Delete 2 memos forever?" })).toBeTruthy();
  });

  it("never saves a Daily review batch drawn from the partial pool", async () => {
    const rest = startLoading([memo(3)]);
    await screen.findByText("memo-3 original");
    fireEvent.click(screen.getByRole("button", { name: /^Daily review/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Daily review/ }).getAttribute("aria-current")).toBeTruthy());
    expect(localStorage.getItem("memo-review-day")).toBeNull();

    await act(async () => rest.resolve(page([memo(2), memo(1)])));
    await waitFor(() => expect(screen.queryByText(/Loading memos/)).toBeNull());
    // The next visit draws from the whole notebook and freezes that batch.
    fireEvent.click(screen.getByRole("button", { name: /^Daily review/ }));
    await waitFor(() => expect(localStorage.getItem("memo-review-day")).not.toBeNull());
  });

  it("holds semantic search until the notebook is whole, so reconcile never prunes unloaded memos", async () => {
    localStorage.setItem("memo:semantic-search", "1");
    const rest = startLoading([memo(3)]);
    await screen.findByText("memo-3 original");
    expect(mocks.semanticEnabled.at(-1)).toBe(false);
    expect(mocks.semanticEnabled).not.toContain(true);

    await act(async () => rest.resolve(page([memo(2), memo(1)])));
    await screen.findByText("memo-1 original");
    await waitFor(() => expect(mocks.semanticEnabled.at(-1)).toBe(true));
  });

  it("pauses through a passcode change instead of dropping to login on an old-cookie 401", async () => {
    const rest = startLoading([memo(3)]);
    await screen.findByText("memo-3 original");
    fireEvent.click(screen.getByRole("button", { name: /My MEMO/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change Passcode/ }));
    await screen.findByRole("dialog", { name: "Change passcode" });

    // The page in flight went out with the old cookie and lands after the rotation.
    mocks.bootstrap.mockResolvedValueOnce(page([memo(2), memo(1)]));
    await act(async () => rest.reject(new AuthRequiredError()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/session has expired/)).toBeNull();
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("memo-1 original")).toBeTruthy();
    expect(mocks.bootstrap.mock.calls).toEqual([[], ["cursor-1", 10], ["cursor-1", 10]]);
    expect(screen.queryByText(/Loading memos/)).toBeNull();
  });

  it("sends no retry with the old cookie while the passcode changes, then resumes from the same cursor", async () => {
    mocks.bootstrap
      .mockResolvedValueOnce(page([memo(3)], { hasMore: true, nextAfter: "cursor-1", total: 3 }))
      .mockRejectedValueOnce(new ApiError("REQUEST_FAILED", 500, "boom"))
      .mockResolvedValueOnce(page([memo(2), memo(1)]));
    renderApp();
    await screen.findByText("memo-3 original");
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /My MEMO/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change Passcode/ }));
    await screen.findByRole("dialog", { name: "Change passcode" });

    // The one-second backoff runs out while the dialog is open: nothing goes out.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("memo-1 original")).toBeTruthy();
    expect(mocks.bootstrap.mock.calls).toEqual([[], ["cursor-1", 10], ["cursor-1", 10]]);
  });
});

describe("multi-tab snapshot persistence", () => {
  it("leaves saving to the tab that holds the writer lock", async () => {
    let grant: (() => void) | null = null;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => Promise<void>) =>
          new Promise<void>((resolve) => {
            grant = () => void callback().then(resolve);
          })
      }
    });
    try {
      mocks.bootstrap.mockResolvedValue(page([memo(1)]));
      renderApp();
      await screen.findByText("memo-1 original");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(mocks.saveSnapshot).not.toHaveBeenCalled();

      // The previous writer closed: this tab takes over and saves once.
      act(() => grant?.());
      await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    } finally {
      delete (navigator as Navigator & { locks?: unknown }).locks;
    }
  });
});

describe("boot waterfall", () => {
  it("opens a warm snapshot from the first sync without waiting for auth status", async () => {
    mocks.getAuthStatus.mockReturnValue(new Promise(() => undefined));
    mocks.readSealedSnapshot.mockResolvedValue(sealed);
    mocks.syncSince.mockResolvedValue(syncResponse({ cursor: 9, hasMore: true, memos: [memo(5, { seq: 9 })] }));
    mocks.openSnapshot.mockResolvedValue({ cursor: 7, syncEpoch: "epoch-a", memos: [memo(4)], tags: [], purged: [] });

    renderApp();
    expect(await screen.findByText("memo-5 original")).toBeTruthy();
    expect(screen.getByText("memo-4 original")).toBeTruthy();
    expect(mocks.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(mocks.syncSince).toHaveBeenCalledTimes(1);
    expect(mocks.syncSince).toHaveBeenCalledWith(7, { includeCacheKey: true });
    // A long gap pages on through the sync hook from the first page's cursor.
    expect(mocks.syncApi.setCursor).toHaveBeenLastCalledWith(9);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("starts status and the first pull together and asks status only to pick setup or login", async () => {
    const status = deferred<{ needsSetup: boolean }>();
    mocks.getAuthStatus.mockReturnValue(status.promise);
    mocks.bootstrap.mockRejectedValue(new AuthRequiredError());

    renderApp();
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledTimes(1));
    expect(mocks.getAuthStatus).toHaveBeenCalledTimes(1);
    await act(async () => status.resolve({ needsSetup: true }));
    expect(await screen.findByText("Create an access passcode")).toBeTruthy();
  });
});
