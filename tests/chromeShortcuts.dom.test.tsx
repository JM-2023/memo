// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Heatmap } from "../src/components/Heatmap";
import { Sidebar } from "../src/components/Sidebar";
import { TagTree } from "../src/components/TagTree";
import { TipProvider } from "../src/components/Tip";
import { edgeSwipeOpens } from "../src/hooks/useDrawerEdgeSwipe";
import { addDays, dateKey } from "../src/lib/dates";
import { LanguageProvider } from "../src/lib/i18n";
import { EASE_OUT } from "../src/lib/motion";
import { RECENT_SEARCHES_LIMIT, parseRecentSearches, rememberSearch } from "../src/lib/recentSearches";
import { cubicBezier, globalShortcutOf, isTextEntry, isUndoLabel } from "../src/lib/shortcuts";
import { OPEN_TAGS_KEY, PERIOD_KEY, loadPeriod, parseOpenTagPaths } from "../src/lib/sidebarMemory";
import { completeTag, flattenTags, matchTags, tagNeedle } from "../src/lib/tagJump";
import type { TagNode } from "../src/lib/tags";
import { startToastSwipe, toastSwipeDirection } from "../src/lib/toastSwipe";

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
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
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  vi.restoreAllMocks();
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("global shortcuts", () => {
  it("names the app's own keys and nobody else's", () => {
    expect(globalShortcutOf(key({ key: "/" }))).toBe("search");
    expect(globalShortcutOf(key({ key: "k", metaKey: true }))).toBe("search");
    expect(globalShortcutOf(key({ key: "K", ctrlKey: true }))).toBe("search");
    expect(globalShortcutOf(key({ key: "n" }))).toBe("compose");
    expect(globalShortcutOf(key({ key: "N" }))).toBe("compose"); // Caps Lock
    expect(globalShortcutOf(key({ key: "z", metaKey: true }))).toBe("undo");
    expect(globalShortcutOf(key({ key: "?", shiftKey: true }))).toBe("help");
    // Redo, ⌥ characters, held keys and IME keys are someone else's.
    expect(globalShortcutOf(key({ key: "z", metaKey: true, shiftKey: true }))).toBeNull();
    expect(globalShortcutOf(key({ key: "n", altKey: true }))).toBeNull();
    expect(globalShortcutOf(key({ key: "N", shiftKey: true }))).toBeNull();
    expect(globalShortcutOf(key({ key: "/", repeat: true }))).toBeNull();
    expect(globalShortcutOf(key({ key: "/", isComposing: true }))).toBeNull();
    expect(globalShortcutOf(key({ key: "a", metaKey: true }))).toBeNull();
  });

  it("stands down inside anything that takes typed text", () => {
    const area = document.createElement("textarea");
    const field = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.appendChild(inner);
    document.body.append(area, field, box, editable);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(field)).toBe(true);
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(inner)).toBe(true);
    expect(isTextEntry(document.body)).toBe(false);
    document.body.replaceChildren();
  });

  it("undoes only an Undo", () => {
    expect(isUndoLabel("Undo")).toBe(true);
    expect(isUndoLabel("撤销")).toBe(true);
    expect(isUndoLabel("Show")).toBe(false);
    expect(isUndoLabel("Stop")).toBe(false);
  });

  it("glides on the --ease-out curve the CSS uses", () => {
    const [x1, y1, x2, y2] = (/cubic-bezier\(([^)]+)\)/.exec(EASE_OUT)?.[1] ?? "").split(",").map(Number);
    const ease = cubicBezier(x1, y1, x2, y2);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    // Front-loaded: most of the way there by a third of the time.
    expect(ease(1 / 3)).toBeGreaterThan(0.75);
    const samples = Array.from({ length: 11 }, (_, index) => ease(index / 10));
    expect(samples.every((value, index) => index === 0 || value >= samples[index - 1])).toBe(true);
  });
});

