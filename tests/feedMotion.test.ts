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

  it("plays a send inside its morph: the cards below glide live, the sent card is the morph's", () => {
    build(5);
    const originalStart = document.startViewTransition;
    document.startViewTransition = ((update: () => void) => {
      update();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    }) as typeof document.startViewTransition;
    try {
      withViewTransition(() => motion.run("create", ["new"], () => feed.prepend(slot("new")), { morphed: "new" }));
    } finally {
      document.startViewTransition = originalStart;
    }

    expect(translateOf(glideOf("0")!.keyframes)).toBe(`0px ${-STEP}px`);
    expect(translateOf(glideOf("4")!.keyframes)).toBe(`0px ${-STEP}px`);
    expect(played.filter((entry) => entry.target === slotOf("new"))).toEqual([]);
  });

  it("drops a sent memo in when no morph carries it, and leaves the page where it is", () => {
    build(20, 1000);
    motion.run("create", ["new"], () => feed.prepend(slot("new")));
    // Nothing kept the place: a send lands at the head of the list.
    expect(window.scrollY).toBe(1000);

    played = [];
    window.scrollY = 0;
    build(5);
    motion.run("create", ["sent"], () => feed.prepend(slot("sent")));

    const arrival = played.find((entry) => entry.target === slotOf("sent"))!;
    expect(arrival.keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(-8px)" });
    expect(translateOf(glideOf("0")!.keyframes)).toBe(`0px ${-STEP}px`);
  });

  it("leaves a retagged card's new text to the card, moving it with its neighbours", () => {
    build(5);

    motion.run("retag", ["1", "3"], () => {
      slotOf("1").remove();
      slotOf("3").textContent = "Memo 3 #ideas";
    });

    // The card hands its own text over (MemoStage); here it only glides.
    expect(translateOf(glideOf("3")!.keyframes)).toBe(`0px ${STEP}px`);
    const stand = [...ghosts.querySelectorAll<HTMLElement>(".feed-ghost")].map((node) => node.textContent);
    expect(stand).toEqual(["Memo 1"]);
  });

  it("exits each card of a batch in its verb", () => {
    build(6);
    motion.run("trash", ["1", "2"], () => {
      slotOf("1").remove();
      slotOf("2").remove();
    });
    const sinks = played.filter((entry) => entry.target.classList.contains("feed-ghost"));
    expect(sinks).toHaveLength(2);
    for (const sink of sinks) expect(sink.keyframes[1]).toMatchObject({ opacity: 0, transform: "scale(0.965)" });

    motion.settle();
    played = [];
    motion.run("restore", ["3", "4"], () => {
      slotOf("3").remove();
      slotOf("4").remove();
    });
    const lifts = played.filter((entry) => entry.target.classList.contains("feed-ghost"));
    expect(lifts).toHaveLength(2);
    for (const lift of lifts) expect(lift.keyframes[1].transform).toBe("translateY(-18px) scale(0.995)");
  });

  it("keeps a mouse press on a gliding card on what it went down on", () => {
    build(4);
    motion.run("trash", ["1"], () => slotOf("1").remove());
    const press = (target: Element, pointerType: string) =>
      target.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, button: 0 }), { pointerType, pointerId: 7 }));
    const button = (id: string) => {
      const element = document.createElement("button");
      element.setPointerCapture = vi.fn();
      slotOf(id).append(element);
      return element;
    };

    // The card below the gap is gliding up: its release, and so its click,
    // stays on what was pressed even if the card moves on under the pointer.
    const moving = button("2");
    press(moving, "mouse");
    expect(moving.setPointerCapture).toHaveBeenCalledWith(7);
    // A touch holds its target by itself; a card standing still needs nothing.
    const touched = button("3");
    press(touched, "touch");
    expect(touched.setPointerCapture).not.toHaveBeenCalled();
    const still = button("0");
    press(still, "mouse");
    expect(still.setPointerCapture).not.toHaveBeenCalled();
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

