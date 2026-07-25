import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptCacheKey, openSnapshot, readSealedSnapshot, saveSnapshot, type Snapshot } from "../src/lib/cache";
import { clearLocalDeviceData } from "../src/lib/logoutCleanup";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("logout cleanup", () => {
  it("clears every current app storage family, encrypted snapshot, and named cache", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    for (const key of [
      "memo:theme",
      "memo:language",
      "memo:share-layout",
      "memo-sort",
      "memo-saved-filters",
      "memo-review-settings",
      "memo-review-day"
    ]) {
      local.setItem(key, "sensitive");
    }
    local.setItem("unrelated:preference", "keep");
    session.setItem("memo:draft", "private draft");
    session.setItem("unrelated:session", "keep");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);

    const cached = new Set(["memo-shell-v1", "memo-images-v1"]);
    const deleteCache = vi.fn(async (name: string) => cached.delete(name));
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => [...cached]),
      delete: deleteCache
    });

    const key = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const snapshot: Snapshot = { cursor: 12, syncEpoch: "server-a", memos: [], tags: [], purged: [] };
    adoptCacheKey(key);
    await saveSnapshot(snapshot);
    const retained = await readSealedSnapshot();
    expect(retained).not.toBeNull();

    await clearLocalDeviceData();

    expect([...Array(local.length)].map((_, index) => local.key(index))).toEqual(["unrelated:preference"]);
    expect([...Array(session.length)].map((_, index) => session.key(index))).toEqual(["unrelated:session"]);
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(cached.size).toBe(0);
    expect(await readSealedSnapshot()).toBeNull();
    expect(await openSnapshot(retained!)).toBeNull();
  });

  it("continues when optional storage backends deny access", async () => {
    const denied = {
      get length(): number {
        throw new Error("denied");
      },
      key: vi.fn(),
      removeItem: vi.fn()
    } as unknown as Storage;
    vi.stubGlobal("localStorage", denied);
    vi.stubGlobal("sessionStorage", denied);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["memo-shell"]),
      delete: vi.fn(async () => {
        throw new Error("denied");
      })
    });

    await expect(clearLocalDeviceData()).resolves.toBeUndefined();
  });
});
