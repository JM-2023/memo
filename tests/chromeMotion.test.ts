// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedMotion, type FeedMotion } from "../src/lib/feedMotion";

interface Played {
  target: Element;
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
}

let played: Played[] = [];
let main: HTMLElement;
let breadcrumb: HTMLElement;
let motion: FeedMotion;

/** jsdom has no layout: each part answers with the box the test gives it. */
function at(el: Element, left: number, top = 16, width = 90, height = 30): Element {
  const rect = { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  el.getBoundingClientRect = () => rect;
  return el;
}

function html(markup: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as HTMLElement;
}

const ghostsOf = () => Array.from(main.querySelectorAll<HTMLElement>("[data-motion-ghost]"));
const playedOn = (target: Element) => played.filter((entry) => entry.target === target);
const keys = (entry: Played) => [...new Set(entry.keyframes.flatMap((frame) => Object.keys(frame).filter((key) => key !== "offset")))];

beforeEach(() => {
  played = [];
  window.innerHeight = 800;
  window.scrollY = 0;
  window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
  Element.prototype.animate = vi.fn(function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, timing?: number | KeyframeAnimationOptions) {
    played.push({ target: this, keyframes: keyframes as Keyframe[], timing: typeof timing === "object" ? timing : {} });
    return { finished: new Promise(() => undefined), cancel: vi.fn(), finish: vi.fn(), effect: { target: this } } as unknown as Animation;
  }) as typeof Element.prototype.animate;
  main = html(`<main><div class="topbar"><div class="breadcrumb"></div></div><section class="memo-feed"><div class="feed-ghosts"></div></section></main>`);
  document.body.append(main);
  at(main.querySelector(".topbar")!, 0, 0, 800, 60);
  breadcrumb = main.querySelector(".breadcrumb")!;
  const feed = main.querySelector<HTMLElement>(".memo-feed")!;
  motion = createFeedMotion({ feed: () => feed, ghosts: () => feed.querySelector(".feed-ghosts") });
});

afterEach(() => {
  motion.settle();
  document.body.innerHTML = "";
  delete (Element.prototype as Partial<Element>).animate;
});

/** The location trail at the root, with a day chip behind the pill. */
function trail(): void {
  const nav = at(html(`<nav class="crumbs"><span class="loc-menu"><button class="loc-trigger" id="loc">All memos</button></span></nav>`), 0, 16, 120);
  at(nav.querySelector(".loc-trigger")!, 10, 16, 100);
  breadcrumb.append(nav, at(html(`<button class="filter-chip" data-motion="day-filter-chip" id="chip">Oct 3</button>`), 130, 16, 80));
}

/** The selection toolbar that replaces it. */
function toolbar(): void {
  const bar = at(html(`<div class="select-bar"><span class="select-count">1 selected</span><button class="select-pill select-all">Select all</button><button class="select-delete">Trash</button></div>`), 0, 16, 600);
  at(bar.querySelector(".select-count")!, 10, 16, 110);
  at(bar.querySelector(".select-all")!, 130, 16, 80);
  at(bar.querySelector(".select-delete")!, 220, 16, 60);
  breadcrumb.replaceChildren(bar);
}

