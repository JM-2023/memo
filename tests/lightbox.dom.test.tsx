// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "../src/components/Lightbox";
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

  it("closes at once on a downward swipe under reduced motion", () => {
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
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(overlay().classList.contains("is-closing")).toBe(false);
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

  it("leaves mouse drags, second fingers and a zoomed page to the browser", () => {
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
    expect(screen.getByRole("alert").textContent).toBe("Couldn't load this image");
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
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load this image");
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
    expect(screen.getByRole("alert").textContent).toBe("Couldn't load this image");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("alert")).toBeNull();
    const again = screen.getByRole("img", { name: "Image 1 of 3" });
    expect(again).not.toBe(first);
    expect(again.classList.contains("is-pending")).toBe(true);
    expect(document.activeElement).toBe(overlay());
  });
});
