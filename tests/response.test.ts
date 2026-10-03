import { describe, expect, it } from "vitest";
import { isStorageFullError, readJson } from "../functions/api/_utils/response";

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

describe("isStorageFullError", () => {
  it("recognizes the SQLite and D1 wordings for a full database or account, including on cause", () => {
    expect(isStorageFullError(new Error("D1_ERROR: database or disk is full: SQLITE_FULL"))).toBe(true);
    expect(isStorageFullError(new Error("D1_ERROR: Exceeded maximum DB size"))).toBe(true);
    expect(
      isStorageFullError(new Error("D1_ERROR: Your account has exceeded D1's maximum account storage limit. Please upgrade your plan."))
    ).toBe(true);
    expect(isStorageFullError(new Error("D1_ERROR", { cause: new Error("database or disk is full") }))).toBe(true);
  });

  it("leaves other D1 failures alone", () => {
    expect(isStorageFullError(new Error("D1_ERROR: UNIQUE constraint failed: memos.id: SQLITE_CONSTRAINT"))).toBe(false);
    expect(isStorageFullError(new Error("D1 DB is overloaded. Too many requests queued."))).toBe(false);
    expect(isStorageFullError(null)).toBe(false);
  });
});
