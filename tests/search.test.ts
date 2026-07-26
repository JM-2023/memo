import { describe, expect, it } from "vitest";
import { setTaskMark } from "../src/lib/markdownEdit";
import { parseSavedFilters, removeSavedFiltersForTag, renameSavedFilterTags, type SavedFilter } from "../src/lib/savedFilters";
import {
  EMPTY_FILTERS,
  facetsOf,
  filtersEqual,
  hasActiveFilters,
  memoMatchesFilters,
  memoMatchesQuery,
  parseSearchQuery,
  queryIsEmpty,
  type FeedFilters
} from "../src/lib/search";
import type { Memo } from "../src/lib/types";

/** Local-noon timestamps keep dayKeyOf deterministic across runner TZs. */
function localIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

function memoOf(content: string, overrides: Partial<Memo> = {}): Memo {
  const createdAt = overrides.createdAt ?? localIso(2026, 7, 10);
  return {
    id: "m1",
    content,
    createdAt,
    updatedAt: createdAt,
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: [],
    ...overrides
  };
}

function filtersWith(patch: Partial<FeedFilters>): FeedFilters {
  return { ...EMPTY_FILTERS, ...patch };
}

describe("search query language", () => {
  it("splits whitespace-separated keywords into AND terms", () => {
    expect(parseSearchQuery("morning  coffee\tritual")).toEqual({ terms: ["morning", "coffee", "ritual"], phrases: [] });
  });

  it("lowercases terms and phrases", () => {
    expect(parseSearchQuery('HeLLo "WoRld Peace"')).toEqual({ terms: ["hello"], phrases: ["world peace"] });
  });

  it("keeps a quoted run as one phrase alongside loose terms", () => {
    expect(parseSearchQuery('tea "morning coffee" note')).toEqual({ terms: ["tea", "note"], phrases: ["morning coffee"] });
  });

  it("accepts curly quotes as phrase delimiters", () => {
    expect(parseSearchQuery("“早安 世界” 咖啡")).toEqual({ terms: ["咖啡"], phrases: ["早安 世界"] });
  });

  it("treats an unterminated quote as a phrase in progress", () => {
    expect(parseSearchQuery('note "half typed')).toEqual({ terms: ["note"], phrases: ["half typed"] });
  });

  it("ignores empty quotes and blank input", () => {
    expect(queryIsEmpty(parseSearchQuery('""'))).toBe(true);
    expect(queryIsEmpty(parseSearchQuery("   "))).toBe(true);
    expect(queryIsEmpty(parseSearchQuery('a "b"'))).toBe(false);
  });

  it("requires every term to match (AND)", () => {
    const memo = memoOf("Morning coffee ritual with notes");
    expect(memoMatchesQuery(memo, parseSearchQuery("coffee morning"))).toBe(true);
    expect(memoMatchesQuery(memo, parseSearchQuery("coffee tea"))).toBe(false);
  });

  it("matches phrases only as contiguous substrings", () => {
    const memo = memoOf("coffee every morning ritual");
    expect(memoMatchesQuery(memo, parseSearchQuery('"morning ritual"'))).toBe(true);
    expect(memoMatchesQuery(memo, parseSearchQuery('"coffee ritual"'))).toBe(false);
    // The same words as loose terms still AND-match.
    expect(memoMatchesQuery(memo, parseSearchQuery("coffee ritual"))).toBe(true);
  });

  it("matches case-insensitively against memo content", () => {
    expect(memoMatchesQuery(memoOf("Hello World"), parseSearchQuery("hello WORLD"))).toBe(true);
  });
});

describe("memo facets", () => {
  it("detects stored attachments as images", () => {
    const memo = memoOf("plain text", { images: [{ id: "i1", mime: "image/png", width: 1, height: 1, bytes: 9 }] });
    expect(facetsOf(memo)).toEqual({ hasImage: true, hasLink: false, hasOpenTask: false });
  });

  it("files markdown images as images, never links", () => {
    expect(facetsOf(memoOf("look ![shot](https://x.com/page)"))).toEqual({ hasImage: true, hasLink: false, hasOpenTask: false });
  });

  it("files a bare URL by its extension", () => {
    expect(facetsOf(memoOf("see https://x.com/pic.png"))).toEqual({ hasImage: true, hasLink: false, hasOpenTask: false });
    expect(facetsOf(memoOf("see https://x.com/doc"))).toEqual({ hasImage: false, hasLink: true, hasOpenTask: false });
  });

  it("detects unchecked tasks exactly like the card renderer", () => {
    expect(facetsOf(memoOf("- [ ] buy milk")).hasOpenTask).toBe(true);
    expect(facetsOf(memoOf("  * [ ] indented")).hasOpenTask).toBe(true);
    expect(facetsOf(memoOf("- [ ]")).hasOpenTask).toBe(true);
    expect(facetsOf(memoOf("- [x] done")).hasOpenTask).toBe(false);
    expect(facetsOf(memoOf("- [ ]tight is a bullet, not a task")).hasOpenTask).toBe(false);
    expect(facetsOf(memoOf("text with [ ] inline")).hasOpenTask).toBe(false);
  });

  it("tracks feed checkbox toggles: ticking the last open task drops the facet", () => {
    const memo = memoOf("- [x] first\n- [ ] last");
    expect(facetsOf(memo).hasOpenTask).toBe(true);
    // Toggle commits deliver a fresh memo snapshot, so the facet cache
    // re-derives — the open-task filter and the checkbox stay in step.
    const allDone = memoOf(setTaskMark(memo.content, 1, true)!, { seq: 2 });
    expect(facetsOf(allDone).hasOpenTask).toBe(false);
    const reopened = memoOf(setTaskMark(allDone.content, 0, false)!, { seq: 3 });
    expect(facetsOf(reopened).hasOpenTask).toBe(true);
  });
});

