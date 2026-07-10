import { describe, expect, it } from "vitest";
import { readJson } from "../functions/api/_utils/response";

function streamedRequest(parts: string[]): Request {
  const encoder = new TextEncoder();
  return new Request("https://memo.test/api/test", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      }
    }),
    // Required by Node's Request implementation for a streaming body.
    duplex: "half"
  } as RequestInit & { duplex: "half" });
}

describe("bounded JSON request parsing", () => {
  it("parses a streamed body without Content-Length", async () => {
    await expect(readJson<{ ok: boolean }>(streamedRequest(["{\"ok\"", ":true}"]), 32)).resolves.toEqual({ ok: true });
  });

  it("rejects actual streamed bytes above the endpoint limit", async () => {
    await expect(readJson(streamedRequest(["{\"value\":\"", "too-large\"}"]), 12)).rejects.toThrow("Request body is too large");
  });
});
