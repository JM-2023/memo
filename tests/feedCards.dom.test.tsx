// @vitest-environment jsdom

// Feed card behaviour: the long-memo fold, the ⋯ menu's flip and ARIA
// wiring, one-step trash with a confirmed permanent delete, the trash card's
// visible Restore, and the off-screen replay skip.

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoCard } from "../src/components/MemoCard";
import { mightFold } from "../src/components/MemoFold";
import { Menu } from "../src/components/Menu";
import { TagTree } from "../src/components/TagTree";
import { formatTime } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import type { TagNode } from "../src/lib/tags";
import type { Memo } from "../src/lib/types";

const baseMemo: Memo = {
  id: "memo-card",
  content: "hello #work",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
  pinnedAt: null,
  deletedAt: null,
  seq: 1,
  images: []
};

const LONG = Array.from({ length: 30 }, (_, index) => `line ${index + 1} with [a link](https://example.com/${index})`).join("\n");

type CardProps = Parameters<typeof MemoCard>[0];

function cardProps(overrides: Partial<CardProps> = {}): CardProps {
  return {
    memo: baseMemo,
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
    onToggleTask: vi.fn(),
    ...overrides
  };
}

function Providers({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

function renderCard(overrides: Partial<CardProps> = {}) {
  const props = cardProps(overrides);
  const view = render(
    <Providers>
      <MemoCard {...props} />
    </Providers>
  );
  return { ...view, props, rerenderCard: (next: Partial<CardProps>) => view.rerender(<Providers><MemoCard {...props} {...next} /></Providers>) };
}

function stubMatchMedia(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
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

beforeEach(() => {
  stubMatchMedia(true);
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Element & { animate?: unknown }).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("long-memo fold", () => {
  it("only measures text that could plausibly outgrow the fold", () => {
    expect(mightFold("a short memo")).toBe(false);
    expect(mightFold(Array.from({ length: 6 }, () => "line").join("\n"))).toBe(false);
    expect(mightFold(LONG)).toBe(true);
    expect(mightFold("x".repeat(400))).toBe(true);
  });

  it("clamps a body taller than the fold and toggles it with a labelled, keyboard-reachable button", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memo-content") ? 900 : 0;
    });
    const { container } = renderCard({ memo: { ...baseMemo, content: LONG } });

    const fold = container.querySelector<HTMLElement>(".memo-fold");
    expect(fold?.hasAttribute("data-overflow")).toBe(true);
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(fold?.id);

    await user.click(toggle);
    expect(fold?.classList.contains("is-expanded")).toBe(true);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");

    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollBy", { configurable: true, value: scrollBy });
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(fold?.classList.contains("is-expanded")).toBe(false);
  });

  it("leaves a body that fits alone: no clamp, no toggle", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    const { container } = renderCard({ memo: { ...baseMemo, content: LONG } });
    expect(container.querySelector(".memo-fold")?.hasAttribute("data-overflow")).toBe(false);
  });

  it("unfolds when keyboard focus lands on a link hidden below the fold", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memo-content") ? 900 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("memo-fold")) return new DOMRect(0, 0, 300, 320);
      if (this.tagName === "A" && this.textContent === "a link" && this.getAttribute("href")?.endsWith("/29")) return new DOMRect(0, 760, 40, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    const { container } = renderCard({ memo: { ...baseMemo, content: LONG } });
    const links = container.querySelectorAll<HTMLAnchorElement>(".memo-fold a");
    act(() => links[0].focus());
    expect(container.querySelector(".memo-fold")?.classList.contains("is-expanded")).toBe(false);
    act(() => links[links.length - 1].focus());
    expect(container.querySelector(".memo-fold")?.classList.contains("is-expanded")).toBe(true);
  });
});

describe("memo card menu", () => {
  it("names each ⋯ by its memo and wires popup state to the panel", async () => {
    const user = userEvent.setup();
    renderCard();
    const trigger = screen.getByRole("button", { name: `Memo actions, ${formatTime(baseMemo.createdAt, "en-US")}` });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
  });

  it("moves to Trash in one step — the toast's Undo is the safety net", async () => {
    const user = userEvent.setup();
    const { props } = renderCard();
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("holds pin and trash while one of them is in flight", async () => {
    const user = userEvent.setup();
    renderCard({ busy: true });
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    expect((screen.getByRole("menuitem", { name: "Pin", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Move to Trash", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("numbers image buttons so nine thumbnails are not nine identical names", () => {
    renderCard({
      memo: {
        ...baseMemo,
        images: [
          { id: "img-a", mime: "image/webp", width: 10, height: 10, bytes: 1 },
          { id: "img-b", mime: "image/webp", width: 10, height: 10, bytes: 1 }
        ]
      }
    });
    expect(screen.getByRole("button", { name: "View image 1 of 2" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "View image 2 of 2" })).not.toBeNull();
  });

  it("opens upward when the panel would run past the viewport bottom", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 340 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("menu-root") ? new DOMRect(300, 620, 26, 26) : new DOMRect(0, 0, 0, 0);
    });
    renderCard();
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    expect(screen.getByRole("menu").classList.contains("is-up")).toBe(true);
  });

  it("keeps opening downward where it fits", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("action-menu") ? 340 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("menu-root") ? new DOMRect(300, 200, 26, 26) : new DOMRect(0, 0, 0, 0);
    });
    renderCard();
    await user.click(screen.getByRole("button", { name: /^Memo actions/ }));
    expect(screen.getByRole("menu").classList.contains("is-up")).toBe(false);
  });
});

