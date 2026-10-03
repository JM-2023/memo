import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { MemoJson } from "../functions/api/_utils/memos";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestDelete as deleteMemo, onRequestPut as putMemo } from "../functions/api/memos/[id]";
import { onRequestPost as createMemo } from "../functions/api/memos/index";

// A repeated pin / trash / restore (a second tap, a retried request, another
// device that got there first) is an intent the memo already satisfies. It
// must answer with the memo's state, not a "changed elsewhere" conflict —
// while a stale request that would actually change something still conflicts.

const appEnv: AppEnv = env;
const MEMO_ID = "idempotent-actions-memo";
const ORIGIN = "https://memo.example";

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

async function put(cookie: string, body: unknown): Promise<Response> {
  return putMemo(context(request(`/api/memos/${MEMO_ID}`, cookie, "PUT", body), { id: MEMO_ID }));
}

async function trash(cookie: string, expectedSeq: number): Promise<Response> {
  return deleteMemo(context(request(`/api/memos/${MEMO_ID}?expectedSeq=${expectedSeq}`, cookie, "DELETE"), { id: MEMO_ID }));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memo_images WHERE memo_id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM tombstones WHERE id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
  ]);
});

async function setup(): Promise<{ cookie: string; created: MemoJson }> {
  const auth = await claimInitialPassword(appEnv, "idempotent-test-hash");
  if (!auth) throw new Error("Test authentication state was not created");
  const cookie = await createSessionCookie(appEnv, auth.sessionGeneration);
  const response = await createMemo(context(request("/api/memos", cookie, "POST", { id: MEMO_ID, content: "first draft" })));
  expect(response.status).toBe(200);
  return { cookie, created: ((await response.json()) as { memo: MemoJson }).memo };
}

describe("repeated memo actions", () => {
  it("answers a stale repeat pin with the current memo instead of a conflict", async () => {
    const { cookie, created } = await setup();
    const first = await put(cookie, { expectedSeq: created.seq, pinned: true });
    expect(first.status).toBe(200);
    const pinned = (await first.json()) as { memoPatch: { pinnedAt: string; seq: number } };

    const repeat = await put(cookie, { expectedSeq: created.seq, pinned: true });
    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as { memo?: MemoJson; memoPatch?: unknown };
    expect(body.memoPatch).toBeUndefined();
    expect(body.memo?.seq).toBe(pinned.memoPatch.seq);
    expect(body.memo?.pinnedAt).toBe(pinned.memoPatch.pinnedAt);
    expect(body.memo?.content).toBe("first draft");

    // A stale request that would change the state still conflicts.
    const staleUnpin = await put(cookie, { expectedSeq: created.seq, pinned: false });
    expect(staleUnpin.status).toBe(409);
  });

  it("treats a second trip to Trash and a second restore as done", async () => {
    const { cookie, created } = await setup();
    const trashed = await trash(cookie, created.seq);
    expect(trashed.status).toBe(200);
    const trashedMemo = ((await trashed.json()) as { memo: MemoJson }).memo;

    const repeatTrash = await trash(cookie, created.seq);
    expect(repeatTrash.status).toBe(200);
    expect(((await repeatTrash.json()) as { memo: MemoJson }).memo.seq).toBe(trashedMemo.seq);

    const restored = await put(cookie, { expectedSeq: trashedMemo.seq, restore: true });
    expect(restored.status).toBe(200);
    const restoredMemo = ((await restored.json()) as { memo: MemoJson }).memo;
    expect(restoredMemo.deletedAt).toBeNull();

    const repeatRestore = await put(cookie, { expectedSeq: trashedMemo.seq, restore: true });
    expect(repeatRestore.status).toBe(200);
    expect(((await repeatRestore.json()) as { memo: MemoJson }).memo.seq).toBe(restoredMemo.seq);

    // A stale trash of a memo that has since come back still conflicts.
    const staleTrash = await trash(cookie, created.seq);
    expect(staleTrash.status).toBe(409);
  });
});
