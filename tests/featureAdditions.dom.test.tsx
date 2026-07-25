// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkTagDialog } from "../src/components/BulkTagDialog";
import { StatsModal } from "../src/components/StatsModal";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider, useI18n } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

let reduceMotion = false;

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function LanguageProbe() {
  const { language } = useI18n();
  return <output aria-label="language">{language}</output>;
}

function makeMemo(created: Date): Memo {
  const timestamp = created.toISOString();
  return {
    id: "memo-stats-drilldown",
    content: "A focused memo #work/client",
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: []
  };
}

function renderBulkTagDialog(overrides: Partial<Parameters<typeof BulkTagDialog>[0]> = {}) {
  const props: Parameters<typeof BulkTagDialog>[0] = {
    selectedCount: 2,
    knownTags: ["work", "work/client"],
    onApply: vi.fn(async () => true),
    onDismiss: vi.fn(),
    onApplied: vi.fn(),
    ...overrides
  };
  const view = render(
    <Providers>
      <BulkTagDialog {...props} />
    </Providers>
  );
  return { props, view };
}

beforeEach(() => {
  reduceMotion = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reduceMotion,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("statistics drilldown", () => {
  it("emits exact year, month, weekday, hour and top-tag filters while disabling empty buckets", () => {
    reduceMotion = true;
    const year = new Date().getFullYear();
    const created = new Date(year, 2, 2, 9, 15);
    const weekday = (created.getDay() + 6) % 7;
    const onDrilldown = vi.fn();
    const locale = "en-US";
    const monthLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(created);
    const dayLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(created);
    const weekdayLabel = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(created);
    const hourFormatter = new Intl.DateTimeFormat(locale, { hour: "numeric" });
    const hourRange = `${hourFormatter.format(created)} – ${hourFormatter.format(new Date(year, 2, 2, 10))}`;

    render(
      <Providers>
        <StatsModal memos={[makeMemo(created)]} uniqueTagCount={1} onClose={vi.fn()} onDrilldown={onDrilldown} />
      </Providers>
    );

    const monthChart = screen.getByRole("group", { name: /^Memos by month\./ });
    const emptyMonth = within(monthChart).getByRole("button", { name: new RegExp(`April ${year}: 0 memos`) });
    expect((emptyMonth as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(emptyMonth);
    expect(onDrilldown).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: `Show 1 memo from ${year}` }));
    fireEvent.click(within(monthChart).getByRole("button", { name: `${monthLabel}: 1 memo` }));
    fireEvent.click(screen.getByRole("button", { name: `Show 1 memo from ${dayLabel}` }));

    const weekdayChart = screen.getByRole("group", { name: /^Distribution by weekday\./ });
    fireEvent.click(within(weekdayChart).getByRole("button", { name: `${weekdayLabel}: 1 memo` }));

    const hourChart = screen.getByRole("group", { name: /^Distribution by time\./ });
    fireEvent.click(within(hourChart).getByRole("button", { name: `${hourRange}: 1 memo` }));
    fireEvent.click(screen.getByRole("button", { name: "Show 1 memo tagged work/client" }));

    expect(onDrilldown.mock.calls.map(([filter]) => filter)).toEqual([
      { kind: "year", year },
      { kind: "month", year, month: 2 },
      { kind: "day", day: `${year}-03-02` },
      { kind: "weekday", year, weekday },
      { kind: "hour", year, hour: 9 },
      { kind: "tag", year, tag: "work/client" }
    ]);
  });
});

describe("bulk tag dialog", () => {
  it("plays its exit before committing the settled batch", async () => {
    vi.useFakeTimers();
    let settle!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const onApply = vi.fn(() => pending);
    const onApplied = vi.fn();
    const { view } = renderBulkTagDialog({ onApply, onApplied });

    fireEvent.change(screen.getByRole("textbox", { name: "Tag" }), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(onApply).toHaveBeenCalledWith("work");

    await act(async () => {
      settle(true);
      await pending;
    });

    expect(view.container.querySelector(".bulk-tag-overlay")?.className).toContain("is-closing");
    expect(onApplied).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(169);
    });
    expect(onApplied).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("stays open and exposes an alert when the batch cannot settle", async () => {
    const onApply = vi.fn(async () => false);
    const onApplied = vi.fn();
    const { view } = renderBulkTagDialog({ onApply, onApplied });

    fireEvent.change(screen.getByRole("textbox", { name: "Tag" }), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn’t add the tag");
    expect(screen.getByRole("dialog", { name: "Add tag to selected memos" })).toBeTruthy();
    expect(view.container.querySelector(".bulk-tag-overlay")?.className).not.toContain("is-closing");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("commits immediately when reduced motion is requested", async () => {
    reduceMotion = true;
    const onApplied = vi.fn();
    const { view } = renderBulkTagDialog({ onApplied });

    fireEvent.change(screen.getByRole("textbox", { name: "Tag" }), { target: { value: "work/client" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector(".bulk-tag-overlay")?.className).not.toContain("is-closing");
  });

  it("cannot submit after synchronization removes the selection", () => {
    renderBulkTagDialog({ selectedCount: 0 });
    fireEvent.change(screen.getByRole("textbox", { name: "Tag" }), { target: { value: "work" } });
    expect((screen.getByRole("button", { name: "Add tag" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("logout preference reset", () => {
  it("does not recreate the default language key after another tab clears it", async () => {
    localStorage.setItem("memo:language", "zh-CN");
    render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>
    );
    expect(screen.getByLabelText("language").textContent).toBe("zh-CN");

    act(() => {
      localStorage.removeItem("memo:language");
      window.dispatchEvent(new StorageEvent("storage", { key: "memo:language", oldValue: "zh-CN", newValue: null }));
    });

    await waitFor(() => expect(screen.getByLabelText("language").textContent).toBe("en"));
    expect(localStorage.getItem("memo:language")).toBeNull();
  });
});
