// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { skipLiveTransition, transitionLive, withViewTransition } from "../src/lib/viewTransition";

const VIEWPORT = 800;
const SLOT_HEIGHT = 200;

/**
 * Lay out `count` feed slots down a document and scroll to `scrollY`. jsdom
 * has no layout, so each slot answers with the rect its position implies.
 */
function feed(count: number, scrollY: number): HTMLElement[] {
  window.innerHeight = VIEWPORT;
  window.scrollY = scrollY;
  document.body.innerHTML = "";
  return Array.from({ length: count }, (_unused, index) => {
    const slot = document.createElement("div");
    slot.className = "memo-slot";
    slot.dataset.vt = `memo-${index}`;
    const documentTop = index * SLOT_HEIGHT;
    slot.getBoundingClientRect = () =>
      ({ top: documentTop - window.scrollY, height: SLOT_HEIGHT }) as DOMRect;
    document.body.append(slot);
    return slot;
  });
}

const named = (slots: HTMLElement[]): number[] =>
  slots.flatMap((slot, index) => (slot.style.viewTransitionName ? [index] : []));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("withViewTransition", () => {
  const originalStart = document.startViewTransition;
  const originalMatch = window.matchMedia;
  afterEach(() => {
    document.startViewTransition = originalStart;
    window.matchMedia = originalMatch;
  });

  function startWith(onUpdate: () => void = () => undefined) {
    const skip = vi.fn();
    document.startViewTransition = ((update: () => void) => {
      update();
      onUpdate();
      return { ready: Promise.resolve(), finished: new Promise(() => undefined), skipTransition: skip };
    }) as typeof document.startViewTransition;
    return skip;
  }

  it("names none of the feed's cards: a morph captures only what its update names", () => {
    const slots = feed(10, 0);
    window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
    let namedDuringUpdate: number[] = [-1];
    startWith(() => {
      namedDuringUpdate = named(slots);
    });

    const update = vi.fn();
    withViewTransition(update);

    expect(update).toHaveBeenCalledWith(true);
    expect(namedDuringUpdate).toEqual([]);
    expect(named(slots)).toEqual([]);
  });

  it("runs the update at once, unanimated, without the API", () => {
    document.startViewTransition = undefined as unknown as typeof document.startViewTransition;
    const update = vi.fn();

    expect(withViewTransition(update)).toBeNull();
    expect(update).toHaveBeenCalledWith(false);
  });

  it("is on screen once ready, until skipped", async () => {
    window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
    const skip = startWith();

    withViewTransition(() => undefined);
    expect(transitionLive()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transitionLive()).toBe(true);

    skipLiveTransition();
    expect(skip).toHaveBeenCalledTimes(1);
    expect(transitionLive()).toBe(false);
    skipLiveTransition();
    expect(skip).toHaveBeenCalledTimes(1);
  });
});
