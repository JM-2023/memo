// @vitest-environment jsdom

// Feed task checkboxes: the rendered [ ]/[x] marks are real controls in the
// live feed (role=checkbox, keyed by source line), inert same-geometry spans
// in trash cards and select mode, and the optimistic pending layer overrides
// what the box shows while a toggle is in flight.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoCard } from "../src/components/MemoCard";
import { LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const memo: Memo = {
  id: "memo-task",
  content: "plan\n- [ ] alpha\n- [x] beta\n- [ ]",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
  pinnedAt: null,
  deletedAt: null,
  seq: 1,
  images: []
};

function renderCard(overrides: Partial<Parameters<typeof MemoCard>[0]> = {}) {
  const onToggleTask = vi.fn();
  render(
    <LanguageProvider>
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
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        onPurge={vi.fn()}
        onPickTag={vi.fn()}
        onOpenImage={vi.fn()}
        onToggleTask={onToggleTask}
        {...overrides}
      />
    </LanguageProvider>
  );
  return { onToggleTask };
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

describe("feed task checkboxes", () => {
  it("renders one live checkbox per task line, named by the task text", () => {
    renderCard();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: "alpha" })).toHaveProperty("ariaChecked", "false");
    expect(screen.getByRole("checkbox", { name: "beta" })).toHaveProperty("ariaChecked", "true");
    // An empty task still gets an accessible name.
    expect(screen.getByRole("checkbox", { name: "Task" })).toBeTruthy();
  });

  it("reports the source line index and the desired state on click", async () => {
    const user = userEvent.setup();
    const { onToggleTask } = renderCard();
    await user.click(screen.getByRole("checkbox", { name: "alpha" }));
    expect(onToggleTask).toHaveBeenLastCalledWith(1, true);
    await user.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(onToggleTask).toHaveBeenLastCalledWith(2, false);
  });

  it("lets a pending flip override the rendered state ahead of the round trip", () => {
    renderCard({ pendingTaskFlips: new Map([[1, true]]) });
    const alpha = screen.getByRole("checkbox", { name: "alpha" });
    expect(alpha.getAttribute("aria-checked")).toBe("true");
    expect(alpha.closest(".md-task")?.classList.contains("is-done")).toBe(true);
    // The override targets one line; beta renders its own truth.
    expect(screen.getByRole("checkbox", { name: "beta" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps trash cards and select mode inert (boxes render, controls do not)", () => {
    renderCard({ variant: "trash" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    cleanup();
    renderCard({ selecting: true });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