describe("chrome motion", () => {
  it("hands the location pill over to the selection counter: the old look fades out over the new one fading in", () => {
    trail();
    motion.run("select", [], toolbar);

    const count = breadcrumb.querySelector(".select-count")!;
    expect(playedOn(count).map((entry) => entry.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    const pill = ghostsOf().find((ghost) => ghost.classList.contains("loc-trigger"))!;
    expect(pill.textContent).toBe("All memos");
    expect(pill.style.left).toBe("10px");
    // At the size it was, not the counter's.
    expect(pill.style.width).toBe("100px");
    expect(playedOn(pill).map((entry) => entry.keyframes)).toEqual([[{ opacity: 1 }, { opacity: 0 }]]);
  });

  it("folds the trail and the chips back the way crumbs leave, without the pill they held", () => {
    trail();
    motion.run("select", [], toolbar);

    const nav = ghostsOf().find((ghost) => ghost.matches("nav.crumbs"))!;
    const chip = ghostsOf().find((ghost) => ghost.matches(".filter-chip"))!;
    for (const ghost of [nav, chip]) expect(playedOn(ghost)[0].keyframes[1]).toMatchObject({ opacity: 0, transform: "translateX(-10px)" });
    // The pill inside the leaving trail is the counter's to hand over.
    expect(nav.querySelector<HTMLElement>(".loc-trigger")!.style.visibility).toBe("hidden");
    // The toolbar's own parts enter by themselves: nothing is laid on them.
    expect(playedOn(breadcrumb.querySelector(".select-delete")!)).toEqual([]);
    expect(playedOn(breadcrumb.querySelector(".select-bar")!)).toEqual([]);
  });

  it("keeps its stand-ins out of reach: inert, hidden from assistive tech, no ids, no motion or names of their own", () => {
    trail();
    motion.run("select", [], toolbar);

    expect(ghostsOf().length).toBeGreaterThan(0);
    for (const ghost of ghostsOf()) {
      expect(ghost.inert).toBe(true);
      expect(ghost.getAttribute("aria-hidden")).toBe("true");
      expect(ghost.querySelector("[id]")).toBeNull();
      expect(ghost.id).toBe("");
      expect(ghost.style.getPropertyValue("animation")).toBe("none");
      expect(ghost.style.getPropertyPriority("view-transition-name")).toBe("important");
    }
  });

  it("glides a part that only moved from where it was drawn", () => {
    breadcrumb.append(
      at(html(`<button class="filter-chip" data-motion="day-filter-chip">Oct 3</button>`), 130),
      at(html(`<button class="filter-chip" data-motion="facet-chip-hasImage">Images</button>`), 230)
    );

    motion.run("select", [], () => {
      breadcrumb.querySelector('[data-motion="day-filter-chip"]')!.remove();
      at(breadcrumb.querySelector('[data-motion="facet-chip-hasImage"]')!, 130);
    });

    const images = breadcrumb.querySelector('[data-motion="facet-chip-hasImage"]')!;
    expect(playedOn(images).map((entry) => entry.keyframes)).toEqual([[{ translate: "100px 0px" }, { translate: "0px 0px" }]]);
    expect(ghostsOf().map((ghost) => ghost.textContent)).toEqual(["Oct 3"]);
  });

  it("cross-fades a pill that arms in place", () => {
    toolbar();
    motion.run("select", [], () => {
      const pill = breadcrumb.querySelector(".select-delete")!;
      pill.className = "select-delete is-confirm";
      pill.textContent = "Delete 1 memo?";
      at(pill, 220, 16, 140);
    });

    const pill = breadcrumb.querySelector(".select-delete")!;
    // It grows from its old edge, 80px of it uncovered over the glide, as it fades in.
    expect(playedOn(pill).map((entry) => entry.keyframes)).toEqual([
      [{ clipPath: "inset(0px 80px 0px 0px round 0px)" }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }],
      [{ opacity: 0 }, { opacity: 1 }]
    ]);
    const ghost = ghostsOf()[0];
    expect(ghost.textContent).toBe("Trash");
    expect(ghost.style.width).toBe("60px");
    expect(playedOn(ghost).map(keys)).toEqual([["opacity"]]);
  });

  it("retracts the old look of a pill that narrows as it disarms", () => {
    toolbar();
    const pill = breadcrumb.querySelector(".select-delete")!;
    pill.className = "select-delete is-confirm";
    at(pill, 220, 16, 140);
    motion.run("select", [], () => {
      pill.className = "select-delete";
      at(pill, 220, 16, 60);
    });
    const ghost = ghostsOf()[0];
    expect(playedOn(ghost)[0].keyframes).toEqual([{ clipPath: "inset(0px 0px 0px 0px round 0px)" }, { clipPath: "inset(0px 80px 0px 0px round 0px)" }]);
    expect(playedOn(pill).map((entry) => entry.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
  });

  it("makes room beside a pill that widens as it arms", () => {
    toolbar();
    const cancel = at(html(`<button class="select-pill select-exit">Cancel</button>`), 290, 16, 60);
    breadcrumb.querySelector(".select-bar")!.append(cancel);
    motion.run("select", [], () => {
      const pill = breadcrumb.querySelector(".select-delete")!;
      pill.className = "select-delete is-confirm";
      at(pill, 220, 16, 140);
      at(cancel, 370, 16, 60);
    });
    expect(playedOn(cancel).map((entry) => entry.keyframes)).toEqual([[{ translate: "-80px 0px" }, { translate: "0px 0px" }]]);
  });

  it("leaves a count that rolls its own digits alone", () => {
    toolbar();
    const count = breadcrumb.querySelector(".select-count")!;
    count.innerHTML = `<span class="roll">1</span> selected`;
    motion.run("select", [], () => {
      count.innerHTML = `<span class="roll">12</span> selected`;
      at(count, 10, 16, 118);
    });
    expect(played).toEqual([]);
  });

  it("plays the same decisions as opacity alone under reduced motion", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    trail();
    breadcrumb.append(at(html(`<button class="filter-chip" data-motion="facet-chip-hasImage">Images</button>`), 230));
    motion.run("select", [], () => {
      breadcrumb.querySelector(".filter-chip")!.remove();
      at(breadcrumb.querySelector('[data-motion="facet-chip-hasImage"]')!, 130);
    });

    expect(played.length).toBeGreaterThan(0);
    for (const entry of played) expect(keys(entry)).toEqual(["opacity"]);
    for (const entry of played) expect(entry.timing.duration).toBeLessThanOrEqual(150);
    // The chip that moved fades out where it was and in where it is.
    const images = breadcrumb.querySelector('[data-motion="facet-chip-hasImage"]')!;
    expect(playedOn(images).map((entry) => entry.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    expect(ghostsOf().some((ghost) => ghost.textContent === "Images" && ghost.style.left === "230px")).toBe(true);
  });

  /** The composer in the column, at `top` on the screen, with the lens's tag if any. */
  function composer(top: number, tag?: string): HTMLElement {
    const node = at(html(`<div class="composer"><textarea></textarea></div>`), 0, top, 600, 120) as HTMLElement;
    if (tag) node.prepend(at(html(`<span class="editor-context-tag"><span>${tag}</span></span>`), 12, top + 8, 60, 20));
    main.insertBefore(node, main.querySelector(".memo-feed"));
    return node;
  }

  it("sinks the composer as Trash folds it away, over the cards closing under it", () => {
    const column = composer(80, "#idea");
    motion.run("lens", [], () => {
      column.hidden = true;
    });

    const [ghost] = ghostsOf();
    expect(ghostsOf()).toHaveLength(1);
    expect(ghost.matches(".composer")).toBe(true);
    // Where it was on the screen, at the composer's own level.
    expect(ghost.style.top).toBe("80px");
    expect(ghost.style.zIndex).toBe("30");
    expect(playedOn(ghost)[0].keyframes[1]).toMatchObject({ opacity: 0, transform: "scale(0.965)" });
    // The tag inside it leaves with it, not on its own.
    expect(ghost.querySelector(".editor-context-tag")).not.toBeNull();
  });

  it("raises a composer a rewind brings from far above where it lands, rather than streak it down the page", () => {
    const column = composer(-3000);
    motion.run("lens", [], () => {
      at(column, 0, 80, 600, 120);
    });

    expect(ghostsOf()).toEqual([]);
    expect(playedOn(column).map((entry) => entry.keyframes[0])).toEqual([{ opacity: 0, transform: "translateY(18px) scale(0.995)" }]);
  });

  it("glides the composer when it moves only a little, and folds the lens's tag in as a crumb", () => {
    const column = composer(80);
    motion.run("lens", [], () => {
      at(column, 0, 110, 600, 120);
      column.prepend(at(html(`<span class="editor-context-tag"><span>#idea</span></span>`), 12, 118, 60, 20));
    });

    expect(playedOn(column).map((entry) => entry.keyframes)).toEqual([[{ translate: "0px -30px" }, { translate: "0px 0px" }]]);
    const tag = column.querySelector(".editor-context-tag")!;
    expect(playedOn(tag).map((entry) => entry.keyframes[0])).toEqual([{ opacity: 0, transform: "translateX(-12px)", filter: "blur(4px)" }]);
  });

  it("lets a column part leave unseen when it was off the screen", () => {
    const column = composer(-3000);
    motion.run("lens", [], () => {
      column.hidden = true;
    });
    expect(ghostsOf()).toEqual([]);
    expect(played).toEqual([]);
  });

  it("ends the stand-ins when everything settles", () => {
    trail();
    motion.run("select", [], toolbar);
    expect(ghostsOf().length).toBeGreaterThan(0);
    motion.settle();
    expect(ghostsOf()).toEqual([]);
  });
});
