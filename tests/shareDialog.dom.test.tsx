// @vitest-environment jsdom

// Share-as-image dialog: the paper card renders the memo through the shared
// markdown grammar with real-element markers (the export serializes the DOM,
// so nothing may live in pseudo-elements), external images that refuse CORS
// drop from preview and note alike, and the dialog follows the app's modal
// conventions (initial focus on the primary action, Escape closes).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareDialog } from "../src/components/ShareDialog";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const memo: Memo = {
  id: "memo-share",
  content: "# Title\nplain line with #work\n- [x] shipped\n",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
  pinnedAt: null,
  deletedAt: null,
  seq: 1,
  images: []
};

function renderDialog(overrides: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onToast = vi.fn();
  const view = render(
    <LanguageProvider>
      <ShareDialog memo={memo} onToast={onToast} onClose={onClose} {...overrides} />
    </LanguageProvider>
  );
  return { onClose, onToast, view };
}

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
});

/** The shared mock above asks for reduced motion, which is what most of these
    tests want: the settled result, with no beat in between. The few that are
    about the beat itself opt back into real motion. */
function allowMotion() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("share dialog", () => {
  it("renders the memo as a print card with real-element markers", () => {
    const { view } = renderDialog();

    screen.getByRole("dialog", { name: "Share as image" });
    const card = view.container.querySelector(".share-card");
    if (!card) throw new Error("Card was not rendered");

    expect(card.querySelector(".sc-h1")?.textContent).toBe("Title");
    expect(card.querySelector(".sc-tag")?.textContent).toBe("#work");
    const task = card.querySelector(".sc-task");
    expect(task?.className).toContain("is-done");
    // The done mark is a real inline SVG, not a pseudo-element.
    expect(task?.querySelector(".sc-box svg")).not.toBeNull();
    expect(card.querySelector(".sc-date")?.textContent).toContain("·");
    expect(card.querySelector(".sc-brand")?.textContent).toBe("MEMO");
    expect(card.querySelector(".sc-seal")).not.toBeNull();
  });

  it("focuses the primary action and closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    const save = screen.getByRole("button", { name: "Save image" });
    await waitFor(() => expect(document.activeElement).toBe(save));

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("switches to the landscape spread and remembers the pick", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog();

    const group = screen.getByRole("group", { name: "Card layout" });
    const landscape = screen.getByRole("button", { name: "Landscape card" });
    expect(view.container.querySelector(".share-card")?.className).not.toContain("is-landscape");

    await user.click(landscape);

    expect(landscape.getAttribute("aria-pressed")).toBe("true");
    expect(group.getAttribute("data-layout")).toBe("landscape");
    expect(view.container.querySelector(".share-card")?.className).toContain("is-landscape");
    expect(view.container.querySelector(".share-modal")?.className).toContain("is-wide");
    expect(localStorage.getItem("memo:share-layout")).toBe("landscape");
  });

  it("opens with the stored layout", () => {
    localStorage.setItem("memo:share-layout", "landscape");
    const { view } = renderDialog();

    expect(view.container.querySelector(".share-card")?.className).toContain("is-landscape");
    expect(screen.getByRole("button", { name: "Landscape card" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("prints on the cool gray stock and remembers the pick", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog();

    const group = screen.getByRole("group", { name: "Card background" });
    expect(view.container.querySelector(".share-card")?.className).not.toContain("is-gray");

    await user.click(screen.getByRole("button", { name: "Cool gray" }));

    expect(group.getAttribute("data-tone")).toBe("gray");
    expect(view.container.querySelector(".share-card")?.className).toContain("is-gray");
    expect(localStorage.getItem("memo:share-tone")).toBe("gray");
  });

  it("opens with the stored stock", () => {
    localStorage.setItem("memo:share-tone", "gray");
    const { view } = renderDialog();

    expect(view.container.querySelector(".share-card")?.className).toContain("is-gray");
    expect(screen.getByRole("button", { name: "Cool gray" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lifts the seal off the card and remembers it", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog();

    const seal = screen.getByRole("button", { name: "Seal" });
    expect(seal.getAttribute("aria-pressed")).toBe("true");

    await user.click(seal);

    // Gone from the DOM, not merely hidden: the export serializes the card,
    // so anything still in the tree would land in the PNG.
    expect(view.container.querySelector(".sc-seal")).toBeNull();
    expect(view.container.querySelector(".sc-brand")).not.toBeNull();
    expect(seal.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("memo:share-seal")).toBe("off");

    await user.click(seal);
    expect(view.container.querySelector(".sc-seal")).not.toBeNull();
    expect(localStorage.getItem("memo:share-seal")).toBe("on");
  });

  it("lets a lifted seal animate away before it leaves the tree", async () => {
    // The mark stays mounted for the length of its lift, marked so app.css
    // can run it, then goes.
    allowMotion();
    const user = userEvent.setup();
    const { view } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Seal" }));

    expect(view.container.querySelector(".sc-seal")?.className).toContain("is-lifting");
    await waitFor(() => expect(view.container.querySelector(".sc-seal")).toBeNull());
  });

  it("opens unsealed when that was the last pick", () => {
    localStorage.setItem("memo:share-seal", "off");
    const { view } = renderDialog();

    expect(view.container.querySelector(".sc-seal")).toBeNull();
    expect(screen.getByRole("button", { name: "Seal" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("sets the entry in a hand and remembers the pick", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog();

    const hand = screen.getByRole("button", { name: "Handwriting" });
    expect(view.container.querySelector(".share-card")?.className).not.toContain("is-hand");

    await user.click(hand);

    expect(hand.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector(".share-card")?.className).toContain("is-hand");
    expect(localStorage.getItem("memo:share-hand")).toBe("on");
  });

  it("opens in the hand when that was the last pick", () => {
    localStorage.setItem("memo:share-hand", "on");
    const { view } = renderDialog();

    expect(view.container.querySelector(".share-card")?.className).toContain("is-hand");
    expect(screen.getByRole("button", { name: "Handwriting" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("takes the wordmark and the tags off the sheet, and remembers", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog();

    const privacy = screen.getByRole("button", { name: "Privacy" });
    expect(view.container.querySelector(".sc-tag")).not.toBeNull();

    await user.click(privacy);

    expect(privacy.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector(".sc-brand")).toBeNull();
    expect(view.container.querySelector(".sc-tag")).toBeNull();
    // Only the marks: the line that carried the tag keeps everything else,
    // and the seal is nobody's name, so it stays.
    expect(view.container.querySelector(".sc-body")?.textContent).toContain("plain line with");
    expect(view.container.querySelector(".sc-seal")).not.toBeNull();
    expect(localStorage.getItem("memo:share-privacy")).toBe("on");
  });

  it("opens with the marks already off when that was the last pick", () => {
    localStorage.setItem("memo:share-privacy", "on");
    const { view } = renderDialog();

    expect(view.container.querySelector(".sc-brand")).toBeNull();
    expect(view.container.querySelector(".sc-tag")).toBeNull();
    expect(screen.getByRole("button", { name: "Privacy" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("drops a line that was nothing but tags, and the blank edge it leaves", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog({ memo: { ...memo, content: "kept\n\n#work #inbox\n" } });
    expect(view.container.querySelectorAll(".sc-body > *")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Privacy" }));

    const body = view.container.querySelector(".sc-body");
    expect(body?.textContent).toBe("kept");
    expect(body?.querySelector(".sc-blank")).toBeNull();
  });

  it("closes the page with no band at all once nothing is left to rule off", async () => {
    const user = userEvent.setup();
    const { view } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Privacy" }));
    // The seal alone still earns the rule…
    expect(view.container.querySelector(".sc-foot")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Seal" }));
    expect(view.container.querySelector(".sc-foot")).toBeNull();
  });

  it("lets the paper drink the marks before they leave the tree", async () => {
    allowMotion();
    const user = userEvent.setup();
    const { view } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Privacy" }));

    const brand = view.container.querySelector(".sc-brand");
    expect(brand?.className).toContain("is-drinking");
    // One node per glyph, each dealt its own beat, so the absorption is
    // granular rather than a wipe.
    expect(brand?.querySelectorAll(".sc-glyph")).toHaveLength(4);
    expect(view.container.querySelector(".sc-tag")?.className).toContain("is-drinking");

    await waitFor(() => expect(view.container.querySelector(".sc-brand")).toBeNull());
    // Settled: nothing per-character is left for the export to serialize.
    expect(view.container.querySelector(".sc-glyph")).toBeNull();
  });

  it("writes the marks back on rather than blinking them in", async () => {
    allowMotion();
    const user = userEvent.setup();
    const { view } = renderDialog();

    const privacy = screen.getByRole("button", { name: "Privacy" });
    await user.click(privacy);
    await waitFor(() => expect(view.container.querySelector(".sc-brand")).toBeNull());

    await user.click(privacy);
    expect(view.container.querySelector(".sc-brand")?.className).toContain("is-writing");

    await waitFor(() => expect(view.container.querySelector(".sc-glyph")).toBeNull());
    expect(view.container.querySelector(".sc-brand")?.textContent).toBe("MEMO");
    expect(view.container.querySelector(".sc-tag")?.textContent).toBe("#work");
  });

  it("drops external images that fail to load and says so", async () => {
    const { view } = renderDialog({
      memo: { ...memo, content: "look\nhttps://example.com/pic.png" }
    });

    const external = view.container.querySelector<HTMLImageElement>(".sc-img img");
    if (!external) throw new Error("External image was not rendered");
    fireEvent.error(external);

    await waitFor(() => expect(screen.getByText("1 linked image can’t be included")).toBeTruthy());
    expect(view.container.querySelector(".sc-img")).toBeNull();
  });
});
