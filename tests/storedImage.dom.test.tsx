// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoCard } from "../src/components/MemoCard";
import { StoredImageFrame } from "../src/components/StoredImage";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { clearImageCache, primeImage } from "../src/lib/imageCache";
import { mediaGridProps, previewCovers, singleImageRatio } from "../src/lib/imageLayout";
import type { Memo, MemoImage } from "../src/lib/types";

function image(id: string, width = 1600, height = 1200): MemoImage {
  return { id, mime: "image/webp", width, height, bytes: 128 };
}

function memoWith(images: MemoImage[]): Memo {
  return {
    id: "memo-images",
    content: "photos",
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images
  };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function renderCard(memo: Memo, onOpenImage = vi.fn()) {
  return render(
    <Providers>
      <MemoCard
        memo={memo}
        variant="normal"
        knownTags={[]}
        editing={false}
        savingEdit={false}
        editConflict={false}
        selecting={false}
        selected={false}
        onToggleSelect={vi.fn()}
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSaveEdit={vi.fn(async () => true)}
        onAcceptEditConflict={vi.fn()}
        onTogglePin={vi.fn()}
        onAddTag={vi.fn()}
        onCopy={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        onPurge={vi.fn()}
        onPickTag={vi.fn()}
        onOpenImage={onOpenImage}
        onToggleTask={vi.fn()}
      />
    </Providers>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:test/${Math.random()}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  clearImageCache();
  vi.unstubAllGlobals();
});

describe("image grid geometry", () => {
  it("uses two columns for two or four images and three otherwise", () => {
    expect(mediaGridProps(2, undefined).className).toBe("memo-images cols-2");
    expect(mediaGridProps(4, undefined).className).toBe("memo-images cols-2");
    expect(mediaGridProps(3, undefined).className).toBe("memo-images cols-3");
    expect(mediaGridProps(9, undefined).className).toBe("memo-images cols-3");
  });

  it("reserves a lone image's own shape within 2:3…16:9", () => {
    expect(singleImageRatio(image("a", 1200, 1600))).toBeCloseTo(0.75);
    expect(singleImageRatio(image("a", 1179, 2556))).toBeCloseTo(2 / 3);
    expect(singleImageRatio(image("a", 4000, 1000))).toBeCloseTo(16 / 9);
    expect(singleImageRatio(image("a", 0, 0))).toBeNull();
    expect(mediaGridProps(1, image("a", 1200, 1600)).style).toEqual({ "--media-ratio": "0.7500" });
  });

  it("asks for the original only when the preview would be upscaled", () => {
    // A 180px grid cell at 2×: the 640×480 preview covers it.
    expect(previewCovers(image("a"), 180, 180, 2)).toBe(true);
    // A phone-wide lone image at 3× needs the original.
    expect(previewCovers(image("a"), 366, 275, 3)).toBe(false);
  });
});

describe("stored image tiles", () => {
  it("loads grid previews, shows a neutral placeholder, then the picture", async () => {
    renderCard(memoWith([image("one"), image("two")]));
    const tiles = screen.getAllByRole("button", { name: /^View image/ });
    expect(tiles[0].className).toContain("is-loading");
    expect(tiles[0].parentElement?.className).toBe("memo-images cols-2");
    await waitFor(() => expect(tiles[0].querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
    expect(tiles[0].className).not.toContain("is-loading");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/images/one?size=thumb", "/api/images/two?size=thumb"]);
  });

  it("draws a cached image on the first render without a request", async () => {
    primeImage("cached", "thumb", new Blob([new Uint8Array([1])], { type: "image/webp" }));
    renderCard(memoWith([image("cached"), image("other")]));
    const [tile] = screen.getAllByRole("button", { name: /^View image/ });
    expect(tile.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
    expect(tile.className).not.toContain("is-loading");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/images/other?size=thumb"]);
  });

  it("turns a failed load into a retry instead of a blank box", async () => {
    const user = userEvent.setup();
    const onOpenImage = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }));
    renderCard(memoWith([image("flaky"), image("fine")]), onOpenImage);

    const failed = await screen.findByRole("button", { name: "Couldn’t load image. Retry" });
    expect(failed.className).toContain("is-failed");
    expect(failed.textContent).toContain("Couldn’t load image");

    await user.click(failed);
    expect(onOpenImage).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^View image/ })).toHaveLength(2));
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/images/flaky?size=thumb")).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: /^View image/ })[0]);
    expect(onOpenImage).toHaveBeenCalledWith([{ src: "/api/images/flaky" }, { src: "/api/images/fine" }], 0);
  });

  describe("a lone image drawn larger than its preview", () => {
    let observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }>;

    beforeEach(() => {
      // A phone-wide tile at 3×: the original is wanted.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 366, height: 275 } as DOMRect);
      vi.stubGlobal("devicePixelRatio", 3);
      observers = [];
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function stubObserver() {
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          disconnect = vi.fn();
          constructor(callback: IntersectionObserverCallback) {
            observers.push({ callback, disconnect: this.disconnect });
          }
          observe() {}
          unobserve() {}
        }
      );
    }

    function intersect() {
      for (const { callback } of observers) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }

    it("paints the preview while the original downloads", async () => {
      let finishOriginal!: (response: Response) => void;
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("?size=thumb")
          ? new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/webp" } })
          : new Promise<Response>((resolve) => (finishOriginal = resolve))
      );
      renderCard(memoWith([image("lone")]));
      const tile = screen.getByRole("button", { name: /^View image/ });
      await waitFor(() => expect(tile.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
      const preview = tile.querySelector("img")!.getAttribute("src");
      expect(tile.className).not.toContain("is-loading");
      await waitFor(() => expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/images/lone?size=thumb", "/api/images/lone"]));

      finishOriginal(new Response(new Uint8Array([2]), { headers: { "Content-Type": "image/webp" } }));
      await waitFor(() => expect(tile.querySelector("img")?.getAttribute("src")).not.toBe(preview));
    });

    it("paints a cached preview at once but waits for the viewport to fetch the original", async () => {
      stubObserver();
      primeImage("offscreen", "thumb", new Blob([new Uint8Array([1])], { type: "image/webp" }));
      renderCard(memoWith([image("offscreen")]));
      const tile = screen.getByRole("button", { name: /^View image/ });
      expect(tile.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      expect(fetchMock).not.toHaveBeenCalled();

      intersect();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][0]).toBe("/api/images/offscreen");
    });
  });

  it("gives the edit morph's ghost tile the same failed look as the live tile", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }));
    renderCard(memoWith([image("broken"), image("broken-too")]));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Couldn’t load image. Retry" })).toHaveLength(2));
    const requests = fetchMock.mock.calls.length;

    const { container } = render(
      <Providers>
        <StoredImageFrame image={image("broken")} sizing="thumb" />
      </Providers>
    );
    const ghost = container.querySelector(".memo-image") as HTMLElement;
    expect(ghost.className).toContain("is-failed");
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.querySelector(".memo-image-failed")?.textContent).toBe("Couldn’t load image");
    // Inert: it mirrors the live tile instead of retrying on its own.
    expect(fetchMock.mock.calls.length).toBe(requests);
  });

  it("reserves a lone image's aspect ratio on the grid", () => {
    renderCard(memoWith([image("portrait", 1200, 1600)]));
    const tile = screen.getByRole("button", { name: /^View image/ });
    const grid = tile.parentElement as HTMLElement;
    expect(grid.className).toBe("memo-images count-1");
    expect(grid.style.getPropertyValue("--media-ratio")).toBe("0.7500");
  });
});
