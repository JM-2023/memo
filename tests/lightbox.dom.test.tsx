// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lightbox, openLightboxFrom } from "../src/components/Lightbox";
import { LanguageProvider } from "../src/lib/i18n";
import { clearImageCache, peekImage, primeImage } from "../src/lib/imageCache";

const ITEMS = [{ src: "/one.png" }, { src: "/two.png" }, { src: "/three.png" }];

function renderLocalized(node: ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

function overlay() {
  return screen.getByRole("dialog", { name: "View image" });
}

/** One finger from (x0, y0) to (x1, y1), in a couple of moves. */
function swipe(target: Element, from: [number, number], to: [number, number], pointerType = "touch") {
  const base = { pointerId: 7, pointerType, isPrimary: true };
  fireEvent.pointerDown(target, { ...base, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(target, { ...base, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  fireEvent.pointerMove(target, { ...base, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(target, { ...base, clientX: to[0], clientY: to[1] });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("Lightbox gestures", () => {
  it("pages forward on a left swipe and wraps backward on a right swipe", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);

    swipe(screen.getByRole("img"), [600, 400], [200, 410]);
    expect(screen.getByRole("img", { name: "Image 2 of 3" }).classList.contains("dir-fwd")).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("2 / 3");

    swipe(screen.getByRole("img"), [200, 400], [700, 390]);
    swipe(screen.getByRole("img"), [200, 400], [700, 390]);
    expect(screen.getByRole("img", { name: "Image 3 of 3" }).classList.contains("dir-back")).toBe(true);
  });

  it("settles back on a short drag and does not treat its tail as a backdrop tap", () => {
    const onClose = vi.fn();
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={onClose} />);

    swipe(overlay(), [500, 400], [480, 402]);
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();
    expect(overlay().style.getPropertyValue("--lb-dx")).toBe("0px");
    expect(overlay().classList.contains("is-dragging")).toBe(false);

    fireEvent.click(overlay());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still answers a deliberate tap on a control right after a swipe", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={onClose} />);

    swipe(screen.getByRole("img"), [600, 400], [200, 410]);
    expect(screen.getByRole("img", { name: "Image 2 of 3" })).not.toBeNull();

    // A new touch lands on the close button inside the swipe's click guard.
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close, { pointerId: 9, pointerType: "touch", isPrimary: true, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(close, { pointerId: 9, pointerType: "touch", isPrimary: true, clientX: 20, clientY: 20 });
    fireEvent.click(close);
    vi.advanceTimersByTime(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fades out where it stands on a downward swipe under reduced motion", () => {
    vi.useFakeTimers();
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia;
    try {
      const onClose = vi.fn();
      renderLocalized(<Lightbox items={ITEMS} index={1} onClose={onClose} />);
      swipe(screen.getByRole("img"), [400, 300], [410, 600]);
      // The stylesheet's dissolve (no zoom, no flight home), then the unmount.
      expect(overlay().classList.contains("is-closing")).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("follows the visual viewport in and out of pinch zoom", () => {
    const listeners = new Set<() => void>();
    const viewport = {
      scale: 1,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    expect(overlay().classList.contains("is-zoomed")).toBe(false);

    viewport.scale = 2.5;
    act(() => listeners.forEach((listener) => listener()));
    expect(overlay().classList.contains("is-zoomed")).toBe(true);
    swipe(screen.getByRole("img"), [600, 400], [100, 400]);
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();

    viewport.scale = 1;
    act(() => listeners.forEach((listener) => listener()));
    expect(overlay().classList.contains("is-zoomed")).toBe(false);
    swipe(screen.getByRole("img"), [600, 400], [100, 400]);
    expect(screen.getByRole("img", { name: "Image 2 of 3" })).not.toBeNull();
  });

  it("dismisses on a downward swipe", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderLocalized(<Lightbox items={ITEMS} index={1} onClose={onClose} />);

    swipe(screen.getByRole("img"), [400, 300], [410, 600]);
    expect(overlay().classList.contains("is-closing")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves mouse drags at fit and a zoomed page to the browser, and drops a swipe for a second finger", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);

    swipe(screen.getByRole("img"), [600, 400], [100, 400], "mouse");
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();

    // A pinch: the second finger lands mid-drag and the drag is dropped.
    const finger = { pointerId: 7, pointerType: "touch", isPrimary: true };
    fireEvent.pointerDown(overlay(), { ...finger, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(overlay(), { ...finger, clientX: 560, clientY: 400 });
    fireEvent.pointerDown(overlay(), { pointerId: 8, pointerType: "touch", isPrimary: false, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(overlay(), { ...finger, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(overlay(), { ...finger, clientX: 100, clientY: 400 });
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();
    expect(overlay().style.getPropertyValue("--lb-dx")).toBe("0px");
    cleanup();

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { scale: 2, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    });
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    expect(overlay().classList.contains("is-zoomed")).toBe(true);
    swipe(screen.getByRole("img"), [600, 400], [100, 400]);
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();
  });
});

describe("Lightbox zoom", () => {
  const zoomOf = (image: HTMLElement) => image.style.getPropertyValue("--lb-zs");

  /** A mouse double-click, with the presses that come before it. */
  function doubleClick(target: HTMLElement, x = 300, y = 200) {
    for (let press = 0; press < 2; press += 1) {
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: x, clientY: y };
      fireEvent.pointerDown(target, base);
      fireEvent.pointerUp(target, base);
    }
    fireEvent.doubleClick(target, { clientX: x, clientY: y });
  }

  it("toggles fit ↔ 2.5× on a double-click, and stands the swipes down while magnified", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    // Nothing to zoom before it can be seen.
    doubleClick(first);
    expect(zoomOf(first)).toBe("");
    fireEvent.load(first);

    doubleClick(first);
    expect(zoomOf(first)).toBe("2.5");
    expect(overlay().classList.contains("is-magnified")).toBe(true);
    // A drag pans now: no page change, no dismiss.
    swipe(first, [600, 400], [100, 410]);
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).toBe(first);
    swipe(first, [400, 300], [410, 700]);
    expect(overlay().classList.contains("is-closing")).toBe(false);

    doubleClick(first);
    expect(zoomOf(first)).toBe("1");
    expect(overlay().classList.contains("is-magnified")).toBe(false);
  });

  it("toggles on a finger's double-tap of the picture", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);
    const tap = () => {
      const finger = { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: 300, clientY: 200 };
      fireEvent.pointerDown(first, finger);
      fireEvent.pointerUp(first, finger);
    };
    tap();
    expect(zoomOf(first)).toBe("");
    tap();
    expect(zoomOf(first)).toBe("2.5");
  });

  it("zooms by key: + steps up, − steps down, 0 fits; Ctrl/⌘ with them stays the browser's", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);
    fireEvent.keyDown(window, { key: "+", shiftKey: true });
    expect(zoomOf(first)).toBe("1.5");
    fireEvent.keyDown(window, { key: "=" });
    expect(zoomOf(first)).toBe("2.25");
    fireEvent.keyDown(window, { key: "-" });
    expect(zoomOf(first)).toBe("1.5");
    fireEvent.keyDown(window, { key: "0" });
    expect(zoomOf(first)).toBe("1");
    const event = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(zoomOf(first)).toBe("1");
  });

  it("zooms about the pointer on Ctrl/⌘ + wheel — a trackpad pinch — between 1× and 4×", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);
    const wheel = (deltaY: number, ctrlKey = true) => {
      const event = new WheelEvent("wheel", { deltaY, ctrlKey, clientX: 300, clientY: 200, bubbles: true, cancelable: true });
      act(() => {
        overlay().dispatchEvent(event);
      });
      return event;
    };
    // A plain scroll at fit is not the viewer's.
    expect(wheel(-100, false).defaultPrevented).toBe(false);
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(Number(zoomOf(first))).toBeCloseTo(Math.SQRT2);
    for (let step = 0; step < 10; step += 1) wheel(-100);
    expect(zoomOf(first)).toBe("4");
    for (let step = 0; step < 10; step += 1) wheel(100);
    expect(zoomOf(first)).toBe("1");
  });

  it("pinches with two fingers, up to 4×, and the finger left down is no tap", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={onClose} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);
    const a = { pointerId: 1, pointerType: "touch", isPrimary: true, clientY: 300 };
    const b = { pointerId: 2, pointerType: "touch", isPrimary: false, clientY: 300 };
    fireEvent.pointerDown(overlay(), { ...a, clientX: 300 });
    fireEvent.pointerDown(overlay(), { ...b, clientX: 400 });
    fireEvent.pointerMove(overlay(), { ...b, clientX: 500 });
    expect(zoomOf(first)).toBe("2");
    fireEvent.pointerMove(overlay(), { ...b, clientX: 1500 });
    expect(zoomOf(first)).toBe("4");
    fireEvent.pointerUp(overlay(), { ...b, clientX: 1500 });
    fireEvent.pointerUp(overlay(), { ...a, clientX: 300 });
    fireEvent.click(overlay());
    vi.advanceTimersByTime(200);
    expect(onClose).not.toHaveBeenCalled();
    expect(overlay().classList.contains("is-magnified")).toBe(true);
    // Still one page: a pinch never pages.
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).toBe(first);
  });

  it("starts the next page at fit, and lets a magnified page leave as it was framed", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(first.classList.contains("is-leaving")).toBe(true);
    expect(zoomOf(first)).toBe("1.5");
    expect(overlay().classList.contains("is-magnified")).toBe(false);
    expect(zoomOf(screen.getByRole("img", { name: "Image 2 of 3" }))).toBe("");
  });
});

describe("Lightbox neighbours", () => {
  it("draws the neighbour beside a sideways drag, and a committed swipe keeps that very picture", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);
    const finger = { pointerId: 7, pointerType: "touch", isPrimary: true, clientY: 402 };
    fireEvent.pointerDown(first, { ...finger, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(first, { ...finger, clientX: 450 });
    const next = document.querySelector<HTMLImageElement>(".lightbox-image.is-peek.peek-next");
    expect(next?.getAttribute("src")).toBe("/two.png");
    expect(next?.getAttribute("aria-hidden")).toBe("true");
    // Back the other way: the previous one (wrapping round) waits on the left.
    fireEvent.pointerMove(first, { ...finger, clientX: 700 });
    expect(document.querySelector(".lightbox-image.peek-prev")?.getAttribute("src")).toBe("/three.png");
    expect(document.querySelector(".lightbox-image.peek-next")).toBeNull();

    fireEvent.pointerMove(first, { ...finger, clientX: 200 });
    const peeked = document.querySelector<HTMLImageElement>(".lightbox-image.peek-next")!;
    fireEvent.load(peeked);
    fireEvent.pointerUp(first, { ...finger, clientX: 200 });
    // It slides on from where the finger let go, as the first slides off.
    const second = screen.getByRole("img", { name: "Image 2 of 3" });
    expect(second).toBe(peeked);
    expect(second.classList.contains("is-carried")).toBe(true);
    expect(second.classList.contains("is-pending")).toBe(false);
    expect(second.style.getPropertyValue("--lb-enter-dx")).toBe("-400px");
    expect(first.classList.contains("is-carried")).toBe(true);
    expect(first.classList.contains("out-fwd")).toBe(true);
    expect(document.querySelector(".lightbox-image.is-peek")).toBeNull();
  });

  it("lets a short drag's neighbour ride the spring back, then go", () => {
    vi.useFakeTimers();
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    swipe(overlay(), [500, 400], [480, 402]);
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();
    expect(document.querySelector(".lightbox-image.is-peek")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".lightbox-image.is-peek")).toBeNull();
  });

  it("shows no neighbour for a lone picture", () => {
    renderLocalized(<Lightbox items={[{ src: "/only.png" }]} index={0} onClose={vi.fn()} />);
    const finger = { pointerId: 7, pointerType: "touch", isPrimary: true, clientY: 400 };
    fireEvent.pointerDown(overlay(), { ...finger, clientX: 600 });
    fireEvent.pointerMove(overlay(), { ...finger, clientX: 400 });
    expect(document.querySelector(".lightbox-image.is-peek")).toBeNull();
  });
});

describe("Lightbox loading", () => {
  it("holds a spinner until the image arrives and says when it fails", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    expect(first.classList.contains("is-pending")).toBe(true);
    expect(document.querySelector(".lightbox-status.is-loading")).not.toBeNull();

    fireEvent.load(first);
    expect(first.classList.contains("is-pending")).toBe(false);
    expect(document.querySelector(".lightbox-status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    const second = screen.getByRole("img", { name: "Image 2 of 3" });
    expect(second.classList.contains("is-pending")).toBe(true);
    fireEvent.error(second);
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t load image");
    expect(document.querySelector(".lightbox-status.is-loading")).toBeNull();
  });

  it("never preloads raw URLs behind the cache's back (stored neighbours go through it, below)", () => {
    const ImageSpy = vi.fn();
    vi.stubGlobal("Image", ImageSpy);
    try {
      renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Next image" }));
      expect(ImageSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("styles its controls on their own, outside the shared icon-button rules", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    for (const name of ["Close", "Previous image", "Next image"]) {
      expect(screen.getByRole("button", { name }).classList.contains("icon-button")).toBe(false);
    }
  });
});

describe("Lightbox over the image cache", () => {
  const STORED = [
    { src: "/api/images/a", imageId: "a" },
    { src: "/api/images/b", imageId: "b" },
    { src: "/api/images/c", imageId: "c" }
  ];
  let fetchMock: ReturnType<typeof vi.fn>;
  let finish: Map<string, (response: Response) => void>;

  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:test/${Math.random()}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    finish = new Map();
    fetchMock = vi.fn((url: string) => new Promise<Response>((resolve) => finish.set(url, resolve)));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    clearImageCache();
    vi.unstubAllGlobals();
  });

  const webp = () => new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/webp" } });

  it("paints the feed's cached preview at once, without a spinner, and swaps in the original", async () => {
    primeImage("a", "thumb", new Blob([new Uint8Array([1])], { type: "image/webp" }));
    const preview = peekImage("a", "thumb");
    renderLocalized(<Lightbox items={STORED} index={0} onClose={vi.fn()} />);
    const picture = screen.getByRole("img", { name: "Image 1 of 3" });
    expect(picture.getAttribute("src")).toBe(preview);
    expect(document.querySelector(".lightbox-status.is-loading")).toBeNull();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/images/a"]);
    fireEvent.load(picture);
    expect(picture.classList.contains("is-pending")).toBe(false);

    await act(async () => finish.get("/api/images/a")!(webp()));
    await waitFor(() => expect(picture.getAttribute("src")).toBe(peekImage("a", "full")));
    // The same element, never hidden again while the original replaces the preview.
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).toBe(picture);
    expect(picture.classList.contains("is-pending")).toBe(false);
  });

  it("holds the spinner only when nothing is cached", async () => {
    renderLocalized(<Lightbox items={STORED} index={1} onClose={vi.fn()} />);
    expect(screen.queryByRole("img", { name: "Image 2 of 3" })).toBeNull();
    expect(document.querySelector(".lightbox-status.is-loading")).not.toBeNull();
    await act(async () => finish.get("/api/images/b")!(webp()));
    const picture = await screen.findByRole("img", { name: "Image 2 of 3" });
    expect(picture.getAttribute("src")).toBe(peekImage("b", "full"));
  });

  it("fetches the neighbours' originals once the current picture is up", async () => {
    primeImage("b", "full", new Blob([new Uint8Array([1])], { type: "image/webp" }));
    renderLocalized(<Lightbox items={STORED} index={1} onClose={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.load(screen.getByRole("img", { name: "Image 2 of 3" }));
    await waitFor(() => expect(fetchMock.mock.calls.map((call) => call[0]).sort()).toEqual(["/api/images/a", "/api/images/c"]));
  });

  it("says when a stored picture cannot be fetched", async () => {
    renderLocalized(<Lightbox items={STORED} index={0} onClose={vi.fn()} />);
    await act(async () => finish.get("/api/images/a")!(new Response("{}", { status: 503 })));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t load image");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Lightbox paging", () => {
  it("keeps the outgoing picture up until the next can be seen, then lets it leave", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    // The very same element stays, hidden from the accessibility tree, still.
    expect(first.isConnected).toBe(true);
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(first.classList.contains("is-leaving")).toBe(true);
    expect(first.classList.contains("out-fwd")).toBe(false);

    fireEvent.load(screen.getByRole("img", { name: "Image 2 of 3" }));
    expect(first.classList.contains("out-fwd")).toBe(true);
    // jsdom has no AnimationEvent, so React listens for the prefixed name.
    act(() => {
      for (const type of ["animationend", "webkitAnimationEnd"]) first.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(first.isConnected).toBe(false);
  });

  it("lets a swiped-away picture leave from where the finger let go, not from the centre", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.load(first);

    swipe(first, [600, 400], [200, 410]);
    expect(first.classList.contains("is-leaving")).toBe(true);
    expect(first.style.getPropertyValue("--lb-leave-dx")).toBe("-400px");
    // The incoming picture starts from the centre.
    expect(overlay().style.getPropertyValue("--lb-dx")).toBe("0px");
    const second = screen.getByRole("img", { name: "Image 2 of 3" });
    fireEvent.load(second);
    expect(first.classList.contains("out-fwd")).toBe(true);
    expect(first.style.getPropertyValue("--lb-leave-dx")).toBe("-400px");
    // Pinned there with nothing to glide it back while it leaves onward.
    const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const leaving = css.match(/\n\.lightbox-image\.is-leaving\s*\{([^}]*)\}/)?.[1] ?? "";
    // (Plus whatever pan a magnified page had: it leaves as it was framed.)
    expect(leaving).toMatch(/translate:\s*calc\(var\(--lb-leave-dx,\s*0px\)\s*\+\s*var\(--lb-zx,\s*0px\)\)\s+var\(--lb-zy,\s*0px\);/);
    expect(leaving).toMatch(/transition:\s*none;/);

    // A key press has no offset to carry.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(second.classList.contains("is-leaving")).toBe(true);
    expect(second.style.getPropertyValue("--lb-leave-dx")).toBe("");
  });

  it("draws a page seen a moment ago at once instead of fading it in again", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    fireEvent.load(screen.getByRole("img", { name: "Image 1 of 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    const again = screen.getByRole("img", { name: "Image 1 of 3" });
    expect(again.classList.contains("is-pending")).toBe(false);
    expect(again.classList.contains("dir-back")).toBe(true);
  });
});

describe("Lightbox keyboard", () => {
  it("pages with the arrows and jumps with Home/End", () => {
    renderLocalized(<Lightbox items={ITEMS} index={1} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toContain("3 / 3");
    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByRole("img", { name: "Image 1 of 3" }).classList.contains("dir-back")).toBe(true);
    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByRole("img", { name: "Image 3 of 3" }).classList.contains("dir-fwd")).toBe(true);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByRole("status").textContent).toContain("2 / 3");
  });

  it("leaves modified arrows to the browser (Cmd+← and Alt+← are Back)", () => {
    renderLocalized(<Lightbox items={ITEMS} index={1} onClose={vi.fn()} />);
    for (const modifier of ["metaKey", "altKey", "ctrlKey", "shiftKey"]) {
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", [modifier]: true, bubbles: true, cancelable: true });
      act(() => {
        window.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(screen.getByRole("status").textContent).toContain("2 / 3");
  });

  it("does not re-slide a lone image, and stops paging once closing", () => {
    vi.useFakeTimers();
    renderLocalized(<Lightbox items={[{ src: "/only.png" }]} index={0} onClose={vi.fn()} />);
    const only = screen.getByRole("img", { name: "Image 1 of 1" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("img", { name: "Image 1 of 1" })).toBe(only);
    expect(only.className).not.toMatch(/dir-/);
    cleanup();

    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("img", { name: "Image 1 of 3" })).not.toBeNull();
  });

  it("returns focus to the tile of the picture last shown", () => {
    const { container } = render(
      <div className="memo-images">
        {ITEMS.map((item, index) => (
          <button key={item.src} type="button" data-lightbox-index={index}>
            tile {index + 1}
          </button>
        ))}
      </div>
    );
    const tiles = container.querySelectorAll("button");
    tiles[0].focus();
    const viewer = renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    viewer.unmount();
    expect(document.activeElement).toBe(tiles[2]);
  });
});

describe("Lightbox closing and failure", () => {
  it("lets the picture recede on close, but not after a swipe already took it", () => {
    vi.useFakeTimers();
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(overlay().classList.contains("is-closing")).toBe(true);
    expect(overlay().classList.contains("is-flung")).toBe(false);
    cleanup();

    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    swipe(screen.getByRole("img"), [400, 300], [410, 600]);
    expect(overlay().classList.contains("is-flung")).toBe(true);
  });

  it("offers Retry on a failed picture and reloads it", () => {
    renderLocalized(<Lightbox items={ITEMS} index={0} onClose={vi.fn()} />);
    const first = screen.getByRole("img", { name: "Image 1 of 3" });
    fireEvent.error(first);
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t load image");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("alert")).toBeNull();
    const again = screen.getByRole("img", { name: "Image 1 of 3" });
    expect(again).not.toBe(first);
    expect(again.classList.contains("is-pending")).toBe(true);
    expect(document.activeElement).toBe(overlay());
  });
});

describe("Lightbox morph with its feed tile", () => {
  const PHOTO = "lightbox-photo";
  let captures: Array<{ tileNames: string[]; vtLightbox: string | undefined }>;
  let tileRect: Partial<DOMRect>;

  /** A feed grid whose tiles open the viewer, as MemoCard wires them. */
  function Gallery({ onClose = vi.fn() }: { onClose?: () => void }) {
    const [open, setOpen] = useState<number | null>(null);
    return (
      <>
        <div className="memo-images">
          {ITEMS.map((item, index) => (
            <button
              key={item.src}
              type="button"
              data-lightbox-index={index}
              aria-label={`tile ${index + 1}`}
              onClick={(event) => openLightboxFrom(event.currentTarget, () => setOpen(index))}
            >
              <img src={item.src} alt="" />
            </button>
          ))}
        </div>
        {open !== null ? (
          <Lightbox
            items={ITEMS}
            index={open}
            onClose={() => {
              setOpen(null);
              onClose();
            }}
          />
        ) : null}
      </>
    );
  }

  // By selector: the open viewer hides the feed from the accessibility tree.
  function tilePicture(index: number): HTMLImageElement {
    return document.querySelectorAll<HTMLImageElement>(".memo-images img")[index];
  }

  function stubMotion(reduced: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    captures = [];
    tileRect = { top: 120, bottom: 220, left: 40, right: 140, width: 100, height: 100 };
    stubMotion(false);
    // Painted pictures, laid out on screen.
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(800);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => tileRect as DOMRect);
    // A transition that records the old capture's names, then runs the update.
    document.startViewTransition = ((update: () => void) => {
      captures.push({
        tileNames: [0, 1, 2].map((index) => tilePicture(index).style.viewTransitionName),
        vtLightbox: document.documentElement.dataset.vtLightbox
      });
      update();
      const done = Promise.resolve();
      return { ready: done, finished: done, updateCallbackDone: done, skipTransition: vi.fn() };
    }) as unknown as typeof document.startViewTransition;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    Reflect.deleteProperty(window, "matchMedia");
    delete document.documentElement.dataset.vtLightbox;
    vi.restoreAllMocks();
  });

  it("grows the photo out of its tile: the tile holds the shared name for the old capture only", () => {
    renderLocalized(<Gallery />);
    fireEvent.click(screen.getByRole("button", { name: "tile 1" }));

    expect(captures).toHaveLength(1);
    expect(captures[0].tileNames).toEqual([PHOTO, "", ""]);
    // The viewer's picture takes the name over; the tile lets go of it.
    expect(tilePicture(0).style.viewTransitionName).toBe("");
    expect(screen.getByRole("img", { name: "Image 1 of 3" }).classList.contains("is-morphed")).toBe(true);
  });

  it("shrinks back into the tile of the picture shown last, then lets go of the name", async () => {
    const onClose = vi.fn();
    renderLocalized(<Gallery onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "tile 1" }));
    fireEvent.load(screen.getByRole("img", { name: "Image 1 of 3" }));
    fireEvent.keyDown(window, { key: "End" });
    fireEvent.load(screen.getByRole("img", { name: "Image 3 of 3" }));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // The viewer is the old capture; the tile, named in the update, the new one.
    expect(captures).toHaveLength(2);
    expect(captures[1]).toEqual({ tileNames: ["", "", ""], vtLightbox: "close" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tilePicture(2).style.viewTransitionName).toBe(PHOTO);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "tile 3" }));

    await waitFor(() => expect(tilePicture(2).style.viewTransitionName).toBe(""), { timeout: 1500 });
    expect(document.documentElement.dataset.vtLightbox).toBeUndefined();
  });

  it("opens and closes the plain way when the tile is out of sight", () => {
    vi.useFakeTimers();
    // Below the fold: the photo would fly in from nowhere the reader can see.
    tileRect = { top: 2000, bottom: 2100, left: 40, right: 140, width: 100, height: 100 };
    const onClose = vi.fn();
    renderLocalized(<Gallery onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "tile 2" }));
    expect(captures).toHaveLength(0);
    const picture = screen.getByRole("img", { name: "Image 2 of 3" });
    expect(picture.classList.contains("is-morphed")).toBe(false);

    fireEvent.load(picture);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(captures).toHaveLength(0);
    expect(overlay().classList.contains("is-closing")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never morphs under reduced motion", () => {
    vi.useFakeTimers();
    stubMotion(true);
    const onClose = vi.fn();
    renderLocalized(<Gallery onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "tile 1" }));
    const picture = screen.getByRole("img", { name: "Image 1 of 3" });
    expect(picture.classList.contains("is-morphed")).toBe(false);

    fireEvent.load(picture);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(captures).toHaveLength(0);
    expect(overlay().classList.contains("is-closing")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
