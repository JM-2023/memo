// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Lightbox } from "../src/components/Lightbox";
import { Menu } from "../src/components/Menu";
import { PromptDialog } from "../src/components/PromptDialog";
import { LanguageProvider } from "../src/lib/i18n";

function renderLocalized(node: ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

function MenuFixture() {
  return (
    <>
      <Menu
        trigger={(open) => (
          <button type="button" aria-haspopup="menu" aria-expanded={open}>
            Actions
          </button>
        )}
      >
        {(close) => (
          <>
            <button type="button" role="menuitem" onClick={close}>
              First
            </button>
            <button type="button" role="menuitem" onClick={close}>
              Second
            </button>
            <button type="button" role="menuitem" onClick={close}>
              Third
            </button>
          </>
        )}
      </Menu>
      <button type="button">After actions</button>
    </>
  );
}

function ConfirmFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open confirmation
      </button>
      {open ? (
        <ConfirmDialog
          title="Remove?"
          body="Remove this item"
          confirmLabel="Remove"
          onCancel={() => setOpen(false)}
          onConfirm={() => undefined}
        />
      ) : null}
    </>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
});

afterEach(() => cleanup());

describe("keyboard-accessible menus", () => {
  it("moves through items with arrows, Home and End, then restores trigger focus on Escape", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items[2]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items[2]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("moves Tab to the next page control before the closing panel unmounts", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.keyboard("{Tab}");

    const after = screen.getByRole("button", { name: "After actions" });
    expect(document.activeElement).toBe(after);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(after);
  });
});

describe("busy dialogs", () => {
  it("keeps a busy confirmation open on Escape and backdrop clicks", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderLocalized(
      <ConfirmDialog title="Import?" body="Import data" confirmLabel="Import" busy onCancel={onCancel} onConfirm={vi.fn()} />
    );

    const dialog = screen.getByRole("dialog", { name: "Import?" });
    await user.keyboard("{Escape}");
    await user.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("keeps a busy prompt open on Escape and backdrop clicks", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderLocalized(
      <PromptDialog
        title="Rename"
        initialValue="work"
        confirmLabel="Rename"
        busy
        validate={() => null}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Rename" });
    await user.keyboard("{Escape}");
    await user.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.body.contains(dialog)).toBe(true);
  });
});

describe("modal focus management", () => {
  it("traps focus, locks the page and restores the opener", async () => {
    const user = userEvent.setup();
    renderLocalized(<ConfirmFixture />);
    const opener = screen.getByRole("button", { name: "Open confirmation" });

    await user.click(opener);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Remove" });
    expect(document.activeElement).toBe(cancel);
    expect(document.body.style.overflow).toBe("hidden");
    expect(opener.inert).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove?" })).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
    expect(opener.inert).toBe(false);
  });

  it("announces the current lightbox image and total while paging", async () => {
    const user = userEvent.setup();
    renderLocalized(
      <Lightbox items={[{ src: "/first.png" }, { src: "/second.png" }]} index={0} onClose={vi.fn()} />
    );

    expect(screen.getByRole("img", { name: "Image 1 of 2" })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("1 / 2");

    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img", { name: "Image 2 of 2" })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("2 / 2");
  });
});