describe("tag jump matching", () => {
  const tree: TagNode[] = [
    { name: "journal", path: "journal", count: 4, children: [{ name: "dreams", path: "journal/dreams", count: 1, children: [] }] },
    { name: "work", path: "work", count: 6, children: [{ name: "project-journey", path: "work/project-journey", count: 2, children: [] }] },
    { name: "ideas", path: "ideas", count: 3, children: [] }
  ];
  const tags = flattenTags(tree);

  it("answers the last word, without its #, and not inside a phrase", () => {
    expect(tagNeedle("apple #Jour")).toBe("jour");
    expect(tagNeedle("apple ")).toBe("");
    expect(tagNeedle("“green app")).toBe("app");
    expect(tagNeedle("“green")).toBe("");
  });

  it("puts substring matches first — a segment start before a mid-word hit — then subsequences", () => {
    const hits = matchTags("jour", tags);
    expect(hits.map((hit) => hit.path)).toEqual(["journal", "journal/dreams", "work/project-journey"]);
    expect(hits[0].marks).toEqual([0, 1, 2, 3]);
    const loose = matchTags("jd", tags);
    expect(loose.map((hit) => hit.path)).toEqual(["journal/dreams"]);
    expect(loose[0].marks).toEqual([0, 8]);
    expect(matchTags("zzz", tags)).toEqual([]);
  });

  it("completes the last word into a tag", () => {
    expect(completeTag("apple jour", "journal")).toBe("apple #journal");
    expect(completeTag("#jo", "journal/dreams")).toBe("#journal/dreams");
  });
});

describe("recent searches", () => {
  it("keeps the last few, newest first, once each", () => {
    let items: string[] = [];
    for (const query of ["fruit", "  window  seat ", "Fruit", "plain"]) items = rememberSearch(items, query);
    expect(items).toEqual(["plain", "Fruit", "window seat"]);
    for (let index = 0; index < 10; index += 1) items = rememberSearch(items, `q${index}`);
    expect(items).toHaveLength(RECENT_SEARCHES_LIMIT);
    expect(rememberSearch(["a"], "   ")).toEqual(["a"]);
  });

  it("reads back only what it could have written", () => {
    expect(parseRecentSearches('["a", 3, "", "A", "b"]')).toEqual(["a", "b"]);
    expect(parseRecentSearches("{")).toEqual([]);
    expect(parseRecentSearches(null)).toEqual([]);
  });
});

describe("drawer edge swipe", () => {
  it("opens on the same terms the drawer closes on", () => {
    expect(edgeSwipeOpens(120, 300, 0)).toBe(true);
    expect(edgeSwipeOpens(80, 300, 0)).toBe(false);
    expect(edgeSwipeOpens(40, 300, 0.8)).toBe(true);
    // Past the line but pulled back hard: it stays shut.
    expect(edgeSwipeOpens(120, 300, -0.8)).toBe(false);
  });
});

describe("toast swipe", () => {
  function pointer(type: string, y: number, t: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y });
    for (const [name, value] of Object.entries({ pointerId: 1, pointerType: "touch", isPrimary: true, timeStamp: t })) {
      Object.defineProperty(event, name, { configurable: true, value });
    }
    return event as unknown as PointerEvent;
  }

  it("leaves toward the edge its stack sits at, and springs back the other way", () => {
    const toast = document.createElement("div");
    document.body.appendChild(toast);
    const dismiss = vi.fn();
    const shift = () => Number(/(-?[\d.]+)px\s*$/.exec(String(toast.style.translate))?.[1]);
    // Anchored at the bottom: a pull up only gives a little and springs back.
    startToastSwipe(pointer("pointerdown", 500, 0), toast, dismiss, "down");
    window.dispatchEvent(pointer("pointermove", 460, 20));
    expect(shift()).toBeLessThan(0);
    expect(shift()).toBeGreaterThan(-15);
    window.dispatchEvent(pointer("pointerup", 460, 40));
    expect(dismiss).not.toHaveBeenCalled();
    // A pull down past 24px dismisses, following the finger all the way.
    startToastSwipe(pointer("pointerdown", 500, 1000), toast, dismiss, "down");
    window.dispatchEvent(pointer("pointermove", 540, 1200));
    expect(shift()).toBeCloseTo(40);
    window.dispatchEvent(pointer("pointerup", 540, 1400));
    expect(dismiss).toHaveBeenCalledTimes(1);
    toast.remove();
  });

  it("reads the edge from where the stack sits: a phone's goes to the top over a dialog", () => {
    const stack = document.createElement("div");
    const at = (top: number) => vi.spyOn(stack, "getBoundingClientRect").mockReturnValue(new DOMRect(16, top, 300, 48));
    at(window.innerHeight - 64);
    expect(toastSwipeDirection(stack)).toBe("down");
    at(16);
    expect(toastSwipeDirection(stack)).toBe("up");
  });
});

