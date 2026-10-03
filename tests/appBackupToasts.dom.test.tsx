// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { TipProvider } from "../src/components/Tip";
import type { ExportProgress } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  exportData: vi.fn(),
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
    exportData: mocks.exportData
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

const seeded: Memo = {
  id: "memo-0",
  content: "Seeded memo",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  pinnedAt: null,
  deletedAt: null,
  seq: 1,
  images: []
};

beforeEach(() => {
  localStorage.clear();
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false });
  mocks.bootstrap.mockResolvedValue({
    memos: [seeded],
    tags: [],
    cursor: 1,
    syncEpoch: "epoch-a",
    serverTime: seeded.createdAt,
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 1, syncEpoch: "epoch-a", serverTime: seeded.createdAt });
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
});

async function renderApp() {
  render(
    <Providers>
      <App />
    </Providers>
  );
  await screen.findByText(/Seeded memo/);
}

describe("backup export toast", () => {
  it("announces the export once and keeps the changing count out of the live region", async () => {
    const user = userEvent.setup();
    mocks.exportData.mockImplementation(
      ({ signal, onProgress }: { signal: AbortSignal; onProgress: (progress: ExportProgress) => void }) =>
        new Promise((_, reject) => {
          onProgress({ done: 50, total: 160 });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    await renderApp();

    await user.click(document.querySelector<HTMLButtonElement>(".user-button")!);
    await user.click(await screen.findByRole("menuitem", { name: "Export Data" }));

    const status = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".toast");
      if (!node) throw new Error("No toast yet");
      return node;
    });
    // Spoken once through the app's standing live region (a11y), never the
    // toast itself, so the ticking count below is not re-read.
    expect(status.getAttribute("role")).toBeNull();
    await waitFor(() =>
      expect(document.querySelector("[data-live-region] [role='status']")?.textContent ?? "").toMatch(/^Exporting your backup…/)
    );
    await waitFor(() => expect(status.querySelector(".toast-detail")?.textContent).toBe(" 50 of 160 memos"));
    const text = status.querySelector(".toast-text")!;
    expect(text.firstChild?.textContent).toBe("Exporting your backup…");
    expect(status.querySelector(".toast-detail")?.getAttribute("aria-hidden")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped exporting your backup", { selector: ".toast *" })).toBeTruthy();
  });
});

describe("backup import failure hint", () => {
  function backupFile(count: number): File {
    const memos = Array.from({ length: count }, (_, index) => ({
      id: `import-${String(index).padStart(4, "0")}`,
      content: `imported ${index}`,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      pinnedAt: null,
      deletedAt: null,
      images: []
    }));
    const json = JSON.stringify({ format: "memo-backup", version: 1, exportedAt: "2026-01-02T00:00:00.000Z", memos, tags: [] });
    return new File([json], "memo-backup.json", { type: "application/json" });
  }

  async function importWithSecondChunk(second: Response) {
    const user = userEvent.setup();
    const responses = [new Response(JSON.stringify({ imported: 100, skipped: 0, images: 0 }), { status: 200 }), second];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift() ?? new Response("{}", { status: 500 }))
    );
    await renderApp();
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*=".json"]')!;
    await user.upload(input, backupFile(101));
    const dialog = await screen.findByRole("dialog", { name: "Import this backup?" });
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    return screen.findByRole("alert");
  }

  it("offers a rerun after a transient failure, joined as a second sentence", async () => {
    const alert = await importWithSecondChunk(new Response("Bad gateway", { status: 502 }));
    expect(alert.textContent).toBe("Request failed (502). Import the file again to pick up where it left off.");
  });

  it("does not offer a rerun when the chunk itself was rejected", async () => {
    const alert = await importWithSecondChunk(
      new Response(JSON.stringify({ code: "BACKUP_MEMO_INVALID", error: "Every backup memo must contain text content." }), { status: 400 })
    );
    expect(alert.textContent).toBe("The backup contains an invalid memo. Nothing from this chunk was imported.");
  });
});
