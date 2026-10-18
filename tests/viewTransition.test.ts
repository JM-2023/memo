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
    // The card a send just landed: named for its morph.
    boxed(feedSection.querySelector<HTMLElement>(".memo-slot")!, 100, 120).style.viewTransitionName = "memo-a";
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
