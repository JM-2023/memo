// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageModal } from "../src/components/StorageModal";
import { TipProvider } from "../src/components/Tip";
import { ApiError, type StorageReport } from "../src/lib/api";
import { LanguageProvider } from "../src/lib/i18n";
import { clearImageCache } from "../src/lib/imageCache";
import type { Memo, MemoImage } from "../src/lib/types";

const DAY = 86_400_000;

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function image(id: string, bytes: number): MemoImage {
  return { id, mime: "image/webp", width: 800, height: 600, bytes };
}

function memo(id: string, content: string, createdAt: string, images: MemoImage[], deletedAt: string | null = null): Memo {
  return { id, content, createdAt, updatedAt: createdAt, pinnedAt: null, deletedAt, seq: 3, images };
}

const now = Date.now();
const memos: Memo[] = [
  memo("kitchen", "Kitchen notes\nmore", "2026-11-01T09:00:00.000Z", [image("small", 30_000)]),
  memo("trip", "# Trip photos", "2025-06-01T09:00:00.000Z", [image("huge", 900_000)]),
  memo("old", "Old receipt", "2024-01-01T09:00:00.000Z", [image("gone", 200_000)], new Date(now - 40 * DAY).toISOString()),
  memo("fresh", "Fresh mistake", "2026-11-20T09:00:00.000Z", [], new Date(now - 2 * DAY).toISOString())
];

function storageReport(overrides: Partial<StorageReport> = {}): StorageReport {
  return {
    measuredAt: new Date(now).toISOString(),
    database: { bytes: 2_000_000, limitBytes: 500_000_000 },
    notes: { memos: 2, textBytes: 30, images: 2, imageBytes: 1_300_000 },
    trash: { memos: 2, textBytes: 24, images: 1, imageBytes: 270_000 },
    images: [
      { id: "small", memoId: "kitchen", bytes: 45_000 },
      { id: "huge", memoId: "trip", bytes: 1_255_000 },
      { id: "gone", memoId: "old", bytes: 270_000 }
    ],
    trashMemos: [
      { id: "fresh", bytes: 13 },
      { id: "old", bytes: 270_011 }
    ],
    ...overrides
  };
}

function renderStorage(props: Partial<Parameters<typeof StorageModal>[0]> = {}) {
  const handlers = {
    loadReport: vi.fn(async () => storageReport()),
    onClose: vi.fn(),
    onOpenMemo: vi.fn(),
    onOpenTrash: vi.fn(),
    onPurge: vi.fn(async () => undefined),
    ...props
  };
  const view = render(
    <Providers>
      <StorageModal memos={memos} {...handlers} />
    </Providers>
  );
  return { ...view, ...handlers };
}

