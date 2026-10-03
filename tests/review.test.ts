import { describe, expect, it } from "vitest";
import { dateKey } from "../src/lib/dates";
import {
  DEFAULT_REVIEW_SETTINGS,
  REVIEW_COUNT_MAX,
  buildReviewDay,
  eligibleReviewMemos,
  parseReviewDay,
  parseReviewSettings,
  pickReviewIds,
  removeReviewSettingsTag,
  renameReviewSettingsTag,
  reviewDayValid,
  reviewFingerprint,
  reviewTagChoices,
  type ReviewSettings
} from "../src/lib/review";
import type { Memo } from "../src/lib/types";

function memo(id: string, content: string, createdAt: string, deletedAt: string | null = null): Memo {
  return { id, content, createdAt, updatedAt: createdAt, pinnedAt: null, deletedAt, seq: 1, images: [] };
}

function settings(patch: Partial<ReviewSettings> = {}): ReviewSettings {
  return { ...DEFAULT_REVIEW_SETTINGS, tags: [], ...patch };
}

const NOW = new Date("2026-07-25T10:00:00.000Z");

describe("review settings parsing", () => {
  it("falls back to defaults on missing or malformed payloads", () => {
    expect(parseReviewSettings(null)).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(parseReviewSettings("not json")).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(parseReviewSettings("[1,2]")).toEqual(DEFAULT_REVIEW_SETTINGS);
  });

  it("falls back per field and clamps the count", () => {
    const parsed = parseReviewSettings(JSON.stringify({ scope: "nope", tags: ["b", "a", "a", 7, ""], range: "2w", count: 999 }));
    expect(parsed).toEqual({ scope: "all", tags: ["a", "b"], range: "all", count: REVIEW_COUNT_MAX });
    expect(parseReviewSettings(JSON.stringify({ count: -3 })).count).toBe(1);
    expect(parseReviewSettings(JSON.stringify({ count: Number.NaN })).count).toBe(DEFAULT_REVIEW_SETTINGS.count);
  });

  it("keeps a valid payload intact", () => {
    const stored: ReviewSettings = { scope: "include", tags: ["work", "life/家"], range: "6m", count: 7 };
    expect(parseReviewSettings(JSON.stringify(stored))).toEqual({ ...stored, tags: ["life/家", "work"] });
  });
});

describe("review scope follows tag renames and removals", () => {
  it("renames listed tags and their descendants, leaving siblings alone", () => {
    const before = settings({ scope: "exclude", tags: ["读书", "读书/小说", "读书会"] });
    expect(renameReviewSettingsTag(before, "读书", "阅读")).toEqual({ ...before, tags: ["读书会", "阅读", "阅读/小说"] });
  });

  it("merges into an already listed target without duplicates", () => {
    expect(renameReviewSettingsTag(settings({ scope: "include", tags: ["a", "b"] }), "a", "b").tags).toEqual(["b"]);
  });

  it("returns the same object when no listed tag is touched", () => {
    const before = settings({ scope: "include", tags: ["work"] });
    expect(renameReviewSettingsTag(before, "life", "home")).toBe(before);
    expect(removeReviewSettingsTag(before, "life")).toBe(before);
  });

  it("drops a removed subtree and falls back to all memos when the list empties", () => {
    expect(removeReviewSettingsTag(settings({ scope: "include", tags: ["a", "b/c"] }), "b")).toMatchObject({ scope: "include", tags: ["a"] });
    expect(removeReviewSettingsTag(settings({ scope: "exclude", tags: ["diary/private"] }), "diary")).toMatchObject({ scope: "all", tags: [] });
  });
});