describe("sidebar memory", () => {
  const sidebarProps = {
    memos: [],
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
    onOpenReview: vi.fn(),
    onOpenReviewSettings: vi.fn(),
    onOpenModelSettings: vi.fn(),
    onOpenStats: vi.fn(),
    onSetTheme: vi.fn(),
    onChangePasscode: vi.fn(),
    onExportData: vi.fn(),
    onImportData: vi.fn(),
    onLogout: vi.fn()
  };

  it("comes back to the period it was left on", async () => {
    const user = userEvent.setup();
    const first = render(
      <Providers>
        <Sidebar {...sidebarProps} />
      </Providers>
    );
    expect(screen.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(localStorage.getItem(PERIOD_KEY)).toBe("month");
    first.unmount();
    render(
      <Providers>
        <Sidebar {...sidebarProps} />
      </Providers>
    );
    expect(screen.getByRole("button", { name: "Month" }).getAttribute("aria-pressed")).toBe("true");
    localStorage.setItem(PERIOD_KEY, "decade");
    expect(loadPeriod()).toBe("week");
  });

  it("comes back with the subtrees it left unfolded, already open", async () => {
    const user = userEvent.setup();
    const tree: TagNode[] = [{ name: "work", path: "work", count: 3, children: [{ name: "client", path: "work/client", count: 1, children: [] }] }];
    const ui = (
      <LanguageProvider>
        <TagTree tree={tree} activeTag={null} pinnedTags={new Map()} onPickTag={vi.fn()} onPinTag={vi.fn()} onRenameTag={vi.fn()} onRemoveTag={vi.fn()} />
      </LanguageProvider>
    );
    const first = render(ui);
    await user.click(screen.getByRole("button", { name: "Expand tag work" }));
    expect(parseOpenTagPaths(localStorage.getItem(OPEN_TAGS_KEY))).toEqual(["work"]);
    first.unmount();
    render(ui);
    expect(screen.getByRole("button", { name: "Collapse tag work" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^client/ })).toBeTruthy();
    expect(parseOpenTagPaths('["a", "a", 1, ""]')).toEqual(["a"]);
  });
});

describe("month heatmap", () => {
  it("dates each cell of the month, not the year's", () => {
    const today = new Date();
    const ui = (period: "month" | "year") => (
      <Providers>
        <Heatmap countsByDay={new Map([[dateKey(today), 2]])} minDay="2000-01-01" activeDay={null} period={period} onPickDay={vi.fn()} />
      </Providers>
    );
    const view = render(ui("month"));
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dates = [...document.querySelectorAll(".heat-current .heat-day")].map((node) => node.textContent);
    expect(dates).toEqual(Array.from({ length: daysInMonth }, (_, index) => String(index + 1)));
    expect(document.querySelector(".heat-current .heat-cell.is-today .heat-day")?.textContent).toBe(String(today.getDate()));
    // Decorative: the cell's own name still says the day and its count.
    expect(document.querySelector(".heat-cell.is-today")?.getAttribute("aria-label")).toMatch(/2 memos$/);
    act(() => view.rerender(ui("year")));
    expect(document.querySelector(".heat-current .heat-day")).toBeNull();
  });

  it("levels the cells on the owner's own scale once there is enough to read", () => {
    const today = new Date();
    // A writer whose ordinary day holds 10 memos (and a couple of 30s): on
    // the fixed steps today's 10 would be the darkest green; on their own
    // scale it is an ordinary day.
    const counts = new Map<string, number>([[dateKey(today), 10]]);
    [10, 10, 10, 10, 10, 10, 10, 10, 30, 30].forEach((count, index) => counts.set(dateKey(addDays(today, -(index + 1))), count));
    render(
      <Providers>
        <Heatmap countsByDay={counts} minDay="2000-01-01" activeDay={null} period="month" onPickDay={vi.fn()} />
      </Providers>
    );
    expect(document.querySelector(".heat-current .heat-cell.is-today")?.classList.contains("level-1")).toBe(true);
  });
});
