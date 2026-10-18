// @vitest-environment jsdom

// Feed card behaviour: the long-memo fold, the ⋯ menu's flip and ARIA
// wiring, one-step trash with a confirmed permanent delete, the trash card's
// visible Restore, the off-screen replay skip, and the card's motion under
// reduced motion.

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoCard, SelectRingStagger } from "../src/components/MemoCard";
import { mightFold } from "../src/components/MemoFold";
import { Menu } from "../src/components/Menu";
import { TagTree } from "../src/components/TagTree";
import { TipProvider } from "../src/components/Tip";
import { formatTime } from "../src/lib/dates";
import { forgetAllFolds, forgetFolds, isUnfolded } from "../src/lib/foldMemory";
import { LanguageProvider } from "../src/lib/i18n";
import { EXIT_MS, T_BASE, T_ENTER, T_EXIT, T_FAST } from "../src/lib/motion";
import { SCROLL_JUMP_EVENT } from "../src/lib/navHistory";
import type { TagNode } from "../src/lib/tags";
import type { Memo } from "../src/lib/types";

const baseMemo: Memo = {
  id: "memo-card",
  content: "hello #work",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
  pinnedAt: null,
  deletedAt: null,
  seq: 1,
  images: []
};

const LONG = Array.from({ length: 30 }, (_, index) => `line ${index + 1} with [a link](https://example.com/${index})`).join("\n");

type CardProps = Parameters<typeof MemoCard>[0];

function cardProps(overrides: Partial<CardProps> = {}): CardProps {
  return {
    memo: baseMemo,
    variant: "normal",
    knownTags: [],
    editing: false,
    savingEdit: false,
    editConflict: false,
    selecting: false,
    selected: false,
    onToggleSelect: vi.fn(),
    onStartEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdit: vi.fn(async () => true),
    onAcceptEditConflict: vi.fn(),
    onTogglePin: vi.fn(),
    onAddTag: vi.fn(),
    onCopy: vi.fn(),
    onShare: vi.fn(),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    onPurge: vi.fn(),
    onPickTag: vi.fn(),
    onOpenImage: vi.fn(),
    onToggleTask: vi.fn(),
    ...overrides
  };
}

