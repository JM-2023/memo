import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/_middleware";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";

function context(url: string, next: () => Promise<Response>): AppContext {
  return {
    request: new Request(url),
    env: {} as AppEnv,
    functionPath: new URL(url).pathname,
    params: {},
    data: {},
    waitUntil() {},
    passThroughOnException() {},
    next
  } as AppContext;
}

describe("Pages canonical host routing", () => {
  it("redirects only the exact production Pages hostname", async () => {
    const productionNext = vi.fn(async () => new Response("unexpected"));
    const production = await onRequest(context("https://project.pages.dev/api/status?check=1", productionNext));

    expect(production.status).toBe(301);
    expect(production.headers.get("Location")).toBe("https://notes.example/api/status?check=1");
    expect(productionNext).not.toHaveBeenCalled();

    const previewNext = vi.fn(async () => new Response("preview-ok"));
    const preview = await onRequest(context("https://a1b2c3.project.pages.dev/api/status", previewNext));

    expect(preview.status).toBe(200);
    await expect(preview.text()).resolves.toBe("preview-ok");
    expect(previewNext).toHaveBeenCalledOnce();
  });
});
