// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFeedPlace, createNavStore, isRootLens, lensesEqual, navIdOf, parseNavLens, restoreFeedPlace, ROOT_LENS, type NavLens } from "../src/lib/navHistory";

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

  it("remembers which entry each one covers, with its place, across a reload", () => {
    const store = createNavStore();
    const root = store.replace(null, ROOT_LENS);
    store.setPlace(root, { anchorId: "m7", offset: 80, scrollY: 1800, cap: 60 });
    const tag = store.push(tagLens, root);
    expect(store.below(tag)?.place?.anchorId).toBe("m7");
    expect(lensesEqual(store.below(tag)!.lens, ROOT_LENS)).toBe(true);
    // Edited in place, the entry still covers the same one.
    store.replace(tag, { ...tagLens, query: "stew" });
    expect(store.below(tag)?.place?.scrollY).toBe(1800);
    // The bottom of the stack covers nothing.
    expect(store.below(root)).toBeNull();

    store.flush();
    expect(createNavStore().below(tag)?.place?.anchorId).toBe("m7");
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

describe("reading place", () => {
  const CARD = 100;
  /** Glides the feed's motion layer is running, by slot: how far down each card is drawn. */
  const glides = new Map<Element, number>();

  /**
   * jsdom has no layout: each slot rests one CARD below the last, measured
   * against the live scroll, and is drawn wherever its glide carries it.
   */
  function buildFeed(count: number): HTMLElement[] {
    const feed = document.createElement("section");
    feed.className = "memo-feed";
    const slots = Array.from({ length: count }, (_unused, index) => {
      const slot = document.createElement("div");
      slot.className = "memo-slot";
      slot.dataset.vt = `memo-${index}`;
      slot.getBoundingClientRect = () => {
        const top = index * CARD - window.scrollY + (glides.get(slot) ?? 0);
        return { top, bottom: top + CARD, left: 0, right: 600, width: 600, height: CARD, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      };
      return slot;
    });
    feed.append(...slots);
    document.body.append(feed);
    return slots;
  }

  beforeEach(() => {
    glides.clear();
    window.scrollY = 500;
    window.scrollTo = vi.fn((x?: ScrollToOptions | number, y?: number) => {
      window.scrollY = typeof x === "object" ? (x.top ?? window.scrollY) : (y ?? window.scrollY);
    }) as typeof window.scrollTo;
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
      const glide = glides.get(element);
      if (glide === undefined) return real(element);
      return { translate: `0px ${glide}px`, transform: "none" } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("notes a card mid-glide at the place it will rest, not where it is drawn", () => {
    const slots = buildFeed(12);
    // Card 4 rests just above the top edge but is drawn 50px lower; card 5
    // rests at the top edge, drawn 60px lower.
    glides.set(slots[4], 50);
    glides.set(slots[5], 60);

    expect(captureFeedPlace(80)).toEqual({ anchorId: "5", offset: 0, scrollY: 500, cap: 80 });
  });

  it("puts a place back against the rest box, and leaves a running glide alone", () => {
    const slots = buildFeed(12);
    glides.set(slots[5], 60);

    restoreFeedPlace({ anchorId: "5", offset: 0, scrollY: 500, cap: 80 });
    vi.advanceTimersByTime(200);

    // The card already rests at its offset: the glide is not drift to chase.
    expect(window.scrollY).toBe(500);
  });
});
