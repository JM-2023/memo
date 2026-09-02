// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoCard } from "../src/components/MemoCard";
import { Menu } from "../src/components/Menu";
import { ScrollTopButton } from "../src/components/ScrollTopButton";
import { SearchFilter } from "../src/components/SearchFilter";
import { Sidebar } from "../src/components/Sidebar";
import { TagTree } from "../src/components/TagTree";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import type { SavedFilter } from "../src/lib/savedFilters";
import type { FeedFilters } from "../src/lib/search";
import type { TagNode } from "../src/lib/tags";
import type { Memo } from "../src/lib/types";

const filters: FeedFilters = {
  noTags: false,
  hasImage: false,
  hasLink: false,
  hasOpenTask: false,
  dateFrom: null,
  dateTo: null
};

const memo: Memo = {
  id: "memo-a11y",
  content: "hello #work",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
  pinnedAt: null,
  deletedAt: null,
  seq: 1,
  images: [{ id: "image-a11y", mime: "image/webp", width: 120, height: 90, bytes: 128 }]
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function BranchBody() {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <>
      <button type="button" role="menuitem">
        Confirm removal
      </button>
      <button type="button" role="menuitem" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </>
  ) : (
    <button type="button" role="menuitem" onClick={() => setConfirming(true)}>
      Delete
    </button>
  );
}

function BranchingMenu() {
  return (
    <Menu trigger={() => <button type="button">Actions</button>}>{() => <BranchBody />}</Menu>
  );
}

