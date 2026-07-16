import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { MemoJson } from "../functions/api/_utils/memos";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestPost as importBackup } from "../functions/api/import";
import { onRequestDelete as deleteMemo, onRequestPut as updateMemo } from "../functions/api/memos/[id]";
import { MAX_CONTENT_CHARS, MAX_IMAGES_PER_MEMO, onRequestPost as createMemo } from "../functions/api/memos/index";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";
const ID_PREFIX = "regression-";

function context(request: Request, params: Record<string, string> = {}): AppContext {
  return {
    request,
    env: appEnv,
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

function request(path: string, cookie: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      Cookie: cookie.split(";", 1)[0],
      Origin: ORIGIN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function authenticatedCookie(): Promise<string> {
  const auth = await claimInitialPassword(appEnv, "backend-regression-hash");
  if (!auth) throw new Error("Test authentication state was not created");
  return createSessionCookie(appEnv, auth.sessionGeneration);
}

async function create(cookie: string, id: string, content = "original"): Promise<MemoJson> {
  const response = await createMemo(context(request("/api/memos", cookie, "POST", { id, content, images: [] })));
  expect(response.status).toBe(200);
  return ((await response.json()) as { memo: MemoJson }).memo;
}

function backupMemo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: "imported",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    images: [],
    ...overrides
  };
}

function backup(memos: unknown[]) {
  return {
    format: "memo-backup",
    version: 1,
    exportedAt: "2026-07-16T00:00:00.000Z",
    memos,
    tags: []
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memo_images WHERE memo_id LIKE ?").bind(`${ID_PREFIX}%`),
    env.DB.prepare("DELETE FROM memos WHERE id LIKE ?").bind(`${ID_PREFIX}%`),
    env.DB.prepare("DELETE FROM tombstones WHERE id LIKE ?").bind(`${ID_PREFIX}%`),
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
  ]);
});

