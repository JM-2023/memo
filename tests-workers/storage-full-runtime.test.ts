import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onRequest as middleware } from "../functions/_middleware";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { MemoJson } from "../functions/api/_utils/memos";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestDelete as deleteMemo } from "../functions/api/memos/[id]";
import { onRequestPost as createMemo } from "../functions/api/memos/index";
import { onRequestDelete as emptyTrash } from "../functions/api/trash";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";

// Local D1 refuses PRAGMA max_page_count, so a real full database cannot be
// produced here. Fail every batch with the error shape D1 reports instead
// (`D1_ERROR: <sqlite message>: <code>`, sqlite message also on `cause`).
const fullDb = new Proxy(appEnv.DB, {
  get(target, property) {
    if (property === "batch") {
      return async () => {
        throw new Error("D1_ERROR: database or disk is full: SQLITE_FULL", {
          cause: new Error("database or disk is full: SQLITE_FULL")
        });
      };
    }
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  }
});

function context(request: Request, contextEnv: AppEnv, next: (ctx: AppContext) => Promise<Response>): AppContext {
  const ctx = {
    request,
    env: contextEnv,
    functionPath: new URL(request.url).pathname,
    params: {},
    data: {},
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as AppContext;
  ctx.next = () => next(ctx);
  return ctx;
}

async function authenticatedCookie(): Promise<string> {
  const auth = await claimInitialPassword(appEnv, "storage-full-hash");
  if (!auth) throw new Error("Test authentication state was not created");
  return (await createSessionCookie(appEnv, auth.sessionGeneration)).split(";", 1)[0];
}

describe("D1 storage limit", () => {
  it("answers a write on a full database with 507 STORAGE_FULL", async () => {
    const cookie = await authenticatedCookie();
    const request = new Request(`${ORIGIN}/api/memos`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "storage-full-1", content: "one more memo", images: [] })
    });

    const response = await middleware(context(request, { ...appEnv, DB: fullDb }, createMemo));

    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toMatchObject({ code: "STORAGE_FULL" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps unrelated failures on the generic 500", async () => {
    const request = new Request(`${ORIGIN}/api/memos`, { method: "POST" });
    const response = await middleware(
      context(request, appEnv, async () => {
        throw new Error("D1_ERROR: no such table: memos: SQLITE_ERROR");
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("freeing space on a full database", () => {
  const PREFIX = "storage-free-";

  async function reset() {
    await env.DB.batch([
      env.DB.prepare("DROP TRIGGER IF EXISTS storage_full_until_images_freed"),
      env.DB.prepare("DELETE FROM memo_images WHERE memo_id LIKE ?").bind(`${PREFIX}%`),
      env.DB.prepare("DELETE FROM memos WHERE id LIKE ?").bind(`${PREFIX}%`),
      env.DB.prepare("DELETE FROM tombstones WHERE id LIKE ?").bind(`${PREFIX}%`),
      env.DB.prepare("DELETE FROM auth_state"),
      env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
    ]);
  }
  beforeEach(reset);
  afterEach(reset);

  function call(path: string, cookie: string, method: "POST" | "DELETE", params: Record<string, string> = {}, body?: unknown): AppContext {
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const ctx = context(request, appEnv, async () => new Response(null, { status: 404 }));
    ctx.params = params;
    return ctx;
  }

  async function trashedMemoWithImage(cookie: string, id: string): Promise<MemoJson> {
    const image = { id: `${id}-image`, mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" };
    const created = await createMemo(call("/api/memos", cookie, "POST", {}, { id, content: "photo", images: [image] }));
    expect(created.status).toBe(200);
    const { memo } = (await created.json()) as { memo: MemoJson };
    const trashed = await deleteMemo(call(`/api/memos/${id}?expectedSeq=${memo.seq}`, cookie, "DELETE", { id }));
    expect(trashed.status).toBe(200);
    return ((await trashed.json()) as { memo: MemoJson }).memo;
  }

  // Local D1 cannot be filled for real. Stand in for "the tombstone insert
  // needs a page and none is free until the memo's attachments are gone" with
  // a trigger that refuses it the way a full database would.
  async function fillUntilImagesFreed() {
    await env.DB.prepare(
      `CREATE TRIGGER storage_full_until_images_freed BEFORE INSERT ON tombstones
       WHEN EXISTS (SELECT 1 FROM memo_images WHERE memo_id = NEW.id)
       BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`
    ).run();
  }

  it("lets a permanent delete free a memo's images before writing its tombstone", async () => {
    const cookie = await authenticatedCookie();
    const id = `${PREFIX}purge-one`;
    const trashed = await trashedMemoWithImage(cookie, id);
    await fillUntilImagesFreed();

    const purged = await deleteMemo(call(`/api/memos/${id}?permanent=1&expectedSeq=${trashed.seq}`, cookie, "DELETE", { id }));

    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toMatchObject({ ok: true, purgedIds: [id] });
    await expect(env.DB.prepare("SELECT id FROM memo_images WHERE memo_id = ?").bind(id).first()).resolves.toBeNull();
    await expect(env.DB.prepare("SELECT id FROM tombstones WHERE id = ?").bind(id).first()).resolves.toEqual({ id });
  });

  it("lets Empty Trash free attachments before writing tombstones", async () => {
    const cookie = await authenticatedCookie();
    const ids = [`${PREFIX}trash-a`, `${PREFIX}trash-b`];
    for (const id of ids) await trashedMemoWithImage(cookie, id);
    await fillUntilImagesFreed();

    const emptied = await emptyTrash(call("/api/trash", cookie, "DELETE"));

    expect(emptied.status).toBe(200);
    const body = (await emptied.json()) as { purged: { id: string; seq: number }[]; purgedIds: string[] };
    expect(body.purgedIds).toEqual(expect.arrayContaining(ids));
    expect(body.purged.every((row) => Number.isInteger(row.seq))).toBe(true);
    await expect(env.DB.prepare("SELECT COUNT(*) AS n FROM memo_images WHERE memo_id LIKE ?").bind(`${PREFIX}%`).first()).resolves.toEqual({ n: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE id LIKE ?").bind(`${PREFIX}%`).first()).resolves.toEqual({ n: 2 });
  });
});
