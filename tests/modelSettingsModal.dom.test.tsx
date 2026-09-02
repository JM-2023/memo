// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/i18n";
import type { ModelLoaderOptions, ModelProgress } from "../src/lib/modelLoader";
import { MODEL_MANIFEST, modelTotalBytes } from "../src/lib/modelManifest";
import type { SemanticIndexProgress } from "../src/lib/semanticIndex";

const mocks = vi.hoisted(() => ({
  present: new Set<string>(),
  clearModelFiles: vi.fn(async () => {}),
  ensureModelFiles: vi.fn(async (_onProgress?: (progress: ModelProgress) => void, _options?: ModelLoaderOptions) => {}),
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
    ensureModelFiles: mocks.ensureModelFiles,
    presentModelFiles: vi.fn(async () => new Set(mocks.present)),
    storedModelState: vi.fn(async () => {
      const count = MODEL_MANIFEST.files.filter((file) => mocks.present.has(file.requestPath)).length;
      return count === MODEL_MANIFEST.files.length ? "complete" : count > 0 ? "partial" : "none";
    })
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
import { resetModelDownload } from "../src/lib/modelDownload";
import { ModelUnavailableError } from "../src/lib/modelLoader";

const TOTAL_BYTES = modelTotalBytes();

function panel(props: Partial<React.ComponentProps<typeof ModelSettingsModal>> = {}) {
  return (
    <LanguageProvider>
      <ModelSettingsModal onClose={vi.fn()} onModelCleared={vi.fn()} {...props} />
    </LanguageProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelDownload();
  mocks.getEmbedder.mockResolvedValue(async () => []);
  mocks.runModelSelfTest.mockResolvedValue(undefined);
  mocks.ensureModelFiles.mockReset();
  mocks.ensureModelFiles.mockImplementation(async () => {});
  mocks.clearModelFiles.mockImplementation(async () => {
    mocks.present = new Set();
  });
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
  resetModelDownload();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("semantic search settings", () => {
  it("names the panel, states the device facts, and lands on Ready", async () => {
    render(panel());

    expect(screen.getByRole("dialog", { name: "Semantic Search" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Semantic Search" })).toBeTruthy();
    // The header is the title alone, like the other dialogs: no icon tile.
    expect(document.querySelector(".model-panel-head")?.children).toHaveLength(2);
    expect(document.querySelector(".model-panel-logo")).toBeNull();
    expect(screen.getByText("On this device")).toBeTruthy();
    expect(screen.getByText("Understands 52 languages")).toBeTruthy();
    // The engineering facts wait in Advanced, out of the main line.
    expect(screen.getByText("384 dimensions · 8-bit quantized")).toBeTruthy();
    expect(screen.getByText("Device storage")).toBeTruthy();
    expect(screen.getByText(MODEL_MANIFEST.version)).toBeTruthy();
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText("Verified on this device and available offline.")).toBeTruthy();
    expect(mocks.ensureModelFiles).not.toHaveBeenCalled();
  });

  it("reports readiness once so an interrupted first Brain toggle can continue", async () => {
    const onModelReady = vi.fn();
    render(panel({ onModelReady }));

    expect(await screen.findByText("Ready")).toBeTruthy();
    await waitFor(() => expect(onModelReady).toHaveBeenCalledOnce());
  });

  it("shows real model-loading progress while the runtime starts", async () => {
    mocks.getEmbedder.mockImplementationOnce(() => new Promise(() => {}));
    render(panel());

    expect(await screen.findByText("Starting up")).toBeTruthy();
    expect(screen.getByText("Almost ready.")).toBeTruthy();
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
      panel({
        semanticStatus: "indexing",
        semanticProgress: { done: 3, total: 10, doneChunks: 16, totalChunks: 60 },
        semanticQueryProgress: { stage: "ranking", done: 25, total: 100 }
      })
    );

    expect(await screen.findByText("Indexing your memos")).toBeTruthy();
    expect(screen.getByText("3 of 10 memos · keyword search keeps working.")).toBeTruthy();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-label")).toBe("Semantic index");
    expect(bars[0].getAttribute("aria-valuenow")).toBe("30");
    expect(bars[0].getAttribute("aria-valuetext")).toBe("3 / 10");
    // Batches are ledger detail now, not the line under the bar.
    expect(screen.getByText("Runs in the background. Close this panel whenever you like.")).toBeTruthy();
    expect(screen.queryByText(/length-grouped/)).toBeNull();
  });

  it("ranks the current view with live figures once the index is ready", async () => {
    render(
      panel({
        semanticStatus: "ready",
        semanticQuery: "fruit",
        semanticQueryProgress: { stage: "ranking", done: 25, total: 100 }
      })
    );

    expect(await screen.findByText("Searching this view")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Ranking current view" });
    expect(bar.getAttribute("aria-valuenow")).toBe("63");
    expect(bar.getAttribute("aria-valuetext")).toBe("25 / 100");
    expect(screen.getByText("Keyword hits keep their place; related memos are added below.")).toBeTruthy();
  });

  it("quotes the live query while it is being embedded on this device", async () => {
    render(
      panel({
        semanticStatus: "ready",
        semanticQuery: "fruit",
        semanticQueryProgress: { stage: "embedding", done: 0, total: 1 }
      })
    );

    expect(await screen.findByText("Understanding query")).toBeTruthy();
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.getByText("Embedding “fruit” on this device.")).toBeTruthy();
  });

  it("wears the lifecycle's orb marks — working, solving, connecting at rest", async () => {
    const orb = () => document.querySelector("canvas.thinking-orb");
    const { rerender } = render(panel({ semanticStatus: "preparing" }));

    expect(await screen.findByText("Starting up")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("working");
    // Decorative: the state is already announced by the live status copy.
    expect(orb()?.getAttribute("aria-hidden")).toBe("true");

    rerender(panel({ semanticStatus: "indexing" }));
    expect(await screen.findByText("Indexing your memos")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("solving");

    rerender(panel({ semanticStatus: "ready" }));
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(orb()?.getAttribute("data-orb")).toBe("connecting");
  });

  it("expands the stage ledger under the one progress bar", async () => {
    const user = userEvent.setup();
    render(
      panel({
        semanticStatus: "indexing",
        semanticProgress: { done: 3, total: 10, doneChunks: 16, totalChunks: 60 }
      })
    );

    expect(await screen.findByText("Indexing your memos")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Stages" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Memos embedded")).toBeTruthy();
    expect(screen.getByText("Batches processed")).toBeTruthy();
    expect(screen.getByText("2 of 8")).toBeTruthy();
    expect(screen.getByText("Sealed with the device key")).toBeTruthy();
  });

  it("shows semantic failures in plain words, keeps the raw reason in Advanced, and offers a direct retry", async () => {
    const user = userEvent.setup();
    const onSemanticRetry = vi.fn();
    render(panel({ onSemanticRetry, semanticStatus: "error", semanticError: "Index storage failed" }));

    expect(await screen.findByText("Semantic search stopped")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.getByText("The index couldn't be saved. Not enough storage, or this is a private window.")).toBeTruthy();
    const detail = screen.getByText("Last error").closest(".model-error-detail");
    expect(detail?.closest("#model-advanced")).toBeTruthy();
    expect(within(detail as HTMLElement).getByText("Index storage failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry semantic search" }));
    expect(onSemanticRetry).toHaveBeenCalledOnce();
  });

  it("offers the rebuild in Ready, states the index size, and asks before spending the CPU", async () => {
    const user = userEvent.setup();
    const onSemanticReindex = vi.fn();
    render(panel({ onSemanticReindex, semanticStatus: "ready", semanticIndexedMemos: 1204 }));

    expect(await screen.findByText("Ready")).toBeTruthy();
    // The device column names the thing the action acts on — a tally, set
    // without separators like every other count in the app.
    expect(screen.getByText("1204 memos")).toBeTruthy();
    expect(screen.getByText("1204 memos indexed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Rebuild index" }));
    expect(onSemanticReindex).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("group", { name: "Confirm rebuilding the index" });
    expect(within(confirmation).getByText("Re-embed 1204 memos?")).toBeTruthy();
    // Focus lands on Cancel: the affirmative costs minutes of this device's CPU.
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));

    await user.click(within(confirmation).getByRole("button", { name: "Rebuild" }));
    expect(onSemanticReindex).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Confirm rebuilding the index" })).toBeNull();
  });

  it("names a rebuild apart from a first build, from the moment the store is cleared", async () => {
    const user = userEvent.setup();
    const rebuild = (status: "preparing" | "indexing", progress?: SemanticIndexProgress) =>
      panel({ onSemanticReindex: vi.fn(), semanticStatus: status, semanticRebuilding: true, semanticProgress: progress ?? null });
    const { rerender } = render(rebuild("preparing"));

    // Clearing the store is part of the rebuild, not the model loading again.
    // (The live headline is the one that counts — the outgoing layer of the
    // swap still carries the state this panel passed through on mount.)
    expect(await screen.findByText("Rebuilding the index")).toBeTruthy();
    expect(document.querySelector(".model-headline")?.textContent).toBe("Rebuilding the index");
    expect(screen.getByText("Preparing")).toBeTruthy();
    expect(screen.getByText("Every memo is queued for indexing.")).toBeTruthy();

    rerender(rebuild("indexing", { done: 12, total: 40, doneChunks: 30, totalChunks: 96 }));
    const bar = screen.getByRole("progressbar", { name: "Index rebuild" });
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    expect(bar.getAttribute("aria-valuetext")).toBe("12 / 40");
    await user.click(screen.getByRole("button", { name: "Stages" }));
    expect(screen.getByText("Previous index discarded")).toBeTruthy();
    // The offer folds away while its own work runs.
    expect(screen.getByRole("button", { name: "Rebuild index" }).closest(".model-collapse")?.className).not.toContain("is-open");
  });

  it("confirms a clear from Advanced, disables semantic search, and clears stores and runtime", async () => {
    const user = userEvent.setup();
    const onModelCleared = vi.fn();
    render(panel({ onModelCleared }));
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
    expect(screen.getByRole("button", { name: "Download model" })).toBeTruthy();
    expect(screen.getByText("About 123 MB · one time")).toBeTruthy();
  });

  it("runs the download at app level: Cancel pauses it, Close never ends it, and a reopen re-attaches", async () => {
    const user = userEvent.setup();
    mocks.present = new Set();
    const [config, tokenizer] = MODEL_MANIFEST.files;
    const boundary = config.bytes + tokenizer.bytes;
    let emit: ((progress: ModelProgress) => void) | null = null;
    let finish: (() => void) | null = null;
    mocks.ensureModelFiles.mockImplementation(
      (onProgress, options) =>
        new Promise<void>((resolve, reject) => {
          emit = onProgress ?? null;
          finish = resolve;
          options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
          onProgress?.({ loadedBytes: 0, totalBytes: TOTAL_BYTES, currentFile: null });
        })
    );

    const { unmount } = render(panel());
    expect(await screen.findByText("Model not downloaded")).toBeTruthy();
    expect(screen.getByText("Download the model once to search your memos by meaning.")).toBeTruthy();
    expect(screen.getByText("About 123 MB · one time")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Download model" }));
    expect(await screen.findByText("Downloading the model")).toBeTruthy();
    expect(screen.getByText("Keyword search keeps working.")).toBeTruthy();
    act(() => emit?.({ loadedBytes: boundary, totalBytes: TOTAL_BYTES, currentFile: null }));
    const bar = screen.getByRole("progressbar", { name: "Download" });
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(screen.getByText("25.3 MB of 123.2 MB · 2 of 4 files")).toBeTruthy();
    expect(screen.getByText("2 of 4 · 25.3 MB")).toBeTruthy();
    // The stop is a quiet ghost beside the bar — never the danger fill.
    const cancel = screen.getByRole("button", { name: "Cancel the download" });
    expect(cancel.className).toContain("ghost-button");
    expect(cancel.className).not.toContain("danger");
    // In flight, there is nothing to resume: the CTA row is folded.
    expect(screen.queryByRole("button", { name: "Resume download" })).toBeNull();
    expect(document.querySelector(".model-action-collapse")?.className).not.toContain("is-open");
    expect(screen.getAllByRole("status")).toHaveLength(1);

    // Close mid-download: the panel goes, the run does not.
    unmount();
    expect(mocks.ensureModelFiles).toHaveBeenCalledOnce();
    render(panel());
    expect(await screen.findByText("Downloading the model")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Download" }).getAttribute("aria-valuenow")).toBe("20");
    expect(screen.queryByRole("button", { name: "Resume download" })).toBeNull();
    expect(mocks.ensureModelFiles).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Cancel the download" }));
    expect(await screen.findByText("Download paused")).toBeTruthy();
    expect(screen.getByText("25 of 123 MB kept. Resume to finish the download.")).toBeTruthy();
    const resume = screen.getByRole("button", { name: "Resume download" });
    expect(resume.closest(".model-collapse")?.className).toContain("is-open");
    expect(screen.getByText("About 98 MB remaining")).toBeTruthy();
    expect(document.activeElement).toBe(resume);
    // A pause is not a failure: nothing to explain, nothing in Advanced.
    expect(screen.queryByText("Download failed")).toBeNull();
    expect(screen.queryByText("Last error")).toBeNull();
    expect(document.querySelector("canvas.thinking-orb")?.getAttribute("data-orb")).toBe("shaping");

    await user.click(resume);
    expect(await screen.findByText("Downloading the model")).toBeTruthy();
    expect(mocks.ensureModelFiles).toHaveBeenCalledTimes(2);

    mocks.present = new Set(MODEL_MANIFEST.files.map((file) => file.requestPath));
    act(() => finish?.());
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText("4 of 4 · 123.2 MB")).toBeTruthy();
  });

  it("says Try again — with no size — when the model fails to start, and keeps the raw reason in Advanced", async () => {
    const user = userEvent.setup();
    mocks.getEmbedder.mockRejectedValueOnce(new Error("Model self-test failed: expected a unit vector, got norm 0.4000"));
    render(panel());

    expect(await screen.findByText("Model couldn't start")).toBeTruthy();
    expect(screen.getByText("The model couldn't start on this device.")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.closest(".model-action-row")?.textContent).toBe("Try again");
    expect(screen.queryByText(/About \d+ MB/)).toBeNull();
    expect(screen.queryByText(/self-test/, { selector: ".model-subline, .model-headline" })).toBeNull();
    const detail = screen.getByText("Last error").closest(".model-error-detail");
    expect(detail?.closest("#model-advanced")).toBeTruthy();
    expect(within(detail as HTMLElement).getByText("Model self-test failed: expected a unit vector, got norm 0.4000")).toBeTruthy();

    // Trying again starts the model; nothing is downloaded twice.
    await user.click(retry);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(mocks.ensureModelFiles).not.toHaveBeenCalled();
    expect(screen.queryByText("Last error")).toBeNull();
  });

  it("names the cause of a failed download in plain words and keeps each mirror's reason in Advanced", async () => {
    const user = userEvent.setup();
    mocks.present = new Set();
    mocks.ensureModelFiles.mockRejectedValueOnce(
      new ModelUnavailableError("Model file onnx/model_quantized.onnx is unavailable from every mirror.", [
        { url: "https://huggingface.co/x/resolve/y/onnx/model_quantized.onnx", reason: "HTTP 503" },
        { url: "https://github.com/x/releases/download/y/model_quantized.onnx", reason: "Failed to fetch" }
      ])
    );
    render(panel());

    await user.click(await screen.findByRole("button", { name: "Download model" }));
    expect(await screen.findByText("Download failed")).toBeTruthy();
    expect(screen.getByText("The download server returned an error (503). Try again later.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry download" })).toBeTruthy();
    expect(screen.getByText("About 123 MB · one time")).toBeTruthy();
    expect(screen.queryByText(/HTTP 503/, { selector: ".model-subline, .model-headline" })).toBeNull();
    const detail = screen.getByText("Last error").closest(".model-error-detail") as HTMLElement;
    expect(within(detail).getByText("huggingface.co — HTTP 503")).toBeTruthy();
    expect(within(detail).getByText("github.com — Failed to fetch")).toBeTruthy();
  });
});
