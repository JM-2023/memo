// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedMotion, type FeedMotion } from "../src/lib/feedMotion";
import { withViewTransition } from "../src/lib/viewTransition";

const VIEWPORT = 800;
const CARD = 100;
const GAP = 14;
const STEP = CARD + GAP;

interface Played {
  target: Element;
  keyframes: Keyframe[];
  cancel: ReturnType<typeof vi.fn>;
}

let played: Played[] = [];
let feed: HTMLElement;
let ghosts: HTMLElement;
let motion: FeedMotion;

/**
 * jsdom has no layout: every slot answers with the box its place in the feed
 * implies (one card every STEP px from the top of the document), measured
 * against the live scroll — so moving nodes and scrolling both move boxes.
 */
function boxFor(slot: HTMLElement): DOMRect {
  const slots = Array.from(feed.querySelectorAll<HTMLElement>(":scope > .memo-slot"));
  const top = slots.indexOf(slot) * STEP - window.scrollY;
  return { top, bottom: top + CARD, left: 0, right: 600, width: 600, height: CARD, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function slot(id: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "memo-slot";
  element.dataset.vt = `memo-${id}`;
  element.textContent = `Memo ${id}`;
  element.getBoundingClientRect = () => boxFor(element);
  return element;
}

function slotOf(id: string): HTMLElement {
  const found = feed.querySelector<HTMLElement>(`:scope > .memo-slot[data-vt="memo-${id}"]`);
  if (!found) throw new Error(`no slot for ${id}`);
  return found;
}

function build(count: number, scrollY = 0): void {
  window.scrollY = scrollY;
  feed.replaceChildren(...Array.from({ length: count }, (_unused, index) => slot(String(index))), ghosts);
}

const translateOf = (keyframes: Keyframe[]) => keyframes[0]?.translate;
/** The latest glide played on a card. */
const glideOf = (id: string) => [...played].reverse().find((entry) => entry.target === slotOf(id) && "translate" in entry.keyframes[0]);

beforeEach(() => {
  played = [];
  window.innerHeight = VIEWPORT;
  window.scrollY = 0;
  window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
  window.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object" && typeof options.top === "number") window.scrollY = options.top;
  }) as typeof window.scrollTo;
  Element.prototype.animate = vi.fn(function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    const entry: Played = { target: this, keyframes: keyframes as Keyframe[], cancel: vi.fn() };
    played.push(entry);
    return { finished: new Promise(() => undefined), cancel: entry.cancel } as unknown as Animation;
  }) as typeof Element.prototype.animate;
  feed = document.createElement("div");
  feed.className = "memo-feed";
  ghosts = document.createElement("div");
  ghosts.className = "feed-ghosts";
  ghosts.getBoundingClientRect = () => ({ top: -window.scrollY, left: 0 }) as DOMRect;
  document.body.append(feed);
  motion = createFeedMotion({ feed: () => feed, ghosts: () => ghosts });
});

afterEach(() => {
  motion.settle();
  document.body.innerHTML = "";
  delete (Element.prototype as Partial<Element>).animate;
  delete document.documentElement.dataset.vtExit;
});

