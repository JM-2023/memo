import { describe, expect, it } from "vitest";
import { advanceFeedWindow, feedWindowCap, filterPreservingId } from "../src/lib/feedSafety";

describe("filterPreservingId", () => {
  const rows = [{ id: "editing", text: "draft base" }, { id: "match", text: "needle" }, { id: "hidden", text: "other" }];

  it("keeps the editing row when a deferred filter no longer matches it", () => {
    expect(filterPreservingId(rows, "editing", (row) => row.text.includes("needle")).map((row) => row.id)).toEqual(["editing", "match"]);
  });

  it("uses the ordinary predicate when no editor is open", () => {
    expect(filterPreservingId(rows, null, (row) => row.text.includes("needle")).map((row) => row.id)).toEqual(["match"]);
  });
});

describe("feed render window", () => {
  it("uses one page immediately when the filter generation changes", () => {
    expect(feedWindowCap({ key: "old-filter", cap: 960 }, "new-filter", 80)).toBe(80);
  });

  it("advances from one page instead of carrying a stale expanded cap forward", () => {
    expect(advanceFeedWindow({ key: "old-filter", cap: 960 }, "new-filter", 80)).toEqual({ key: "new-filter", cap: 160 });
  });

  it("does not revive an old cap when equivalent filters are revisited", () => {
    const firstVisit = {};
    const narrowed = {};
    const secondVisit = {};
    const expanded = { key: firstVisit, cap: 960 };

    expect(feedWindowCap(expanded, narrowed, 80)).toBe(80);
    expect(feedWindowCap(expanded, secondVisit, 80)).toBe(80);
  });
});
