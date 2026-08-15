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
  EMBED_BATCH_TEXTS: 8,
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
  // jsdom has no canvas backend; the orb only needs the calls it makes
  // (dots for every mark, moveTo/lineTo/stroke for connecting's web).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn()
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
  it("names the panel, states the device facts, and lands on Ready", async () => {
    render(
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} />
      </LanguageProvider>
    );

    expect(screen.getByRole("dialog", { name: "Semantic Search" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Semantic Search" })).toBeTruthy();
    expect(screen.getByText("On this device")).toBeTruthy();
    expect(screen.getByText("52 languages · 384 dimensions")).toBeTruthy();
    expect(screen.getByText("Device storage")).toBeTruthy();
    expect(screen.getByText(MODEL_MANIFEST.version)).toBeTruthy();
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText("Verified on this device and available offline.")).toBeTruthy();
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

    expect(await screen.findByText("Loading model")).toBeTruthy();
    act(() => {
      mocks.runtime.current = { stage: "loading-files", percent: 45 };
      for (const listener of mocks.runtime.listeners) listener();
    });

    const progress = screen.getByRole("progressbar", { name: "Model loading" });
    expect(progress.getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByText("Reading verified files from storage.")).toBeTruthy();
  });

  it("keeps one true progress surface: indexing outranks a queued query", async () => {
    render(
      <LanguageProvider>
        <ModelSettingsModal
          onClose={vi.fn()}
          onModelCleared={vi.fn()}
          semanticStatus="indexing"
          semanticProgress={{ done: 3, total: 10, doneChunks: 16, totalChunks: 60 }}
          semanticQueryProgress={{ stage: "ranking", done: 25, total: 100 }}
        />
      </LanguageProvider>
    );

    expect(await screen.findByText("Building index")).toBeTruthy();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-label")).toBe("Semantic index");
    expect(bars[0].getAttribute("aria-valuenow")).toBe("30");
    expect(bars[0].getAttribute("aria-valuetext")).toBe("3 / 10");
    expect(screen.getByText("Batch 3 of 8 · length-grouped, yielded between slices")).toBeTruthy();
  });

  it("ranks the current view with live figures once the index is ready", async () => {
    render(
      <LanguageProvider>
        <ModelSettingsModal
          onClose={vi.fn()}
          onModelCleared={vi.fn()}
          semanticStatus="ready"
          semanticQuery="fruit"
          semanticQueryProgress={{ stage: "ranking", done: 25, total: 100 }}
        />
      </LanguageProvider>
    );

    expect(await screen.findByText("Searching this view")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Ranking current view" });
    expect(bar.getAttribute("aria-valuenow")).toBe("63");
    expect(bar.getAttribute("aria-valuetext")).toBe("25 / 100");
    expect(screen.getByText("Keyword hits keep their place; related memos are added below.")).toBeTruthy();
  });

  it("quotes the live query while it is being embedded on this device", async () => {
    render(
      <LanguageProvider>
        <ModelSettingsModal
          onClose={vi.fn()}
          onModelCleared={vi.fn()}
          semanticStatus="ready"
          semanticQuery="fruit"
          semanticQueryProgress={{ stage: "embedding", done: 0, total: 1 }}
        />
      </LanguageProvider>
    );

    expect(await screen.findByText("Understanding query")).toBeTruthy();
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.getByText("Embedding “fruit” on this device.")).toBeTruthy();
  });

  it("wears the lifecycle's orb marks — working, solving, connecting at rest", async () => {
    const orb = () => document.querySelector("canvas.thinking-orb");
    const panel = (status: "preparing" | "indexing" | "ready") => (
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} semanticStatus={status} />
      </LanguageProvider>
    );
    const { rerender } = render(panel("preparing"));

    expect(await screen.findByText("Loading model")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("working");
    // Decorative: the state is already announced by the live status copy.
    expect(orb()?.getAttribute("aria-hidden")).toBe("true");

    rerender(panel("indexing"));
    expect(await screen.findByText("Building index")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("solving");

    rerender(panel("ready"));
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("connecting");
  });

  it("expands the stage ledger under the one progress bar", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <ModelSettingsModal
          onClose={vi.fn()}
          onModelCleared={vi.fn()}
          semanticStatus="indexing"
          semanticProgress={{ done: 3, total: 10, doneChunks: 16, totalChunks: 60 }}
        />
      </LanguageProvider>
    );

    expect(await screen.findByText("Building index")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Stages" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Memos embedded")).toBeTruthy();
    expect(screen.getByText("Sealed with the device key")).toBeTruthy();
  });

  it("shows semantic failures and offers a direct retry", async () => {
    const user = userEvent.setup();
    const onSemanticRetry = vi.fn();
    render(
      <LanguageProvider>
        <ModelSettingsModal
          onClose={vi.fn()}
          onModelCleared={vi.fn()}
          onSemanticRetry={onSemanticRetry}
          semanticStatus="error"
          semanticError="Index storage failed"
        />
      </LanguageProvider>
    );

    expect(await screen.findByText("Semantic search stopped")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.getByText("Semantic search hit an error. Index storage failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry semantic search" }));
    expect(onSemanticRetry).toHaveBeenCalledOnce();
  });

  it("confirms a clear from Advanced, disables semantic search, and clears stores and runtime", async () => {
    const user = userEvent.setup();
    const onModelCleared = vi.fn();
    render(
      <LanguageProvider>
        <ModelSettingsModal onClose={vi.fn()} onModelCleared={onModelCleared} />
      </LanguageProvider>
    );
    expect(await screen.findByText("Ready")).toBeTruthy();

    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    await user.click(advanced);
    expect(advanced.getAttribute("aria-expanded")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Clear model" }));
    const confirmation = screen.getByRole("group", { name: "Confirm clearing the model" });
    expect(within(confirmation).getByText("Clear model from this device?")).toBeTruthy();
    await user.click(within(confirmation).getByRole("button", { name: "Clear model" }));

    await waitFor(() => expect(screen.getByText("Model not downloaded")).toBeTruthy());
    expect(onModelCleared).toHaveBeenCalledOnce();
    expect(mocks.resetModelRuntime).toHaveBeenCalledOnce();
    expect(mocks.clearModelFiles).toHaveBeenCalledOnce();
    expect(mocks.deleteSemanticIndexDb).toHaveBeenCalledOnce();
    expect(screen.getByText("Model and semantic index cleared from this device.")).toBeTruthy();
  });
});