describe("structured filters", () => {
  it("noTags keeps only memos without tags", () => {
    const noTags = filtersWith({ noTags: true });
    expect(memoMatchesFilters(memoOf("plain thought"), noTags)).toBe(true);
    expect(memoMatchesFilters(memoOf("tagged #idea"), noTags)).toBe(false);
    // A #fragment inside a URL is not a tag.
    expect(memoMatchesFilters(memoOf("https://x.com/a#section"), noTags)).toBe(true);
  });

  it("facet filters AND together", () => {
    const both = filtersWith({ hasImage: true, hasOpenTask: true });
    expect(memoMatchesFilters(memoOf("- [ ] fix ![s](https://x.com/p)"), both)).toBe(true);
    expect(memoMatchesFilters(memoOf("- [ ] fix"), both)).toBe(false);
  });

  it("date range is inclusive and supports open ends", () => {
    const memo = memoOf("x", { createdAt: localIso(2026, 7, 10) });
    expect(memoMatchesFilters(memo, filtersWith({ dateFrom: "2026-07-10", dateTo: "2026-07-10" }))).toBe(true);
    expect(memoMatchesFilters(memo, filtersWith({ dateFrom: "2026-07-11" }))).toBe(false);
    expect(memoMatchesFilters(memo, filtersWith({ dateFrom: "2026-07-01" }))).toBe(true);
    expect(memoMatchesFilters(memo, filtersWith({ dateTo: "2026-07-09" }))).toBe(false);
    expect(memoMatchesFilters(memo, filtersWith({ dateTo: "2026-07-31" }))).toBe(true);
  });

  it("normalizes a reversed date pair into the span between them", () => {
    const memo = memoOf("x", { createdAt: localIso(2026, 7, 10) });
    expect(memoMatchesFilters(memo, filtersWith({ dateFrom: "2026-07-20", dateTo: "2026-07-01" }))).toBe(true);
  });

  it("hasActiveFilters and filtersEqual observe every field", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(filtersWith({ hasLink: true }))).toBe(true);
    expect(hasActiveFilters(filtersWith({ dateTo: "2026-07-01" }))).toBe(true);
    expect(filtersEqual(filtersWith({ noTags: true }), filtersWith({ noTags: true }))).toBe(true);
    expect(filtersEqual(filtersWith({ noTags: true }), EMPTY_FILTERS)).toBe(false);
  });
});

describe("saved filter storage", () => {
  const valid = {
    id: "f1",
    name: "工作待办",
    query: '"weekly review"',
    tag: "work",
    day: null,
    filters: { noTags: false, hasImage: false, hasLink: false, hasOpenTask: true, dateFrom: "2026-07-01", dateTo: null }
  };

  it("round-trips a valid payload", () => {
    expect(parseSavedFilters(JSON.stringify([valid]))).toEqual([valid]);
  });

  it("returns empty for missing, corrupt or non-array payloads", () => {
    expect(parseSavedFilters(null)).toEqual([]);
    expect(parseSavedFilters("not json")).toEqual([]);
    expect(parseSavedFilters('{"a":1}')).toEqual([]);
  });

  it("drops entries without a usable id or name and coerces bad fields", () => {
    const parsed = parseSavedFilters(
      JSON.stringify([
        { ...valid, id: "" },
        { ...valid, name: "   " },
        { ...valid, id: "f2", query: 7, tag: 3, day: "not-a-day", filters: { hasImage: "yes", dateFrom: "2026-13-99" } }
      ])
    );
    expect(parsed).toEqual([
      {
        id: "f2",
        name: "工作待办",
        query: "",
        tag: null,
        day: null,
        filters: { noTags: false, hasImage: false, hasLink: false, hasOpenTask: false, dateFrom: null, dateTo: null }
      }
    ]);
  });

  it("caps the list at the storage limit", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...valid, id: `f${index}`, name: `n${index}` }));
    expect(parseSavedFilters(JSON.stringify(many))).toHaveLength(20);
  });

  it("migrates exact and descendant tag lenses when a subtree is renamed", () => {
    const saved = [
      { ...valid, id: "exact", tag: "work" },
      { ...valid, id: "child", tag: "work/client" },
      { ...valid, id: "sibling", tag: "workshop" },
      { ...valid, id: "untagged", tag: null }
    ] satisfies SavedFilter[];

    const renamed = renameSavedFilterTags(saved, "work", "archive");

    expect(renamed.map(({ id, tag }) => ({ id, tag }))).toEqual([
      { id: "exact", tag: "archive" },
      { id: "child", tag: "archive/client" },
      { id: "sibling", tag: "workshop" },
      { id: "untagged", tag: null }
    ]);
    expect(renamed[2]).toBe(saved[2]);
    expect(renamed[3]).toBe(saved[3]);
  });

  it("drops saved lenses aimed at a removed tag subtree instead of widening them", () => {
    const saved = [
      { ...valid, id: "exact", tag: "work" },
      { ...valid, id: "child", tag: "work/client" },
      { ...valid, id: "sibling", tag: "workshop" },
      { ...valid, id: "untagged", tag: null }
    ] satisfies SavedFilter[];

    expect(removeSavedFiltersForTag(saved, "work").map(({ id, tag }) => ({ id, tag }))).toEqual([
      { id: "sibling", tag: "workshop" },
      { id: "untagged", tag: null }
    ]);
  });
});
