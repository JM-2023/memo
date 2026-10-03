// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../src/lib/search";
import { findHitOffsets, hitRangesIn, searchNeedles } from "../src/lib/searchHighlight";

describe("searchNeedles", () => {
  it("takes phrases and terms, longest first, without duplicates", () => {
    expect(searchNeedles(parseSearchQuery('fruit "green apple" fruit an'))).toEqual(["green apple", "fruit", "an"]);
  });
});

describe("findHitOffsets", () => {
  it("matches case-insensitively, every occurrence", () => {
    expect(findHitOffsets("Fruit and fruit", ["fruit"])).toEqual([
      [0, 5],
      [10, 15]
    ]);
  });

  it("maps back to source offsets when lowercasing changes the length", () => {
    // "İ" lowercases to two code units; the hit after it must not drift.
    const text = "İstanbul fruit";
    const [hit] = findHitOffsets(text, ["fruit"]);
    expect(text.slice(hit[0], hit[1])).toBe("fruit");
    const [dotted] = findHitOffsets(text, ["i"]);
    expect(text.slice(dotted[0], dotted[1])).toBe("İ");
  });

  it("returns nothing for no needles", () => {
    expect(findHitOffsets("anything", [])).toEqual([]);
  });
});

describe("hitRangesIn", () => {
  function content(html: string): HTMLElement {
    const root = document.createElement("div");
    root.className = "memo-content";
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }

  it("spans inline markup within a line but never crosses lines or table cells", () => {
    const root = content(
      '<p>Green <strong>app</strong>le pie</p><p>ab</p><p>c</p><p class="md-tr"><span class="md-td">a</span><span class="md-td">bc</span></p>'
    );
    const ranges = hitRangesIn(root, ["apple", "bc"]);
    expect(ranges.map((range) => range.toString())).toEqual(["apple", "bc"]);
    // "ab" + "c" sit on separate lines: no "abc"-style straddling hit.
    expect(hitRangesIn(root, ["abc"])).toHaveLength(0);
    root.remove();
  });

  it("skips typeset formulas", () => {
    const root = content('<p>x <span class="md-math"><annotation>fruit</annotation></span> fruit</p>');
    const ranges = hitRangesIn(root, ["fruit"]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.closest(".md-math")).toBeNull();
    root.remove();
  });
});
