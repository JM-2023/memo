import { describe, expect, it } from "vitest";
import type { StorageReport } from "../src/lib/api";
import {
  daysInTrash,
  estimateStoredBytes,
  formatBytes,
  sortImageEntries,
  staleTrash,
  storedBytesOf,
  storedImageEntries,
  summarizeStorage
} from "../src/lib/storage";
import type { Memo, MemoImage } from "../src/lib/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T12:00:00.000Z");

function image(id: string, bytes: number): MemoImage {
  return { id, mime: "image/webp", width: 100, height: 100, bytes };
}

function memo(id: string, createdAt: string, images: MemoImage[] = [], deletedAt: string | null = null, content = `memo ${id}`): Memo {
  return { id, content, createdAt, updatedAt: createdAt, pinnedAt: null, deletedAt, seq: 1, images };
}

function report(overrides: Partial<StorageReport> = {}): StorageReport {
  return {
    measuredAt: new Date(NOW).toISOString(),
    database: { bytes: 2_000_000, limitBytes: 500_000_000 },
    notes: { memos: 2, textBytes: 100_000, images: 2, imageBytes: 1_200_000 },
    trash: { memos: 1, textBytes: 1_000, images: 1, imageBytes: 300_000 },
    images: [],
    trashMemos: [],
    ...overrides
  };
}

describe("formatBytes", () => {
  it("keeps three significant figures in decimal units", () => {
    expect(formatBytes(0, "en-US")).toBe("0 B");
    expect(formatBytes(512, "en-US")).toBe("512 B");
    expect(formatBytes(1_234, "en-US")).toBe("1.2 KB");
    expect(formatBytes(860_000, "en-US")).toBe("860 KB");
    expect(formatBytes(12_400_000, "en-US")).toBe("12.4 MB");
    expect(formatBytes(500_000_000, "en-US")).toBe("500 MB");
    expect(formatBytes(1_250_000_000, "en-US")).toBe("1.3 GB");
  });

  it("steps up a unit instead of printing 1000 of the smaller one", () => {
    expect(formatBytes(999_960, "en-US")).toBe("1.0 MB");
    expect(formatBytes(999, "en-US")).toBe("999 B");
    expect(formatBytes(99_960, "en-US")).toBe("100 KB");
  });

  it("uses the locale's decimal mark and never groups digits", () => {
    expect(formatBytes(12_400_000, "de-DE")).toBe("12,4 MB");
    expect(formatBytes(-5, "en-US")).toBe("0 B");
    expect(formatBytes(Number.NaN, "en-US")).toBe("0 B");
  });
});

describe("summarizeStorage", () => {
  it("splits the measured file into images, text, Trash and the rest", () => {
    const summary = summarizeStorage(report());
    expect(summary.measured).toBe(true);
    expect(summary.used).toBe(2_000_000);
    expect(summary.ratio).toBeCloseTo(0.004);
    expect(summary.parts).toEqual([
      { key: "images", bytes: 1_200_000 },
      { key: "text", bytes: 100_000 },
      { key: "trash", bytes: 301_000 },
      { key: "other", bytes: 2_000_000 - 1_601_000 }
    ]);
  });

  it("falls back to the content's sum when the runtime gives no size", () => {
    const summary = summarizeStorage(report({ database: { bytes: null, limitBytes: 500_000_000 } }));
    expect(summary.measured).toBe(false);
    expect(summary.used).toBe(1_601_000);
    expect(summary.parts.at(-1)).toEqual({ key: "other", bytes: 0 });
  });

  it("never lets the file read smaller than what it holds", () => {
    expect(summarizeStorage(report({ database: { bytes: 10, limitBytes: 500_000_000 } })).used).toBe(1_601_000);
  });
});

describe("image entries", () => {
  const big = image("big", 900_000);
  const small = image("small", 30_000);
  const old = image("old", 400_000);
  const memos = [
    memo("a", "2026-11-01T00:00:00.000Z", [small, big]),
    memo("b", "2025-01-01T00:00:00.000Z", [old]),
    memo("c", "2026-11-20T00:00:00.000Z")
  ];

  it("lists every stored attachment, sized from the report when it has one", () => {
    const entries = storedImageEntries(memos, report({ images: [{ id: "big", memoId: "a", bytes: 1_300_000 }] }));
    expect(entries.map((entry) => [entry.image.id, entry.bytes])).toEqual([
      ["small", estimateStoredBytes(30_000)],
      ["big", 1_300_000],
      ["old", estimateStoredBytes(400_000)]
    ]);
    expect(estimateStoredBytes(30_000)).toBe(40_000);
  });

  it("sorts newest memo first with attachments in order, or largest first", () => {
    const entries = storedImageEntries(memos, null);
    expect(sortImageEntries(entries, "newest").map((entry) => entry.image.id)).toEqual(["small", "big", "old"]);
    expect(sortImageEntries(entries, "largest").map((entry) => entry.image.id)).toEqual(["big", "old", "small"]);
  });
});

describe("old Trash", () => {
  const recent = memo("recent", "2026-01-01T00:00:00.000Z", [], new Date(NOW - 3 * DAY).toISOString());
  const older = memo("older", "2026-01-01T00:00:00.000Z", [image("x", 3_000)], new Date(NOW - 45 * DAY).toISOString(), "héllo");
  const oldest = memo("oldest", "2026-01-01T00:00:00.000Z", [], new Date(NOW - 90 * DAY).toISOString());
  const live = memo("live", "2026-01-01T00:00:00.000Z");

  it("counts whole days in Trash", () => {
    expect(daysInTrash(recent, NOW)).toBe(3);
    expect(daysInTrash(older, NOW)).toBe(45);
    expect(daysInTrash(live, NOW)).toBe(0);
  });

  it("picks memos past the threshold, longest in Trash first", () => {
    expect(staleTrash([live, recent, older, oldest], NOW).map((item) => item.id)).toEqual(["oldest", "older"]);
    expect(staleTrash([recent], NOW, 3).map((item) => item.id)).toEqual(["recent"]);
  });

  it("sizes them from the report, or from their text and attachments", () => {
    expect(storedBytesOf([older, oldest], report({ trashMemos: [{ id: "oldest", bytes: 777 }] }))).toBe(6 + 4_000 + 777);
    expect(storedBytesOf([older], report({ images: [{ id: "x", memoId: "older", bytes: 4_100 }] }))).toBe(6 + 4_100);
  });
});