function Providers({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

function renderCard(overrides: Partial<CardProps> = {}) {
  const props = cardProps(overrides);
  const view = render(
    <Providers>
      <MemoCard {...props} />
    </Providers>
  );
  return { ...view, props, rerenderCard: (next: Partial<CardProps>) => view.rerender(<Providers><MemoCard {...props} {...next} /></Providers>) };
}

function stubMatchMedia(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

beforeEach(() => {
  stubMatchMedia(true);
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
});

afterEach(() => {
  cleanup();
  // Unfolded memos are remembered feed-wide (lib/foldMemory), and every
  // test's card shares one id.
  forgetAllFolds();
  delete (Element.prototype as Element & { animate?: unknown }).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("long-memo fold", () => {
  it("only measures text that could plausibly outgrow the fold", () => {
    expect(mightFold("a short memo")).toBe(false);
    expect(mightFold(Array.from({ length: 6 }, () => "line").join("\n"))).toBe(false);
    expect(mightFold(LONG)).toBe(true);
    expect(mightFold("x".repeat(400))).toBe(true);
  });

  it("clamps a body taller than the fold and toggles it with a labelled, keyboard-reachable button", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memo-content") ? 900 : 0;
    });
    const { container } = renderCard({ memo: { ...baseMemo, content: LONG } });

    const fold = container.querySelector<HTMLElement>(".memo-fold");
    expect(fold?.hasAttribute("data-overflow")).toBe(true);
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(fold?.id);

    await user.click(toggle);
    expect(fold?.classList.contains("is-expanded")).toBe(true);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");

    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollBy", { configurable: true, value: scrollBy });
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(fold?.classList.contains("is-expanded")).toBe(false);
  });

  describe("fold motion", () => {
    interface Recorded {
      el: Element;
      keyframes: Keyframe[];
      options: KeyframeAnimationOptions;
      finish: () => void;
      cancel: ReturnType<typeof vi.fn>;
      handle: { playState: AnimationPlayState; progress: number };
    }
    let animations: Recorded[];

    function foldAnimations() {
      return animations.filter((animation) => animation.el.classList.contains("memo-fold"));
    }

    function setup(cardTop: number) {
      stubMatchMedia(false);
      animations = [];
      Object.defineProperty(Element.prototype, "animate", {
        configurable: true,
        value: vi.fn(function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
          let resolve!: () => void;
          const finished = new Promise<void>((done) => (resolve = done));
          const cancel = vi.fn();
          const handle = {
            finished,
            cancel,
            playState: "running" as AnimationPlayState,
            progress: 0,
            effect: { getComputedTiming: () => ({ progress: handle.progress }) }
          };
          animations.push({ el: this, keyframes, options, finish: () => resolve(), cancel, handle });
          return handle;
        })
      });
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("memo-content") ? 900 : 0;
      });
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this.classList.contains("memo-fold")) return new DOMRect(0, cardTop + 30, 300, this.classList.contains("is-expanded") ? 900 : 320);
        if (this.classList.contains("memo-card")) return new DOMRect(0, cardTop, 330, 1000);
        return new DOMRect(0, 0, 0, 0);
      });
      const scrollBy = vi.fn();
      Object.defineProperty(window, "scrollBy", { configurable: true, value: scrollBy });
      return { ...renderCard({ memo: { ...baseMemo, content: LONG } }), scrollBy };
    }

    it("drains the fade with the height while unfolding, and eases back down with the card's top in view", async () => {
      const user = userEvent.setup();
      const { container, scrollBy } = setup(40);
      const fold = container.querySelector<HTMLElement>(".memo-fold")!;

      await user.click(screen.getByRole("button", { name: "Show more" }));
      expect(fold.classList.contains("is-expanded")).toBe(true);
      // The mask stays on while it drains, so no hard edge slides down.
      expect(fold.classList.contains("is-unfolding")).toBe(true);
      const [unfold] = foldAnimations();
      expect(unfold.keyframes).toEqual([
        { height: "320px", "--fold-fade": "56px" },
        { height: "900px", "--fold-fade": "0px" }
      ]);
      expect(unfold.options).toMatchObject({ duration: T_ENTER, fill: "forwards" });
      await act(async () => unfold.finish());
      expect(fold.classList.contains("is-unfolding")).toBe(false);
      expect(unfold.cancel).toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Show less" }));
      expect(fold.classList.contains("is-expanded")).toBe(false);
      const fold2 = foldAnimations()[1];
      expect(fold2.keyframes).toEqual([
        { maxHeight: "900px", "--fold-fade": "0px" },
        { maxHeight: "320px", "--fold-fade": "56px" }
      ]);
      // Closing is an exit: its beat and curve.
      expect(fold2.options).toMatchObject({ duration: T_EXIT });
      expect(scrollBy).not.toHaveBeenCalled();
    });

    function rollSetup(startY: number) {
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
      let scrollY = startY;
      Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
      return {
        frames,
        frame: () => act(() => frames.shift()?.(performance.now())),
        scroll: (by: number) => (scrollY = Math.max(0, scrollY + by)),
        scrollY: () => scrollY
      };
    }

    it("rolls back to the memo's start when the card's top is above the viewport, the toggle held under the pointer", async () => {
      const user = userEvent.setup();
      const { container, scrollBy } = setup(-700);
      await user.click(screen.getByRole("button", { name: "Show more" }));
      await act(async () => foldAnimations()[0].finish());
      const page = rollSetup(2000);
      scrollBy.mockImplementation(({ top }: ScrollToOptions) => page.scroll(top ?? 0));
      const jumps = vi.fn();
      window.addEventListener(SCROLL_JUMP_EVENT, jumps);

      await user.click(screen.getByRole("button", { name: "Show less" }));
      const fold = container.querySelector<HTMLElement>(".memo-fold")!;
      expect(fold.classList.contains("is-expanded")).toBe(false);
      // The curve lives on the fade; the box holds its open height inline.
      const roll = foldAnimations()[1];
      expect(roll.keyframes).toEqual([{ "--fold-fade": "0px" }, { "--fold-fade": "56px" }]);
      // 580px to travel: the base 280ms plus 58ms.
      expect(roll.options).toMatchObject({ duration: 338 });
      expect(fold.style.maxHeight).toBe("900px");
      // Nothing jumps on the click itself...
      expect(scrollBy).not.toHaveBeenCalled();

      // ...the page scrolls up on the curve, and the box closes by exactly
      // what it scrolled, so the toggle stays put.
      page.frame();
      expect(scrollBy).not.toHaveBeenCalled();
      roll.handle.progress = 0.5;
      page.frame();
      expect(scrollBy).toHaveBeenLastCalledWith({ top: -290, behavior: "instant" });
      expect(fold.style.maxHeight).toBe("610px");
      // The reader's own wheel mid-roll is theirs: it is not undone.
      page.scroll(120);
      roll.handle.progress = 0.8;
      page.frame();
      expect(scrollBy).toHaveBeenLastCalledWith({ top: -174, behavior: "instant" });
      expect(fold.style.maxHeight).toBe("436px");
      roll.handle.playState = "finished";
      page.frame();
      expect(scrollBy).toHaveBeenLastCalledWith({ top: -116, behavior: "instant" });
      // The folded rule takes over where the roll lands.
      expect(fold.style.maxHeight).toBe("");
      expect(page.scrollY()).toBe(2000 - 580 + 120);
      expect(page.frames).toHaveLength(0);
      // The app moved the page, not the reader: the phone topbar holds.
      expect(jumps).toHaveBeenCalled();
      window.removeEventListener(SCROLL_JUMP_EVENT, jumps);
    });

    it("still closes the box when the page's top stops the roll", async () => {
      const user = userEvent.setup();
      const { container, scrollBy } = setup(-700);
      await user.click(screen.getByRole("button", { name: "Show more" }));
      await act(async () => foldAnimations()[0].finish());
      const page = rollSetup(100);
      scrollBy.mockImplementation(({ top }: ScrollToOptions) => page.scroll(top ?? 0));

      await user.click(screen.getByRole("button", { name: "Show less" }));
      const fold = container.querySelector<HTMLElement>(".memo-fold")!;
      const roll = foldAnimations()[1];
      roll.handle.progress = 0.5;
      page.frame();
      // 290px owed, 100px of page to give: the toggle rises the other 190.
      expect(page.scrollY()).toBe(0);
      expect(fold.style.maxHeight).toBe("610px");
      roll.handle.playState = "finished";
      page.frame();
      expect(fold.style.maxHeight).toBe("");
    });

    it("hands an interrupted roll's box back at its current height", async () => {
      const user = userEvent.setup();
      const { container } = setup(-700);
      await user.click(screen.getByRole("button", { name: "Show more" }));
      await act(async () => foldAnimations()[0].finish());
      const page = rollSetup(2000);
      await user.click(screen.getByRole("button", { name: "Show less" }));
      const fold = container.querySelector<HTMLElement>(".memo-fold")!;
      const roll = foldAnimations()[1];
      roll.handle.progress = 0.5;
      page.frame();
      expect(fold.style.maxHeight).toBe("610px");

      await user.click(screen.getByRole("button", { name: "Show more" }));
      expect(roll.cancel).toHaveBeenCalled();
      // The cap is gone, so the reopened box can grow to its full height.
      expect(fold.style.maxHeight).toBe("");
      page.frame();
      expect(page.frames).toHaveLength(0);
    });

    it("snaps shut under reduced motion, keeping the toggle under the pointer, and fades the edge back in", async () => {
      const user = userEvent.setup();
      const { container, scrollBy } = setup(-700);
      await user.click(screen.getByRole("button", { name: "Show more" }));
      await act(async () => foldAnimations()[0].finish());
      stubMatchMedia(true);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("memo-fold-toggle")) return new DOMRect(0, this.previousElementSibling?.classList.contains("is-expanded") ? 300 : -280, 80, 20);
        if (this.classList.contains("memo-fold")) return new DOMRect(0, -670, 300, this.classList.contains("is-expanded") ? 900 : 320);
        if (this.classList.contains("memo-card")) return new DOMRect(0, -700, 330, 1000);
        return new DOMRect(0, 0, 0, 0);
      });

      await user.click(screen.getByRole("button", { name: "Show less" }));
      expect(container.querySelector(".memo-fold")?.classList.contains("is-expanded")).toBe(false);
      expect(scrollBy).toHaveBeenCalledWith({ top: -580, behavior: "instant" });
      // The box does not travel: only the fade pours back, over --t.
      expect(foldAnimations()).toHaveLength(2);
      const fade = foldAnimations()[1];
      expect(fade.keyframes).toEqual([{ "--fold-fade": "0px" }, { "--fold-fade": "56px" }]);
      expect(fade.options).toMatchObject({ duration: T_BASE });
    });

    it("opens at once under reduced motion and drains only the fade", async () => {
      const user = userEvent.setup();
      const { container } = setup(40);
      stubMatchMedia(true);
      await user.click(screen.getByRole("button", { name: "Show more" }));
      const fold = container.querySelector<HTMLElement>(".memo-fold")!;
      expect(fold.classList.contains("is-expanded")).toBe(true);
      // The mask holds while the fade drains, so the end of the text
      // dissolves in instead of appearing with a hard edge.
      expect(fold.classList.contains("is-unfolding")).toBe(true);
      const [unfold] = foldAnimations();
      expect(unfold.keyframes).toEqual([{ "--fold-fade": "56px" }, { "--fold-fade": "0px" }]);
      expect(unfold.options).toMatchObject({ duration: T_BASE, fill: "forwards" });
      await act(async () => unfold.finish());
      expect(fold.classList.contains("is-unfolding")).toBe(false);
    });
  });

  it("comes back open after a remount when the reader left it open, and forgets it on purge", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memo-content") ? 900 : 0;
    });
    const long = { ...baseMemo, content: LONG };
    const first = renderCard({ memo: long });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(isUnfolded(long.id)).toBe(true);
    // A lens change (or a trip to Trash) unmounts the card…
    first.unmount();
    // …and the card that comes back is still open, so a reading place
    // measured inside the open body still lands where it was taken.
    const { container } = renderCard({ memo: long });
    expect(container.querySelector(".memo-fold")?.classList.contains("is-expanded")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(isUnfolded(long.id)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Show more" }));
    forgetFolds([long.id]);
    expect(isUnfolded(long.id)).toBe(false);
  });

  it("leaves a body that fits alone: no clamp, no toggle", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    const { container } = renderCard({ memo: { ...baseMemo, content: LONG } });
    expect(container.querySelector(".memo-fold")?.hasAttribute("data-overflow")).toBe(false);
  });

  it("unfolds when keyboard focus lands on a link hidden below the fold", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memo-content") ? 900 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("memo-fold")) return new DOMRect(0, 0, 300, 320);
      if (this.tagName === "A" && this.textContent === "a link" && this.getAttribute("href")?.endsWith("/29")) return new DOMRect(0, 760, 40, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    const { container } = renderCard({ memo: { ...baseMemo, content: LONG } });
    const links = container.querySelectorAll<HTMLAnchorElement>(".memo-fold a");
    act(() => links[0].focus());
    expect(container.querySelector(".memo-fold")?.classList.contains("is-expanded")).toBe(false);
    act(() => links[links.length - 1].focus());
    expect(container.querySelector(".memo-fold")?.classList.contains("is-expanded")).toBe(true);
  });
});

