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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
