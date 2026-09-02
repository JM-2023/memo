// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Image } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/components/Editor";
import { FilterChip } from "../src/components/FilterChip";
import { SearchFilter } from "../src/components/SearchFilter";
import { Sidebar } from "../src/components/Sidebar";
import { TagTree } from "../src/components/TagTree";
import { TipProvider } from "../src/components/Tip";
import { dateKey } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import { EMPTY_FILTERS } from "../src/lib/search";
import type { TagNode } from "../src/lib/tags";
import type { Memo } from "../src/lib/types";

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no Web Animations; the tag tree's FLIP pass reads them.
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: vi.fn(() => ({ cancel: vi.fn(), finish: vi.fn() })) });
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
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  delete (Element.prototype as Element & { animate?: typeof Element.prototype.animate }).animate;
});

describe("tag completion", () => {
  it("keeps Enter's own meaning once the typed run already spells a tag", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={["life", "life/cooking", "life/garden"]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const editor = screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    await user.type(editor, "Weekend #life");

    // The children are still on offer (Tab takes one)…
    const offered = screen.getAllByRole("option").map((option) => option.textContent);
    expect(offered.some((text) => text?.includes("life/cooking"))).toBe(true);
    expect(offered.some((text) => text === "#life" || text === "life")).toBe(false);

    // …but Enter no longer swaps #life for its first child.
    await user.keyboard("{Enter}");
    expect(editor.value).toBe("Weekend #life\n");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ranks prefix matches first and still completes a partial run on Enter", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={["alife", "life", "life/cooking"]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const editor = screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
    await user.type(editor, "#li");
    const offered = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(offered[0]).toContain("life");
    expect(offered[0]).not.toContain("alife");
    await user.keyboard("{Enter}");
    expect(editor.value).toBe("#life ");
  });
});

describe("tag tree", () => {
  const tree: TagNode[] = [
    {
      name: "life",
      path: "life",
      count: 3,
      children: [
        { name: "cooking", path: "life/cooking", count: 2, children: [] },
        { name: "garden", path: "life/garden", count: 1, children: [] }
      ]
    }
  ];

  function renderTree(activeTag: string | null, onRemoveTag = vi.fn()) {
    return render(
      <Providers>
        <TagTree tree={tree} activeTag={activeTag} pinnedTags={new Map()} onPickTag={vi.fn()} onPinTag={vi.fn()} onRenameTag={vi.fn()} onRemoveTag={onRemoveTag} />
      </Providers>
    );
  }

  it("opens the subtree the lens sits in, so the selected row is visible", () => {
    renderTree("life/cooking");
    expect(screen.getByRole("button", { name: "Collapse tag life" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "cooking, 2 memos" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("stays folded when the lens is elsewhere", () => {
    renderTree(null);
    expect(screen.getByRole("button", { name: "Expand tag life" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "cooking, 2 memos" })).toBeNull();
  });

  it("names the sub-tags a removal takes with it", async () => {
    const user = userEvent.setup();
    const onRemoveTag = vi.fn();
    renderTree(null, onRemoveTag);
    await user.click(screen.getByRole("button", { name: "Actions for tag life" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove tag" }));
    expect(screen.getByText(/Remove #life and the 2 tags under it from 3 memos\?/)).toBeTruthy();
    expect(screen.getByText(/#life\/cooking · #life\/garden/)).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Remove tag" }));
    expect(onRemoveTag).toHaveBeenCalledWith("life");
  });
});

describe("theme control", () => {
  it("offers the three themes as one choice instead of a cycling button", async () => {
    const user = userEvent.setup();
    const onSetTheme = vi.fn();
    render(
      <Providers>
        <Sidebar
          memos={[] as Memo[]}
          tagTree={[] as TagNode[]}
          uniqueTagCount={0}
          countsByDay={new Map<string, number>()}
          activeTag={null}
          activeDay={null}
          filtersActive={false}
          view="memos"
          trashCount={0}
          theme="system"
          pinnedTags={new Map<string, string>()}
          onPickTag={vi.fn()}
          onPinTag={vi.fn()}
          onRenameTag={vi.fn()}
          onRemoveTag={vi.fn()}
          onPickDay={vi.fn()}
          onShowAll={vi.fn()}
          onOpenTrash={vi.fn()}
          onOpenReview={vi.fn()}
          onOpenReviewSettings={vi.fn()}
          onOpenModelSettings={vi.fn()}
          onOpenStats={vi.fn()}
          onSetTheme={onSetTheme}
          onChangePasscode={vi.fn()}
          onExportData={vi.fn()}
          onImportData={vi.fn()}
          onLogout={vi.fn()}
        />
      </Providers>
    );
    await user.click(screen.getByRole("button", { name: /My MEMO/ }));
    const system = screen.getByRole("menuitemradio", { name: "Follow system" });
    expect(system.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(onSetTheme).toHaveBeenCalledWith("dark");
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
  });
});

describe("filter panel", () => {
  it("idles No tags inside a tag and lands a quick range whole", async () => {
    const user = userEvent.setup();
    const onPresetRange = vi.fn();
    const onToggleFacet = vi.fn();
    render(
      <Providers>
        <SearchFilter
          filters={EMPTY_FILTERS}
          saved={[]}
          activeSavedId={null}
          canSave={false}
          disabled={false}
          activeTag="life"
          onToggleFacet={onToggleFacet}
          onDateChange={vi.fn()}
          onPresetRange={onPresetRange}
          onClearDates={vi.fn()}
          onApplySaved={vi.fn()}
          onDeleteSaved={vi.fn()}
          onSaveCurrent={vi.fn()}
        />
      </Providers>
    );
    await user.click(screen.getByRole("button", { name: "Filter memos" }));
    const noTags = screen.getByRole("button", { name: /No tags/ }) as HTMLButtonElement;
    expect(noTags.disabled).toBe(true);
    expect(noTags.textContent).toContain("not inside #life");

    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(onPresetRange).toHaveBeenCalledTimes(1);
    const [from, to] = onPresetRange.mock.calls[0] as [string, string];
    expect(to).toBe(dateKey(new Date()));
    expect(from < to).toBe(true);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("filter chips", () => {
  it("splits an editable chip into an edit half and a remove nub", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onClear = vi.fn();
    render(
      <FilterChip
        icon={Image}
        label="With images"
        clearLabel="Clear “With images” filter"
        editLabel="Edit filters: “With images”"
        transitionName="facet-chip-hasImage"
        onClear={onClear}
        onEdit={onEdit}
      />
    );
    await user.click(screen.getByRole("button", { name: "Edit filters: “With images”" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear “With images” filter" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("keeps a chip without a panel as one remove button", () => {
    render(<FilterChip icon={Image} label="Aug 17" clearLabel="Clear date filter: Aug 17" transitionName="day-filter-chip" onClear={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Clear date filter: Aug 17" })).toBeTruthy();
  });
});
