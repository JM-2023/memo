import { describe, expect, it } from "vitest";
import { feedQueryForStatsDrilldown, memoMatchesStatsDrilldown, statsDrilldownLabel, type StatsDrilldown } from "../src/lib/statsDrilldown";
import type { Memo } from "../src/lib/types";

function memoAt(id: string, localCreatedAt: Date, content = ""): Memo {
  return {
    id,
    content,
    createdAt: localCreatedAt.toISOString(),
    updatedAt: localCreatedAt.toISOString(),
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: []
  };
}

describe("stats drilldown matching", () => {
  const mondayMorning = memoAt("monday", new Date(2026, 6, 6, 9, 30), "#work/project");

  it("uses the memo's local creation year and zero-based month", () => {
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "year", year: 2026 })).toBe(true);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "year", year: 2025 })).toBe(false);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "month", year: 2026, month: 6 })).toBe(true);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "month", year: 2026, month: 5 })).toBe(false);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "month", year: 2025, month: 6 })).toBe(false);
  });

  it("matches one exact local calendar day", () => {
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "day", day: "2026-07-06" })).toBe(true);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "day", day: "2026-07-05" })).toBe(false);
  });

  it("uses StatsModal's Monday-first weekday index inside the selected year", () => {
    const sunday = memoAt("sunday", new Date(2026, 6, 5, 18));
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "weekday", year: 2026, weekday: 0 })).toBe(true);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "weekday", year: 2026, weekday: 1 })).toBe(false);
    expect(memoMatchesStatsDrilldown(sunday, { kind: "weekday", year: 2026, weekday: 6 })).toBe(true);
    expect(memoMatchesStatsDrilldown(sunday, { kind: "weekday", year: 2025, weekday: 6 })).toBe(false);
  });

  it("uses the local creation hour inside the selected year", () => {
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "hour", year: 2026, hour: 9 })).toBe(true);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "hour", year: 2026, hour: 8 })).toBe(false);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "hour", year: 2025, hour: 9 })).toBe(false);
  });

  it("matches one complete tag path exactly and only within the selected year", () => {
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "tag", year: 2026, tag: "work/project" })).toBe(true);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "tag", year: 2026, tag: "work" })).toBe(false);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "tag", year: 2026, tag: "Work/project" })).toBe(false);
    expect(memoMatchesStatsDrilldown(mondayMorning, { kind: "tag", year: 2025, tag: "work/project" })).toBe(false);
  });

  it("rejects an invalid creation timestamp", () => {
    expect(
      memoMatchesStatsDrilldown(
        { ...mondayMorning, createdAt: "not-a-date" },
        { kind: "year", year: 2026 }
      )
    ).toBe(false);
  });
});

describe("stats drilldown search handoff", () => {
  it("uses the deferred query in the ordinary feed", () => {
    expect(feedQueryForStatsDrilldown(null, "new input", "deferred input")).toBe("deferred input");
  });

  it("drops a stale deferred query on entry and uses new drilldown input immediately", () => {
    const drilldown: StatsDrilldown = { kind: "year", year: 2026 };
    expect(feedQueryForStatsDrilldown(drilldown, "", "old feed query")).toBe("");
    expect(feedQueryForStatsDrilldown(drilldown, "new drilldown query", "")).toBe("new drilldown query");
  });
});

describe("stats drilldown labels", () => {
  const cases: { drilldown: StatsDrilldown; en: string; zh: string }[] = [
    { drilldown: { kind: "year", year: 2026 }, en: "2026", zh: "2026年" },
    { drilldown: { kind: "month", year: 2026, month: 6 }, en: "July 2026", zh: "2026年7月" },
    { drilldown: { kind: "day", day: "2026-07-06" }, en: "Jul 6, 2026", zh: "2026年7月6日" },
    { drilldown: { kind: "weekday", year: 2026, weekday: 0 }, en: "Monday · 2026", zh: "2026年 · 星期一" },
    { drilldown: { kind: "hour", year: 2026, hour: 9 }, en: "9 AM – 10 AM · 2026", zh: "2026年 · 9时 – 10时" },
    { drilldown: { kind: "tag", year: 2026, tag: "工作/项目" }, en: "#工作/项目 · 2026", zh: "2026年 · #工作/项目" }
  ];

  for (const { drilldown, en, zh } of cases) {
    it(`formats ${drilldown.kind} in both app locales`, () => {
      expect(statsDrilldownLabel(drilldown, "en-US")).toBe(en);
      expect(statsDrilldownLabel(drilldown, "zh-CN")).toBe(zh);
    });
  }

  it("formats the final hour as a local 23:00–00:00 range", () => {
    expect(statsDrilldownLabel({ kind: "hour", year: 2026, hour: 23 }, "en-US")).toBe("11 PM – 12 AM · 2026");
    expect(statsDrilldownLabel({ kind: "hour", year: 2026, hour: 23 }, "zh-CN")).toBe("2026年 · 23时 – 0时");
  });
});
