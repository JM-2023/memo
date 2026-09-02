// App-level owner of "make the on-device model ready": download whatever is
// missing, then activate the runtime and self-test it. It lives outside React
// so the settings panel can close mid-download and reopen onto live progress
// — the promise and the AbortController are module state, not component
// state — and so the toolbar can show the same work. One run at a time:
// start() while a run is in flight hands back that run's promise instead of
// racing a second 123 MB fetch. Cancelling aborts the transfer at the file
// level; every file already verified stays stored, so a resume picks up at
// the next file boundary rather than at zero.

import { useSyncExternalStore } from "react";
import {
  ensureModelFiles,
  isAbortError,
  ModelFilesClearedError,
  ModelUnavailableError,
  storedModelState,
  type MirrorFailure,
  type ModelLoaderOptions
} from "./modelLoader";
import { MODEL_MANIFEST, modelTotalBytes, type ModelManifest } from "./modelManifest";
import { getEmbedder, getModelRuntimeProgress, runModelSelfTest } from "./modelRuntime";

export type ModelDownloadPhase = "idle" | "downloading" | "activating" | "ready" | "error" | "cancelled";

export interface ModelDownloadError {
  origin: "download" | "activate";
  /** The raw reason — detail for the Advanced ledger, never a headline. */
  message: string;
  /** Per-mirror reasons when no source could deliver a file; else empty. */
  failures: readonly MirrorFailure[];
}

export interface ModelDownloadState {
  phase: ModelDownloadPhase;
  /** Bytes present or in flight; after a cancel, exactly the bytes kept. */
  loadedBytes: number;
  totalBytes: number;
  /** Files verified and stored, in manifest order. */
  filesDone: number;
  filesTotal: number;
  /** Request path of the file downloading now, null between files. */
  currentFile: string | null;
  /** Smoothed transfer rate while downloading; null until it is known. */
  bytesPerSecond: number | null;
  error: ModelDownloadError | null;
}

export interface ModelDownloadOptions {
  /** Loader overrides — manifest, fetch, mirrors — for tests. */
  loader?: ModelLoaderOptions;
}

/** How the panel sorts a failure into the handful of causes it has words for. */
export type ModelFailureKind = "offline" | "http" | "verify" | "storage" | "activate" | "unknown";

export interface ModelFailureCause {
  kind: ModelFailureKind;
  /** The HTTP status when `kind` is "http". */
  status: number | null;
}

/* ---- the store ---------------------------------------------------------- */

const listeners = new Set<() => void>();
let state: ModelDownloadState = initialState(MODEL_MANIFEST);
let inflight: Promise<void> | null = null;
let controller: AbortController | null = null;
/** Bumped by reset(); a run whose generation is stale publishes nothing. */
let generation = 0;

function initialState(manifest: ModelManifest): ModelDownloadState {
  return Object.freeze({
    phase: "idle",
    loadedBytes: 0,
    totalBytes: modelTotalBytes(manifest),
    filesDone: 0,
    filesTotal: manifest.files.length,
    currentFile: null,
    bytesPerSecond: null,
    error: null
  });
}

function publish(patch: Partial<ModelDownloadState>): void {
  state = Object.freeze({ ...state, ...patch });
  for (const listener of listeners) listener();
}

