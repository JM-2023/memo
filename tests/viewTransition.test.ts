// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { tuneFeedTransitionNames, withViewTransition } from "../src/lib/viewTransition";

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

it("names visible cards beyond the first 32 rows and bounds snapshot work", () => {
  const slots = feed(100, 70 * SLOT_HEIGHT);
  tuneFeedTransitionNames(window.scrollY);
  expect(named(slots)).toContain(70);
  expect(named(slots)).not.toContain(0);
  window.innerHeight = 100_000;
  tuneFeedTransitionNames(0);
  expect(named(slots)).toHaveLength(32);
});

it("refreshes both captures for mutation callers without their own feed tuning", () => {
  const slots = feed(100, 70 * SLOT_HEIGHT);
  const originalStart = document.startViewTransition;
  const originalMatch = window.matchMedia;
  window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
  document.startViewTransition = ((update: () => void) => {
    expect(named(slots)).toContain(70);
    update();
    expect(named(slots)).toContain(0);
    expect(named(slots)).not.toContain(70);
    return { ready: Promise.resolve() };
  }) as typeof document.startViewTransition;
  try {
    withViewTransition(() => { window.scrollY = 0; });
  } finally {
    document.startViewTransition = originalStart;
    window.matchMedia = originalMatch;
  }
});

describe("withViewTransition under each verb and motion setting", () => {
  function startWith(onUpdate: () => void = () => undefined) {
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    document.startViewTransition = ((update: () => void) => {
      update();
      onUpdate();
      return { ready: Promise.resolve(), finished, skipTransition: () => undefined };
    }) as typeof document.startViewTransition;
    return () => finish();
  }

  const originalStart = document.startViewTransition;
  const originalMatch = window.matchMedia;
  afterEach(() => {
    document.startViewTransition = originalStart;
    window.matchMedia = originalMatch;
    delete document.documentElement.dataset.vtExit;
  });

  it("names no card under reduced motion, so the feed dissolves in place", () => {
    const slots = feed(10, 0);
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    let namedDuringUpdate: number[] = [];
    startWith(() => {
      namedDuringUpdate = named(slots);
    });

    withViewTransition(() => undefined);

    expect(named(slots)).toEqual([]);
    expect(namedDuringUpdate).toEqual([]);
  });

  it("marks the root with the verb's exit for exactly as long as the transition runs", async () => {
    feed(3, 0);
    window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
    const finish = startWith();

    withViewTransition(() => undefined, { exit: "lift" });
    expect(document.documentElement.dataset.vtExit).toBe("lift");

    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.dataset.vtExit).toBeUndefined();
  });

  it("leaves the default sink unmarked, clearing an earlier verb", () => {
    feed(3, 0);
    window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
    startWith();

    withViewTransition(() => undefined, { exit: "fade" });
    expect(document.documentElement.dataset.vtExit).toBe("fade");
    withViewTransition(() => undefined);
    expect(document.documentElement.dataset.vtExit).toBeUndefined();
  });
});

describe("a press while a transition is on screen", () => {
  const originalStart = document.startViewTransition;
  const originalMatch = window.matchMedia;
  const originalStyle = window.getComputedStyle;
  const originalFromPoint = document.elementFromPoint;
  const originalAnimations = document.getAnimations;
  afterEach(() => {
    document.startViewTransition = originalStart;
    window.matchMedia = originalMatch;
    window.getComputedStyle = originalStyle;
    document.elementFromPoint = originalFromPoint;
    document.getAnimations = originalAnimations;
  });

  /** Put a transition on screen (its pseudo-elements up); returns its skip. */
  async function liveTransition(hitTest: () => Element | null) {
    const skip = vi.fn();
    window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
    document.startViewTransition = ((update: () => void) => {
      update();
      return { ready: Promise.resolve(), finished: new Promise(() => undefined), skipTransition: skip };
    }) as typeof document.startViewTransition;
    // Nothing animating to read: every snapshot paints where its element stands.
    document.getAnimations = () => [];
    // jsdom computes no view-transition-name; the inline one is the capture.
    window.getComputedStyle = ((element: Element) =>
      ({ viewTransitionName: (element as HTMLElement).style?.viewTransitionName || "none" }) as CSSStyleDeclaration) as typeof window.getComputedStyle;
    document.elementFromPoint = vi.fn(hitTest);
    withViewTransition(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return skip;
  }

  function boxed<T extends HTMLElement>(element: T, top: number, height: number): T {
    element.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height }) as DOMRect;
    return element;
  }

  const press = (target: Element, type: "pointerdown" | "mousedown") => {
    const init = { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 150 };
    target.dispatchEvent(type === "pointerdown" ? new PointerEvent(type, { ...init, isPrimary: true, pointerId: 1 }) : new MouseEvent(type, init));
  };

  it("carries a press on a captured card to the control drawn there, ending the transition", async () => {
    window.innerHeight = VIEWPORT;
    window.scrollY = 0;
    document.body.innerHTML = '<section class="memo-feed"><div class="memo-slot" data-vt="memo-a"><button type="button">⋯</button></div></section>';
    const feedSection = document.querySelector("section")!;
    boxed(feedSection.querySelector<HTMLElement>(".memo-slot")!, 100, 120);
    const trigger = feedSection.querySelector("button")!;
    const skip = await liveTransition(() => trigger);
    const heard: string[] = [];
    feedSection.addEventListener("pointerdown", (event) => {
      if (event.target === feedSection) heard.push("lost on the feed");
    });
    trigger.addEventListener("pointerdown", () => heard.push("pointerdown"));
    trigger.addEventListener("mousedown", () => heard.push("mousedown"));

    // The browser hit-tests past the captured card to the feed around it.
    press(feedSection, "pointerdown");
    press(feedSection, "mousedown");

    expect(skip).toHaveBeenCalledTimes(1);
    expect(heard).toEqual(["pointerdown", "mousedown"]);
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves a press that reached its own element alone, and the transition running", async () => {
    document.body.innerHTML = '<nav><button type="button" class="tag-label">ideas</button></nav>';
    const row = document.querySelector("button")!;
    const skip = await liveTransition(() => row);
    const heard: Element[] = [];
    row.addEventListener("pointerdown", (event) => heard.push(event.target as Element));

    press(row, "pointerdown");

    expect(skip).not.toHaveBeenCalled();
    expect(heard).toEqual([row]);
  });

  it("keeps focus where a relayed mousedown's own handler holds it", async () => {
    document.body.innerHTML = '<main><div class="composer"><textarea></textarea><button type="button">B</button></div></main>';
    const main = document.querySelector("main")!;
    const composer = boxed(main.querySelector<HTMLElement>(".composer")!, 100, 120);
    composer.style.viewTransitionName = "composer";
    const field = main.querySelector("textarea")!;
    const bold = main.querySelector("button")!;
    // The toolbar's keepFieldFocus.
    const held = vi.fn((event: Event) => event.preventDefault());
    bold.addEventListener("mousedown", held);
    field.focus();
    await liveTransition(() => bold);

    press(main, "pointerdown");
    press(main, "mousedown");

    expect(held).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
  });
});
