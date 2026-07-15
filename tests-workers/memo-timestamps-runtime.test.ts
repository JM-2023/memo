import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { MemoJson } from "../functions/api/_utils/memos";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestDelete as deleteMemo, onRequestPut as putMemo } from "../functions/api/memos/[id]";
import { onRequestPost as createMemo } from "../functions/api/memos/index";

const appEnv: AppEnv = env;
const MEMO_ID = "timestamp-contract-memo";
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

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memo_images WHERE memo_id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM tombstones WHERE id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
  ]);
});

describe("memo timestamp contract", () => {
  it("keeps created_at immutable and changes updated_at only for content or attachment edits", async () => {
    const auth = await claimInitialPassword(appEnv, "timestamp-test-hash");
    if (!auth) throw new Error("Test authentication state was not created");
    const cookie = await createSessionCookie(appEnv, auth.sessionGeneration);

    const createdResponse = await createMemo(
      context(request("/api/memos", cookie, "POST", { id: MEMO_ID, content: "first draft" }))
    );
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as { memo: MemoJson };
    expect(created.memo.updatedAt).toBe(created.memo.createdAt);

    const originalSentAt = "2020-01-02T03:04:05.000Z";
    await env.DB
      .prepare("UPDATE memos SET created_at = ?, updated_at = ? WHERE id = ?")
      .bind(originalSentAt, originalSentAt, MEMO_ID)
      .run();

    const editResponse = await putMemo(
      context(
        request(`/api/memos/${MEMO_ID}`, cookie, "PUT", {
          expectedSeq: created.memo.seq,
          content: "second draft"
        }),
        { id: MEMO_ID }
      )
    );
    expect(editResponse.status).toBe(200);
    const edited = (await editResponse.json()) as { memo: MemoJson };
    expect(edited.memo.createdAt).toBe(originalSentAt);
    expect(edited.memo.updatedAt).not.toBe(originalSentAt);
    const lastEditedAt = edited.memo.updatedAt;

    const pinResponse = await putMemo(
      context(
        request(`/api/memos/${MEMO_ID}`, cookie, "PUT", {
          expectedSeq: edited.memo.seq,
          pinned: true
        }),
        { id: MEMO_ID }
      )
    );
    expect(pinResponse.status).toBe(200);
    const pinned = (await pinResponse.json()) as { memoPatch: { seq: number } };

    const trashResponse = await deleteMemo(
      context(request(`/api/memos/${MEMO_ID}?expectedSeq=${pinned.memoPatch.seq}`, cookie, "DELETE"), { id: MEMO_ID })
    );
    expect(trashResponse.status).toBe(200);
    const trashed = (await trashResponse.json()) as { memo: MemoJson };

    const restoreResponse = await putMemo(
      context(
        request(`/api/memos/${MEMO_ID}`, cookie, "PUT", {
          expectedSeq: trashed.memo.seq,
          restore: true
        }),
        { id: MEMO_ID }
      )
    );
    expect(restoreResponse.status).toBe(200);

    const stored = await env.DB
      .prepare("SELECT created_at, updated_at FROM memos WHERE id = ?")
      .bind(MEMO_ID)
      .first<{ created_at: string; updated_at: string }>();
    expect(stored).toEqual({ created_at: originalSentAt, updated_at: lastEditedAt });
  });
});
