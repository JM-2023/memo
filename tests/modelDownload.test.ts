import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store is exercised end to end against the real loader: the model
// store is the same in-memory map modelLoader.test.ts uses, the mirrors are
// a fetch stub, and only the runtime (WASM, transformers.js) is a mock.
const mockStore = vi.hoisted(() => ({
  files: new Map<string, ArrayBuffer>()
}));

const runtime = vi.hoisted(() => ({
  getEmbedder: vi.fn(async () => async () => []),
  runModelSelfTest: vi.fn(async () => {}),
  stage: "idle"
}));

vi.mock("../src/lib/modelStore", () => ({
  deleteModelStoreDb: vi.fn(async () => mockStore.files.clear()),
  readStoredModelFile: vi.fn(async (version: string, requestPath: string) => mockStore.files.get(`${version}/${requestPath}`) ?? null),
  writeStoredModelFile: vi.fn(async (version: string, requestPath: string, bytes: ArrayBuffer) => {
    mockStore.files.set(`${version}/${requestPath}`, bytes);
  }),
  listStoredModelFiles: vi.fn(async (version: string) => {
    const prefix = `${version}/`;
    const present = new Set<string>();
    for (const key of mockStore.files.keys()) {
      if (key.startsWith(prefix)) present.add(key.slice(prefix.length));
    }
    return present;
  }),
  purgeOtherModelVersions: vi.fn(async () => {}),
  requestPersistentStorage: vi.fn(async () => {})
}));

vi.mock("../src/lib/modelRuntime", () => ({
  getEmbedder: runtime.getEmbedder,
  runModelSelfTest: runtime.runModelSelfTest,
  getModelRuntimeProgress: () => ({ stage: runtime.stage, percent: 0 })
}));

import {
  cancelModelDownload,
  classifyModelFailure,
  getModelDownloadSnapshot,
  isModelWorkInFlight,
  resetModelDownload,
  startModelDownload,
  subscribeModelDownload,
  type ModelDownloadState
} from "../src/lib/modelDownload";
import { storedModelState } from "../src/lib/modelLoader";
import { sha256Hex, type ModelFileSpec, type ModelManifest } from "../src/lib/modelManifest";