describe("feed motion", () => {
  it("closes the gap a trashed card leaves, from where its neighbours were painted", () => {
    build(5);

    const result = motion.run("trash", ["2"], () => slotOf("2").remove());

    // The cards below glide up from their old places.
    expect(translateOf(glideOf("3")!.keyframes)).toBe(`0px ${STEP}px`);
    expect(translateOf(glideOf("4")!.keyframes)).toBe(`0px ${STEP}px`);
    expect(glideOf("1")).toBeUndefined();
    // The card itself recedes where the reader saw it, outside the list.
    const ghost = ghosts.querySelector<HTMLElement>(".feed-ghost");
    expect(ghost?.textContent).toBe("Memo 2");
    expect(ghost?.style.top).toBe(`${2 * STEP}px`);
    expect(ghost?.classList.contains("memo-slot")).toBe(false);
    const exit = played.find((entry) => entry.target === ghost)!;
    expect(exit.keyframes[1]).toMatchObject({ opacity: 0, transform: "scale(0.965)" });
    // The neighbours close over the exit rather than under it.
    expect(slotOf("3").style.zIndex).toBe("1");
    expect(result.departed.get("2")).toBe("removed");
  });

  it("speaks each verb's exit", () => {
    build(4);
    motion.run("restore", ["1"], () => slotOf("1").remove());
    const lift = played.find((entry) => entry.target.classList.contains("feed-ghost"))!;
    expect(lift.keyframes[1].transform).toBe("translateY(-18px) scale(0.995)");

    motion.settle();
    played = [];
    motion.run("purge", ["2"], () => slotOf("2").remove());
    const fade = played.find((entry) => entry.target.classList.contains("feed-ghost"))!;
    expect(fade.keyframes[1]).toEqual({ opacity: 0 });
  });

  it("keeps the reader's place when a card arrives above the screen", () => {
    // Scrolled well down: slot 8 starts above the top edge and anchors.
    build(20, 1000);
    const before = slotOf("12").getBoundingClientRect().top;

    motion.run("remote", ["new"], () => feed.prepend(slot("new")));

    expect(window.scrollY).toBe(1000 + STEP);
    expect(slotOf("12").getBoundingClientRect().top).toBe(before);
    // Nothing on screen moved, so nothing glides.
    expect(glideOf("12")).toBeUndefined();
  });

  it("reports a pinned card that left the screen, and lets it go upward", () => {
    build(20, 1000);

    const result = motion.run("pin", ["12"], () => feed.prepend(slotOf("12")));

    expect(result.departed.get("12")).toBe("up");
    // A copy taken before the change plays the departure where it was seen
    // (the page has scrolled to keep the reader's place; the ghost has not).
    const ghost = ghosts.querySelector<HTMLElement>(".feed-ghost");
    expect(Number.parseFloat(ghost?.style.top ?? "") - window.scrollY).toBe(12 * STEP - 1000);
    const exit = played.find((entry) => entry.target === ghost)!;
    expect(exit.keyframes[1].transform).toBe("translateY(-18px) scale(0.995)");
    // The cards below it close the gap.
    expect(translateOf(glideOf("13")!.keyframes)).toBe(`0px ${STEP}px`);
  });

  it("lifts a named card that crosses its neighbours on screen", () => {
    build(6);

    motion.run("pin", ["3"], () => feed.prepend(slotOf("3")));

    expect(translateOf(glideOf("3")!.keyframes)).toBe(`0px ${3 * STEP}px`);
    expect(slotOf("3").style.zIndex).toBe("2");
    expect(translateOf(glideOf("0")!.keyframes)).toBe(`0px ${-STEP}px`);
  });

  it("starts a second change from the first one's frame, ending its glides", () => {
    build(6);
    motion.run("trash", ["1"], () => slotOf("1").remove());
    const first = glideOf("4")!;

    motion.run("trash", ["2"], () => slotOf("2").remove());

    expect(first.cancel).toHaveBeenCalled();
    expect(glideOf("4")).not.toBe(first);
  });

  it("dissolves under reduced motion: opacity only, in place, still keeping the reader's place", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    build(20, 1000);

    motion.run("remote", ["new"], () => feed.prepend(slot("new")));
    expect(window.scrollY).toBe(1000 + STEP);

    played = [];
    motion.run("trash", ["10"], () => slotOf("10").remove());

    expect(played.length).toBeGreaterThan(0);
    for (const entry of played) {
      // Nothing travels: no translate, no transform, only opacity.
      for (const frame of entry.keyframes) expect(Object.keys(frame).filter((key) => key !== "offset")).toEqual(["opacity"]);
    }
    const timings = vi.mocked(Element.prototype.animate).mock.calls.slice(-played.length).map((call) => call[1] as KeyframeAnimationOptions);
    for (const timing of timings) expect(timing.duration).toBeLessThanOrEqual(150);
    // The trashed card fades where it was drawn.
    const gone = [...ghosts.querySelectorAll<HTMLElement>(".feed-ghost")].find((node) => node.textContent === "Memo 10");
    expect(Number.parseFloat(gone?.style.top ?? "") - window.scrollY).toBe(10 * STEP - 1000);
  });

  it("cross-fades a neighbour closing the gap under reduced motion instead of gliding it", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    build(5);

    motion.run("trash", ["2"], () => slotOf("2").remove());

    // The live card fades in at its new place…
    const live = played.find((entry) => entry.target === slotOf("3"))!;
    expect(live.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    // …while its old look fades out where it was.
    const old = [...ghosts.querySelectorAll<HTMLElement>(".feed-ghost")].find((node) => node.textContent === "Memo 3");
    expect(old?.style.top).toBe(`${3 * STEP}px`);
    expect(played.find((entry) => entry.target === old)!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(glideOf("3")).toBeUndefined();
  });

  it("leaves a change inside a view transition's update to the snapshot", () => {
    build(5);
    const originalStart = document.startViewTransition;
    document.startViewTransition = ((update: () => void) => {
      update();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    }) as typeof document.startViewTransition;
    try {
      const commit = vi.fn(() => slotOf("2").remove());
      withViewTransition(() => motion.run("trash", ["2"], commit));
      expect(commit).toHaveBeenCalledOnce();
      expect(played).toEqual([]);
    } finally {
      document.startViewTransition = originalStart;
    }
  });

  it("settles everything in flight when a view transition captures the page", () => {
    build(5);
    const detach = motion.attach();
    motion.run("trash", ["2"], () => slotOf("2").remove());
    const glide = glideOf("3")!;
    expect(ghosts.children).toHaveLength(1);

    const originalStart = document.startViewTransition;
    document.startViewTransition = ((update: () => void) => {
      update();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    }) as typeof document.startViewTransition;
    try {
      withViewTransition(() => undefined);
    } finally {
      document.startViewTransition = originalStart;
      detach();
    }

    expect(glide.cancel).toHaveBeenCalled();
    expect(ghosts.children).toHaveLength(0);
    expect(slotOf("3").style.zIndex).toBe("");
  });

  it("just commits where Web Animations are missing", () => {
    delete (Element.prototype as Partial<Element>).animate;
    build(5);
    const commit = vi.fn(() => slotOf("2").remove());

    const result = motion.run("trash", ["2"], commit);

    expect(commit).toHaveBeenCalledOnce();
    expect(result.departed.size).toBe(0);
    expect(ghosts.children).toHaveLength(0);
  });
});
