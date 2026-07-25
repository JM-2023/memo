// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/components/Editor";
import { Heatmap } from "../src/components/Heatmap";
import { PasscodePad } from "../src/components/PasscodePad";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";

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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Editor accessibility and composition", () => {
  it("connects the tag combobox to its listbox and leaves IME keys untouched", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={["alpha", "beta"]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );

    const editor = screen.getByRole("combobox", { name: "Memo content" });
    await user.type(editor, "#");

    const listbox = screen.getByRole("listbox", { name: "Tag suggestions" });
    const options = screen.getAllByRole("option");
    expect(editor.getAttribute("aria-expanded")).toBe("true");
    expect(editor.getAttribute("aria-controls")).toBe(listbox.id);
    expect(editor.getAttribute("aria-activedescendant")).toBe(options[0].id);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[0].tabIndex).toBe(-1);

    await user.keyboard("{ArrowDown}");
    expect(editor.getAttribute("aria-activedescendant")).toBe(options[1].id);
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    const composingArrowWasNotPrevented = fireEvent.keyDown(editor, {
      key: "ArrowUp",
      code: "ArrowUp",
      isComposing: true
    });
    expect(composingArrowWasNotPrevented).toBe(true);
    expect(editor.getAttribute("aria-activedescendant")).toBe(options[1].id);

    const imeEnterWasNotPrevented = fireEvent.keyDown(editor, {
      key: "Enter",
      code: "Enter",
      keyCode: 229
    });
    expect(imeEnterWasNotPrevented).toBe(true);
    expect((editor as HTMLTextAreaElement).value).toBe("#");
    expect(screen.getByRole("listbox", { name: "Tag suggestions" })).toBe(listbox);
  });

  it("announces a save failure", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor
          mode="create"
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => {
            throw new Error("Save failed");
          })}
        />
      </Providers>
    );

    await user.type(screen.getByRole("combobox", { name: "Memo content" }), "draft");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Save failed");
  });

  it("counts an inherited context tag before allowing a near-limit create", () => {
    render(
      <Providers>
        <Editor mode="create" contextTag="work" knownTags={["work"]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );

    const editor = screen.getByRole("combobox", { name: "Memo content" });
    const inherited = screen.getByLabelText("Inherited tag: work");
    expect(editor.getAttribute("aria-describedby")).toBe(inherited.id);

    // "\n#work" adds six characters to the trimmed payload.
    fireEvent.change(editor, { target: { value: "x".repeat(39_994), selectionStart: 39_994 } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(editor, { target: { value: "x".repeat(39_995), selectionStart: 39_995 } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("40,001 / 40,000").className).toContain("is-over");
  });
});

describe("Heatmap day state", () => {
  it("moves the current month forward when local midnight passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 23, 59, 59, 900));

    render(
      <Providers>
        <Heatmap countsByDay={new Map()} minDay="2026-01-01" activeDay={null} period="month" onPickDay={vi.fn()} />
      </Providers>
    );

    expect(screen.getByRole("button", { name: /July 2026/ })).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("button", { name: /August 2026/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /July 2026/ })).toBeNull();
  });

  it("exposes the selected day as a pressed toggle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12));

    render(
      <Providers>
        <Heatmap
          countsByDay={new Map([["2026-07-16", 3]])}
          minDay="2026-01-01"
          activeDay="2026-07-16"
          period="month"
          onPickDay={vi.fn()}
        />
      </Providers>
    );

    expect(screen.getByRole("button", { name: "Jul 16, 3 memos" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Jul 17, 0 memos" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("PasscodePad keyboard and status behavior", () => {
  it("submits once when Enter natively activates the focused confirm button", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(
      <LanguageProvider>
        <PasscodePad icon={null} title="Unlock" subtitle="Enter passcode" onComplete={onComplete} />
      </LanguageProvider>
    );

    await user.keyboard("1234");
    const confirm = screen.getByRole("button", { name: "Confirm" });
    confirm.focus();
    await user.keyboard("{Enter}");

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("1234");
  });

  it("announces a dynamic passcode error", () => {
    const onComplete = vi.fn();
    const view = render(
      <LanguageProvider>
        <PasscodePad icon={null} title="Unlock" subtitle="Enter passcode" onComplete={onComplete} />
      </LanguageProvider>
    );
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");

    view.rerender(
      <LanguageProvider>
        <PasscodePad icon={null} title="Unlock" subtitle="Incorrect passcode" error onComplete={onComplete} />
      </LanguageProvider>
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Incorrect passcode");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
  });
});
