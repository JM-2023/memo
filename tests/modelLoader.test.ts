import { beforeEach, describe, expect, it, vi } from "vitest";

// The loader's persistence layer is mocked with an in-memory map so these
// tests exercise the mirror chain, verification, and fallback logic without
// IndexedDB; modelStore.test.ts covers the real store.
const mockStore = vi.hoisted(() => ({
  files: new Map<string, ArrayBuffer>(),
  failWrites: false
}));

vi.mock("../src/lib/modelStore", () => ({
  deleteModelStoreDb: vi.fn(async () => mockStore.files.clear()),
  readStoredModelFile: vi.fn(async (version: string, requestPath: string) => mockStore.files.get(`${version}/${requestPath}`) ?? null),
  writeStoredModelFile: vi.fn(async (version: string, requestPath: string, bytes: ArrayBuffer) => {
    if (mockStore.failWrites) throw new Error("quota exceeded");
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

import {
  clearModelFiles,
  ensureModelFiles,
  importModelFiles,
  ModelUnavailableError,
  readModelFileBytes,
  storedModelState,
  type ModelProgress
} from "../src/lib/modelLoader";
import { sha256Hex, type ModelFileSpec, type ModelManifest } from "../src/lib/modelManifest";

const encoder = new TextEncoder();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Distinct versions per test keep the loader's session overlay isolated. */
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

type Routes = Record<string, () => Response>;

function fetchStub(routes: Routes): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("missing route", { status: 404 });
    return route();
  }) as typeof fetch;
  return { impl, calls };
}

function mirrorUrls(file: ModelFileSpec): string[] {
  return [`https://primary.test/${file.asset}`, `https://fallback.test/${file.asset}`];
}

beforeEach(() => {
  mockStore.files.clear();
  mockStore.failWrites = false;
});

describe("model loader", () => {
  it("downloads, verifies, and freezes every file from the primary mirror", async () => {
    const { manifest, bodies } = await makeManifest("v-happy", {
      "config.json": "config-body",
      "onnx/model.onnx": "weights-body"
    });
    const { impl, calls } = fetchStub({
      "https://primary.test/config.json": () => new Response(bodies.get("config.json")!),
      "https://primary.test/model.onnx": () => new Response(bodies.get("model.onnx")!)
    });

    const events: ModelProgress[] = [];
    await ensureModelFiles((progress) => events.push(progress), { manifest, fetchImpl: impl, mirrorUrls });

    expect(calls).toEqual(["https://primary.test/config.json", "https://primary.test/model.onnx"]);
    expect(await storedModelState(manifest)).toBe("complete");
    const config = await readModelFileBytes("config.json", manifest);
    expect(config && new TextDecoder().decode(config)).toBe("config-body");

    const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    expect(events.at(-1)).toEqual({ loadedBytes: total, totalBytes: total, currentFile: null });
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].loadedBytes).toBeGreaterThanOrEqual(events[index - 1].loadedBytes);
    }
  });

  it("downloads nothing when every file is already frozen", async () => {
    const { manifest, bodies } = await makeManifest("v-cached", { "config.json": "cached-body" });
    mockStore.files.set("v-cached/config.json", bodies.get("config.json")!.buffer as ArrayBuffer);

    const { impl, calls } = fetchStub({});
    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls });
    expect(calls).toEqual([]);
  });

  it("falls back to the next mirror when the primary errors", async () => {
    const { manifest, bodies } = await makeManifest("v-fallback", { "config.json": "fallback-body" });
    const { impl, calls } = fetchStub({
      "https://primary.test/config.json": () => new Response("down", { status: 500 }),
      "https://fallback.test/config.json": () => new Response(bodies.get("config.json")!)
    });

    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls });
    expect(calls).toEqual(["https://primary.test/config.json", "https://fallback.test/config.json"]);
    expect(await storedModelState(manifest)).toBe("complete");
  });

  it("abandons a mirror that stalls before response headers", async () => {
    const { manifest, bodies } = await makeManifest("v-header-stall", { "config.json": "fallback-body" });
    const calls: string[] = [];
    const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("primary.test")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(new Response(bodies.get("config.json")!));
    }) as typeof fetch;

    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls, stallTimeoutMs: 5 });

    expect(calls).toEqual(["https://primary.test/config.json", "https://fallback.test/config.json"]);
    expect(await storedModelState(manifest)).toBe("complete");
  });

  it("abandons a response body that stops making progress", async () => {
    const { manifest, bodies } = await makeManifest("v-body-stall", { "config.json": "fallback-body" });
    const calls: string[] = [];
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.includes("primary.test") ? new Response(stalledBody) : new Response(bodies.get("config.json")!);
    }) as typeof fetch;

    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls, stallTimeoutMs: 5 });

    expect(calls).toEqual(["https://primary.test/config.json", "https://fallback.test/config.json"]);
    expect(await storedModelState(manifest)).toBe("complete");
  });

  it("discards tampered bytes no matter which mirror served them", async () => {
    const { manifest, bodies } = await makeManifest("v-tamper", { "config.json": "honest-body" });
    // Same length, different content: only the hash can catch it.
    const tampered = encoder.encode("hOnest-body");
    const { impl, calls } = fetchStub({
      "https://primary.test/config.json": () => new Response(tampered),
      "https://fallback.test/config.json": () => new Response(bodies.get("config.json")!)
    });

    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls });
    expect(calls.length).toBe(2);
    const kept = await readModelFileBytes("config.json", manifest);
    expect(kept && new TextDecoder().decode(kept)).toBe("honest-body");
  });

  it("cancels a body that exceeds the pinned size", async () => {
    const { manifest, bodies } = await makeManifest("v-oversize", { "config.json": "exact" });
    const { impl } = fetchStub({
      "https://primary.test/config.json": () => new Response(encoder.encode("exact-plus-extra")),
      "https://fallback.test/config.json": () => new Response(bodies.get("config.json")!)
    });

    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls });
    expect(await storedModelState(manifest)).toBe("complete");
  });

  it("reports every mirror's failure when a file is unobtainable", async () => {
    const { manifest } = await makeManifest("v-dead", { "config.json": "never-served" });
    const { impl } = fetchStub({});

    const failure = await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ModelUnavailableError);
    const { failures } = failure as ModelUnavailableError;
    expect(failures.map((entry) => entry.url)).toEqual(["https://primary.test/config.json", "https://fallback.test/config.json"]);
    for (const entry of failures) expect(entry.reason).toContain("HTTP 404");
  });

  it("keeps verified bytes in memory for the session when persistence fails", async () => {
    const { manifest, bodies } = await makeManifest("v-quota", { "config.json": "unpersistable" });
    mockStore.failWrites = true;
    const { impl } = fetchStub({
      "https://primary.test/config.json": () => new Response(bodies.get("config.json")!)
    });

    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls });
    expect(mockStore.files.size).toBe(0);
    expect(await storedModelState(manifest)).toBe("complete");
    const kept = await readModelFileBytes("config.json", manifest);
    expect(kept && new TextDecoder().decode(kept)).toBe("unpersistable");
  });

  it("clears persisted files and the session-only quota fallback together", async () => {
    const { manifest, bodies } = await makeManifest("v-clear", { "config.json": "clear-me" });
    mockStore.failWrites = true;
    const { impl } = fetchStub({
      "https://primary.test/config.json": () => new Response(bodies.get("config.json")!)
    });
    await ensureModelFiles(undefined, { manifest, fetchImpl: impl, mirrorUrls });
    mockStore.files.set("another-version/config.json", encoder.encode("persisted").buffer as ArrayBuffer);
    expect(await storedModelState(manifest)).toBe("complete");

    await clearModelFiles();

    expect(mockStore.files.size).toBe(0);
    expect(await storedModelState(manifest)).toBe("none");
  });

  it("does not let an in-flight import restore files after they are cleared", async () => {
    const { manifest, bodies } = await makeManifest("v-clear-race", { "config.json": "late import" });
    const started = deferred<void>();
    const bytes = deferred<ArrayBuffer>();
    const pending = importModelFiles(
      [
        {
          name: "config.json",
          arrayBuffer: () => {
            started.resolve();
            return bytes.promise;
          }
        }
      ],
      { manifest }
    );
    await started.promise;

    await clearModelFiles();
    bytes.resolve(bodies.get("config.json")!.buffer as ArrayBuffer);

    await expect(pending).rejects.toThrow("cleared during this operation");
    expect(await storedModelState(manifest)).toBe("none");
  });

  it("imports files by content hash regardless of their names", async () => {
    const { manifest, bodies } = await makeManifest("v-import", {
      "config.json": "import-config",
      "onnx/model.onnx": "import-weights"
    });

    const asFile = (name: string, bytes: Uint8Array) => ({
      name,
      arrayBuffer: async () => bytes.buffer as ArrayBuffer
    });

    const first = await importModelFiles(
      [
        asFile("renamed-anything.bin", bodies.get("model.onnx")!),
        asFile("garbage.txt", encoder.encode("not part of the model"))
      ],
      { manifest }
    );
    expect(first.imported).toEqual(["onnx/model.onnx"]);
    expect(first.unmatched).toEqual(["garbage.txt"]);
    expect(await storedModelState(manifest)).toBe("partial");

    const second = await importModelFiles(
      [asFile("model.onnx", bodies.get("model.onnx")!), asFile("config.json", bodies.get("config.json")!)],
      { manifest }
    );
    expect(second.alreadyPresent).toEqual(["onnx/model.onnx"]);
    expect(second.imported).toEqual(["config.json"]);
    expect(await storedModelState(manifest)).toBe("complete");
  });
});
