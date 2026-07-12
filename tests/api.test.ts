import { afterEach, describe, expect, it, vi } from "vitest";
import { API_REQUEST_TIMEOUT_MS, ApiError, getAuthStatus, syncSince } from "../src/lib/api";

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