describe("memo card menu", () => {
  it("names each ⋯ by its memo and wires popup state to the panel", async () => {
    const user = userEvent.setup();
    renderCard();
    const trigger = screen.getByRole("button", { name: `Memo actions, ${formatTime(baseMemo.createdAt, "en-US")}` });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
  });

  it("moves to Trash in one step — the toast's Undo is the safety net", async () => {
    const user = userEvent.setup();
    const { props } = renderCard();
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("holds pin and trash while one of them is in flight", async () => {
    const user = userEvent.setup();
    renderCard({ busy: true });
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    expect((screen.getByRole("menuitem", { name: "Pin", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Move to Trash", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("numbers image buttons so nine thumbnails are not nine identical names", () => {
    renderCard({
      memo: {
        ...baseMemo,
        images: [
          { id: "img-a", mime: "image/webp", width: 10, height: 10, bytes: 1 },
          { id: "img-b", mime: "image/webp", width: 10, height: 10, bytes: 1 }
        ]
      }
    });
    expect(screen.getByRole("button", { name: "View image 1 of 2" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "View image 2 of 2" })).not.toBeNull();
  });

  it("opens upward when the panel would run past the viewport bottom", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 340 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("menu-root") ? new DOMRect(300, 620, 26, 26) : new DOMRect(0, 0, 0, 0);
    });
    renderCard();
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    expect(screen.getByRole("menu").classList.contains("is-up")).toBe(true);
  });

  it("keeps opening downward where it fits", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 340 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("menu-root") ? new DOMRect(300, 200, 26, 26) : new DOMRect(0, 0, 0, 0);
    });
    renderCard();
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    expect(screen.getByRole("menu").classList.contains("is-up")).toBe(false);
  });
});