describe("trash card", () => {
  const trashed: Memo = { ...baseMemo, deletedAt: "2026-07-17T09:30:00.000Z" };

  it("offers Restore on the card and states the deletion in words", async () => {
    const user = userEvent.setup();
    const { props, container } = renderCard({ memo: trashed, variant: "trash" });
    const stamp = formatTime(trashed.deletedAt!, "en-US");
    expect(container.querySelector(".memo-time")?.textContent).toBe(`Deleted ${stamp}`);
    await user.click(screen.getByRole("button", { name: `Restore memo deleted ${stamp}` }));
    expect(props.onRestore).toHaveBeenCalledTimes(1);
  });

  it("disables Restore while a restore is in flight", () => {
    renderCard({ memo: trashed, variant: "trash", busy: true });
    expect((screen.getByRole("button", { name: /^Restore memo deleted/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms a permanent delete, describing the consequence and starting on Cancel", async () => {
    const user = userEvent.setup();
    const { props } = renderCard({ memo: trashed, variant: "trash" });
    await user.click(screen.getByRole("button", { name: /^Memo actions, deleted/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));
    const confirm = screen.getByRole("menuitem", { name: "Delete forever" });
    expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/can’t be undone/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel" })));
    expect(props.onPurge).not.toHaveBeenCalled();
    await user.click(confirm);
    expect(props.onPurge).toHaveBeenCalledTimes(1);
  });
});

describe("tag menu", () => {
  it("describes the removal's reach on the confirm item and wires the trigger", async () => {
    const user = userEvent.setup();
    const tree: TagNode[] = [
      { name: "work", path: "work", count: 3, children: [{ name: "client", path: "work/client", count: 1, children: [] }] }
    ];
    render(
      <Providers>
        <TagTree tree={tree} activeTag={null} pinnedTags={new Map()} onPickTag={vi.fn()} onPinTag={vi.fn()} onRenameTag={vi.fn()} onRemoveTag={vi.fn()} />
      </Providers>
    );
    const trigger = screen.getByRole("button", { name: "Actions for tag work" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: "Remove tag" }));
    const confirm = screen.getByRole("menuitem", { name: "Remove tag" });
    const described = (confirm.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toMatch(/Remove #work and the 1 tag under it from 3 memos\? The memos stay\./);
    expect(described).toMatch(/#work\/client/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel" })));
  });
});

describe("generic menu", () => {
  it("labels the panel after an older-style trigger that ignores triggerProps", async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger={() => <button type="button">Actions</button>}>
        {() => (
          <button type="button" role="menuitem">
            One
          </button>
        )}
      </Menu>
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(trigger.id).not.toBe("");
    expect(within(document.body).getByRole("menu", { name: "Actions" })).not.toBeNull();
  });
});

describe("off-screen replay", () => {
  // MemoStage keeps one shared observer for the module's lifetime, so the
  // records outlive a single test.
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];

  function setupMotion() {
    stubMatchMedia(false);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => ({ cancel: vi.fn(), finished: new Promise<Animation>(() => {}) }) as unknown as Animation)
    });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly record: { callback: IntersectionObserverCallback; targets: Element[] };
        constructor(callback: IntersectionObserverCallback) {
          this.record = { callback, targets: [] };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      }
    );
  }

  it("replays a remote edit on a card near the viewport", () => {
    setupMotion();
    const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, content: "first" } });
    rerenderCard({ memo: { ...baseMemo, content: "first\nsecond", seq: 2 } });
    expect(container.querySelector(".stage-overlay")).not.toBeNull();
  });

  it("lands a remote edit far off-screen with no ghost or overlay", () => {
    setupMotion();
    const { container, rerenderCard } = renderCard({ memo: { ...baseMemo, content: "first" } });
    const stage = container.querySelector(".card-stage");
    const watcher = observers.find((observer) => observer.targets.includes(stage!));
    if (!watcher) throw new Error("The card was not watched");
    act(() => watcher.callback([{ target: stage, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    rerenderCard({ memo: { ...baseMemo, content: "first\nsecond", seq: 2 } });
    expect(container.querySelector(".stage-overlay")).toBeNull();
    expect(container.querySelector(".stage-ghost")).toBeNull();
    expect(container.textContent).toContain("second");
  });
});