describe("lens swaps", () => {
  /** A new list in the feed's place — these cards, in this order (kept ones keep their nodes) — and the page where the change leaves it. */
  function swap(ids: string[], scrollY = 0): () => void {
    return () => {
      const nodes = ids.map((id) => feed.querySelector<HTMLElement>(`:scope > .memo-slot[data-vt="memo-${id}"]`) ?? slot(id));
      feed.replaceChildren(...nodes, ghosts);
      window.scrollY = scrollY;
    };
  }
  const ghostsNow = () => [...ghosts.querySelectorAll<HTMLElement>(".feed-ghost")];

  it("glides the cards it keeps from where the reader saw them to where the rewind puts them", () => {
    // Scrolled two cards down: card 5 is painted at 342px, card 7 at 570px.
    build(20, 2 * STEP);

    motion.run("lens", [], swap(["7", "5", "x", "y"]));

    expect(translateOf(glideOf("7")!.keyframes)).toBe(`0px ${5 * STEP}px`);
    expect(translateOf(glideOf("5")!.keyframes)).toBe(`0px ${2 * STEP}px`);
    // The cards it drops sink where they were seen, though the page is back at the top.
    expect(ghostsNow().map((node) => [node.textContent, node.style.top])).toEqual(
      ["2", "3", "4", "6", "8", "9"].map((id) => [`Memo ${id}`, `${(Number(id) - 2) * STEP}px`])
    );
    const exit = played.find((entry) => entry.target === ghostsNow()[0])!;
    expect(exit.keyframes[1]).toMatchObject({ opacity: 0, transform: "scale(0.965)" });
    expect(exit.timing.duration).toBe(160);
    // Kept cards close over them.
    expect(slotOf("7").style.zIndex).toBe("1");
  });

  it("keeps a card that stays put over the exits too, while they play", async () => {
    build(6);

    motion.run("lens", [], swap(["0", "1", "2"]));

    // Cards 0–2 kept their places; 3–5 sink below them.
    expect(glideOf("0")).toBeUndefined();
    expect(slotOf("0").style.zIndex).toBe("1");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slotOf("0").style.zIndex).toBe("");
  });

  it("brings a card from far off in where it lands, and lets one going far off leave where it was, instead of streaking", () => {
    build(20);
    const order = ["15", "0", ...Array.from({ length: 13 }, (_unused, index) => String(index + 2)), "16", "17", "18", "19", "1"];

    motion.run("lens", [], swap(order));

    // Card 15 was a page and a half down: it rises at the top.
    expect(glideOf("15")).toBeUndefined();
    const rise = played.find((entry) => entry.target === slotOf("15"))!;
    expect(rise.keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(18px) scale(0.995)" });
    // Card 1 went to the end of the list: a copy of it sinks where it was seen; the card itself is left alone.
    expect(ghostsNow().map((node) => [node.textContent, node.style.top])).toEqual([["Memo 1", `${STEP}px`]]);
    expect(played.filter((entry) => entry.target === slotOf("1"))).toEqual([]);
    expect(translateOf(glideOf("0")!.keyframes)).toBe(`0px ${-STEP}px`);
  });

  it("brings a new list in a beat behind the old one leaving, ≤48ms apart down the screen", async () => {
    build(3);
    motion.observe(feed);
    played = [];

    motion.run("lens", [], swap(Array.from({ length: 10 }, (_unused, index) => `n${index}`)));
    await delivered();

    // n0–n7 land on screen (n7 at 798px); n8 and n9 below the fold need nothing.
    const rises = entrances();
    expect(rises.map((entry) => (entry.target as HTMLElement).dataset.vt)).toEqual(Array.from({ length: 8 }, (_unused, index) => `memo-n${index}`));
    expect(rises.map((entry) => entry.timing.delay)).toEqual([30, 38, 46, 54, 62, 70, 78, 78]);
    expect(rises[0].timing.fill).toBe("backwards");
    expect(ghostsNow().map((node) => node.textContent)).toEqual(["Memo 0", "Memo 1", "Memo 2"]);
    // It comes in over the old list sinking, not under it.
    expect(slotOf("n0").style.zIndex).toBe("1");
  });

  it("starts a second lens swap from the frame the first one paints", () => {
    build(6);
    motion.run("lens", [], swap(["3", "0", "1", "2", "4", "5"]));
    const first = glideOf("3")!;
    expect(translateOf(first.keyframes)).toBe(`0px ${3 * STEP}px`);

    // Half-way down its glide: drawn 171px below its place.
    const style = vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element: Element) =>
        ({ translate: element === slotOf("3") ? "0px 171px" : "none", transform: "none", opacity: "1", getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration
    );
    const box = slotOf("3").getBoundingClientRect;
    slotOf("3").getBoundingClientRect = () => {
      const rest = box();
      return { ...rest, top: rest.top + 171, bottom: rest.bottom + 171, y: rest.y + 171 } as DOMRect;
    };
    try {
      motion.run("lens", [], swap(["0", "3", "1", "2", "4", "5"]));
    } finally {
      style.mockRestore();
    }

    expect(first.cancel).toHaveBeenCalled();
    // From 171px, where it was drawn, to its new place at 114px.
    expect(translateOf(glideOf("3")!.keyframes)).toBe(`0px ${171 - STEP}px`);
  });

  it("dissolves a new list under reduced motion: opacity only, nothing travels, nothing waits", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    build(10);

    motion.run("lens", [], swap(["5", "n1", "0"]));

    expect(played.length).toBeGreaterThan(0);
    for (const entry of played) {
      for (const frame of entry.keyframes) expect(Object.keys(frame).filter((key) => key !== "offset")).toEqual(["opacity"]);
      expect(entry.timing.duration).toBeLessThanOrEqual(150);
      expect(entry.timing.delay ?? 0).toBe(0);
    }
    // Card 5's old look fades out where it was while it fades in at the top.
    expect(ghostsNow().some((node) => node.textContent === "Memo 5" && node.style.top === `${5 * STEP}px`)).toBe(true);
    expect(played.find((entry) => entry.target === slotOf("5"))!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it("renders the cards around the screen for the measure, and lets them go two frames later", async () => {
    build(30);

    motion.run("lens", [], swap(["n", ...Array.from({ length: 29 }, (_unused, index) => String(index))]));

    // Down to a viewport below the screen (1600px), eight at a time: the
    // first sixteen cards.
    const forced = Array.from(feed.querySelectorAll<HTMLElement>(":scope > .memo-slot")).map((node) => node.style.contentVisibility);
    expect(forced.slice(0, 16)).toEqual(Array(16).fill("visible"));
    expect(forced.slice(16)).toEqual(Array(14).fill(""));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(Array.from(feed.querySelectorAll<HTMLElement>(":scope > .memo-slot")).every((node) => node.style.contentVisibility === "")).toBe(true);
  });

  it("keeps the card a restored place hangs on where the change put it while the cards above it take their real heights", () => {
    build(30);
    // Rendered, a card is 160px tall; until then it stands at the 100px estimate.
    const heightOf = (node: HTMLElement) => (node.style.contentVisibility === "visible" ? 160 : CARD);
    for (const node of feed.querySelectorAll<HTMLElement>(":scope > .memo-slot")) {
      node.getBoundingClientRect = () => {
        let top = -window.scrollY;
        for (const other of feed.querySelectorAll<HTMLElement>(":scope > .memo-slot")) {
          if (other === node) break;
          top += heightOf(other) + GAP;
        }
        return { top, bottom: top + heightOf(node), left: 0, right: 600, width: 600, height: heightOf(node), x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      };
    }

    // The change restores a place: card 10 at the top of the screen.
    motion.run("lens", [], () => {
      window.scrollY = 10 * STEP;
    });

    // Cards 3–9, within a viewport above it, were rendered — 60px taller each — and the page followed.
    expect(window.scrollY).toBe(10 * STEP + 7 * 60);
    expect(slotOf("10").getBoundingClientRect().top).toBe(0);
  });

  it("holds the place card while the browser renders the cards above it, until the reader takes over", () => {
    let report: (() => void) | null = null;
    const observed = new Set<Element>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          report = callback;
        }
        observe(element: Element) {
          observed.add(element);
        }
        disconnect() {
          observed.clear();
        }
      }
    );
    build(30);
    const grown = new Set<string>();
    for (const node of feed.querySelectorAll<HTMLElement>(":scope > .memo-slot")) {
      node.getBoundingClientRect = () => {
        let top = -window.scrollY;
        for (const other of feed.querySelectorAll<HTMLElement>(":scope > .memo-slot")) {
          if (other === node) break;
          top += (grown.has(other.dataset.vt!) ? 60 : CARD) + GAP;
        }
        return { top, bottom: top + CARD, left: 0, right: 600, width: 600, height: CARD, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      };
    }
    try {
      // A return lands card 20 at the top of the screen.
      motion.run("lens", [], () => {
        window.scrollY = 20 * STEP;
      });
      // The cards above it are watched — three viewports' worth.
      expect(observed.has(slotOf("19"))).toBe(true);
      expect(observed.has(slotOf("20"))).toBe(false);

      // A frame later two of them take their real, shorter heights.
      grown.add("memo-17").add("memo-18");
      report!();
      expect(window.scrollY).toBe(20 * STEP - 80);
      expect(slotOf("20").getBoundingClientRect().top).toBe(0);

      // Where the browser's own scroll anchoring has already kept it, nothing more moves.
      grown.add("memo-16");
      window.scrollY -= 40;
      report!();
      expect(window.scrollY).toBe(20 * STEP - 80 - 40);

      // The reader scrolls: the place is theirs now.
      window.dispatchEvent(new Event("wheel"));
      expect(observed.size).toBe(0);

      // A later change ends one in progress, too.
      motion.run("lens", [], () => {
        window.scrollY = 22 * STEP;
      });
      expect(observed.size).toBeGreaterThan(0);
      motion.run("trash", ["25"], () => slotOf("25").remove());
      expect(observed.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps an exit in flight where the reader sees it when the next swap scrolls the page", () => {
    build(20, 5 * STEP);
    motion.run("trash", ["7"], () => slotOf("7").remove());
    const leaving = ghostsNow()[0];
    // Drawn where the card was: 2 cards below the top of the screen.
    leaving.getBoundingClientRect = () => ({ top: Number.parseFloat(leaving.style.top) - window.scrollY, left: 0 }) as DOMRect;
    expect(leaving.getBoundingClientRect().top).toBe(2 * STEP);

    motion.run("lens", [], swap(["0", "1", "2"]));

    expect(leaving.isConnected).toBe(true);
    expect(leaving.getBoundingClientRect().top).toBe(2 * STEP);
  });

  it("cuts a swap the browser has animated already: what is in flight lands, nothing new plays", async () => {
    build(5);
    motion.observe(feed);
    motion.run("trash", ["2"], () => slotOf("2").remove());
    const glide = glideOf("3")!;
    played = [];

    motion.run("lens", [], swap(["n0", "0"]), { motion: "none" });
    await delivered();

    expect(glide.cancel).toHaveBeenCalled();
    expect(ghosts.children).toHaveLength(0);
    expect(played).toEqual([]);
  });
});
