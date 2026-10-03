// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "../src/components/Lightbox";
import { LanguageProvider } from "../src/lib/i18n";

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

  it("leaves the neighbours alone: the card already loaded them and /api/images is no-store", () => {
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