beforeEach(() => {
  clearImageCache();
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
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:test/${Math.random()}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp" } })));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function tileNames(): string[] {
  const wall = screen.getByRole("list", { name: "Stored images" });
  return within(wall)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

describe("storage overview", () => {
  it("states the size against the ceiling in words and splits the meter by what fills it", async () => {
    renderStorage();
    expect(await screen.findByText("2.0")).toBeTruthy();
    expect(screen.getByText("of 500 MB")).toBeTruthy();
    expect(screen.getByText("Under 1% of the 500 MB limit · 498 MB free")).toBeTruthy();
    expect(screen.getByRole("img", { name: "2.0 MB of 500 MB used: Images 1.3 MB, Text 30 B, Trash 270 KB, Other 430 KB" })).toBeTruthy();
    const figures = screen.getByRole("dialog", { name: "Storage" }).querySelectorAll(".stats-kpi");
    expect([...figures].map((figure) => figure.textContent)).toEqual([
      "Images1.3 MB2 images",
      "Text30 B2 memos",
      "Trash270 KB2 memos",
      "Other430 KBIndexes and sync history"
    ]);
  });

  it("says when the database is nearly full or full, in words", async () => {
    const { unmount } = renderStorage({
      loadReport: vi.fn(async () => storageReport({ database: { bytes: 450_000_000, limitBytes: 500_000_000 } }))
    });
    expect(await screen.findByText("Nearly full.")).toBeTruthy();
    expect(screen.getByText(/50\.0 MB left — at 500 MB, new memos and images stop saving\./)).toBeTruthy();
    unmount();
    renderStorage({ loadReport: vi.fn(async () => storageReport({ database: { bytes: 501_000_000, limitBytes: 500_000_000 } })) });
    expect(await screen.findByText("Full.")).toBeTruthy();
  });

  it("offers a retry when the report fails, and the wall still reads with estimates", async () => {
    const loadReport = vi
      .fn<() => Promise<StorageReport | undefined>>()
      .mockRejectedValueOnce(new ApiError("NETWORK_ERROR", 0, "offline"))
      .mockResolvedValueOnce(storageReport());
    renderStorage({ loadReport });
    expect(await screen.findByText("Couldn’t reach the server. Check your connection and try again.")).toBeTruthy();
    // 900 KB original → 1.2 MB of base64, before its preview is counted.
    expect(tileNames()).toContain("Open memo: Trip photos, Jun 1, 2025, 1.2 MB");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("2.0")).toBeTruthy();
    expect(loadReport).toHaveBeenCalledTimes(2);
  });
});

describe("image wall", () => {
  it("lists stored images newest first, or largest first, Trash included", async () => {
    renderStorage();
    await screen.findByText("2.0");
    expect(tileNames()).toEqual([
      "Open memo: Kitchen notes, Nov 1, 2026, 45.0 KB",
      "Open memo: Trip photos, Jun 1, 2025, 1.3 MB",
      "Open memo: Old receipt, in Trash, 270 KB"
    ]);
    expect(screen.getByText("Trashed 40 days ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Largest" }));
    expect(tileNames().map((name) => name.split(",")[0])).toEqual(["Open memo: Trip photos", "Open memo: Old receipt", "Open memo: Kitchen notes"]);
    fireEvent.click(screen.getByRole("button", { name: "In Trash" }));
    expect(tileNames()).toEqual(["Open memo: Old receipt, in Trash, 270 KB"]);
    expect(screen.getByText("1 image · 270 KB")).toBeTruthy();
  });

  it("opens the memo an image belongs to once the panel has left", async () => {
    const { onOpenMemo } = renderStorage();
    await screen.findByText("2.0");
    fireEvent.click(screen.getByRole("button", { name: "Open memo: Old receipt, in Trash, 270 KB" }));
    await waitFor(() => expect(onOpenMemo).toHaveBeenCalledWith("old"));
  });
});

describe("old Trash", () => {
  it("names what has sat in Trash past 30 days and deletes exactly those, asking twice", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { onPurge, loadReport } = renderStorage();
    await screen.findByText("2.0");
    const line = screen.getByText((_, element) => element?.classList.contains("storage-trash-line") ?? false);
    expect(line.textContent).toBe("1 memo has been in Trash for over 30 days, holding 270 KB.");

    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    const armed = screen.getByRole("button", { name: "Delete 1 memo forever?" });
    // A second click on the beat of arming is a double-click, not a yes.
    fireEvent.click(armed);
    expect(onPurge).not.toHaveBeenCalled();
    clock += 600;
    await act(async () => {
      fireEvent.click(armed);
    });
    expect(onPurge).toHaveBeenCalledWith(["old"]);
    await waitFor(() => expect(loadReport).toHaveBeenCalledTimes(2));
  });

  it("disarms when focus leaves, and leads to Trash", async () => {
    const { onOpenTrash } = renderStorage();
    await screen.findByText("2.0");
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    fireEvent.blur(screen.getByRole("button", { name: "Delete 1 memo forever?" }));
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Trash" }));
    await waitFor(() => expect(onOpenTrash).toHaveBeenCalled());
  });
});
