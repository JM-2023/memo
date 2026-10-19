import { describe, expect, it } from "vitest";
import { dateKey } from "../src/lib/dates";
import {
  DEFAULT_REVIEW_SETTINGS,
  NO_REVIEW_SEEN,
  RANDOM_PICK,
  REVIEW_COUNT_MAX,
  buildReviewDay,
  drawReview,
  eligibleReviewMemos,
  parseReviewDay,
  parseReviewHidden,
  parseReviewSeen,
  parseReviewSettings,
  pickReviewIds,
  removeReviewSettingsTag,
  renameReviewSettingsTag,
  reviewAge,
  reviewBreakdown,
  reviewDayStarved,
  reviewDayValid,
  reviewFingerprint,
  reviewPickFor,
  reviewPickOf,
  reviewTagChoices,
  withReviewSeen,
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

  it("lets an empty batch go stale once something qualifies, and only then", () => {
    const empty = buildReviewDay([], settings(), NOW);
    expect(empty.ids).toEqual([]);
    expect(reviewDayStarved(empty, [], settings(), NOW)).toBe(false);
    expect(reviewDayStarved(empty, [memo("a", "x", "2026-07-25T09:00:00.000Z", "2026-07-25T09:30:00.000Z")], settings(), NOW)).toBe(false);
    expect(reviewDayStarved(empty, [memo("a", "x #work", "2026-07-25T09:00:00.000Z")], settings({ scope: "untagged" }), NOW)).toBe(false);
    expect(reviewDayStarved(empty, [memo("a", "x", "2026-07-25T09:00:00.000Z")], settings(), NOW)).toBe(true);
    // A batch that drew something stays frozen, whatever arrives.
    const drawn = buildReviewDay(pool, settings({ count: 4 }), NOW);
    expect(reviewDayStarved(drawn, [...pool, memo("new", "x", "2026-07-25T09:00:00.000Z")], settings({ count: 4 }), NOW)).toBe(false);
  });

  it("fingerprints ignore tag order but track every knob", () => {
    const base = settings({ scope: "include", tags: ["a", "b"], range: "3m", count: 9 });
    expect(reviewFingerprint(settings({ scope: "include", tags: ["b", "a"], range: "3m", count: 9 }))).toBe(reviewFingerprint(base));
    expect(reviewFingerprint(settings({ scope: "exclude", tags: ["a", "b"], range: "3m", count: 9 }))).not.toBe(reviewFingerprint(base));
  });
});