describe("review eligibility", () => {
  const pool = [
    memo("a", "no tags here", "2026-07-20T00:00:00.000Z"),
    memo("b", "#work planning", "2026-07-01T00:00:00.000Z"),
    memo("c", "#work/project deep", "2026-02-01T00:00:00.000Z"),
    memo("d", "#life groceries", "2025-05-01T00:00:00.000Z"),
    memo("e", "trashed #work", "2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z")
  ];

  it("always skips trashed memos", () => {
    const ids = eligibleReviewMemos(pool, settings(), NOW).map((entry) => entry.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("include scope matches chosen tags and their descendants", () => {
    const ids = eligibleReviewMemos(pool, settings({ scope: "include", tags: ["work"] }), NOW).map((entry) => entry.id);
    expect(ids).toEqual(["b", "c"]);
  });

  it("exclude scope drops chosen tags and their descendants", () => {
    const ids = eligibleReviewMemos(pool, settings({ scope: "exclude", tags: ["work"] }), NOW).map((entry) => entry.id);
    expect(ids).toEqual(["a", "d"]);
  });

  it("untagged scope keeps only memos without tags", () => {
    const ids = eligibleReviewMemos(pool, settings({ scope: "untagged" }), NOW).map((entry) => entry.id);
    expect(ids).toEqual(["a"]);
  });

  it("time ranges cut by creation date", () => {
    expect(eligibleReviewMemos(pool, settings({ range: "1m" }), NOW).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(eligibleReviewMemos(pool, settings({ range: "6m" }), NOW).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(eligibleReviewMemos(pool, settings({ range: "1y" }), NOW).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("clamps month arithmetic at short-month edges", () => {
    const endOfMarch = new Date("2026-03-31T12:00:00.000Z");
    const inside = memo("x", "kept", "2026-03-01T00:00:00.000Z");
    const outside = memo("y", "cut", "2026-02-20T00:00:00.000Z");
    const ids = eligibleReviewMemos([inside, outside], settings({ range: "1m" }), endOfMarch).map((entry) => entry.id);
    expect(ids).toEqual(["x"]);
  });
});

describe("daily draw", () => {
  const pool = Array.from({ length: 40 }, (_, index) => memo(`m${String(index).padStart(2, "0")}`, `note ${index}`, "2026-01-01T00:00:00.000Z"));

  it("is deterministic for one seed and bounded by pool and count", () => {
    const first = pickReviewIds(pool, 10, "seed-a");
    const second = pickReviewIds(pool, 10, "seed-a");
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(10);
    expect(pickReviewIds(pool.slice(0, 3), 10, "seed-a")).toHaveLength(3);
    for (const id of first) expect(pool.some((entry) => entry.id === id)).toBe(true);
  });

  it("does not depend on the caller's array order", () => {
    const shuffled = [...pool].reverse();
    expect(pickReviewIds(shuffled, 10, "seed-a")).toEqual(pickReviewIds(pool, 10, "seed-a"));
  });

  it("changes with the seed (different days draw different hands)", () => {
    expect(pickReviewIds(pool, 10, "2026-07-25")).not.toEqual(pickReviewIds(pool, 10, "2026-07-26"));
  });

  it("keeps the drawn prefix when only the count grows", () => {
    const day = new Date("2026-07-25T09:00:00.000Z");
    const five = buildReviewDay(pool, settings({ count: 5 }), day);
    const ten = buildReviewDay(pool, settings({ count: 10 }), day);
    expect(ten.ids.slice(0, 5)).toEqual(five.ids);
  });

  it("stamps day and fingerprint so validity can be re-checked later", () => {
    const built = buildReviewDay(pool, settings({ count: 4 }), NOW);
    expect(built.day).toBe(dateKey(NOW));
    expect(built.ids).toHaveLength(4);
    expect(reviewDayValid(built, settings({ count: 4 }), NOW)).toBe(true);
    expect(reviewDayValid(built, settings({ count: 5 }), NOW)).toBe(false);
    expect(reviewDayValid(built, settings({ count: 4 }), new Date("2026-07-26T09:00:00.000Z"))).toBe(false);
    expect(reviewDayValid(null, settings(), NOW)).toBe(false);
  });

  it("fingerprints ignore tag order but track every knob", () => {
    const base = settings({ scope: "include", tags: ["a", "b"], range: "3m", count: 9 });
    expect(reviewFingerprint(settings({ scope: "include", tags: ["b", "a"], range: "3m", count: 9 }))).toBe(reviewFingerprint(base));
    expect(reviewFingerprint(settings({ scope: "exclude", tags: ["a", "b"], range: "3m", count: 9 }))).not.toBe(reviewFingerprint(base));
  });
});

describe("stored day parsing", () => {
  it("round-trips a built day", () => {
    const built = buildReviewDay([memo("a", "x", "2026-01-01T00:00:00.000Z")], settings(), NOW);
    expect(parseReviewDay(JSON.stringify(built))).toEqual(built);
  });

  it("rejects malformed payloads", () => {
    expect(parseReviewDay(null)).toBeNull();
    expect(parseReviewDay("nope")).toBeNull();
    expect(parseReviewDay(JSON.stringify({ day: "2026-13-01", fingerprint: "f", ids: [] }))).toBeNull();
    expect(parseReviewDay(JSON.stringify({ day: "2026-07-25", fingerprint: "", ids: [] }))).toBeNull();
    expect(parseReviewDay(JSON.stringify({ day: "2026-07-25", fingerprint: "f", ids: "x" }))).toBeNull();
  });

  it("drops junk ids and duplicates, capping at the count ceiling", () => {
    const ids = Array.from({ length: 80 }, (_, index) => `id${index}`);
    const parsed = parseReviewDay(JSON.stringify({ day: "2026-07-25", fingerprint: "f", ids: [null, "", "dup", "dup", ...ids] }));
    expect(parsed?.ids[0]).toBe("dup");
    expect(parsed?.ids).toHaveLength(REVIEW_COUNT_MAX);
    expect(new Set(parsed?.ids).size).toBe(REVIEW_COUNT_MAX);
  });
});

describe("review tag choices", () => {
  const known = ["learning/reading", "life/cooking", "life/garden/vegetables", "work"];

  it("offers every parent of a tag in use, grouped under its top-level tag", () => {
    const { pinned, groups } = reviewTagChoices(known, []);
    expect(pinned).toEqual([]);
    expect(groups.map((group) => group.root)).toEqual(["learning", "life", "work"]);
    expect(groups[1].chips).toEqual([
      { path: "life", label: "#life" },
      { path: "life/cooking", label: "/cooking" },
      { path: "life/garden", label: "/garden" },
      { path: "life/garden/vegetables", label: "/garden/vegetables" }
    ]);
    expect(groups[2].chips).toEqual([{ path: "work", label: "#work" }]);
  });

  it("puts the saved picks first and spells out paths whose root went with them", () => {
    const { pinned, groups } = reviewTagChoices(known, ["life", "gone/old"]);
    expect(pinned).toEqual([
      { path: "gone/old", label: "#gone/old" },
      { path: "life", label: "#life" }
    ]);
    // A vanished pick still brings its parent along as a choice.
    expect(groups[0].chips).toEqual([{ path: "gone", label: "#gone" }]);
    const life = groups.find((group) => group.root === "life");
    expect(life?.chips.map((chip) => chip.label)).toEqual(["#life/cooking", "#life/garden", "#life/garden/vegetables"]);
  });
});