const encoder = new TextEncoder();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function makeManifest(version: string, contents: Record<string, string>): Promise<{ manifest: ModelManifest; bodies: Map<string, Uint8Array> }> {
  const files: ModelFileSpec[] = [];
  const bodies = new Map<string, Uint8Array>();
  for (const [requestPath, content] of Object.entries(contents)) {
    const bytes = encoder.encode(content);
    const asset = requestPath.split("/").at(-1)!;
    bodies.set(asset, bytes);
    files.push({ asset, requestPath, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  return {
    manifest: { id: "test/model", hfRevision: "0".repeat(40), version, releaseTag: `model-${version}`, files },
    bodies
  };
}

function mirrorUrls(file: ModelFileSpec): string[] {
  return [`https://primary.test/${file.asset}`, `https://fallback.test/${file.asset}`];
}

/** Resolves once the store's state satisfies `matches` (checked at once, then on every publish). */
function waitForState(matches: (state: ModelDownloadState) => boolean): Promise<ModelDownloadState> {
  return new Promise((resolve, reject) => {
    const current = getModelDownloadSnapshot();
    if (matches(current)) {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`store never reached the expected state; last phase ${getModelDownloadSnapshot().phase}`));
    }, 4000);
    const unsubscribe = subscribeModelDownload(() => {
      const next = getModelDownloadSnapshot();
      if (!matches(next)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(next);
    });
  });
}

beforeEach(() => {
  mockStore.files.clear();
  runtime.stage = "idle";
  runtime.getEmbedder.mockReset();
  runtime.getEmbedder.mockResolvedValue(async () => []);
  runtime.runModelSelfTest.mockReset();
  runtime.runModelSelfTest.mockResolvedValue(undefined);
  resetModelDownload();
});

afterEach(() => {
  resetModelDownload();
  vi.useRealTimers();
});

describe("model download store", () => {
  it("runs one download at a time: start() while in flight returns the same promise", async () => {
    const { manifest, bodies } = await makeManifest("v-once", { "config.json": "config-body" });
    const release = deferred<void>();
    const calls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      await release.promise;
      return new Response(bodies.get("config.json")!);
    }) as typeof fetch;
    const loader = { manifest, fetchImpl: impl, mirrorUrls };

    const first = startModelDownload({ loader });
    const second = startModelDownload({ loader });
    expect(second).toBe(first);

    const downloading = await waitForState((state) => state.phase === "downloading");
    expect(isModelWorkInFlight(downloading)).toBe(true);
    expect(downloading.filesTotal).toBe(1);
    expect(downloading.totalBytes).toBe(manifest.files[0].bytes);
    expect(startModelDownload({ loader })).toBe(first);

    release.resolve();
    await first;
    const ready = getModelDownloadSnapshot();
    expect(ready.phase).toBe("ready");
    expect(isModelWorkInFlight(ready)).toBe(false);
    expect(ready.loadedBytes).toBe(ready.totalBytes);
    expect(ready.filesDone).toBe(1);
    expect(calls).toEqual(["https://primary.test/config.json"]);
    expect(runtime.getEmbedder).toHaveBeenCalledOnce();
    expect(runtime.runModelSelfTest).toHaveBeenCalledOnce();
    expect(await storedModelState(manifest)).toBe("complete");
  });

  it("cancel keeps the verified files, lands in cancelled — not error — and a resume starts at the boundary", async () => {
    const { manifest, bodies } = await makeManifest("v-cancel", {
      "config.json": "config-body",
      "onnx/model.onnx": "weights-body"
    });
    const calls: string[] = [];
    const weightsRequested = deferred<void>();
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("config.json")) return new Response(bodies.get("config.json")!);
      if (calls.filter((seen) => seen.endsWith("model.onnx")).length === 1) {
        weightsRequested.resolve();
        return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      }
      return new Response(bodies.get("model.onnx")!);
    }) as typeof fetch;
    const loader = { manifest, fetchImpl: impl, mirrorUrls, stallTimeoutMs: 60_000 };

    const run = startModelDownload({ loader });
    await weightsRequested.promise;
    await waitForState((state) => state.phase === "downloading" && state.filesDone === 1);
    cancelModelDownload();

    await run;
    const paused = getModelDownloadSnapshot();
    expect(paused.phase).toBe("cancelled");
    expect(paused.error).toBeNull();
    expect(paused.loadedBytes).toBe(manifest.files[0].bytes);
    expect(paused.filesDone).toBe(1);
    expect(paused.currentFile).toBeNull();
    expect(isModelWorkInFlight(paused)).toBe(false);
    expect(await storedModelState(manifest)).toBe("partial");
    expect(runtime.getEmbedder).not.toHaveBeenCalled();
    // Out of a download, cancel has nothing to stop.
    cancelModelDownload();
    expect(getModelDownloadSnapshot().phase).toBe("cancelled");

    await startModelDownload({ loader });
    expect(getModelDownloadSnapshot().phase).toBe("ready");
    expect(calls).toEqual([
      "https://primary.test/config.json",
      "https://primary.test/model.onnx",
      "https://primary.test/model.onnx"
    ]);
    expect(await storedModelState(manifest)).toBe("complete");
  });

  it("turns a dead mirror chain into a download error carrying every mirror's reason", async () => {
    const { manifest } = await makeManifest("v-dead", { "config.json": "never-served" });
    const impl = (async () => new Response("missing", { status: 404 })) as typeof fetch;

    await startModelDownload({ loader: { manifest, fetchImpl: impl, mirrorUrls } });

    const failed = getModelDownloadSnapshot();
    expect(failed.phase).toBe("error");
    expect(failed.error?.origin).toBe("download");
    expect(failed.error?.failures.map((failure) => failure.reason)).toEqual(["HTTP 404", "HTTP 404"]);
    expect(failed.loadedBytes).toBe(0);
    expect(isModelWorkInFlight(failed)).toBe(false);
  });

  it("reports a failed start against activation, with every file already kept", async () => {
    const { manifest, bodies } = await makeManifest("v-activate", { "config.json": "config-body" });
    const impl = (async () => new Response(bodies.get("config.json")!)) as typeof fetch;
    runtime.getEmbedder.mockRejectedValueOnce(new Error("Model self-test failed: expected a unit vector"));

    await startModelDownload({ loader: { manifest, fetchImpl: impl, mirrorUrls } });

    const failed = getModelDownloadSnapshot();
    expect(failed.phase).toBe("error");
    expect(failed.error).toEqual({ origin: "activate", message: "Model self-test failed: expected a unit vector", failures: [] });
    expect(failed.filesDone).toBe(failed.filesTotal);
    expect(failed.loadedBytes).toBe(failed.totalBytes);
    expect(await storedModelState(manifest)).toBe("complete");

    // Trying again activates without asking the network for anything.
    const calls: string[] = [];
    const quiet = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    await startModelDownload({ loader: { manifest, fetchImpl: quiet, mirrorUrls } });
    expect(getModelDownloadSnapshot().phase).toBe("ready");
    expect(calls).toEqual([]);
  });

  it("goes straight to ready when every file is here and the runtime already passed its self-test", async () => {
    const { manifest, bodies } = await makeManifest("v-live", { "config.json": "config-body" });
    mockStore.files.set("v-live/config.json", bodies.get("config.json")!.buffer as ArrayBuffer);
    runtime.stage = "ready";

    const seen: string[] = [];
    const unsubscribe = subscribeModelDownload(() => seen.push(getModelDownloadSnapshot().phase));
    await startModelDownload({ loader: { manifest, mirrorUrls } });
    unsubscribe();

    expect(seen).toEqual(["ready"]);
    expect(runtime.getEmbedder).not.toHaveBeenCalled();
    expect(getModelDownloadSnapshot().filesDone).toBe(1);
  });

  it("reset() abandons an in-flight run so the next start() begins fresh", async () => {
    const { manifest, bodies } = await makeManifest("v-reset", { "config.json": "config-body" });
    const stale = deferred<Response>();
    const staleRequested = deferred<void>();
    let requests = 0;
    const impl = (async () => {
      requests += 1;
      if (requests === 1) {
        staleRequested.resolve();
        return stale.promise;
      }
      return new Response(bodies.get("config.json")!);
    }) as typeof fetch;
    const loader = { manifest, fetchImpl: impl, mirrorUrls, stallTimeoutMs: 60_000 };

    const first = startModelDownload({ loader });
    await waitForState((state) => state.phase === "downloading");
    // "downloading" is published before the first request opens; the reset
    // has to land on a transfer that is actually in flight.
    await staleRequested.promise;
    resetModelDownload();
    expect(getModelDownloadSnapshot().phase).toBe("idle");

    const second = startModelDownload({ loader });
    expect(second).not.toBe(first);
    await second;
    expect(getModelDownloadSnapshot().phase).toBe("ready");

    // The abandoned run settling late changes nothing.
    stale.resolve(new Response(bodies.get("config.json")!));
    await first;
    expect(getModelDownloadSnapshot().phase).toBe("ready");
    expect(runtime.getEmbedder).toHaveBeenCalledOnce();
  });

  it("publishes a transfer rate once it has enough history to trust", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { manifest, bodies } = await makeManifest("v-rate", { "config.json": "abcdef" });
    let push!: (bytes: Uint8Array) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (bytes) => controller.enqueue(bytes);
        close = () => controller.close();
      }
    });
    const opened = deferred<void>();
    const impl = (async () => {
      opened.resolve();
      return new Response(body);
    }) as typeof fetch;

    const run = startModelDownload({ loader: { manifest, fetchImpl: impl, mirrorUrls, stallTimeoutMs: 60_000 } });
    await opened.promise;
    push(bodies.get("config.json")!.slice(0, 2));
    await waitForState((state) => state.loadedBytes === 2);
    expect(getModelDownloadSnapshot().bytesPerSecond).toBeNull();

    vi.setSystemTime(1_002_000);
    push(bodies.get("config.json")!.slice(2, 4));
    const rated = await waitForState((state) => state.loadedBytes === 4);
    // 4 bytes over the 2 s since the first sample.
    expect(rated.bytesPerSecond).toBe(2);

    push(bodies.get("config.json")!.slice(4));
    close();
    await run;
    expect(getModelDownloadSnapshot()).toMatchObject({ phase: "ready", bytesPerSecond: null, loadedBytes: 6 });
  });
});

