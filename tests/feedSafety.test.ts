import { describe, expect, it } from "vitest";
import { filterPreservingId } from "../src/lib/feedSafety";

describe("filterPreservingId", () => {
  const rows = [{ id: "editing", text: "draft base" }, { id: "match", text: "needle" }, { id: "hidden", text: "other" }];

  it("keeps the editing row when a deferred filter no longer matches it", () => {
    expect(filterPreservingId(rows, "editing", (row) => row.text.includes("needle")).map((row) => row.id)).toEqual(["editing", "match"]);
  });

  it("uses the ordinary predicate when no editor is open", () => {
    expect(filterPreservingId(rows, null, (row) => row.text.includes("needle")).map((row) => row.id)).toEqual(["match"]);
  });
});
