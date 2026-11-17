import "fake-indexeddb/auto";
import { resolveObjectURL } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptCacheKey, forgetCacheKey } from "../src/lib/cache";
import {
  acquireImage,
  clearImageCache,
  deleteImageCacheDb,
  imageUrl,
  peekImage,
  primeImage,
  pruneImageCache,
  releaseImage
} from "../src/lib/imageCache";
import { derivePreview } from "../src/lib/imageEncode";
import { holdPreviews } from "../src/lib/outbox";
import { clearLocalDeviceData } from "../src/lib/logoutCleanup";
import type { Memo } from "../src/lib/types";

// Node has no canvas; the derivation itself is covered by its callers' contract.
vi.mock("../src/lib/imageEncode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/imageEncode")>()),
  derivePreview: vi.fn(async () => null)
}));

const KEY =btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function memoWith(...imageIds: string[]): Memo {
  return {
    id: `memo-${imageIds.join("-")}`,
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq: 1,
    images: imageIds.map((id) => ({ id, mime: "image/webp", width: 100, height: 100, bytes: 3 }))
  };
}

function imageResponse(bytes: number[] = [1, 2, 3], type = "image/webp", variant?: "preview" | "original"): Response {
  const headers: Record<string, string> = { "Content-Type": type };
  if (variant) headers["X-Image-Variant"] = variant;
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

async function bytesAt(url: string): Promise<number[]> {
  const blob = resolveObjectURL(url);
  return [...new Uint8Array(await blob!.arrayBuffer())];
}

/** Let fire-and-forget IndexedDB writes settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await deleteImageCacheDb();
  forgetCacheKey();
  fetchMock = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(derivePreview).mockReset();
  vi.mocked(derivePreview).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image URLs", () => {
  it("asks for the preview with size=thumb and the original without it", () => {
    expect(imageUrl("abc", "thumb")).toBe("/api/images/abc?size=thumb");
    expect(imageUrl("abc", "full")).toBe("/api/images/abc");
  });
});

describe("in-memory image cache", () => {
  it("downloads an image once for concurrent and later holders", async () => {
    const [first, second] = await Promise.all([acquireImage("a", "thumb"), acquireImage("a", "thumb")]);
    expect(first).toBe(second);
    expect(first.startsWith("blob:")).toBe(true);
    releaseImage("a", "thumb", first);
    releaseImage("a", "thumb", second);

    // A remount within the session draws from memory.
    const again = await acquireImage("a", "thumb");
    expect(again).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/images/a?size=thumb");
  });

  it("serves primed upload bytes without a request", async () => {
    primeImage("fresh", "thumb", new Blob([new Uint8Array([9])], { type: "image/webp" }));
    expect(peekImage("fresh", "thumb")).not.toBeNull();
    await acquireImage("fresh", "thumb");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects failed responses so the tile can offer a retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401, headers: { "Content-Type": "application/json" } }));
    await expect(acquireImage("denied", "thumb")).rejects.toThrow("401");
    // Nothing poisoned the cache: the retry downloads again.
    await expect(acquireImage("denied", "thumb")).resolves.toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("revokes every blob URL on clear and refuses late arrivals", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const url = await acquireImage("b", "full");
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    const late = acquireImage("c", "full");
    await flush();
    clearImageCache();
    expect(revoke).toHaveBeenCalledWith(url);
    finish(imageResponse());
    await expect(late).rejects.toThrow();
    expect(peekImage("c", "full")).toBeNull();
  });
});

describe("eviction", () => {
  it("hands a new image to its requester even when drawn images fill the budget", async () => {
    // Cards draw six 9 MiB originals: 54 MiB, past the 48 MiB idle budget,
    // so from the sixth on every new entry lands over budget.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("held-")
        ? new Response(new Uint8Array(9 * 1024 * 1024), { status: 200, headers: { "Content-Type": "image/webp" } })
        : imageResponse([9, 9, 9])
    );
    const held: string[] = [];
    for (let index = 0; index < 6; index += 1) held.push(await acquireImage(`held-${index}`, "full"));
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // A successful download must reach the card that asked for it, not be
    // evicted as the only unreferenced entry before the card can hold it.
    const url = await acquireImage("next", "thumb");
    expect(await bytesAt(url)).toEqual([9, 9, 9]);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    // The drawn images are all still alive too.
    for (const heldUrl of held) expect(resolveObjectURL(heldUrl)).toBeDefined();

    releaseImage("next", "thumb", url);
    held.forEach((heldUrl, index) => releaseImage(`held-${index}`, "full", heldUrl));
  });

  it("holds an unsent memo's pictures even when drawn images fill the budget", async () => {
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(9 * 1024 * 1024), { status: 200, headers: { "Content-Type": "image/webp" } }));
    const held: string[] = [];
    for (let index = 0; index < 6; index += 1) held.push(await acquireImage(`drawn-${index}`, "full"));

    // Not in memory (sent again under fresh ids): stored from the payload
    // and held in the same step, so neither copy is the entry evicted.
    const release = holdPreviews([
      { id: "queued", dataBase64: btoa("\x01\x02"), mime: "image/webp", width: 1, height: 1, thumbBase64: btoa("\x03"), thumbMime: "image/webp", previewUrl: "" }
    ]);
    const thumb = peekImage("queued", "thumb");
    const full = peekImage("queued", "full");
    expect(thumb && (await bytesAt(thumb))).toEqual([3]);
    expect(full && (await bytesAt(full))).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    release();
    held.forEach((url, index) => releaseImage(`drawn-${index}`, "full", url));
  });

  it("keeps a peeked URL alive until its holder can retain it", async () => {
    const big = () => new Blob([new Uint8Array(30 * 1024 * 1024)], { type: "image/webp" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      primeImage("peeked", "full", big());
      // A render paints this URL; its effect has not retained it yet.
      const url = peekImage("peeked", "full");
      // Meanwhile another load pushes unreferenced memory over budget.
      primeImage("other", "full", big());
      const held = await acquireImage("peeked", "full");
      expect(held).toBe(url);
      expect(fetchMock).not.toHaveBeenCalled();
      releaseImage("peeked", "full", held);

      // Unreferenced and no longer just peeked: the budget applies again.
      now.mockReturnValue(1_000_000 + 5_000);
      primeImage("third", "full", big());
      expect(peekImage("peeked", "full")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

describe("previews for attachments stored without one", () => {
  it("derives a preview from the original once, seals it, and keeps the original for the session", async () => {
    adoptCacheKey(KEY);
    fetchMock.mockResolvedValueOnce(imageResponse([1, 2, 3, 4], "image/jpeg", "original"));
    vi.mocked(derivePreview).mockResolvedValueOnce(new Blob([new Uint8Array([7, 7])], { type: "image/webp" }));

    const preview = await acquireImage("legacy", "thumb");
    expect(await bytesAt(preview)).toEqual([7, 7]);
    expect(vi.mocked(derivePreview).mock.calls[0][0].size).toBe(4);
    // A lone tile upgrading to the original needs no second download.
    const original = await acquireImage("legacy", "full");
    expect(await bytesAt(original)).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();

    // The next cold start reads the derived preview from disk.
    clearImageCache();
    const restored = await acquireImage("legacy", "thumb");
    expect(await bytesAt(restored)).toEqual([7, 7]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(derivePreview).toHaveBeenCalledTimes(1);
  });

  it("keeps the served bytes when they are a real preview or cannot be reduced", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse([1, 2], "image/webp", "preview"));
    expect(await bytesAt(await acquireImage("modern", "thumb"))).toEqual([1, 2]);
    expect(derivePreview).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(imageResponse([3, 4], "image/png", "original"));
    expect(await bytesAt(await acquireImage("small-legacy", "thumb"))).toEqual([3, 4]);
    expect(derivePreview).toHaveBeenCalledTimes(1);
  });

  it("never derives from a requested original", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse([1, 2, 3], "image/jpeg", "original"));
    await acquireImage("full-only", "full");
    expect(derivePreview).not.toHaveBeenCalled();
  });
});

describe("sealed preview cache", () => {
  it("restores previews across sessions only while the key is known", async () => {
    adoptCacheKey(KEY);
    await acquireImage("p", "thumb");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A cold start: memory is empty, the sealed copy answers.
    clearImageCache();
    const url = await acquireImage("p", "thumb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const restored = resolveObjectURL(url);
    expect(restored?.type).toBe("image/webp");
    expect([...new Uint8Array(await restored!.arrayBuffer())]).toEqual([1, 2, 3]);

    // Without a session there is no key: the ciphertext stays shut.
    clearImageCache();
    forgetCacheKey();
    await acquireImage("p", "thumb");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stores nothing without a key and never seals originals", async () => {
    await acquireImage("nokey", "thumb");
    adoptCacheKey(KEY);
    await acquireImage("orig", "full");
    await flush();
    clearImageCache();
    await acquireImage("nokey", "thumb");
    await acquireImage("orig", "full");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("prunes previews whose memo is gone and keeps trashed ones", async () => {
    adoptCacheKey(KEY);
    await acquireImage("kept", "thumb");
    await acquireImage("trashed", "thumb");
    await acquireImage("purged", "thumb");
    await flush();
    const trashed = { ...memoWith("trashed"), deletedAt: "2026-01-02T00:00:00.000Z" };
    await pruneImageCache([memoWith("kept"), trashed], Date.now());
    clearImageCache();
    fetchMock.mockClear();
    await acquireImage("kept", "thumb");
    await acquireImage("trashed", "thumb");
    expect(fetchMock).not.toHaveBeenCalled();
    await acquireImage("purged", "thumb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes the sealed previews on logout", async () => {
    adoptCacheKey(KEY);
    await acquireImage("gone", "thumb");
    await flush();
    await deleteImageCacheDb();
    fetchMock.mockClear();
    await acquireImage("gone", "thumb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is part of the device cleanup an explicit logout runs", async () => {
    adoptCacheKey(KEY);
    const held = await acquireImage("logout", "thumb");
    await flush();
    await clearLocalDeviceData();
    expect(peekImage("logout", "thumb")).toBeNull();
    adoptCacheKey(KEY);
    fetchMock.mockClear();
    const after = await acquireImage("logout", "thumb");
    expect(after).not.toBe(held);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
