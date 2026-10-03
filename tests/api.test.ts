import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_REQUEST_TIMEOUT_MS,
  API_UPLOAD_TIMEOUT_MAX_MS,
  ApiError,
  AuthRequiredError,
  batchMemos,
  createMemo,
  getAuthStatus,
  isSessionRevoked,
  lastAuthLossWasRevocation,
  requestTimeoutMs,
  syncSince,
  updateMemo
} from "../src/lib/api";

function abortablePendingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true }
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("API request lifetime", () => {
  it("turns an indefinitely pending request into a typed timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(abortablePendingFetch));

    const request = getAuthStatus();
    const failure = expect(request).rejects.toMatchObject<ApiError>({ code: "REQUEST_TIMEOUT", status: 408 });
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);

    await failure;
  });

  it("keeps the timeout active while the response body is being read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            })
        } as Response)
      )
    );

    const request = getAuthStatus();
    const failure = expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", status: 408 });
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);

    await failure;
  });

  it("preserves a caller abort instead of reporting it as a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(abortablePendingFetch));
    const controller = new AbortController();

    const request = syncSince(10, { signal: controller.signal });
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("API uploads", () => {
  function pendingImages(count: number, chars: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `image-${index}`,
      dataBase64: "A".repeat(chars),
      mime: "image/webp",
      width: 1600,
      height: 1200,
      previewUrl: `blob:${index}`
    }));
  }

  it("scales the request lifetime with the body size, up to a ceiling", () => {
    expect(requestTimeoutMs(0)).toBe(API_REQUEST_TIMEOUT_MS);
    expect(requestTimeoutMs(1_000_000)).toBe(API_REQUEST_TIMEOUT_MS + 15_000);
    expect(requestTimeoutMs(11_000_000)).toBe(API_UPLOAD_TIMEOUT_MAX_MS);
  });

  it("does not give up on a large upload at the base 30s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(abortablePendingFetch));

    const request = createMemo("big-upload", "", pendingImages(3, 900_000));
    let settled = false;
    void request.catch(() => undefined).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1_000);
    expect(settled).toBe(false);

    const failure = expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(requestTimeoutMs(2_700_000));
    await failure;
  });

  it("reports an unreachable server as a typed network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    await expect(getAuthStatus()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });

  it("sends image saves over XHR with upload progress and keeps typed server errors", async () => {
    const sent: { method: string; path: string; body: string | null }[] = [];
    class FakeXhr {
      status = 0;
      statusText = "";
      responseText = "";
      responseType = "";
      upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onloadend: (() => void) | null = null;
      private method = "";
      private path = "";
      open(method: string, path: string) {
        this.method = method;
        this.path = path;
      }
      setRequestHeader() {}
      abort() {}
      send(body: string | null) {
        sent.push({ method: this.method, path: this.path, body });
        queueMicrotask(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 });
          this.upload.onprogress?.({ lengthComputable: true, loaded: 200, total: 200 });
          this.status = 507;
          this.responseText = JSON.stringify({ code: "STORAGE_FULL", error: "The D1 database is full." });
          this.onload?.();
          this.onloadend?.();
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const progress: number[] = [];

    await expect(
      createMemo("with-image", "photo", pendingImages(1, 10), { onUploadProgress: (fraction) => progress.push(fraction) })
    ).rejects.toMatchObject({ code: "STORAGE_FULL", status: 507 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/memos" });
    expect(JSON.parse(sent[0].body ?? "{}")).toMatchObject({ id: "with-image", content: "photo" });
    expect(progress).toEqual([0.25, 1]);
  });

  it("turns an XHR network failure into the same typed network error", async () => {
    class OfflineXhr {
      upload = { onprogress: null };
      responseType = "";
      onerror: (() => void) | null = null;
      onloadend: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        queueMicrotask(() => {
          this.onerror?.();
          this.onloadend?.();
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", OfflineXhr);

    await expect(
      updateMemo("memo-1", { expectedSeq: 1, addImages: pendingImages(1, 10) }, { onUploadProgress: () => undefined })
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  describe("XHR upload lifetime", () => {
    // An XHR that never finishes on its own: the test drives its upload events,
    // and abort() fires onabort/onloadend the way a browser does.
    class ControlledXhr {
      static last: ControlledXhr | null = null;
      upload: {
        onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
        onload: (() => void) | null;
      } = { onprogress: null, onload: null };
      responseType = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onloadend: (() => void) | null = null;
      aborted = false;
      constructor() {
        ControlledXhr.last = this;
      }
      open() {}
      setRequestHeader() {}
      bodyLength = 0;
      send(body: string | null) {
        this.bodyLength = body?.length ?? 0;
      }
      abort() {
        this.aborted = true;
        this.onabort?.();
        this.onloadend?.();
      }
      progress(loaded: number, total: number) {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total });
      }
    }

    function startUpload() {
      ControlledXhr.last = null;
      vi.useFakeTimers();
      vi.stubGlobal("XMLHttpRequest", ControlledXhr);
      const images = pendingImages(3, 900_000);
      const request = createMemo("slow-upload", "", images, { onUploadProgress: () => undefined });
      let settled = false;
      void request.catch(() => undefined).finally(() => (settled = true));
      const xhr = ControlledXhr.last as ControlledXhr | null;
      if (!xhr) throw new Error("The upload did not go through XHR");
      return { request, xhr, isSettled: () => settled, lifetime: requestTimeoutMs(xhr.bodyLength) };
    }

    it("keeps an upload that is still sending past the size-scaled ceiling", async () => {
      const { xhr, isSettled } = startUpload();
      // 230s of slow but steady progress, past the 180s ceiling.
      for (let step = 1; step < 24; step += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        xhr.progress(step, 24);
      }
      expect(23 * 10_000).toBeGreaterThan(API_UPLOAD_TIMEOUT_MAX_MS);
      expect(isSettled()).toBe(false);
      expect(xhr.aborted).toBe(false);
      xhr.abort();
    });

    it("reports an upload that stops making progress as a connection problem", async () => {
      const { request, xhr } = startUpload();
      await vi.advanceTimersByTimeAsync(5_000);
      xhr.progress(10, 100);

      const failure = expect(request).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
      await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
      await failure;
      expect(xhr.aborted).toBe(true);
    });

    it("bounds the wait for the reply once the body is out with REQUEST_TIMEOUT", async () => {
      const { request, xhr, isSettled, lifetime } = startUpload();
      xhr.progress(100, 100);
      xhr.upload.onload?.();
      await vi.advanceTimersByTimeAsync(lifetime - 1_000);
      expect(isSettled()).toBe(false);

      const failure = expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", status: 408 });
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
      expect(xhr.aborted).toBe(true);
    });
  });
});

describe("memo batch requests", () => {
  const items = (n: number) => Array.from({ length: n }, (_, index) => ({ id: `m${index}`, expectedSeq: index + 1 }));
  const jsonResponse = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

  it("chunks a large selection and reports settled items after each request", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: { id: string; expectedSeq: number }[] };
      return Promise.resolve(
        jsonResponse(200, { patches: body.items.map((item) => ({ id: item.id, deletedAt: "2026-01-01T00:00:00.000Z", seq: 900 })), failed: [] })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];

    const result = await batchMemos("trash", items(450), { onProgress: (settled) => progress.push(settled) });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).items.length)).toEqual([200, 200, 50]);
    expect(progress).toEqual([200, 400, 450]);
    expect(result.patches).toHaveLength(450);
    expect(result.failed).toEqual([]);
  });

  it("sends tags in smaller chunks with the tag name", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { memos: [], unchanged: [], failed: [] }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await batchMemos("tag", items(31), { tag: "work" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ op: "tag", tag: "work" });
  });

  it("keeps committed chunks and fails the rest when a request fails, but rethrows a lost session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { patches: [{ id: "m0", deletedAt: null, seq: 5 }], failed: [] }))
      .mockResolvedValueOnce(jsonResponse(500, { code: "INTERNAL_ERROR", error: "boom" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await batchMemos("restore", items(450));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.patches).toEqual([{ id: "m0", deletedAt: null, seq: 5 }]);
    expect(result.failed).toHaveLength(250);
    expect(result.failed[0]).toMatchObject({ id: "m200", code: "INTERNAL_ERROR" });

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(401, { code: "AUTH_REQUIRED", error: "Authentication required" }))));
    await expect(batchMemos("trash", items(2))).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe("auth loss reasons", () => {
  function respond401(params?: Record<string, string>) {
    const body = JSON.stringify({ code: "AUTH_REQUIRED", error: "Authentication required", ...(params ? { params } : {}) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401 })));
  }

  it("tells a revoked session from one that merely expired", async () => {
    respond401({ reason: "revoked" });
    const revoked = await syncSince(0).catch((cause: unknown) => cause);
    expect(isSessionRevoked(revoked)).toBe(true);
    expect(lastAuthLossWasRevocation()).toBe(true);

    respond401();
    const expired = await syncSince(0).catch((cause: unknown) => cause);
    expect(expired).toBeInstanceOf(AuthRequiredError);
    expect(isSessionRevoked(expired)).toBe(false);
    expect(lastAuthLossWasRevocation()).toBe(false);
  });
});
