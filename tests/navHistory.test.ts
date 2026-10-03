// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNavStore, isRootLens, lensesEqual, navIdOf, parseNavLens, ROOT_LENS, type NavLens } from "../src/lib/navHistory";

const tagLens: NavLens = { ...ROOT_LENS, tag: "life/cooking", query: "soup" };

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("nav lens parsing", () => {
  it("rebuilds a stored lens field by field and drops what is malformed", () => {
    expect(parseNavLens({ view: "elsewhere" })).toBeNull();
    const lens = parseNavLens({
      view: "memos",
      tag: 42,
      day: "2026-13-40",
      drilldown: { kind: "month", year: 2026, month: "x" },
      filters: { hasImage: true, dateFrom: "2026-09-01", dateTo: "nope" },
      query: "pie"
    });
    expect(lens).toEqual({
      view: "memos",
      tag: null,
      day: null,
      drilldown: null,
      filters: { noTags: false, hasImage: true, hasLink: false, hasOpenTask: false, dateFrom: "2026-09-01", dateTo: null },
      query: "pie"
    });
  });

  it("tells All memos from every narrower lens", () => {
    expect(isRootLens(ROOT_LENS)).toBe(true);
    expect(isRootLens({ ...ROOT_LENS, query: "  " })).toBe(true);
    expect(isRootLens(tagLens)).toBe(false);
    expect(isRootLens({ ...ROOT_LENS, view: "trash" })).toBe(false);
    expect(isRootLens({ ...ROOT_LENS, drilldown: { kind: "year", year: 2026 } })).toBe(false);
  });
});

describe("nav store", () => {
  it("stamps history with an opaque id and keeps the lens in sessionStorage", () => {
    const store = createNavStore();
    const first = store.replace(null, ROOT_LENS);
    expect(navIdOf(window.history.state)).toBe(first);
    const before = window.history.length;
    const second = store.push(tagLens);
    expect(window.history.length).toBe(before + 1);
    expect(navIdOf(window.history.state)).toBe(second);
    expect(JSON.stringify(window.history.state)).not.toMatch(/cooking|soup/);

    store.flush();
    const reread = createNavStore();
    expect(lensesEqual(reread.get(second)!.lens, tagLens)).toBe(true);
    expect(lensesEqual(reread.get(first)!.lens, ROOT_LENS)).toBe(true);
  });

  it("forgets a place once its lens is edited in place", () => {
    const store = createNavStore();
    const id = store.replace(null, ROOT_LENS);
    store.setPlace(id, { anchorId: "m1", offset: 120, scrollY: 2400, cap: 120 });
    expect(store.get(id)?.place?.anchorId).toBe("m1");
    store.replace(id, { ...ROOT_LENS, query: "s" });
    expect(store.get(id)?.place).toBeNull();
  });

  it("clears memory and storage together (logout)", () => {
    const store = createNavStore();
    const id = store.push(tagLens);
    store.flush();
    expect(sessionStorage.getItem("memo:nav")).toContain("cooking");
    store.push(tagLens);
    store.clear();
    vi.runAllTimers();
    expect(store.get(id)).toBeNull();
    expect(sessionStorage.getItem("memo:nav")).toBeNull();
  });
});
