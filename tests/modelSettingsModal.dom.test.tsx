// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/i18n";
import { MODEL_MANIFEST } from "../src/lib/modelManifest";

const mocks = vi.hoisted(() => ({
  present: new Set<string>(),
  clearModelFiles: vi.fn(async () => {}),
  deleteSemanticIndexDb: vi.fn(async () => {}),
  resetModelRuntime: vi.fn(async () => {}),
  getEmbedder: vi.fn(async () => async () => []),
  runModelSelfTest: vi.fn(async () => {})
}));

vi.mock("../src/lib/modelLoader", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/modelLoader")>();
  return {
    ...original,
    clearModelFiles: mocks.clearModelFiles,
    presentModelFiles: vi.fn(async () => new Set(mocks.present)),
    storedModelState: vi.fn(async () => "complete")
  };
});

vi.mock("../src/lib/modelRuntime", () => ({
  getEmbedder: mocks.getEmbedder,
  resetModelRuntime: mocks.resetModelRuntime,
  runModelSelfTest: mocks.runModelSelfTest
}));

vi.mock("../src/lib/semanticIndex", () => ({
  deleteSemanticIndexDb: mocks.deleteSemanticIndexDb
}));

import { ModelSettingsModal } from "../src/components/ModelSettingsModal";

beforeEach(() => {
  mocks.present = new Set(MODEL_MANIFEST.files.map((file) => file.requestPath));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") && false,
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("semantic search settings", () => {
  it("uses scan-friendly Title Case labels and exposes model storage state", async () => {
    render(
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} />
      </LanguageProvider>
    );

    expect(screen.getByRole("dialog", { name: "Semantic Search" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Semantic Search" })).toBeTruthy();
    expect(screen.getByText("52 Languages")).toBeTruthy();
    expect(screen.getByText("384 Dimensions")).toBeTruthy();
    expect(screen.getByText("Device Storage")).toBeTruthy();
    expect(await screen.findByText("Ready")).toBeTruthy();
  });

  it("reports readiness once so an interrupted first Brain toggle can continue", async () => {
    const onModelReady = vi.fn();
    render(
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} onModelReady={onModelReady} />
      </LanguageProvider>
    );

    expect(await screen.findByText("Ready")).toBeTruthy();
    await waitFor(() => expect(onModelReady).toHaveBeenCalledOnce());
  });

  it("confirms a standalone clear, disables semantic search, and clears both stores and runtime", async () => {
    const user = userEvent.setup();
    const onModelCleared = vi.fn();
    render(
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={onModelCleared} />
      </LanguageProvider>
    );
    expect(await screen.findByText("Ready")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear Model" }));
    const confirmation = screen.getByRole("group", { name: "Confirm Clear Model" });
    expect(within(confirmation).getByText("Clear Model From This Device?")).toBeTruthy();
    await user.click(within(confirmation).getByRole("button", { name: "Clear Model" }));

    await waitFor(() => expect(screen.getByText("Not Downloaded")).toBeTruthy());
    expect(onModelCleared).toHaveBeenCalledOnce();
    expect(mocks.resetModelRuntime).toHaveBeenCalledOnce();
    expect(mocks.clearModelFiles).toHaveBeenCalledOnce();
    expect(mocks.deleteSemanticIndexDb).toHaveBeenCalledOnce();
    expect(screen.getByText("Model and semantic index cleared from this device.")).toBeTruthy();
  });
});
