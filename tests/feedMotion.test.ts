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
  timing: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
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
/** MutationObserver records are delivered in a microtask. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The entrances played on cards, by memo key. */
const entrances = () => played.filter((entry) => entry.target.classList.contains("memo-slot") && !("translate" in entry.keyframes[0]));
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
  Element.prototype.animate = vi.fn(function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, timing?: number | KeyframeAnimationOptions) {
    const entry: Played = { target: this, keyframes: keyframes as Keyframe[], timing: typeof timing === "object" ? timing : {}, cancel: vi.fn(), finish: vi.fn() };
    played.push(entry);
    return { finished: new Promise(() => undefined), cancel: entry.cancel, finish: entry.finish } as unknown as Animation;
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
  motion.observe(null);
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

describe("card arrivals", () => {
  it("cascades the cards a page brings in, near the screen only", async () => {
    build(0);
    motion.observe(feed);

    feed.insertBefore(slot("0"), ghosts);
    for (let index = 1; index < 14; index += 1) feed.insertBefore(slot(String(index)), ghosts);
    await delivered();

    // A viewport and a half (1200px) is near: cards 0–10, ≤48ms apart.
    const played = entrances();
    expect(played.map((entry) => (entry.target as HTMLElement).dataset.vt)).toEqual(Array.from({ length: 11 }, (_unused, index) => `memo-${index}`));
    expect(played.map((entry) => entry.timing.delay)).toEqual([0, 8, 16, 24, 32, 40, 48, 48, 48, 48, 48]);
    expect(played[0].keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(18px) scale(0.995)" });
    // Held at its first frame through its turn in the cascade.
    expect(played[3].timing.fill).toBe("backwards");
  });

  it("lands at once the cards their first frame shows below the fold", async () => {
    build(0);
    motion.observe(feed);
    for (let index = 0; index < 12; index += 1) feed.insertBefore(slot(String(index)), ghosts);
    await delivered();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const byCard = new Map(entrances().map((entry) => [(entry.target as HTMLElement).dataset.vt, entry]));
    // Card 7 starts at 798px, the last on screen; 8–10 were near, not seen.
    expect(byCard.get("memo-7")!.finish).not.toHaveBeenCalled();
    for (const key of ["memo-8", "memo-9", "memo-10"]) expect(byCard.get(key)!.finish).toHaveBeenCalled();
  });

  it("brings in the cards the feed already holds when it is first watched", () => {
    build(3);
    motion.observe(feed);
    expect(entrances()).toHaveLength(3);
  });

  it("does not replay an entrance for a kept card React moves", async () => {
    build(4);
    motion.observe(feed);
    played = [];

    feed.prepend(slotOf("2"));
    await delivered();

    expect(played).toEqual([]);
  });

  it("leaves the cards a change mounts to that change", async () => {
    build(4);
    motion.observe(feed);
    played = [];

    motion.run("remote", ["new"], () => feed.prepend(slot("new")));
    await delivered();

    // One entrance, the change's own, in step with the glides it plays.
    expect(entrances().filter((entry) => entry.target === slotOf("new"))).toHaveLength(1);
    expect(glideOf("0")).toBeDefined();
  });

  it("leaves the cards a view transition's update mounts to its snapshot", async () => {
    build(3);
    motion.observe(feed);
    const detach = motion.attach();
    played = [];
    const originalStart = document.startViewTransition;
    document.startViewTransition = ((update: () => void) => {
      update();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    }) as typeof document.startViewTransition;
    try {
      withViewTransition(() => feed.insertBefore(slot("new"), ghosts));
      await delivered();
    } finally {
      document.startViewTransition = originalStart;
      detach();
    }

    expect(played).toEqual([]);
  });

  it("fades the cards in under reduced motion, all at once", async () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    build(0);
    motion.observe(feed);

    for (let index = 0; index < 3; index += 1) feed.insertBefore(slot(String(index)), ghosts);
    await delivered();

    const played = entrances();
    expect(played).toHaveLength(3);
    for (const entry of played) {
      expect(entry.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(entry.timing).toMatchObject({ duration: 150, delay: 0 });
    }
  });

  it("starts a change on a card still arriving from the frame its entrance paints", () => {
    build(4);
    motion.observe(feed);
    // Half-way through its rise: 9px low, half faded in. (jsdom reads no
    // matrices; the rise's is a plain translation.)
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        m41: number;
        m42: number;
        constructor(value: string) {
          const [, , , , x = 0, y = 0] = /matrix\((.*)\)/.exec(value)?.[1].split(",").map(Number) ?? [];
          this.m41 = x;
          this.m42 = y;
        }
      }
    );
    const style = vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element: Element) =>
        ({
          translate: "none",
          transform: element === slotOf("3") ? "matrix(1, 0, 0, 1, 0, 9)" : "none",
          opacity: element === slotOf("3") ? "0.5" : "1",
          getPropertyValue: () => ""
        }) as unknown as CSSStyleDeclaration
    );
    const box = slotOf("3").getBoundingClientRect;
    slotOf("3").getBoundingClientRect = () => {
      const rest = box();
      return { ...rest, top: rest.top + 9, bottom: rest.bottom + 9, y: rest.y + 9 } as DOMRect;
    };
    try {
      motion.run("trash", ["1"], () => slotOf("1").remove());
    } finally {
      style.mockRestore();
      vi.unstubAllGlobals();
    }

    // The rise is cut, and the glide picks it up where it was painted.
    const rise = played.find((entry) => entry.target === slotOf("3") && !("translate" in entry.keyframes[0]))!;
    expect(rise.cancel).toHaveBeenCalled();
    expect(glideOf("3")!.keyframes[0]).toEqual({ translate: `0px ${STEP + 9}px`, opacity: 0.5 });
  });
});
