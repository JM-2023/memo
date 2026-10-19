import { describe, expect, it } from "vitest";
import { addDays, dateKey } from "../src/lib/dates";
import { HEAT_SCALE_MIN_DAYS, buildHeatWeeks, heatScale, levelFor, levelOnScale } from "../src/lib/stats";

const now = new Date(2026, 9, 19, 12);

/** Counts on consecutive days ending today, oldest first. */
function days(counts: number[], endOffset = 0): Map<string, number> {
  const map = new Map<string, number>();
  counts.forEach((count, index) => map.set(dateKey(addDays(now, endOffset - (counts.length - 1 - index))), count));
  return map;
}

describe("heatmap scale", () => {
  it("keeps the fixed steps until there are enough written days", () => {
    expect(heatScale(days(Array(HEAT_SCALE_MIN_DAYS - 1).fill(3)), now)).toBeNull();
    expect(levelOnScale(3, null)).toBe(levelFor(3));
    // levelFor itself is untouched for its other callers.
    expect([0, 1, 2, 3, 4, 5, 9].map(levelFor)).toEqual([0, 1, 2, 3, 3, 4, 4]);
  });

  it("reads quartiles of the owner's own days, so a heavy writer's ordinary day isn't the darkest", () => {
    // Twelve days of 4–15 memos: quartiles 6, 9, 12.
    const scale = heatScale(days([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), now);
    expect(scale?.cuts).toEqual([6, 9, 12]);
    expect([0, 5, 6, 7, 9, 12, 13].map((count) => levelOnScale(count, scale))).toEqual([0, 1, 1, 2, 2, 3, 4]);
  });

  it("keeps every level a range of its own when most days hold the same count", () => {
    const scale = heatScale(days(Array(20).fill(1)), now);
    expect(scale?.cuts).toEqual([1, 2, 3]);
    expect([1, 2, 3, 4].map((count) => levelOnScale(count, scale))).toEqual([1, 2, 3, 4]);
  });

  it("only counts the last ~90 days, and only days with memos", () => {
    const old = days(Array(30).fill(20), -120);
    const recent = days([0, 0, 1, 1, 1, 1, 2, 2]);
    const merged = new Map([...old, ...recent]);
    // Eight days in the window, but two of them are empty.
    expect(heatScale(merged, now)).toBeNull();
  });

  it("feeds the cells' levels when given, and the fixed steps when not", () => {
    const byDay = days([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const start = addDays(now, -11);
    const fixed = buildHeatWeeks(start, now, byDay, now).flat().find((cell) => cell.key === dateKey(now));
    const personal = buildHeatWeeks(start, now, byDay, now, heatScale(byDay, now)).flat().find((cell) => cell.key === dateKey(now));
    expect(fixed?.level).toBe(4);
    expect(personal?.level).toBe(4);
    const ordinary = dateKey(addDays(now, -7)); // 8 memos
    expect(buildHeatWeeks(start, now, byDay, now).flat().find((cell) => cell.key === ordinary)?.level).toBe(4);
    expect(buildHeatWeeks(start, now, byDay, now, heatScale(byDay, now)).flat().find((cell) => cell.key === ordinary)?.level).toBe(2);
  });
});
