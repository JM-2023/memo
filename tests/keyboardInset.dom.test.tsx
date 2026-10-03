// @vitest-environment jsdom

// Dialogs with a text field keep clear of an on-screen keyboard: the overlay
// carries how much of the layout viewport the keyboard covers (--kb-inset),
// which its bottom padding rises by on a phone's bottom sheet.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptDialog } from "../src/components/PromptDialog";
import { LanguageProvider } from "../src/lib/i18n";

type Listener = () => void;

function fakeViewport(height: number) {
  const listeners = new Map<string, Set<Listener>>();
  const viewport = {
    height,
    offsetTop: 0,
    scale: 1,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    fire: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

function renderPrompt() {
  return render(
    <LanguageProvider>
      <PromptDialog
        title="Rename tag"
        initialValue="work"
        confirmLabel="Rename"
        validate={() => null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    </LanguageProvider>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("keyboard inset", () => {
  it("publishes how much the keyboard covers, and follows it", () => {
    const viewport = fakeViewport(800);
    renderPrompt();
    const overlay = screen.getByRole("dialog");
    expect(overlay.style.getPropertyValue("--kb-inset")).toBe("0px");

    viewport.height = 460;
    act(() => viewport.fire("resize"));
    expect(overlay.style.getPropertyValue("--kb-inset")).toBe("340px");

    // iOS scrolls the visual viewport up under the keyboard as well.
    viewport.offsetTop = 40;
    act(() => viewport.fire("scroll"));
    expect(overlay.style.getPropertyValue("--kb-inset")).toBe("300px");
  });

  it("reads a pinch-zoomed viewport as no keyboard", () => {
    const viewport = fakeViewport(400);
    viewport.scale = 2;
    renderPrompt();
    expect(screen.getByRole("dialog").style.getPropertyValue("--kb-inset")).toBe("0px");
  });

  it("keeps the dialog fields at 16px on touch screens, so focusing one never zooms", () => {
    // iOS zooms into a field under 16px on focus. The inset reads a zoomed
    // page as a pinch (above) and would publish 0 just as the keyboard
    // opens, leaving the sheet's actions under it — so the fields that open
    // the keyboard over a sheet must never trigger that zoom.
    const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([^@]*?)\n\}/g)].map((match) => match[1]).join("\n");
    const sized = [...coarse.matchAll(/([^{}]+)\{\s*font-size:\s*max\(16px,[^}]*\}/g)].flatMap((match) =>
      match[1].split(",").map((selector) => selector.trim())
    );
    expect(sized).toEqual(expect.arrayContaining([".prompt-input", ".bulk-tag-field input"]));
  });

  it("stops listening once the dialog closes", () => {
    const viewport = fakeViewport(800);
    const view = renderPrompt();
    expect(viewport.listenerCount()).toBe(2);
    view.unmount();
    expect(viewport.listenerCount()).toBe(0);
  });
});
