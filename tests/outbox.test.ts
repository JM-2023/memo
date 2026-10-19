import { describe, expect, it } from "vitest";
import { ApiError, AuthRequiredError } from "../src/lib/api";
import {
  failureOf,
  freshImages,
  mapEntries,
  nextQueued,
  optimisticMemo,
  outboxRetryDelay,
  sendStatesOf,
  unsentMemos,
  withEntry,
  withoutEntry,
  type Outbox,
  type OutboxEntry
} from "../src/lib/outbox";
import type { Memo, NewImagePayload } from "../src/lib/types";

function payload(id: string): NewImagePayload {
  return { id, dataBase64: "AAAA", mime: "image/webp", width: 40, height: 30, previewUrl: `blob:${id}` };
}

function entry(id: string, at: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id,
    memo: optimisticMemo(id, id, [], new Date(at)),
    content: id,
    draft: id,
    tag: null,
    images: [],
    selection: { start: 0, end: 0 },
    status: "sending",
    failure: null,
    ...overrides
  };
}

function stored(id: string): Memo {
  return { ...optimisticMemo(id, id, []), seq: 3 };
}

describe("the outbox", () => {
  it("makes a card of a send: its id, its text, its pictures, no pin, no trash", () => {
    const memo = optimisticMemo("client-1", "hello #work", [payload("image-1")], new Date("2026-10-19T08:00:00.000Z"));
    expect(memo).toEqual({
      id: "client-1",
      content: "hello #work",
      createdAt: "2026-10-19T08:00:00.000Z",
      updatedAt: "2026-10-19T08:00:00.000Z",
      pinnedAt: null,
      deletedAt: null,
      seq: 0,
      images: [{ id: "image-1", mime: "image/webp", width: 40, height: 30, bytes: 3 }]
    });
  });

  it("keeps sends in the order they were written, an entry put back included", () => {
    const first = entry("a", "2026-10-19T08:00:00.000Z");
    const second = entry("b", "2026-10-19T08:00:01.000Z");
    const third = entry("c", "2026-10-19T08:00:02.000Z");
    let outbox: Outbox = withEntry(withEntry(withEntry(new Map(), first), second), third);
    outbox = withoutEntry(outbox, "b");
    expect([...outbox.keys()]).toEqual(["a", "c"]);
    // A discard's Undo: back in its place, not at the end.
    outbox = withEntry(outbox, second);
    expect([...outbox.keys()]).toEqual(["a", "b", "c"]);
    // A change keeps its place too.
    outbox = withEntry(outbox, { ...first, status: "failed", failure: "network" });
    expect([...outbox.keys()]).toEqual(["a", "b", "c"]);
    expect(outbox.get("a")?.status).toBe("failed");
  });

  it("sends the oldest waiting entry next, skipping the failed", () => {
    const outbox: Outbox = new Map([
      ["a", entry("a", "2026-10-19T08:00:00.000Z", { status: "failed", failure: "refused" })],
      ["b", entry("b", "2026-10-19T08:00:01.000Z")],
      ["c", entry("c", "2026-10-19T08:00:02.000Z")]
    ]);
    expect(nextQueued(outbox)?.id).toBe("b");
    expect(nextQueued(new Map())).toBeUndefined();
  });

  it("leaves the outbox untouched when nothing matches", () => {
    const outbox: Outbox = new Map([["a", entry("a", "2026-10-19T08:00:00.000Z")]]);
    expect(mapEntries(outbox, (item) => item.status === "failed", (item) => ({ ...item, status: "sending" }))).toBe(outbox);
    expect(withoutEntry(outbox, "missing")).toBe(outbox);
    const failed = mapEntries(outbox, (item) => item.status === "sending", (item) => ({ ...item, status: "failed", failure: "network" }));
    expect(failed).not.toBe(outbox);
    expect(failed.get("a")?.failure).toBe("network");
    expect(outbox.get("a")?.status).toBe("sending");
  });

  it("shows a send the server already holds as sent, never twice", () => {
    const outbox: Outbox = new Map([
      ["a", entry("a", "2026-10-19T08:00:00.000Z")],
      ["b", entry("b", "2026-10-19T08:00:01.000Z", { status: "failed", failure: "network" })],
      ["c", entry("c", "2026-10-19T08:00:02.000Z", { status: "failed", failure: "refused" })]
    ]);
    const server = new Map([["a", stored("a")]]);
    expect(unsentMemos(outbox, server).map((memo) => memo.id)).toEqual(["b", "c"]);
    expect([...sendStatesOf(outbox, server, false)]).toEqual([
      ["b", "failed"],
      ["c", "refused"]
    ]);
    // Online, the failed one is trying again on its own; a refusal still waits for a press.
    expect([...sendStatesOf(outbox, server, true)]).toEqual([
      ["b", "retrying"],
      ["c", "refused"]
    ]);
  });

  it("keeps retrying a failed send once the quick retries are spent, once a minute", () => {
    expect([0, 1, 2, 3, 4, 10].map(outboxRetryDelay)).toEqual([2_000, 6_000, 20_000, 60_000, 60_000, 60_000]);
  });

  it("tells a send that will go on its own from one only a press retries", () => {
    expect(failureOf(new ApiError("NETWORK_ERROR", 0, "offline"), true)).toBe("network");
    expect(failureOf(new ApiError("REQUEST_TIMEOUT", 408, "slow"), true)).toBe("network");
    expect(failureOf(new ApiError("INTERNAL_ERROR", 503, "down"), true)).toBe("network");
    expect(failureOf(new TypeError("Failed to fetch"), true)).toBe("network");
    expect(failureOf(new AuthRequiredError(), true)).toBe("auth");
    expect(failureOf(new ApiError("STORAGE_FULL", 507, "full"), true)).toBe("refused");
    expect(failureOf(new ApiError("MEMO_CONTENT_TOO_LONG", 400, "long"), true)).toBe("refused");
    // Offline, anything is the connection's fault.
    expect(failureOf(new ApiError("MEMO_CONTENT_TOO_LONG", 400, "long"), false)).toBe("network");
  });

  it("gives a taken-back memo's pictures new ids, keeping their bytes and previews", () => {
    const [image] = freshImages([payload("image-1")]);
    expect(image.id).not.toBe("image-1");
    expect(image).toMatchObject({ dataBase64: "AAAA", mime: "image/webp", width: 40, height: 30, previewUrl: "blob:image-1" });
  });
});