describe("backend mutation regressions", () => {
  it("rejects overlong creates and updates without truncating or writing data", async () => {
    const cookie = await authenticatedCookie();
    const overlong = "x".repeat(MAX_CONTENT_CHARS + 1);
    const rejectedId = `${ID_PREFIX}create-too-long`;

    const createResponse = await createMemo(
      context(request("/api/memos", cookie, "POST", { id: rejectedId, content: overlong, images: [] }))
    );
    expect(createResponse.status).toBe(400);
    await expect(createResponse.json()).resolves.toMatchObject({
      code: "MEMO_CONTENT_TOO_LONG",
      params: { max: MAX_CONTENT_CHARS }
    });
    await expect(env.DB.prepare("SELECT id FROM memos WHERE id = ?").bind(rejectedId).first()).resolves.toBeNull();

    const existingId = `${ID_PREFIX}update-too-long`;
    const existing = await create(cookie, existingId);
    const updateResponse = await updateMemo(
      context(
        request(`/api/memos/${existingId}`, cookie, "PUT", {
          expectedSeq: existing.seq,
          content: overlong
        }),
        { id: existingId }
      )
    );
    expect(updateResponse.status).toBe(400);
    await expect(updateResponse.json()).resolves.toMatchObject({ code: "MEMO_CONTENT_TOO_LONG" });
    await expect(
      env.DB.prepare("SELECT content, seq FROM memos WHERE id = ?").bind(existingId).first()
    ).resolves.toEqual({ content: "original", seq: existing.seq });
  });

  it("rejects lossy backup content and attachment normalization before importing", async () => {
    const cookie = await authenticatedCookie();
    const overlongId = `${ID_PREFIX}import-too-long`;
    const overlongResponse = await importBackup(
      context(
        request("/api/import", cookie, "POST", backup([backupMemo(overlongId, { content: "x".repeat(MAX_CONTENT_CHARS + 1) })]))
      )
    );
    expect(overlongResponse.status).toBe(400);
    await expect(overlongResponse.json()).resolves.toMatchObject({ code: "MEMO_CONTENT_TOO_LONG" });

    const tooManyId = `${ID_PREFIX}import-too-many-images`;
    const images = Array.from({ length: MAX_IMAGES_PER_MEMO + 1 }, (_, index) => ({
      id: `${ID_PREFIX}image-${index}`,
      mime: "image/png",
      width: 1,
      height: 1,
      dataBase64: "AQ=="
    }));
    const tooManyResponse = await importBackup(
      context(request("/api/import", cookie, "POST", backup([backupMemo(tooManyId, { images })])))
    );
    expect(tooManyResponse.status).toBe(400);
    await expect(tooManyResponse.json()).resolves.toMatchObject({
      code: "IMAGE_LIMIT_EXCEEDED",
      params: { max: MAX_IMAGES_PER_MEMO }
    });

    const malformedId = `${ID_PREFIX}import-malformed-image`;
    const malformedResponse = await importBackup(
      context(
        request(
          "/api/import",
          cookie,
          "POST",
          backup([
            backupMemo(malformedId, {
              // Numeric base64 used to be string-coerced and silently accepted.
              images: [{ id: `${ID_PREFIX}broken-image`, mime: "image/png", width: 1, height: 1, dataBase64: 1234 }]
            })
          ])
        )
      )
    );
    expect(malformedResponse.status).toBe(400);
    await expect(malformedResponse.json()).resolves.toMatchObject({ code: "BACKUP_IMAGE_INVALID" });

    const collisionImageId = `${ID_PREFIX}existing-image`;
    const ownerId = `${ID_PREFIX}image-owner`;
    const ownerResponse = await createMemo(
      context(
        request("/api/memos", cookie, "POST", {
          id: ownerId,
          content: "owner",
          images: [{ id: collisionImageId, mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" }]
        })
      )
    );
    expect(ownerResponse.status).toBe(200);
    const collisionMemoId = `${ID_PREFIX}import-image-collision`;
    const collisionResponse = await importBackup(
      context(
        request(
          "/api/import",
          cookie,
          "POST",
          backup([
            backupMemo(collisionMemoId, {
              images: [{ id: collisionImageId, mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" }]
            })
          ])
        )
      )
    );
    expect(collisionResponse.status).toBe(409);
    await expect(collisionResponse.json()).resolves.toMatchObject({ code: "BACKUP_IMAGE_INVALID" });

    const stored = await env.DB
      .prepare("SELECT id FROM memos WHERE id IN (?, ?, ?, ?)")
      .bind(overlongId, tooManyId, malformedId, collisionMemoId)
      .all();
    expect(stored.results).toEqual([]);
  });

  it("rejects malformed, duplicate, and empty backup memos instead of reporting them as skipped", async () => {
    const cookie = await authenticatedCookie();
    const duplicateId = `${ID_PREFIX}duplicate-import-id`;
    const emptyId = `${ID_PREFIX}empty-import`;
    const cases = [
      backup([backupMemo("invalid memo id")]),
      backup([backupMemo(duplicateId), backupMemo(duplicateId)]),
      backup([backupMemo(emptyId, { content: "", images: [] })])
    ];

    for (const payload of cases) {
      const response = await importBackup(context(request("/api/import", cookie, "POST", payload)));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "BACKUP_MEMO_INVALID" });
    }

    const stored = await env.DB
      .prepare("SELECT id FROM memos WHERE id IN (?, ?)")
      .bind(duplicateId, emptyId)
      .all();
    expect(stored.results).toEqual([]);
  });

  it("reports skipped only for valid memo ids that already exist", async () => {
    const cookie = await authenticatedCookie();
    const existingId = `${ID_PREFIX}already-imported`;
    const importedId = `${ID_PREFIX}new-import`;
    const importedImageId = `${ID_PREFIX}new-import-image`;
    await create(cookie, existingId);
    const payload = backup([
      backupMemo(existingId),
      backupMemo(importedId, {
        images: [{ id: importedImageId, mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" }]
      })
    ]);

    const first = await importBackup(context(request("/api/import", cookie, "POST", payload)));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ imported: 1, skipped: 1, images: 1 });

    const retry = await importBackup(context(request("/api/import", cookie, "POST", payload)));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ imported: 0, skipped: 2, images: 0 });
    await expect(
      env.DB.prepare("SELECT memo_id FROM memo_images WHERE id = ?").bind(importedImageId).first()
    ).resolves.toEqual({ memo_id: importedId });
  });

  it("requires a memo to be in Trash before permanently deleting it", async () => {
    const cookie = await authenticatedCookie();
    const id = `${ID_PREFIX}purge-active`;
    const active = await create(cookie, id);

    const rejected = await deleteMemo(
      context(request(`/api/memos/${id}?permanent=1&expectedSeq=${active.seq}`, cookie, "DELETE"), { id })
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({ code: "MEMO_NOT_TRASHED" });
    await expect(env.DB.prepare("SELECT id FROM memos WHERE id = ?").bind(id).first()).resolves.toEqual({ id });
    await expect(env.DB.prepare("SELECT id FROM tombstones WHERE id = ?").bind(id).first()).resolves.toBeNull();

    const trashResponse = await deleteMemo(
      context(request(`/api/memos/${id}?expectedSeq=${active.seq}`, cookie, "DELETE"), { id })
    );
    expect(trashResponse.status).toBe(200);
    const trashed = ((await trashResponse.json()) as { memo: MemoJson }).memo;
    const purged = await deleteMemo(
      context(request(`/api/memos/${id}?permanent=1&expectedSeq=${trashed.seq}`, cookie, "DELETE"), { id })
    );
    expect(purged.status).toBe(200);
    await expect(env.DB.prepare("SELECT id FROM memos WHERE id = ?").bind(id).first()).resolves.toBeNull();
    await expect(env.DB.prepare("SELECT id FROM tombstones WHERE id = ?").bind(id).first()).resolves.toEqual({ id });
  });
});
