// @vitest-environment jsdom

// Daily review's quiet progress: why a card came back, when it counts as
// seen, the masthead's figure and hairline, and the word once today's set is
// done — never a streak or a count of days.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatReviewAge, ReviewActions, ReviewBanner, ReviewContext, ReviewFinish, ReviewSeenMark } from "../src/components/DailyReview";
import { REVIEW_SEEN_MS, useReviewSeen } from "../src/hooks/useReviewSeen";
import { LanguageProvider } from "../src/lib/i18n";
import type { ReviewPick } from "../src/lib/review";

function Providers({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

function inChinese() {
  localStorage.setItem("memo:language", "zh-CN");
}

/** Local noon on a local date. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("why a card came back", () => {
  const now = new Date(2026, 9, 19, 18);

  it("puts a memo's age in the UI locale, its figure set off in Chinese", () => {
    expect(formatReviewAge(localNoon(2025, 11, 19), "en-US", now)).toBe("11 months ago");
    expect(formatReviewAge(localNoon(2025, 11, 19), "zh-CN", now)).toBe("11 个月前");
    expect(formatReviewAge(localNoon(2026, 10, 19), "en-US", now)).toBe("today");
    expect(formatReviewAge(localNoon(2026, 10, 19), "zh-CN", now)).toBe("今天");
    expect(formatReviewAge(localNoon(2023, 10, 1), "zh-CN", now)).toBe("3 年前");
  });

  function renderContext(pick: ReviewPick, createdAt = localNoon(2025, 10, 19)) {
    return render(
      <Providers>
        <ReviewContext pick={pick} createdAt={createdAt} />
      </Providers>
    );
  }

  it("says on this day and the anniversaries in the leaf, a chance draw muted", () => {
    const { container, unmount } = renderContext({ reason: "onThisDay", years: 1 });
    expect(container.textContent).toBe("1 year ago today·");
    expect(container.querySelector(".review-context")?.classList.contains("is-dated")).toBe(true);
    expect(container.querySelector("svg")).not.toBeNull();
    unmount();

    renderContext({ reason: "onThisDay", years: 4 });
    expect(screen.getByText("4 years ago today")).toBeTruthy();
    cleanup();
    renderContext({ reason: "anniversary", span: "halfYear" });
    expect(screen.getByText("Six months ago")).toBeTruthy();
    cleanup();

    const random = renderContext({ reason: "random" }, new Date(Date.now() - 3 * 86_400_000).toISOString());
    expect(random.container.querySelector(".review-context")?.classList.contains("is-dated")).toBe(false);
    expect(random.container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Random · 3 days ago")).toBeTruthy();
  });

  it("reads naturally in Chinese", () => {
    inChinese();
    renderContext({ reason: "onThisDay", years: 1 });
    expect(screen.getByText("去年今天")).toBeTruthy();
    cleanup();
    renderContext({ reason: "onThisDay", years: 3 });
    expect(screen.getByText("3 年前的今天")).toBeTruthy();
    cleanup();
    renderContext({ reason: "anniversary", span: "week" });
    expect(screen.getByText("一周前")).toBeTruthy();
  });
});

describe("the seen check", () => {
  it("dissolves in only when the card becomes seen in front of the reader", () => {
    const view = render(
      <Providers>
        <ReviewSeenMark seen={false} />
      </Providers>
    );
    expect(view.container.querySelector(".review-seen-mark")).toBeNull();
    view.rerender(
      <Providers>
        <ReviewSeenMark seen />
      </Providers>
    );
    const mark = view.container.querySelector(".review-seen-mark");
    expect(mark?.classList.contains("is-new")).toBe(true);
    expect(mark?.getAttribute("aria-label")).toBe("Revisited");
    // jsdom has no AnimationEvent, so React may listen under the prefixed name.
    act(() => {
      for (const type of ["animationend", "webkitAnimationEnd"]) mark!.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(view.container.querySelector(".review-seen-mark")?.classList.contains("is-new")).toBe(false);
    cleanup();

    // Mounted already seen (a return to the review): no entrance.
    const again = render(
      <Providers>
        <ReviewSeenMark seen />
      </Providers>
    );
    expect(again.container.querySelector(".review-seen-mark")?.classList.contains("is-new")).toBe(false);
  });
});

describe("a review card's actions", () => {
  it("offers Not again, Pin and Edit, each naming the card by its time", () => {
    const onHide = vi.fn();
    const onTogglePin = vi.fn();
    const onEdit = vi.fn();
    render(
      <Providers>
        <ReviewActions live createdAt={localNoon(2025, 10, 19)} pinned busy={false} onHide={onHide} onTogglePin={onTogglePin} onEdit={onEdit} />
      </Providers>
    );
    fireEvent.click(screen.getByRole("button", { name: /^Not again: memo from / }));
    const pin = screen.getByRole("button", { name: /^Pin memo from / });
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pin);
    fireEvent.click(screen.getByRole("button", { name: /^Edit memo from / }));
    expect([onHide, onTogglePin, onEdit].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("draws the same row with nothing to press in the stage's twin", () => {
    const { container } = render(
      <Providers>
        <ReviewActions live={false} createdAt={localNoon(2025, 10, 19)} pinned={false} busy={false} onHide={vi.fn()} onTogglePin={vi.fn()} onEdit={vi.fn()} />
      </Providers>
    );
    expect(container.querySelector(".review-actions")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll(".review-action")).toHaveLength(3);
  });
});

describe("the day's masthead and its end", () => {
  it("shows how much of today's set is revisited, why it came back, and a filling hairline", () => {
    const view = render(
      <Providers>
        <ReviewBanner day="2026-10-19" seen={3} total={10} breakdown={{ onThisDay: 1, anniversary: 0, random: 9 }} />
      </Providers>
    );
    expect(view.container.querySelector(".sr-only")?.textContent).toBe("Oct 19 · 3 of 10 revisited");
    expect(view.container.querySelector(".review-banner-mix")?.textContent).toBe("On this day 1 · Random 9");
    const bar = screen.getByRole("progressbar", { name: "Revisited today" });
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax"), bar.getAttribute("aria-valuetext")]).toEqual(["3", "10", "3 of 10"]);
    expect((view.container.querySelector(".review-progress-fill") as HTMLElement).style.width).toBe("30%");

    view.rerender(
      <Providers>
        <ReviewBanner day="2026-10-19" seen={10} total={10} breakdown={{ onThisDay: 1, anniversary: 0, random: 9 }} />
      </Providers>
    );
    expect((view.container.querySelector(".review-progress-fill") as HTMLElement).style.width).toBe("100%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
  });

  it("reads the same in Chinese", () => {
    inChinese();
    const { container } = render(
      <Providers>
        <ReviewBanner day="2026-10-19" seen={3} total={10} breakdown={{ onThisDay: 2, anniversary: 3, random: 5 }} />
      </Providers>
    );
    expect(container.querySelector(".sr-only")?.textContent).toBe("10月19日 · 已回顾 3 / 10");
    expect(container.querySelector(".review-banner-mix")?.textContent).toBe("往年今天 2 · 周年 3 · 随机 5");
  });

  it("closes the day with the actual count, and no tally of days", () => {
    const view = render(
      <Providers>
        <ReviewFinish count={10} />
      </Providers>
    );
    expect(view.container.textContent).toBe("All ten revisited for todayA new set tomorrow");
    expect(view.container.querySelector(".review-finish-leaf")).not.toBeNull();
    cleanup();
    render(
      <Providers>
        <ReviewFinish count={14} />
      </Providers>
    );
    expect(screen.getByText("All 14 revisited for today")).toBeTruthy();
    cleanup();
    inChinese();
    render(
      <Providers>
        <ReviewFinish count={10} />
      </Providers>
    );
    expect(screen.getByText("今天的十条都回顾过了")).toBeTruthy();
    expect(screen.getByText("明天再抽新的一组")).toBeTruthy();
  });
});

describe("when a card counts as seen", () => {
  interface FakeObserver {
    callback: IntersectionObserverCallback;
    observed: Set<Element>;
  }
  let observers: FakeObserver[];
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    observers = [];
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly record: FakeObserver;
        constructor(callback: IntersectionObserverCallback) {
          this.record = { callback, observed: new Set() };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.observed.add(target);
        }
        unobserve(target: Element) {
          this.record.observed.delete(target);
        }
        disconnect() {
          this.record.observed.clear();
        }
        takeRecords() {
          return [];
        }
      }
    );
  });

  afterEach(() => {
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  function Feed({ ids, seen, onSeen }: { ids: string[]; seen: ReadonlySet<string>; onSeen: (id: string) => void }) {
    const feedRef = useRef<HTMLElement | null>(null);
    useReviewSeen(feedRef, ids, seen, onSeen);
    return (
      <section ref={feedRef}>
        <div className="review-banner" />
        {ids.map((id) => (
          <div key={id} className="memo-slot" data-vt={`memo-${id}`}>
            <article>
              <p>{id} text</p>
              <button type="button">⋯ {id}</button>
            </article>
          </div>
        ))}
      </section>
    );
  }

  function slot(id: string): Element {
    return document.querySelector(`[data-vt="memo-${id}"]`)!;
  }

  /** Report `id`'s slot to the observer as showing `ratio` of itself, `height` px of a 800px screen. */
  function show(id: string, ratio: number, height = 100) {
    const observer = observers[observers.length - 1];
    act(() => {
      observer.callback(
        [
          {
            target: slot(id),
            isIntersecting: ratio > 0,
            intersectionRatio: ratio,
            intersectionRect: { height } as DOMRectReadOnly,
            rootBounds: { height: 800 } as DOMRectReadOnly
          } as IntersectionObserverEntry
        ],
        observer as unknown as IntersectionObserver
      );
    });
  }

  it("needs 60% of the card on screen for 1.2s", () => {
    const onSeen = vi.fn();
    render(<Feed ids={["a", "b"]} seen={new Set()} onSeen={onSeen} />);
    expect([...observers[0].observed]).toEqual([slot("a"), slot("b")]);

    show("a", 0.5);
    act(() => vi.advanceTimersByTime(REVIEW_SEEN_MS * 2));
    expect(onSeen).not.toHaveBeenCalled();

    show("a", 0.7);
    act(() => vi.advanceTimersByTime(REVIEW_SEEN_MS - 100));
    show("a", 0.4);
    act(() => vi.advanceTimersByTime(REVIEW_SEEN_MS));
    expect(onSeen).not.toHaveBeenCalled();

    show("a", 0.7);
    show("b", 0.9);
    act(() => vi.advanceTimersByTime(REVIEW_SEEN_MS));
    expect(onSeen.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(observers[0].observed.size).toBe(0);
  });

  it("counts a card taller than the screen once it fills most of it", () => {
    const onSeen = vi.fn();
    render(<Feed ids={["tall"]} seen={new Set()} onSeen={onSeen} />);
    show("tall", 0.35, 700);
    act(() => vi.advanceTimersByTime(REVIEW_SEEN_MS));
    expect(onSeen).toHaveBeenCalledWith("tall");
  });

  it("stops the clock in a hidden tab and starts it over on return", () => {
    const onSeen = vi.fn();
    render(<Feed ids={["a"]} seen={new Set()} onSeen={onSeen} />);
    show("a", 1);
    act(() => vi.advanceTimersByTime(REVIEW_SEEN_MS - 200));
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(REVIEW_SEEN_MS * 3);
    });
    expect(onSeen).not.toHaveBeenCalled();
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(REVIEW_SEEN_MS - 200);
    });
    expect(onSeen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onSeen).toHaveBeenCalledWith("a");
  });

  it("counts opening a card's controls, or double-clicking it, at once", () => {
    const onSeen = vi.fn();
    render(<Feed ids={["a", "b"]} seen={new Set()} onSeen={onSeen} />);
    fireEvent.click(screen.getByText("a text"));
    expect(onSeen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "⋯ a" }));
    fireEvent.doubleClick(screen.getByText("b text"));
    expect(onSeen.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("leaves cards already seen, and watches nothing outside the review", () => {
    const onSeen = vi.fn();
    const view = render(<Feed ids={["a", "b"]} seen={new Set(["a"])} onSeen={onSeen} />);
    expect([...observers[0].observed]).toEqual([slot("b")]);
    fireEvent.click(screen.getByRole("button", { name: "⋯ a" }));
    expect(onSeen).not.toHaveBeenCalled();

    view.rerender(<Feed ids={[]} seen={new Set()} onSeen={onSeen} />);
    expect(observers[0].observed.size).toBe(0);
    expect(observers).toHaveLength(1);
  });
});
