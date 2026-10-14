// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapText } from "../src/components/SwapText";

function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({})
  } as DOMRect;
}

describe("SwapText width motion", () => {
  // The box's laid-out width, keyed by the content it is showing; a box
  // caught mid-tween reports the animated width instead.
  let widthOf: (content: string | undefined) => number;
  let inFlight: { content: string; width: number } | null;
  let heightOf: (content: string | undefined) => number;
  let reduceMotion: boolean;
  let animateMock: ReturnType<typeof vi.fn>;
  let animations: { cancel: ReturnType<typeof vi.fn> }[];
  let originalAnimate: PropertyDescriptor | undefined;

  beforeEach(() => {
    widthOf = (content) => (content === "Language" ? 200 : 80);
    inFlight = null;
    heightOf = () => 20;
    reduceMotion = false;
    animations = [];
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion") && reduceMotion,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });

    const realComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (!(el instanceof HTMLElement) || !el.classList.contains("swap")) return realComputedStyle(el, pseudo);
      const content = el.querySelector<HTMLElement>(".swap-cur")?.textContent ?? undefined;
      const width = inFlight && inFlight.content === content ? inFlight.width : widthOf(content);
      return { width: `${width}px`, height: `${heightOf(content)}px` } as CSSStyleDeclaration;
    });

    animateMock = vi.fn(() => {
      const animation = { cancel: vi.fn() };
      animations.push(animation);
      return {
        cancel: animation.cancel,
        finished: new Promise<Animation>(() => undefined)
      } as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: animateMock
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });

  it("takes over a rapid second swap from the current visual width", () => {
    const { rerender } = render(<SwapText id="en">Language</SwapText>);

    rerender(<SwapText id="zh">语言</SwapText>);
    expect(animateMock).toHaveBeenNthCalledWith(
      1,
      [{ width: "200px" }, { width: "80px" }],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );

    inFlight = { content: "语言", width: 126.5 };
    rerender(<SwapText id="en">Language</SwapText>);

    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animateMock).toHaveBeenNthCalledWith(
      2,
      [{ width: "126.5px" }, { width: "200px" }],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
  });

  it("tweens height along with width when the incoming content takes another line", () => {
    // The heatmap title folds its count under the date range once the sidebar
    // runs out of room; the block must glide taller, not jump a line.
    widthOf = (content) => (content?.includes("12 memos") ? 80 : 200);
    heightOf = (content) => (content?.includes("12 memos") ? 37 : 20);
    const { rerender } = render(
      <SwapText id="w0">
        Aug 31 – Sep 6<span>2 memos</span>
      </SwapText>
    );

    rerender(
      <SwapText id="w1">
        Sep 7 – Sep 13<span>12 memos</span>
      </SwapText>
    );

    expect(animateMock).toHaveBeenCalledOnce();
    expect(animateMock).toHaveBeenCalledWith(
      [
        { width: "200px", height: "20px" },
        { width: "80px", height: "37px" }
      ],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
  });

  it("pins both layers to their own widths for the length of the tween", async () => {
    // Content that wraps would otherwise re-wrap at every intermediate width
    // of the box: the incoming layer is laid out at the width it ends with,
    // the outgoing at the width it left with (its own fractional width).
    widthOf = (content) => (content === "Language" ? 167.36 : 80);
    let finish: (value: Animation) => void = () => undefined;
    animateMock.mockImplementationOnce(() => {
      const animation = { cancel: vi.fn() };
      animations.push(animation);
      return {
        cancel: animation.cancel,
        finished: new Promise<Animation>((resolve) => {
          finish = resolve;
        })
      } as unknown as Animation;
    });
    const { container, rerender } = render(<SwapText id="en">Language</SwapText>);

    rerender(<SwapText id="zh">语言</SwapText>);

    const cur = container.querySelector<HTMLElement>(".swap-cur");
    const old = container.querySelector<HTMLElement>(".swap-old");
    expect(old?.style.width).toBe("167.36px");
    expect(cur?.style.width).toBe("80.01px");

    finish({} as Animation);
    await Promise.resolve();
    expect(cur?.style.width).toBe("");
  });

  it("measures the layout, not a rect scaled by the button pressed around it", () => {
    // Show more → Show less fires while the toggle is still pressed to 0.96.
    // Sized from that rect, the incoming label was pinned 4% narrower than
    // its own text, sat off-centre with its last letter clipped, and jumped
    // back when the pin came off. offsetWidth rounds, so it is no use either.
    widthOf = (content) => (content === "Show less" ? 73.75 : 66.125);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      return rect(widthOf(this.querySelector<HTMLElement>(".swap-cur")?.textContent ?? undefined) * 0.96, 19.2);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function () {
      return Math.round(widthOf(this.querySelector<HTMLElement>(".swap-cur")?.textContent ?? undefined));
    });
    const { container, rerender } = render(<SwapText id="more">Show more</SwapText>);

    rerender(<SwapText id="less">Show less</SwapText>);

    expect(animateMock).toHaveBeenCalledWith(
      [{ width: "66.125px" }, { width: "73.75px" }],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
    expect(container.querySelector<HTMLElement>(".swap-old")?.style.width).toBe("66.125px");
    expect(container.querySelector<HTMLElement>(".swap-cur")?.style.width).toBe("73.76px");
  });

  it("leaves the width alone when told to, tweening only the height", () => {
    // The heatmap title sits centred between fixed arrows: a width tween
    // there moves nothing, and forces the box through widths its content
    // doesn't fit — the count on the right was clipped until it arrived.
    heightOf = (content) => (content?.includes("12 memos") ? 37 : 20);
    const { container, rerender } = render(
      <SwapText id="w0" tweenWidth={false}>
        Aug 31 – Sep 6<span>2 memos</span>
      </SwapText>
    );

    rerender(
      <SwapText id="w1" tweenWidth={false}>
        Sep 7 – Sep 13<span>12 memos</span>
      </SwapText>
    );

    expect(animateMock).toHaveBeenCalledOnce();
    expect(animateMock).toHaveBeenCalledWith([{ height: "20px" }, { height: "37px" }], { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    expect(container.querySelector<HTMLElement>(".swap-cur")?.style.width).toBe("");
  });

  it("skips width motion when reduced motion is requested", () => {
    reduceMotion = true;
    const { rerender } = render(<SwapText id="en">Language</SwapText>);

    rerender(<SwapText id="zh">语言</SwapText>);

    expect(animateMock).not.toHaveBeenCalled();
  });
});
