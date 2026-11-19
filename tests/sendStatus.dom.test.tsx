// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendStatus, SendStatusActions, sendStatusLabel, sendStatusTone, useSendHold, type SendStatusKind } from "../src/components/SendStatus";
import { LanguageProvider } from "../src/lib/i18n";
import { BUSY_HOLD_MS, EXIT_MS } from "../src/lib/motion";
import type { SendState } from "../src/lib/outbox";

let reducedMotion = false;

function CardHeaderHarness({
  state,
  recallBlocked,
  onTakeBack = vi.fn(),
  onRetrySend = vi.fn(),
  onDiscardUnsent = vi.fn()
}: {
  state: SendState | undefined;
  recallBlocked?: boolean;
  onTakeBack?: () => void;
  onRetrySend?: () => void;
  onDiscardUnsent?: () => void;
}) {
  const { holding, settling } = useSendHold(state);
  const time = <time className={`memo-time${settling ? " is-arriving" : ""}`}>12:00</time>;
  return (
    <div data-holding={String(holding)} data-settling={String(settling)}>
      <SendStatus surface="card" state={state} holding={holding} id="stamp-1" settled={time} />
      <div className="memo-head-right">
        <SendStatusActions
          state={state}
          holding={holding}
          recallBlocked={recallBlocked}
          onTakeBack={onTakeBack}
          onRetrySend={onRetrySend}
          onDiscardUnsent={onDiscardUnsent}
        />
      </div>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  reducedMotion = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
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

describe("shared <SendStatus> and <SendStatusActions>", () => {
  it("keeps Take back unclickable, unfocusable and inert during the 150ms hold, and reveals it cleanly after", () => {
    vi.useFakeTimers();
    const onTakeBack = vi.fn();
    const { container } = render(
      <LanguageProvider>
        <CardHeaderHarness state="sending" onTakeBack={onTakeBack} />
      </LanguageProvider>
    );

    // Inside the 150ms hold: hidden, inert, disabled, tabIndex -1, and clicks never fire onTakeBack.
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();
    const holdingGroup = container.querySelector<HTMLElement>(".memo-send-actions.is-holding");
    expect(holdingGroup).not.toBeNull();
    expect(holdingGroup?.getAttribute("aria-hidden")).toBe("true");
    expect(holdingGroup?.inert).toBe(true);
    const hiddenButton = holdingGroup?.querySelector<HTMLButtonElement>("button");
    expect(hiddenButton?.disabled).toBe(true);
    expect(hiddenButton?.tabIndex).toBe(-1);
    if (hiddenButton) fireEvent.click(hiddenButton);
    expect(onTakeBack).not.toHaveBeenCalled();

    const holdingLabel = container.querySelector<HTMLElement>(".memo-send-state.is-sending.is-holding");
    expect(holdingLabel?.id).toBe("stamp-1");

    act(() => {
      vi.advanceTimersByTime(BUSY_HOLD_MS - 1);
    });
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const liveButton = screen.getByRole("button", { name: "Take back" }) as HTMLButtonElement;
    expect(liveButton.disabled).toBe(false);
    expect(liveButton.closest(".memo-send-actions")?.classList.contains("is-entering")).toBe(true);
    fireEvent.click(liveButton);
    expect(onTakeBack).toHaveBeenCalledTimes(1);
  });

  it("crossfades both label and buttons out on slow completion (inert while leaving), and leaves no ghost on fast completion", () => {
    vi.useFakeTimers();
    const onTakeBack = vi.fn();
    const { container, rerender } = render(
      <LanguageProvider>
        <CardHeaderHarness state="sending" onTakeBack={onTakeBack} />
      </LanguageProvider>
    );

    // Fast send settles inside the 150ms hold: straight to <time>, no leaving ghost.
    act(() => {
      vi.advanceTimersByTime(BUSY_HOLD_MS - 30);
    });
    rerender(
      <LanguageProvider>
        <CardHeaderHarness state={undefined} onTakeBack={onTakeBack} />
      </LanguageProvider>
    );
    expect(container.querySelector("time")?.textContent).toBe("12:00");
    expect(container.querySelector(".is-leaving")).toBeNull();

    // Slow send reveals after 150ms, then settles: both label and action buttons crossfade out.
    rerender(
      <LanguageProvider>
        <CardHeaderHarness state="sending" onTakeBack={onTakeBack} />
      </LanguageProvider>
    );
    act(() => {
      vi.advanceTimersByTime(BUSY_HOLD_MS);
    });
    expect(screen.getByRole("button", { name: "Take back" })).toBeTruthy();

    rerender(
      <LanguageProvider>
        <CardHeaderHarness state={undefined} onTakeBack={onTakeBack} />
      </LanguageProvider>
    );
    expect(container.querySelector(".memo-send-state.is-leaving")).not.toBeNull();
    const leavingActions = container.querySelector<HTMLElement>(".memo-send-actions.is-leaving");
    expect(leavingActions).not.toBeNull();
    expect(leavingActions?.inert).toBe(true);
    expect(leavingActions?.getAttribute("aria-hidden")).toBe("true");
    const leavingBtn = leavingActions?.querySelector<HTMLButtonElement>("button");
    expect(leavingBtn?.disabled).toBe(true);
    expect(leavingBtn?.tabIndex).toBe(-1);
    if (leavingBtn) fireEvent.click(leavingBtn);
    expect(onTakeBack).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(container.querySelector(".is-leaving")).toBeNull();
  });

  it("uses red styling only for refused sends, keeps offline and retrying calm gray, and keeps action buttons mounted across state changes", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <LanguageProvider>
        <CardHeaderHarness state="failed" />
      </LanguageProvider>
    );

    const retryBefore = screen.getByRole("button", { name: "Retry" });
    const editBefore = screen.getByRole("button", { name: "Edit" });
    const discardBefore = screen.getByRole("button", { name: "Discard" });
    expect(container.querySelector(".memo-send-state.is-failed")).not.toBeNull();
    expect(container.querySelector(".memo-send-dot")).toBeNull();

    // Offline -> auto-retrying: label crossfades, no red dot, exact same buttons stay still.
    rerender(
      <LanguageProvider>
        <CardHeaderHarness state="retrying" />
      </LanguageProvider>
    );
    expect(container.querySelector(".memo-send-state.is-retrying")).not.toBeNull();
    expect(container.querySelector(".memo-send-dot")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retryBefore);
    expect(screen.getByRole("button", { name: "Edit" })).toBe(editBefore);
    expect(screen.getByRole("button", { name: "Discard" })).toBe(discardBefore);
    expect(container.querySelector(".memo-send-actions.is-leaving")).toBeNull();

    // Retrying -> server refused: gets red dot and is-refused class; buttons still stay mounted.
    rerender(
      <LanguageProvider>
        <CardHeaderHarness state="refused" />
      </LanguageProvider>
    );
    expect(container.querySelector(".memo-send-state.is-refused")).not.toBeNull();
    expect(container.querySelector(".memo-send-dot")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retryBefore);
    expect(screen.getByRole("button", { name: "Discard" })).toBe(discardBefore);

    // Manual Retry ("refused" -> "sending"): failed buttons crossfade out inert; Take back holds 150ms inert.
    rerender(
      <LanguageProvider>
        <CardHeaderHarness state="sending" />
      </LanguageProvider>
    );
    expect(container.querySelector(".memo-send-actions.is-leaving")).not.toBeNull();
    expect(container.querySelector(".memo-send-actions.is-holding")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();
  });

  it("renders unified EN and ZH verb sets across card and toast surfaces, with error tone only for refused", () => {
    const en = (e: string) => e;
    const zh = (_e: string, c: string) => c;
    const kinds: SendStatusKind[] = ["sending", "retrying", "failed", "refused", "sent"];
    expect(kinds.map((k) => sendStatusLabel(k, en, "card"))).toEqual([
      "Sending…",
      "Not sent · retrying",
      "Not sent · will retry when you’re online",
      "Not sent · the server refused it",
      "Sent"
    ]);
    expect(kinds.map((k) => sendStatusLabel(k, en, "toast"))).toEqual([
      "Sending… — this view hides it",
      "Not sent · retrying — this view hides it",
      "Not sent · will retry when you’re online — this view hides it",
      "Not sent · the server refused it — this view hides it",
      "Sent — this view hides it"
    ]);
    expect(kinds.map((k) => sendStatusLabel(k, zh, "card"))).toEqual([
      "发送中…",
      "未发送 · 正在重试",
      "未发送 · 联网后会自动补发",
      "未发送 · 服务器未接受",
      "已发送"
    ]);
    expect(kinds.map((k) => sendStatusLabel(k, zh, "toast"))).toEqual([
      "发送中…，当前视图下看不到它",
      "未发送 · 正在重试，当前视图下看不到它",
      "未发送 · 联网后会自动补发，当前视图下看不到它",
      "未发送 · 服务器未接受，当前视图下看不到它",
      "已发送，当前视图下看不到它"
    ]);
    expect(kinds.map(sendStatusTone)).toEqual(["info", "info", "info", "error", "info"]);
  });

  it("crossfades and tweens toast width on state change, dissolving without width tween under reduced motion", () => {
    vi.useFakeTimers();
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      const liveText = el.querySelector(".send-status-face:not(.is-leaving)")?.textContent ?? el.textContent ?? "";
      const width = liveText.includes("refused") ? 260 : liveText.includes("Sending") ? 220 : 180;
      return { width: `${width}px`, height: "20px" } as unknown as CSSStyleDeclaration;
    });

    const { container, rerender } = render(
      <LanguageProvider>
        <SendStatus surface="toast" state="sending" />
      </LanguageProvider>
    );
    expect(container.querySelector(".toast-mark")).toBeNull();
    expect(screen.getByText("Sending… — this view hides it")).toBeTruthy();

    rerender(
      <LanguageProvider>
        <SendStatus surface="toast" state="sent" />
      </LanguageProvider>
    );
    expect(screen.getByText("Sent — this view hides it")).toBeTruthy();
    expect(container.querySelector(".send-status-face.is-toast.is-leaving")).not.toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith([{ width: "220px" }, { width: "180px" }], expect.objectContaining({ duration: 220 }));

    // Under reduced motion, transitions crossfade without a width tween.
    animate.mockClear();
    reducedMotion = true;
    rerender(
      <LanguageProvider>
        <SendStatus surface="toast" state="refused" />
      </LanguageProvider>
    );
    expect(container.querySelector(".toast-mark")).not.toBeNull();
    expect(animate).not.toHaveBeenCalled();

    delete (Element.prototype as Partial<Element>).animate;
  });
});