describe("pin mark", () => {
  const PINNED_AT = "2026-07-16T09:00:00.000Z";
  const mark = (container: HTMLElement) => container.querySelector(".memo-head .memo-pin-mark");

  it("stays still when a pinned card mounts, and pops only when the memo becomes pinned", () => {
    const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, pinnedAt: PINNED_AT } });
    expect(mark(container)?.classList.contains("is-new")).toBe(false);

    rerenderCard({ memo: { ...baseMemo, pinnedAt: null } });
    // Unpinning plays the pop backwards rather than cutting the mark.
    expect(mark(container)?.classList.contains("is-leaving")).toBe(true);
    rerenderCard({ memo: { ...baseMemo, pinnedAt: PINNED_AT } });
    expect(mark(container)?.classList.contains("is-new")).toBe(true);

    // Once played, a later render (an edit closing, say) does not replay it.
    act(() => {
      for (const type of ["animationend", "webkitAnimationEnd"]) mark(container)!.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(mark(container)?.classList.contains("is-new")).toBe(false);
    rerenderCard({ memo: { ...baseMemo, pinnedAt: PINNED_AT, content: "hello again" } });
    expect(mark(container)?.classList.contains("is-new")).toBe(false);
  });

  it("holds the unpinned mark for the exit beat, unnamed, then lets it go", () => {
    vi.useFakeTimers();
    try {
      const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, pinnedAt: PINNED_AT } });
      expect(within(container).getByLabelText("Pinned")).not.toBeNull();
      rerenderCard({ memo: { ...baseMemo, pinnedAt: null } });
      const leaving = mark(container);
      expect(leaving?.classList.contains("is-leaving")).toBe(true);
      // Already unpinned: the leaving mark says nothing.
      expect(leaving?.getAttribute("aria-hidden")).toBe("true");
      expect(within(container).queryByLabelText("Pinned")).toBeNull();
      act(() => vi.advanceTimersByTime(EXIT_MS - 1));
      expect(mark(container)).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(mark(container)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("card name", () => {
  it("names each card by its time, as its ⋯ is", () => {
    renderCard();
    const card = screen.getByRole("article", { name: formatTime(baseMemo.createdAt, "en-US") });
    const time = card.querySelector("time.memo-time");
    expect(card.getAttribute("aria-labelledby")).toBe(time?.id);
  });

  it("names a trashed card by its deletion", () => {
    const trashed: Memo = { ...baseMemo, deletedAt: "2026-07-17T09:30:00.000Z" };
    renderCard({ memo: trashed, variant: "trash" });
    expect(screen.getByRole("article", { name: `Deleted ${formatTime(trashed.deletedAt!, "en-US")}` })).not.toBeNull();
  });
});

describe("trash card", () => {
  const trashed: Memo = { ...baseMemo, deletedAt: "2026-07-17T09:30:00.000Z" };

  it("offers Restore on the card and states the deletion in words", async () => {
    const user = userEvent.setup();
    const { props, container } = renderCard({ memo: trashed, variant: "trash" });
    const stamp = formatTime(trashed.deletedAt!, "en-US");
    expect(container.querySelector(".memo-time")?.textContent).toBe(`Deleted ${stamp}`);
    await user.click(screen.getByRole("button", { name: `Restore memo deleted ${stamp}` }));
    expect(props.onRestore).toHaveBeenCalledTimes(1);
  });

  it("disables Restore while a restore is in flight", () => {
    renderCard({ memo: trashed, variant: "trash", busy: true });
    expect((screen.getByRole("button", { name: /^Restore memo deleted/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms a permanent delete, describing the consequence and starting on Cancel", async () => {
    const user = userEvent.setup();
    const { props } = renderCard({ memo: trashed, variant: "trash" });
    await user.click(screen.getByRole("button", { name: /^Memo actions, deleted/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));
    const confirm = screen.getByRole("menuitem", { name: "Delete forever" });
    expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/can’t be undone/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel" })));
    expect(props.onPurge).not.toHaveBeenCalled();
    await user.click(confirm);
    expect(props.onPurge).toHaveBeenCalledTimes(1);
  });
});

describe("tag menu", () => {
  it("describes the removal's reach on the confirm item and wires the trigger", async () => {
    const user = userEvent.setup();
    const tree: TagNode[] = [
      { name: "work", path: "work", count: 3, children: [{ name: "client", path: "work/client", count: 1, children: [] }] }
    ];
    render(
      <Providers>
        <TagTree tree={tree} activeTag={null} pinnedTags={new Map()} onPickTag={vi.fn()} onPinTag={vi.fn()} onRenameTag={vi.fn()} onRemoveTag={vi.fn()} />
      </Providers>
    );
    const trigger = screen.getByRole("button", { name: "Actions for tag work" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: "Remove tag" }));
    const confirm = screen.getByRole("menuitem", { name: "Remove tag" });
    const described = (confirm.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toMatch(/Remove #work and the 1 tag under it from 3 memos\? The memos stay\./);
    expect(described).toMatch(/#work\/client/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel" })));
  });
});

describe("generic menu", () => {
  it("labels the panel after an older-style trigger that ignores triggerProps", async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger={() => <button type="button">Actions</button>}>
        {() => (
          <button type="button" role="menuitem">
            One
          </button>
        )}
      </Menu>
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(trigger.id).not.toBe("");
    expect(within(document.body).getByRole("menu", { name: "Actions" })).not.toBeNull();
  });
});

describe("off-screen replay", () => {
  // MemoStage keeps one shared observer for the module's lifetime, so the
  // records outlive a single test.
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];

  function setupMotion() {
    stubMatchMedia(false);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => ({ cancel: vi.fn(), finished: new Promise<Animation>(() => {}) }) as unknown as Animation)
    });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly record: { callback: IntersectionObserverCallback; targets: Element[] };
        constructor(callback: IntersectionObserverCallback) {
          this.record = { callback, targets: [] };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      }
    );
  }

  it("replays a remote edit on a card near the viewport", () => {
    setupMotion();
    const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, content: "first" } });
    rerenderCard({ memo: { ...baseMemo, content: "first\nsecond", seq: 2 } });
    expect(container.querySelector(".stage-overlay")).not.toBeNull();
  });

  it("gives the replay's ghost the live header, pin and ⋯ included, and keeps the live header on top", () => {
    setupMotion();
    const pinnedMemo = { ...baseMemo, content: "first", pinnedAt: "2026-07-16T09:00:00.000Z" };
    const { container, rerenderCard } = renderCard({ memo: pinnedMemo });
    rerenderCard({ memo: { ...pinnedMemo, content: "first\nsecond", seq: 2 } });

    const ghost = container.querySelector(".stage-ghost");
    if (!ghost) throw new Error("No replay ghost");
    const shape = (head: Element) =>
      [...head.querySelectorAll(".memo-head-right > *, .memo-tool-slot > *")].map((node) =>
        (node.getAttribute("class") ?? "").split(" ").filter((name) => name.startsWith("memo-") && name !== "memo-tool-slot")
      );
    const liveHead = container.querySelector(".memo-view-surface .memo-head")!;
    const ghostHead = ghost.querySelector(".memo-head")!;
    expect(ghostHead.querySelector(".memo-pin-mark")).not.toBeNull();
    expect(ghostHead.querySelector(".memo-menu-trigger")).not.toBeNull();
    expect(ghostHead.querySelector(".memo-select-box")).not.toBeNull();
    expect(ghostHead.querySelector("button")).toBeNull();
    expect(ghostHead.textContent).toBe(liveHead.textContent);
    expect(shape(ghostHead).flat()).toEqual(expect.arrayContaining(shape(liveHead).flat()));
    expect(container.querySelector(".card-stage")?.classList.contains("keeps-head")).toBe(true);
  });

  it("lands a remote edit far off-screen with no ghost or overlay", () => {
    setupMotion();
    const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, content: "first" } });
    const stage = container.querySelector(".card-stage");
    const watcher = observers.find((observer) => observer.targets.includes(stage!));
    if (!watcher) throw new Error("The card was not watched");
    act(() => watcher.callback([{ target: stage, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    rerenderCard({ memo: { ...baseMemo, content: "first\nsecond", seq: 2 } });
    expect(container.querySelector(".stage-overlay")).toBeNull();
    expect(container.querySelector(".stage-ghost")).toBeNull();
    expect(container.textContent).toContain("second");
  });
});

describe("stage under reduced motion", () => {
  interface Played {
    el: Element;
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
  }
  let played: Played[];

  function setupReduced() {
    stubMatchMedia(true);
    played = [];
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: vi.fn(function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        played.push({ el: this, keyframes, options });
        return { cancel: vi.fn(), finished: new Promise<Animation>(() => {}) } as unknown as Animation;
      })
    });
  }

  const travels = (keyframes: Keyframe[]) => keyframes.some((frame) => "transform" in frame || "height" in frame || "clipPath" in frame);

  it("dissolves into the editor in place: the outgoing view fades, the editor fades in, nothing travels", () => {
    setupReduced();
    // The editor's toolbar needs the app's tip bubble.
    const props = cardProps();
    const card = (next: Partial<CardProps>) => (
      <Providers>
        <TipProvider>
          <MemoCard {...props} {...next} />
        </TipProvider>
      </Providers>
    );
    const { container, rerender } = render(card({}));
    rerender(card({ editing: true }));
    const stage = container.querySelector<HTMLElement>(".card-stage")!;
    expect(stage.classList.contains("is-morphing")).toBe(true);
    // No height tween: the stage stands at the editor's height at once.
    expect(stage.style.height).toBe("");
    expect(played).toHaveLength(2);
    const [out, enter] = played;
    expect((out.el as HTMLElement).classList.contains("is-view")).toBe(true);
    expect(out.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(out.options).toMatchObject({ duration: T_FAST });
    expect((enter.el as HTMLElement).classList.contains("is-edit")).toBe(true);
    expect(enter.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(enter.options).toMatchObject({ duration: T_BASE });
    expect(played.some((track) => travels(track.keyframes))).toBe(false);
  });

  it("cross-fades a changed memo instead of replaying its lines", () => {
    setupReduced();
    const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, content: "first" } });
    rerenderCard({ memo: { ...baseMemo, content: "first\nsecond", seq: 2 } });
    // No line clones: the old body (the ghost) fades over the new one.
    expect(container.querySelector(".stage-overlay")).toBeNull();
    expect(container.querySelector(".stage-ghost.is-out")).not.toBeNull();
    expect(container.querySelector(".stage-hold")).toBeNull();
    expect(played.map((track) => track.keyframes)).toEqual([
      [{ opacity: 1 }, { opacity: 0 }],
      [{ opacity: 0 }, { opacity: 1 }]
    ]);
  });
});