describe("classifyModelFailure", () => {
  it("lets the primary mirror's status speak over the secondary's CORS rejection", () => {
    expect(
      classifyModelFailure("download", "unavailable from every mirror", [
        { url: "https://huggingface.co/a", reason: "HTTP 503" },
        { url: "https://github.com/b", reason: "Failed to fetch" }
      ])
    ).toEqual({ kind: "http", status: 503 });
  });

  it("reads every mirror failing the same way as the network being down", () => {
    expect(
      classifyModelFailure("download", "unavailable from every mirror", [
        { url: "https://huggingface.co/a", reason: "Failed to fetch" },
        { url: "https://github.com/b", reason: "stalled for 30000 ms" }
      ])
    ).toEqual({ kind: "offline", status: null });
  });

  it("names a hash or size mismatch as a file that did not verify", () => {
    expect(classifyModelFailure("download", "x", [{ url: "https://huggingface.co/a", reason: "SHA-256 mismatch" }])).toEqual({
      kind: "verify",
      status: null
    });
    expect(classifyModelFailure("download", "received 10 bytes, expected 20")).toEqual({ kind: "verify", status: null });
  });

  it("treats quota and private-window failures as storage", () => {
    expect(classifyModelFailure("download", "QuotaExceededError: The quota has been exceeded.")).toEqual({ kind: "storage", status: null });
    expect(classifyModelFailure("semantic", "Index storage failed")).toEqual({ kind: "storage", status: null });
  });

  it("keeps activation and runtime trouble apart from the network", () => {
    expect(classifyModelFailure("activate", "Model self-test failed: expected 3 vectors")).toEqual({ kind: "activate", status: null });
    expect(classifyModelFailure("semantic", "Model self-test failed: expected a unit vector")).toEqual({ kind: "activate", status: null });
    expect(classifyModelFailure("semantic", "something else entirely")).toEqual({ kind: "unknown", status: null });
    expect(classifyModelFailure("download", "something else entirely")).toEqual({ kind: "unknown", status: null });
  });
});
