// @vitest-environment jsdom

// Feed task checkboxes: the rendered [ ]/[x] marks are real controls in the
// live feed (role=checkbox, keyed by source line), inert same-geometry spans
// in trash cards and select mode, and the optimistic pending layer overrides
// what the box shows while a toggle is in flight.

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoCard } from "../src/components/MemoCard";
import { LanguageProvider } from "../src/lib/i18n";
import { EXIT_MS } from "../src/lib/motion";
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
  const baseProps: Parameters<typeof MemoCard>[0] = {
    memo,
    variant: "normal",
    knownTags: [],
    editing: false,
    savingEdit: false,
    editConflict: false,
    selecting: false,
    selected: false,
    onToggleSelect: vi.fn(),
    onStartEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdit: vi.fn(async () => true),
    onAcceptEditConflict: vi.fn(),
    onTogglePin: vi.fn(),
    onAddTag: vi.fn(),
    onCopy: vi.fn(),
    onShare: vi.fn(),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    onPurge: vi.fn(),
    onPickTag: vi.fn(),
    onOpenImage: vi.fn(),
    onToggleTask,
    ...overrides
  };
  const view = render(
    <LanguageProvider>
      <MemoCard {...baseProps} />
    </LanguageProvider>
  );
  return {
    onToggleTask,
    rerender: (next: Partial<Parameters<typeof MemoCard>[0]>) =>
      view.rerender(
        <LanguageProvider>
          <MemoCard {...baseProps} {...next} />
        </LanguageProvider>
      )
  };
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
  vi.useRealTimers();
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

  it("names a box by the task's rendered text, not the Markdown under it", () => {
    renderCard({ memo: { ...memo, content: "- [ ] read **Dune** and [notes](https://a.com/n) #books" } });
    const box = screen.getByRole("checkbox", { name: "read Dune and notes #books" });
    const body = document.getElementById(box.getAttribute("aria-labelledby") ?? "");
    expect(body?.classList.contains("md-body")).toBe(true);
    expect(box.hasAttribute("aria-label")).toBe(false);
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

  it("strikes a done task on an inline run inside its body, so each wrapped line gets its own", () => {
    renderCard();
    const beta = screen.getByRole("checkbox", { name: "beta" });
    const run = beta.parentElement?.querySelector(":scope > .md-body > .md-task-text");
    expect(run?.textContent).toBe("beta");
    expect(run?.closest(".md-task")?.classList.contains("is-done")).toBe(true);
    // The box is still named by the whole body.
    expect(beta.getAttribute("aria-labelledby")).toBe(run?.parentElement?.id);
  });

  it("counts the ticked boxes after the stamp, the flips in flight included", () => {
    renderCard({ pendingTaskFlips: new Map([[1, true]]) });
    const progress = document.querySelector(".memo-view-surface .memo-head .memo-progress");
    expect(progress?.querySelector("[aria-hidden='true']")?.textContent).toBe("2/3");
    expect(progress?.querySelector(".sr-only")?.textContent).toBe("2 of 3 tasks done");
  });

  it("places the completion check after the figure and plays both its entrance and exit", () => {
    vi.useFakeTimers();
    const { rerender } = renderCard({
      pendingTaskFlips: new Map([
        [1, true],
        [3, false]
      ])
    });
    const progress = () => document.querySelector(".memo-view-surface .memo-head .memo-progress")!;
    const figure = () => progress().querySelector(".memo-progress-figure")!;
    expect(figure().querySelector(".memo-progress-check")).toBeNull();

    // Ticking the last box pops the check AFTER "3/3" so the digits never jump.
    rerender({
      pendingTaskFlips: new Map([
        [1, true],
        [3, true]
      ])
    });
    expect(progress().classList.contains("is-complete")).toBe(true);
    const entered = figure().querySelector(".memo-progress-check")!;
    expect(entered.classList.contains("is-new")).toBe(true);
    expect(figure().lastElementChild).toBe(entered);
    expect(figure().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(figure().textContent).toBe("3/3");

    // Unchecking plays the check's exit before removing it.
    rerender({
      pendingTaskFlips: new Map([
        [1, true],
        [3, false]
      ])
    });
    expect(progress().classList.contains("is-complete")).toBe(false);
    const leaving = figure().querySelector(".memo-progress-check");
    expect(leaving?.classList.contains("is-leaving")).toBe(true);
    expect(figure().lastElementChild).toBe(leaving);
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(figure().querySelector(".memo-progress-check")).toBeNull();
  });

  it("does not pop the completion check on an already-complete card's initial mount", () => {
    renderCard({ memo: { ...memo, content: "- [x] alpha\n- [x] beta" } });
    const check = document.querySelector(".memo-view-surface .memo-head .memo-progress-check");
    expect(check).not.toBeNull();
    expect(check?.classList.contains("is-new")).toBe(false);
  });

  it("keeps trash cards and select mode inert (boxes render, controls do not)", () => {
    renderCard({ variant: "trash" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    cleanup();
    renderCard({ selecting: true });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