describe("select ring stagger", () => {
  it("counts the ripple among the cards on screen, from the top of the view", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const feed = document.createElement("section");
    const tops = [-900, -300, 40, 240, 440, 640, 840];
    const slots = tops.map((top) => {
      const slot = document.createElement("div");
      slot.className = "memo-slot";
      slot.getBoundingClientRect = () => new DOMRect(0, top, 300, 180);
      feed.appendChild(slot);
      return slot;
    });
    // A masthead above the list is not a card.
    const banner = document.createElement("div");
    banner.className = "review-banner";
    feed.prepend(banner);
    document.body.appendChild(feed);
    const feedRef = createRef<HTMLElement>() as { current: HTMLElement | null };
    feedRef.current = feed;

    const { rerender } = render(<SelectRingStagger active feedRef={feedRef as React.RefObject<HTMLElement>} />);
    expect(slots.map((slot) => slot.style.getPropertyValue("--sbd"))).toEqual(["", "", "0ms", "15ms", "30ms", "", ""]);

    rerender(<SelectRingStagger active={false} feedRef={feedRef as React.RefObject<HTMLElement>} />);
    expect(slots.every((slot) => slot.style.getPropertyValue("--sbd") === "")).toBe(true);
    feed.remove();
  });

  it("stops the ripple at 90ms", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 2000 });
    const feed = document.createElement("section");
    const slots = Array.from({ length: 9 }, (_, index) => {
      const slot = document.createElement("div");
      slot.className = "memo-slot";
      slot.getBoundingClientRect = () => new DOMRect(0, index * 200, 300, 180);
      feed.appendChild(slot);
      return slot;
    });
    document.body.appendChild(feed);
    const feedRef = { current: feed };
    render(<SelectRingStagger active feedRef={feedRef} />);
    expect(slots.map((slot) => slot.style.getPropertyValue("--sbd"))).toEqual(["0ms", "15ms", "30ms", "45ms", "60ms", "75ms", "90ms", "90ms", "90ms"]);
    feed.remove();
  });
});