/** Local noon on a local date, so day keys read the same in any timezone. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

describe("weighted daily draw", () => {
  const DAY = "2026-10-19";
  const at = (year: number, month: number, day: number) => reviewPickFor(localNoon(year, month, day), DAY);

  it("names memos written on this date in earlier years, with how many years back", () => {
    expect(at(2025, 10, 19)).toEqual({ reason: "onThisDay", years: 1 });
    expect(at(2021, 10, 19)).toEqual({ reason: "onThisDay", years: 5 });
    // A 29th comes back on the last day of a short February.
    expect(reviewPickFor(localNoon(2024, 2, 29), "2027-02-28")).toEqual({ reason: "onThisDay", years: 3 });
    expect(reviewPickFor(localNoon(2024, 2, 29), "2028-02-28")).toBe(RANDOM_PICK);
  });

  it("names the anniversaries a day either side, and nothing else", () => {
    for (const day of [11, 12, 13]) expect(at(2026, 10, day)).toEqual({ reason: "anniversary", span: "week" });
    for (const day of [18, 19, 20]) expect(at(2026, 9, day)).toEqual({ reason: "anniversary", span: "month" });
    for (const day of [18, 19, 20]) expect(at(2026, 4, day)).toEqual({ reason: "anniversary", span: "halfYear" });
    for (const day of [18, 20]) expect(at(2025, 10, day)).toEqual({ reason: "anniversary", span: "year" });
    expect(at(2026, 10, 10)).toBe(RANDOM_PICK);
    expect(at(2026, 10, 14)).toBe(RANDOM_PICK);
    expect(at(2026, 8, 19)).toBe(RANDOM_PICK);
    // Today's own memos, and a clock running ahead, are chance draws.
    expect(at(2026, 10, 19)).toBe(RANDOM_PICK);
    expect(at(2026, 10, 25)).toBe(RANDOM_PICK);
  });

  const onThisDay = [memo("otd-1", "x", localNoon(2025, 10, 19)), memo("otd-2", "x", localNoon(2023, 10, 19))];
  const anniversaries = [memo("ann-w", "x", localNoon(2026, 10, 12)), memo("ann-y", "x", localNoon(2025, 10, 20))];
  const random = Array.from({ length: 20 }, (_, index) => memo(`r${String(index).padStart(2, "0")}`, "x", localNoon(2026, 1, 1 + index)));
  const pool = [...random, ...anniversaries, ...onThisDay];

  it("deals on this day first, then the anniversaries, then a seeded remainder", () => {
    const { ids, reasons } = drawReview(pool, 10, "seed", DAY);
    expect(ids).toHaveLength(10);
    expect(new Set(ids.slice(0, 2))).toEqual(new Set(["otd-1", "otd-2"]));
    expect(new Set(ids.slice(2, 4))).toEqual(new Set(["ann-w", "ann-y"]));
    expect(ids.slice(4).every((id) => id.startsWith("r"))).toBe(true);
    expect(reasons["otd-2"]).toEqual({ reason: "onThisDay", years: 3 });
    expect(reasons["ann-w"]).toEqual({ reason: "anniversary", span: "week" });
    expect(reasons[ids[9]]).toEqual({ reason: "random" });
    expect(Object.keys(reasons).sort()).toEqual([...ids].sort());
  });

  it("stays a pure function of pool and seed, inside the count", () => {
    expect(drawReview([...pool].reverse(), 10, "seed", DAY)).toEqual(drawReview(pool, 10, "seed", DAY));
    expect(drawReview(pool, 10, "other", DAY).ids.slice(4)).not.toEqual(drawReview(pool, 10, "seed", DAY).ids.slice(4));
    // A quota smaller than the first tier takes from it alone.
    const one = drawReview(pool, 1, "seed", DAY);
    expect(one.ids).toHaveLength(1);
    expect(one.ids[0].startsWith("otd")).toBe(true);
    expect(drawReview(pool, 0, "seed", DAY).ids).toEqual([]);
  });

  it("keeps the dealt prefix when only the count grows", () => {
    const now = new Date(2026, 9, 19, 9);
    const three = buildReviewDay(pool, settings({ count: 3 }), now);
    const twelve = buildReviewDay(pool, settings({ count: 12 }), now);
    expect(twelve.ids.slice(0, 3)).toEqual(three.ids);
    expect(twelve.reasons[three.ids[0]]).toEqual(three.reasons[three.ids[0]]);
  });

  it("only draws what the scope and range allow", () => {
    const now = new Date(2026, 9, 19, 9);
    const recent = buildReviewDay(pool, settings({ range: "1m", count: 10 }), now);
    expect(recent.ids.some((id) => id.startsWith("otd") || id === "ann-y")).toBe(false);
    expect(recent.ids[0]).toBe("ann-w");
  });

  it("never draws a memo set aside, and an all-set-aside pool is not starved", () => {
    const now = new Date(2026, 9, 19, 9);
    const excluded = new Set(["otd-1", "ann-w", "r00"]);
    const day = buildReviewDay(pool, settings({ count: 50 }), now, excluded);
    expect(day.ids.some((id) => excluded.has(id))).toBe(false);
    expect(day.ids).toHaveLength(pool.length - excluded.size);
    const only = [memo("solo", "x", localNoon(2026, 1, 1))];
    const empty = buildReviewDay(only, settings(), now, new Set(["solo"]));
    expect(empty.ids).toEqual([]);
    expect(reviewDayStarved(empty, only, settings(), now, new Set(["solo"]))).toBe(false);
    expect(reviewDayStarved(empty, only, settings(), now)).toBe(true);
  });

  it("tallies the reasons of the cards still in today's list", () => {
    const day = buildReviewDay(pool, settings({ count: 10 }), new Date(2026, 9, 19, 9));
    expect(reviewBreakdown(day, day.ids)).toEqual({ onThisDay: 2, anniversary: 2, random: 6 });
    expect(reviewBreakdown(day, day.ids.slice(1))).toEqual({ onThisDay: 1, anniversary: 2, random: 6 });
  });
});

describe("a memo's age", () => {
  const now = new Date(2026, 9, 19, 18);
  const age = (year: number, month: number, day: number) => reviewAge(localNoon(year, month, day), now);

  it("says it in the unit a person would", () => {
    expect(age(2026, 10, 19)).toEqual({ value: 0, unit: "day" });
    expect(age(2026, 10, 14)).toEqual({ value: 5, unit: "day" });
    expect(age(2026, 9, 29)).toEqual({ value: 2, unit: "week" });
    expect(age(2026, 8, 19)).toEqual({ value: 2, unit: "month" });
    expect(age(2025, 11, 19)).toEqual({ value: 11, unit: "month" });
    expect(age(2025, 11, 20)).toEqual({ value: 10, unit: "month" });
    expect(age(2024, 10, 19)).toEqual({ value: 2, unit: "year" });
  });
});

describe("stored day parsing", () => {
  it("round-trips a built day", () => {
    const built = buildReviewDay([memo("a", "x", "2026-01-01T00:00:00.000Z")], settings(), NOW);
    expect(parseReviewDay(JSON.stringify(built))).toEqual(built);
  });

  it("reads a day stored before reasons were kept as random draws", () => {
    const parsed = parseReviewDay(JSON.stringify({ day: "2026-07-25", fingerprint: "f", ids: ["a", "b"] }));
    expect(parsed).toEqual({ day: "2026-07-25", fingerprint: "f", ids: ["a", "b"], reasons: {} });
    expect(reviewPickOf(parsed!, "a")).toEqual({ reason: "random" });
    expect(reviewBreakdown(parsed!, parsed!.ids)).toEqual({ onThisDay: 0, anniversary: 0, random: 2 });
    // An id that happens to name an Object.prototype member is still just an id.
    expect(reviewPickOf(parsed!, "constructor")).toBe(RANDOM_PICK);
  });

  it("keeps only well-formed reasons for ids in the batch", () => {
    const parsed = parseReviewDay(
      JSON.stringify({
        day: "2026-07-25",
        fingerprint: "f",
        ids: ["a", "b", "c", "d", "e"],
        reasons: {
          a: { reason: "onThisDay", years: 0 },
          b: { reason: "anniversary", span: "decade" },
          c: "random",
          d: { reason: "anniversary", span: "week" },
          e: { reason: "onThisDay", years: 2 },
          stray: { reason: "random" }
        }
      })
    );
    expect(parsed?.reasons).toEqual({ d: { reason: "anniversary", span: "week" }, e: { reason: "onThisDay", years: 2 } });
    expect(parseReviewDay(JSON.stringify({ day: "2026-07-25", fingerprint: "f", ids: ["a"], reasons: ["a"] }))?.reasons).toEqual({});
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

describe("seen cards and set-aside memos", () => {
  it("parses the seen record by day, dropping junk", () => {
    expect(parseReviewSeen(null)).toBe(NO_REVIEW_SEEN);
    expect(parseReviewSeen("nope")).toBe(NO_REVIEW_SEEN);
    expect(parseReviewSeen(JSON.stringify({ day: "July", ids: ["a"] }))).toBe(NO_REVIEW_SEEN);
    expect(parseReviewSeen(JSON.stringify({ day: "2026-07-25", ids: ["a", "a", 3, "", "b"] }))).toEqual({ day: "2026-07-25", ids: ["a", "b"] });
    expect(parseReviewSeen(JSON.stringify({ day: "2026-07-25", ids: "a" }))).toEqual({ day: "2026-07-25", ids: [] });
  });

  it("adds a seen card to its day and starts over on a new one", () => {
    const seen = withReviewSeen(NO_REVIEW_SEEN, "2026-07-25", "a");
    expect(seen).toEqual({ day: "2026-07-25", ids: ["a"] });
    expect(withReviewSeen(seen, "2026-07-25", "a")).toBe(seen);
    expect(withReviewSeen(seen, "2026-07-25", "b")).toEqual({ day: "2026-07-25", ids: ["a", "b"] });
    expect(withReviewSeen(seen, "2026-07-26", "b")).toEqual({ day: "2026-07-26", ids: ["b"] });
  });

  it("parses the set-aside list as unique ids only", () => {
    expect(parseReviewHidden(null)).toEqual([]);
    expect(parseReviewHidden("{")).toEqual([]);
    expect(parseReviewHidden(JSON.stringify({ ids: ["a"] }))).toEqual([]);
    expect(parseReviewHidden(JSON.stringify(["a", "b", "a", null, ""]))).toEqual(["a", "b"]);
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
