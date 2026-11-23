import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestDelete as trashMemo } from "../functions/api/memos/[id]";
import { onRequestPost as createMemo } from "../functions/api/memos/index";
import { databaseLimitBytes, onRequestGet as getStorage, type StorageReportJson } from "../functions/api/storage";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";
// 6 original bytes → 8 base64 chars; 3 preview bytes → 4.
const ORIGINAL = "AQIDBAUG";
const PREVIEW = "CQgH";

function context(request: Request, params: Record<string, string> = {}, overrides: Partial<AppEnv> = {}): AppContext {
  return {
    request,
    env: { ...appEnv, ...overrides },
    functionPath: new URL(request.url).pathname,
    params,
    data: {},
    waitUntil() {},
    passThroughOnException() {},
    async next() {
      return new Response(null, { status: 404 });
    }
  } as AppContext;
}

function request(path: string, cookie: string | null, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie.split(";", 1)[0];
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
}

async function report(overrides: Partial<AppEnv> = {}): Promise<StorageReportJson> {
  const response = await getStorage(context(request("/api/storage", cookie), {}, overrides));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return (await response.json()) as StorageReportJson;
}

let cookie = "";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')"),
    env.DB.prepare("DELETE FROM memo_images"),
    env.DB.prepare("DELETE FROM memos")
  ]);
  const auth = await claimInitialPassword(appEnv, "storage-test-hash");
  cookie = await createSessionCookie(appEnv, auth!.sessionGeneration);
});

describe("storage report", () => {
  it("needs a session", async () => {
    const response = await getStorage(context(request("/api/storage", null)));
    expect(response.status).toBe(401);
  });

  it("measures text in bytes and attachments as stored, split between notes and Trash", async () => {
    const created = await createMemo(
      context(
        request("/api/memos", cookie, {
          method: "POST",
          body: {
            id: "storage-a",
            content: "héllo 世界",
            images: [
              { id: "storage-img-1", dataBase64: ORIGINAL, mime: "image/webp", width: 1600, height: 1200, thumbBase64: PREVIEW, thumbMime: "image/webp" },
              { id: "storage-img-2", dataBase64: ORIGINAL, mime: "image/png", width: 10, height: 10 }
            ]
          }
        })
      )
    );
    expect(created.status).toBe(200);
    const trashed = await createMemo(
      context(
        request("/api/memos", cookie, {
          method: "POST",
          body: { id: "storage-b", content: "old", images: [{ id: "storage-img-3", dataBase64: ORIGINAL, mime: "image/jpeg", width: 10, height: 10 }] }
        })
      )
    );
    const { memo } = (await trashed.json()) as { memo: { seq: number } };
    const moved = await trashMemo(
      context(request(`/api/memos/storage-b?expectedSeq=${memo.seq}`, cookie, { method: "DELETE" }), { id: "storage-b" })
    );
    expect(moved.status).toBe(200);

    const result = await report();
    // "héllo 世界" is 13 UTF-8 bytes, not 8 characters.
    expect(result.notes).toEqual({ memos: 1, textBytes: 13, images: 2, imageBytes: 8 + 4 + 8 });
    expect(result.trash).toEqual({ memos: 1, textBytes: 3, images: 1, imageBytes: 8 });
    expect(result.images).toEqual([
      { id: "storage-img-1", memoId: "storage-a", bytes: 12 },
      { id: "storage-img-2", memoId: "storage-a", bytes: 8 },
      { id: "storage-img-3", memoId: "storage-b", bytes: 8 }
    ]);
    expect(result.trashMemos).toEqual([{ id: "storage-b", bytes: 3 + 8 }]);
    // The runtime reports the file's real size, which holds far more than the content.
    expect(result.database.bytes).toBeGreaterThan(20 + 13 + 11);
    expect(result.database.limitBytes).toBe(500_000_000);
    expect(Number.isNaN(Date.parse(result.measuredAt))).toBe(false);
  });

  it("answers for an empty notebook", async () => {
    const result = await report();
    expect(result.notes).toEqual({ memos: 0, textBytes: 0, images: 0, imageBytes: 0 });
    expect(result.trash).toEqual({ memos: 0, textBytes: 0, images: 0, imageBytes: 0 });
    expect(result.images).toEqual([]);
    expect(result.trashMemos).toEqual([]);
  });

  it("takes the ceiling from D1_DATABASE_LIMIT_MB and ignores nonsense", async () => {
    expect((await report({ D1_DATABASE_LIMIT_MB: "10000" })).database.limitBytes).toBe(10_000_000_000);
    expect(databaseLimitBytes({ D1_DATABASE_LIMIT_MB: "lots" })).toBe(500_000_000);
    expect(databaseLimitBytes({ D1_DATABASE_LIMIT_MB: "-5" })).toBe(500_000_000);
    expect(databaseLimitBytes({})).toBe(500_000_000);
  });
});
