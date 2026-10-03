// @vitest-environment jsdom

// Daily review settings, tag picker: a pick covers its whole subtree, so the
// parents of every tag in use are choices even when no memo spells them out;
// subtags follow their parent as /paths; the saved picks lead the list; and a
// picked parent shows its subtags as already included.

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSettingsModal } from "../src/components/ReviewSettingsModal";
import { LanguageProvider } from "../src/lib/i18n";
import type { ReviewSettings } from "../src/lib/review";
import type { Memo } from "../src/lib/types";

function memo(id: string, content: string): Memo {
  const at = "2026-07-16T08:00:00.000Z";
  return { id, content, createdAt: at, updatedAt: at, pinnedAt: null, deletedAt: null, seq: 1, images: [] };
}

const memos = [memo("a", "soup #life/cooking"), memo("b", "beans #life/garden"), memo("c", "notes #learning/reading")];
const knownTags = ["learning/reading", "life/cooking", "life/garden"];

function renderModal(settings: Partial<ReviewSettings> = {}) {
  const onSave = vi.fn();
  const view = render(
    <LanguageProvider>
      <ReviewSettingsModal
        settings={{ scope: "include", tags: [], range: "all", count: 10, ...settings }}
        memos={memos}
        knownTags={knownTags}
        onSave={onSave}
        onClose={vi.fn()}
      />
    </LanguageProvider>
  );
  return { onSave, view };
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
  localStorage.clear();
});

describe("review settings tag picker", () => {
  it("offers parent tags, with subtags following them as paths", () => {
    renderModal();
    const picker = screen.getByRole("group", { name: "Choose tags" });
    const chips = within(picker).getAllByRole("button");
    expect(chips.map((chip) => chip.getAttribute("aria-label") ?? chip.textContent)).toEqual([
      "#learning",
      "#learning/reading",
      "#life",
      "#life/cooking",
      "#life/garden"
    ]);
    // Subtags read as the path below their parent; the name is the full tag.
    expect(screen.getByRole("button", { name: "#life/cooking" }).textContent).toBe("/cooking");
  });

  it("saves a parent pick, and shows its subtags as included", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();
    await user.click(screen.getByRole("button", { name: "#life" }));

    expect(screen.getByRole("button", { name: "#life" }).getAttribute("aria-pressed")).toBe("true");
    const cooking = screen.getByRole("button", { name: "#life/cooking" });
    expect(cooking.getAttribute("aria-pressed")).toBe("false");
    expect(cooking.className).toContain("is-covered");
    expect(screen.getByRole("button", { name: "#learning/reading" }).className).not.toContain("is-covered");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tags: ["life"] }));
  });

  it("lists the saved picks first, and keeps them there while the draft changes", async () => {
    const user = userEvent.setup();
    renderModal({ tags: ["life/garden"] });
    const picker = screen.getByRole("group", { name: "Choose tags" });
    const first = () => within(picker).getAllByRole("button")[0];
    expect(first().textContent).toBe("#life/garden");
    expect(first().getAttribute("aria-pressed")).toBe("true");

    await user.click(first());
    expect(first().textContent).toBe("#life/garden");
    expect(first().getAttribute("aria-pressed")).toBe("false");
  });
});