function MemoFixture({ selecting = false }: { selecting?: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <MemoCard
      memo={memo}
      variant="normal"
      knownTags={["work"]}
      editing={editing}
      savingEdit={false}
      editConflict={false}
      selecting={selecting}
      selected={false}
      onToggleSelect={vi.fn()}
      onStartEdit={() => setEditing(true)}
      onCancelEdit={() => setEditing(false)}
      onSaveEdit={vi.fn(async () => true)}
      onAcceptEditConflict={vi.fn()}
      onTogglePin={vi.fn()}
      onCopy={vi.fn()}
      onShare={vi.fn()}
      onDelete={vi.fn()}
      onRestore={vi.fn()}
      onPurge={vi.fn()}
      onPickTag={vi.fn()}
      onOpenImage={vi.fn()}
    />
  );
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
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  delete (Element.prototype as Element & { animate?: typeof Element.prototype.animate }).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("focus recovery", () => {
  it("focuses the first item after an action menu swaps confirmation branches", async () => {
    const user = userEvent.setup();
    render(<BranchingMenu />);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = screen.getByRole("menuitem", { name: "Confirm removal" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    await user.click(screen.getByRole("menuitem", { name: "Cancel" }));
    const remove = screen.getByRole("menuitem", { name: "Delete" });
    await waitFor(() => expect(document.activeElement).toBe(remove));
  });

  it("returns focus to the memo action trigger after cancelling an edit", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <MemoFixture />
      </Providers>
    );

    await user.click(screen.getByRole("button", { name: "Memo actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("combobox", { name: "Memo content" });
    expect(document.activeElement).toBe(editor);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const trigger = await screen.findByRole("button", { name: "Memo actions" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores focus while the outgoing editor remains mounted for its morph", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: vi.fn(
        () =>
          ({
            cancel: vi.fn(),
            finished: new Promise<Animation>(() => {})
          }) as unknown as Animation
      )
    });

    render(
      <Providers>
        <MemoFixture />
      </Providers>
    );
    await user.click(screen.getByRole("button", { name: "Memo actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    const outgoingEditor = screen.getByRole("combobox", { name: "Memo content" });
    const trigger = await screen.findByRole("button", { name: "Memo actions" });
    expect(outgoingEditor.isConnected).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(outgoingEditor.isConnected).toBe(true);
  });
});

describe("selection and scroll affordances", () => {
  it("makes the select overlay the only tabbable surface in a selected-mode memo", async () => {
    const user = userEvent.setup();
    const view = render(
      <Providers>
        <MemoFixture selecting />
      </Providers>
    );

    const surface = view.container.querySelector<HTMLElement>(".memo-view-surface");
    if (!surface) throw new Error("Memo view surface was not rendered");
    expect(surface.inert).toBe(true);
    expect(surface.getAttribute("aria-hidden")).toBe("true");
    expect(surface.querySelector(".memo-tag")?.tagName).toBe("SPAN");
    expect(within(surface).getByRole("button", { name: "Memo actions", hidden: true }).tabIndex).toBe(-1);
    expect(within(surface).getByRole("button", { name: "View image", hidden: true }).tabIndex).toBe(-1);

    const overlay = screen.getByRole("button", { name: "Select this memo" });
    await user.tab();
    expect(document.activeElement).toBe(overlay);
  });

  it("hides the dormant back-to-top button from AT and uses the Trash fallback when the composer is hidden", async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0, writable: true });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600, writable: true });
    const composer = document.createElement("div");
    composer.className = "composer";
    composer.hidden = true;
    document.body.append(composer);

    const view = render(
      <Providers>
        <ScrollTopButton />
      </Providers>
    );
    const slot = view.container.querySelector<HTMLElement>(".scroll-top-slot");
    if (!slot) throw new Error("Back-to-top slot was not rendered");
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
    expect(slot.inert).toBe(true);
    expect(slot.querySelector("button")?.tabIndex).toBe(-1);

    window.scrollY = 900;
    window.dispatchEvent(new Event("scroll"));
    expect(await screen.findByRole("button", { name: "Back to top" })).not.toBeNull();
    expect(slot.inert).toBe(false);
    composer.remove();
  });
});

describe("selected and expanded semantics", () => {
  it("exposes tag selection and names each expansion control", async () => {
    const user = userEvent.setup();
    const tree: TagNode[] = [{ name: "work", path: "work", count: 2, children: [{ name: "project", path: "work/project", count: 1, children: [] }] }];
    render(
      <Providers>
        <TagTree
          tree={tree}
          activeTag="work"
          pinnedTags={new Map()}
          onPickTag={vi.fn()}
          onPinTag={vi.fn()}
          onRenameTag={vi.fn()}
          onRemoveTag={vi.fn()}
        />
      </Providers>
    );

    // The count sits inside the button (it trails the name in the row), so the
    // label spells it out rather than leaving the digits glued to the name.
    expect(screen.getByRole("button", { name: "work, 2 memos" }).getAttribute("aria-pressed")).toBe("true");
    const expand = screen.getByRole("button", { name: "Expand tag work" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await user.click(expand);
    expect(screen.getByRole("button", { name: "Collapse tag work" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("exposes the active saved filter and current sidebar destination", async () => {
    const user = userEvent.setup();
    const saved: SavedFilter = { id: "saved-a", name: "Focus", query: "", tag: null, day: null, filters };
    const sidebarProps = {
      memos: [] as Memo[],
      tagTree: [] as TagNode[],
      uniqueTagCount: 0,
      countsByDay: new Map<string, number>(),
      activeTag: null,
      activeDay: null,
      filtersActive: false,
      view: "memos" as const,
      trashCount: 0,
      theme: "system" as const,
      pinnedTags: new Map<string, string>(),
      onPickTag: vi.fn(),
      onPinTag: vi.fn(),
      onRenameTag: vi.fn(),
      onRemoveTag: vi.fn(),
      onPickDay: vi.fn(),
      onShowAll: vi.fn(),
      onOpenTrash: vi.fn(),
      onOpenStats: vi.fn(),
      onSetTheme: vi.fn(),
      onChangePasscode: vi.fn(),
      onExportData: vi.fn(),
      onImportData: vi.fn(),
      onLogout: vi.fn()
    };
    render(
      <Providers>
        <Sidebar {...sidebarProps} />
        <SearchFilter
          filters={filters}
          saved={[saved]}
          activeSavedId={saved.id}
          canSave={false}
          disabled={false}
          onToggleFacet={vi.fn()}
          onDateChange={vi.fn()}
          onClearDates={vi.fn()}
          onApplySaved={vi.fn()}
          onDeleteSaved={vi.fn()}
          onSaveCurrent={vi.fn()}
        />
      </Providers>
    );

    expect(screen.getByRole("button", { name: /All memos/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /Trash/ }).hasAttribute("aria-current")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true");
  });
});
