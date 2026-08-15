// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { tuneFeedTransitionNames } from "../src/lib/viewTransition";

const VIEWPORT = 800;
const SLOT_HEIGHT = 200;

/**
 * Lay out `count` feed slots down a document, each already carrying its
 * view-transition-name, and scroll to `scrollY`. jsdom has no layout, so each
 * slot answers with the rect its position implies.
 */
function feed(count: number, scrollY: number): HTMLElement[] {
  window.innerHeight = VIEWPORT;
  window.scrollY = scrollY;
  document.body.innerHTML = "";
  return Array.from({ length: count }, (_unused, index) => {
    const slot = document.createElement("div");
    slot.className = "memo-slot";
    slot.dataset.vt = `memo-${index}`;
    slot.style.viewTransitionName = `memo-${index}`;
    const documentTop = index * SLOT_HEIGHT;
    slot.getBoundingClientRect = () =>
      ({ top: documentTop - window.scrollY, height: SLOT_HEIGHT }) as DOMRect;
    document.body.append(slot);
    return slot;
  });
}

const named = (slots: HTMLElement[]): number[] =>
  slots.flatMap((slot, index) => (slot.style.viewTransitionName === "" ? [] : [index]));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tuneFeedTransitionNames", () => {
  it("keeps the names of slots within half a viewport of the capture", () => {
    // Scrolled to slot 10; the band reaches half a viewport past both edges.
    const slots = feed(30, 10 * SLOT_HEIGHT);
    tuneFeedTransitionNames(window.scrollY);

    // Slot 7 ends 400px above the fold, slot 16 starts 400px below it.
    expect(named(slots)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("measures against the top of the document when the swap rewinds there", () => {
    // The outgoing pass runs before the scroll reset lands, so the incoming
    // viewport — not the live one — is what decides.
    const slots = feed(30, 10 * SLOT_HEIGHT);
    tuneFeedTransitionNames(0);

    expect(named(slots)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("gives a near slot its name back after an earlier capture dropped it", () => {
    // The regression: a swap at the top strips everything below the first
    // screen, React never rewrites an unchanged slot's style, and the reader
    // then scrolls down to one of those slots and filters from there. Without
    // the restore, the card they are looking at is missing from the outgoing
    // capture and arrives as a first-time entrance instead of a glide.
    const slots = feed(30, 0);
    tuneFeedTransitionNames(0);
    expect(slots[12].style.viewTransitionName).toBe("");

    window.scrollY = 12 * SLOT_HEIGHT;
    tuneFeedTransitionNames(window.scrollY);

    expect(slots[12].style.viewTransitionName).toBe("memo-12");
    // ...and the ones now pages away are the ones dropped instead.
    expect(slots[0].style.viewTransitionName).toBe("");
  });

  it("leaves a slot unnamed when the feed never gave it a name", () => {
    // Past the per-swap morph budget, App renders no data-vt at all.
    const slots = feed(3, 0);
    for (const slot of slots) delete slot.dataset.vt;

    tuneFeedTransitionNames(0);

    expect(named(slots)).toEqual([]);
  });
});
