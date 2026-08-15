// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  runModelSelfTest: vi.fn(async () => {}),
  runtime: {
    current: { stage: "idle", percent: 0 },
    listeners: new Set<() => void>()
  }
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
  getModelRuntimeProgress: () => mocks.runtime.current,
  resetModelRuntime: mocks.resetModelRuntime,
  runModelSelfTest: mocks.runModelSelfTest,
  subscribeModelRuntimeProgress: (listener: () => void) => {
    mocks.runtime.listeners.add(listener);
    return () => mocks.runtime.listeners.delete(listener);
  }
}));

vi.mock("../src/lib/semanticIndex", () => ({
  deleteSemanticIndexDb: mocks.deleteSemanticIndexDb
}));

import { ModelSettingsModal } from "../src/components/ModelSettingsModal";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEmbedder.mockResolvedValue(async () => []);
  mocks.runModelSelfTest.mockResolvedValue(undefined);
  mocks.runtime.current = { stage: "idle", percent: 0 };
  mocks.runtime.listeners.clear();
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
  // jsdom has no canvas backend; the orb only needs the calls it makes.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn()
  } as unknown as CanvasRenderingContext2D);
  // Present but never firing: the orb paints its first frame and parks,
  // instead of running an unbounded rAF loop through the suite.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("shows real model-loading progress while the runtime starts", async () => {
    mocks.getEmbedder.mockImplementationOnce(() => new Promise(() => {}));
    render(
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} />
      </LanguageProvider>
    );

    expect(await screen.findByText("Loading Model")).toBeTruthy();
    act(() => {
      mocks.runtime.current = { stage: "loading-files", percent: 45 };
      for (const listener of mocks.runtime.listeners) listener();
    });

    const progress = screen.getByRole("progressbar", { name: "Model Loading Progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByText("Reading verified model files from device storage.")).toBeTruthy();
  });

  it("shows indexing and live query-ranking progress in the same panel", async () => {
    render(
      <LanguageProvider>
        <ModelSettingsModal
          onClose={vi.fn()}
          onModelCleared={vi.fn()}
          semanticStatus="indexing"
          semanticProgress={{ done: 3, total: 10 }}
          semanticQueryProgress={{ stage: "ranking", done: 25, total: 100 }}
        />
      </LanguageProvider>
    );

    expect(await screen.findByText("Building Search Index")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Semantic Index Progress" }).getAttribute("aria-valuenow")).toBe("30");
    expect(screen.getByRole("progressbar", { name: "Semantic Search Progress" }).getAttribute("aria-valuenow")).toBe("63");
    expect(screen.getByText("3 / 10 Memos")).toBeTruthy();
    expect(screen.getByText("25 / 100 Rows")).toBeTruthy();
  });

  it("marks loading with the working orb, index building with solving, and rest with neither", async () => {
    const orb = () => document.querySelector("canvas.thinking-orb");
    const panel = (status: "preparing" | "indexing" | "ready") => (
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} semanticStatus={status} />
      </LanguageProvider>
    );
    const { rerender } = render(panel("preparing"));

    expect(await screen.findByText("Preparing Semantic Search")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("working");
    // Decorative: the state is already announced by the live status copy.
    expect(orb()?.getAttribute("aria-hidden")).toBe("true");

    rerender(panel("indexing"));
    expect(await screen.findByText("Building Search Index")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("solving");

    rerender(panel("ready"));
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(orb()).toBeNull();
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