export function subscribeModelDownload(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getModelDownloadSnapshot(): ModelDownloadState {
  return state;
}

/** The live download state, for the panel and the toolbar alike. */
export function useModelDownload(): ModelDownloadState {
  return useSyncExternalStore(subscribeModelDownload, getModelDownloadSnapshot, getModelDownloadSnapshot);
}

/** True while bytes are moving or the runtime is starting — the moments a closed panel still has something to show. */
export function isModelWorkInFlight(snapshot: ModelDownloadState): boolean {
  return snapshot.phase === "downloading" || snapshot.phase === "activating";
}

/* ---- throughput: a rate that reads as a figure, not a flicker ----------- */

const RATE_WINDOW_MS = 8000;
const RATE_MIN_SPAN_MS = 1500;
const RATE_REFRESH_MS = 500;
/** Chunks arrive tens of times a second; the bar's own transition is 320 ms. */
const PROGRESS_PUBLISH_MS = 150;

class Throughput {
  private samples: { at: number; bytes: number }[] = [];
  private refreshedAt = 0;
  private rate: number | null = null;

  sample(bytes: number, now: number): number | null {
    this.samples.push({ at: now, bytes });
    while (this.samples.length > 1 && now - this.samples[0].at > RATE_WINDOW_MS) this.samples.shift();
    if (now - this.refreshedAt < RATE_REFRESH_MS) return this.rate;
    const first = this.samples[0];
    const span = now - first.at;
    // A mirror failover rolls the byte count back; the previous rate holds
    // until the new stream has enough history of its own.
    if (span >= RATE_MIN_SPAN_MS && bytes > first.bytes) {
      this.rate = ((bytes - first.bytes) / span) * 1000;
      this.refreshedAt = now;
    }
    return this.rate;
  }
}

/** Files whose bytes lie entirely under `loadedBytes`, in manifest order. */
function filesBelow(manifest: ModelManifest, loadedBytes: number): number {
  let sum = 0;
  let count = 0;
  for (const file of manifest.files) {
    sum += file.bytes;
    if (loadedBytes < sum) break;
    count += 1;
  }
  return count;
}

function describeFailure(origin: ModelDownloadError["origin"], cause: unknown): ModelDownloadError {
  return {
    origin,
    message: cause instanceof Error ? cause.message : String(cause),
    failures: cause instanceof ModelUnavailableError ? cause.failures : []
  };
}

/* ---- the run -------------------------------------------------------------- */

/**
 * Make the model ready: download the missing files, then activate and
 * self-test the runtime. Idempotent while a run is in flight — the same
 * promise comes back — and safe to call again after any outcome. The promise
 * always resolves; the outcome is the store's phase, so a caller that only
 * wanted to kick the work off never has to catch.
 */
export function startModelDownload(options: ModelDownloadOptions = {}): Promise<void> {
  if (inflight) return inflight;
  generation += 1;
  const run = generation;
  const alive = () => run === generation;
  const abort = new AbortController();
  controller = abort;
  const manifest = options.loader?.manifest ?? MODEL_MANIFEST;
  const totalBytes = modelTotalBytes(manifest);
  const filesTotal = manifest.files.length;

  const promise = (async () => {
    const stored = await storedModelState(manifest);
    if (!alive()) return;
    if (stored === "complete" && getModelRuntimeProgress().stage === "ready") {
      // Every file is here and the runtime already passed its self-test this
      // session: nothing to start, nothing to flash through.
      if (state.phase !== "ready") {
        publish({ phase: "ready", loadedBytes: totalBytes, totalBytes, filesDone: filesTotal, filesTotal, currentFile: null, bytesPerSecond: null, error: null });
      }
      return;
    }

    /* `boundary` is loadedBytes at the last file boundary — the bytes a
       cancel keeps, since a file is stored only once it has verified. */
    let boundary = 0;
    let filesDone = 0;
    if (stored !== "complete") {
      const throughput = new Throughput();
      let publishedAt = 0;
      // Chunks inside the publish window wait for its trailing edge, so the
      // last figures of a burst always land rather than being dropped.
      let trailing: ReturnType<typeof setTimeout> | null = null;
      let pending: Partial<ModelDownloadState> | null = null;
      const flush = () => {
        trailing = null;
        if (!pending || !alive()) return;
        publishedAt = Date.now();
        publish(pending);
        pending = null;
      };
      const settle = () => {
        if (trailing) clearTimeout(trailing);
        trailing = null;
        pending = null;
      };
      publish({ phase: "downloading", loadedBytes: 0, totalBytes, filesDone: 0, filesTotal, currentFile: null, bytesPerSecond: null, error: null });
      try {
        await ensureModelFiles(
          (progress) => {
            if (!alive()) return;
            const now = Date.now();
            const atBoundary = progress.currentFile === null;
            if (atBoundary) {
              boundary = progress.loadedBytes;
              filesDone = filesBelow(manifest, boundary);
            }
            const rate = throughput.sample(progress.loadedBytes, now);
            const patch = { loadedBytes: progress.loadedBytes, filesDone, currentFile: progress.currentFile, bytesPerSecond: rate };
            if (!atBoundary && now - publishedAt < PROGRESS_PUBLISH_MS) {
              pending = patch;
              trailing ??= setTimeout(flush, Math.max(1, PROGRESS_PUBLISH_MS - (now - publishedAt)));
              return;
            }
            settle();
            publishedAt = now;
            publish(patch);
          },
          { ...options.loader, signal: abort.signal }
        );
        settle();
      } catch (cause) {
        settle();
        if (!alive()) return;
        if (isAbortError(cause)) {
          publish({ phase: "cancelled", loadedBytes: boundary, filesDone, currentFile: null, bytesPerSecond: null, error: null });
        } else if (cause instanceof ModelFilesClearedError) {
          // A logout or clear emptied the store underneath the run: nothing
          // is kept and there is nothing to resume.
          publish(initialState(manifest));
        } else {
          publish({
            phase: "error",
            loadedBytes: boundary,
            filesDone,
            currentFile: null,
            bytesPerSecond: null,
            error: describeFailure("download", cause)
          });
        }
        return;
      }
      if (!alive()) return;
    }

    publish({ phase: "activating", loadedBytes: totalBytes, totalBytes, filesDone: filesTotal, filesTotal, currentFile: null, bytesPerSecond: null, error: null });
    try {
      await getEmbedder();
      await runModelSelfTest();
    } catch (cause) {
      if (!alive()) return;
      publish({ phase: "error", error: describeFailure("activate", cause) });
      return;
    }
    if (!alive()) return;
    publish({ phase: "ready" });
  })().finally(() => {
    if (inflight === promise) {
      inflight = null;
      controller = null;
    }
  });
  inflight = promise;
  return promise;
}

/**
 * Stop the transfer. Files already verified stay stored and the store lands
 * in "cancelled" — a pause, not a failure. Activation cannot be interrupted
 * (every file is present by then), so this is a no-op outside a download.
 */
export function cancelModelDownload(): void {
  if (state.phase !== "downloading") return;
  controller?.abort();
}

/**
 * Forget the run and its outcome: after the model is cleared from the
 * device, or between tests. Anything in flight is aborted and its late
 * results are ignored, so the next start() begins fresh.
 */
export function resetModelDownload(): void {
  generation += 1;
  controller?.abort();
  controller = null;
  inflight = null;
  publish(initialState(MODEL_MANIFEST));
}

/* ---- naming the cause ----------------------------------------------------- */

const HTTP_STATUS = /\bHTTP (\d{3})\b/;
const VERIFY = /sha-256 mismatch|received \d+ bytes, expected|exceeds the pinned/i;
const STORAGE = /quota|storage|indexeddb|InvalidStateError|SecurityError|mutation operation/i;
const NETWORK = /failed to fetch|networkerror|load failed|network request failed|fetch failed|stalled for|ECONN|ENOTFOUND|EAI_AGAIN|timed? ?out/i;
const RUNTIME = /self-test|embedding shape|runtime was cleared|wasm|webassembly|onnx|backend|pipeline|unable to load|failed to load|out of memory|tensor/i;

function kindOf(reason: string): ModelFailureCause {
  const http = reason.match(HTTP_STATUS);
  if (http) return { kind: "http", status: Number(http[1]) };
  if (VERIFY.test(reason)) return { kind: "verify", status: null };
  if (STORAGE.test(reason)) return { kind: "storage", status: null };
  if (NETWORK.test(reason)) return { kind: "offline", status: null };
  return { kind: "unknown", status: null };
}

/**
 * Sort a failure into a cause the panel has words for. Mirror reasons are
 * read in order and the first specific one wins: the primary mirror's 503
 * says more than the secondary's CORS rejection, while a device that is
 * offline fails every mirror the same way. "semantic" is the search hook's
 * own error string, which mostly comes from the same runtime.
 */
export function classifyModelFailure(
  origin: "download" | "activate" | "semantic",
  message: string,
  failures: readonly MirrorFailure[] = []
): ModelFailureCause {
  if (origin === "activate") return { kind: "activate", status: null };
  if (origin === "download" && typeof navigator !== "undefined" && navigator.onLine === false) {
    return { kind: "offline", status: null };
  }
  if (origin === "semantic") {
    if (STORAGE.test(message)) return { kind: "storage", status: null };
    if (RUNTIME.test(message)) return { kind: "activate", status: null };
    return { kind: "unknown", status: null };
  }
  const reasons = failures.length > 0 ? failures.map((failure) => failure.reason) : [message];
  let fallback: ModelFailureCause | null = null;
  for (const reason of reasons) {
    const cause = kindOf(reason);
    if (cause.kind === "http" || cause.kind === "verify" || cause.kind === "storage") return cause;
    fallback ??= cause;
  }
  return fallback ?? { kind: "unknown", status: null };
}
