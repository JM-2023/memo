// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapText } from "../src/components/SwapText";

function rect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height: 20,
    top: 0,
    right: width,
    bottom: 20,
    left: 0,
    toJSON: () => ({})
  } as DOMRect;
}

describe("SwapText width motion", () => {
  let visualWidth: number;
  let heightOf: (content: string | undefined) => number;
  let reduceMotion: boolean;
  let animateMock: ReturnType<typeof vi.fn>;
  let animations: { cancel: ReturnType<typeof vi.fn> }[];
  let originalAnimate: PropertyDescriptor | undefined;

  beforeEach(() => {
    visualWidth = 200;
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

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(visualWidth));
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function () {
      const current = this.querySelector<HTMLElement>(".swap-cur")?.textContent;
      return current === "Language" ? 200 : 80;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      return heightOf(this.querySelector<HTMLElement>(".swap-cur")?.textContent ?? undefined);
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

    visualWidth = 126.5;
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
    // the outgoing at the width it left with (its own fractional rect).
    visualWidth = 167.36;
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
    expect(cur?.style.width).toBe("168px");

    finish({} as Animation);
    await Promise.resolve();
    expect(cur?.style.width).toBe("");
  });

  it("skips width motion when reduced motion is requested", () => {
    reduceMotion = true;
    const { rerender } = render(<SwapText id="en">Language</SwapText>);

    rerender(<SwapText id="zh">语言</SwapText>);

    expect(animateMock).not.toHaveBeenCalled();
  });
});
