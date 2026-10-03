import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { MemoJson } from "../functions/api/_utils/memos";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { MAX_BATCH_ITEMS, onRequestPost as batch, type MemoBatchResult } from "../functions/api/memos/batch";
import { onRequestDelete as deleteMemo } from "../functions/api/memos/[id]";
import { onRequestPost as createMemo } from "../functions/api/memos/index";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";
const ID_PREFIX = "batch-";

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

function request(path: string, cookie: string, method: "POST" | "DELETE", body?: unknown): Request {
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
  const auth = await claimInitialPassword(appEnv, "batch-test-hash");
  if (!auth) throw new Error("Test authentication state was not created");
  return createSessionCookie(appEnv, auth.sessionGeneration);
}

async function create(cookie: string, id: string, content: string): Promise<MemoJson> {
  const response = await createMemo(context(request("/api/memos", cookie, "POST", { id: `${ID_PREFIX}${id}`, content, images: [] })));
  expect(response.status).toBe(200);
  return ((await response.json()) as { memo: MemoJson }).memo;
}

async function runBatch(cookie: string, body: unknown): Promise<{ status: number; data: MemoBatchResult & { code?: string } }> {
  const response = await batch(context(request("/api/memos/batch", cookie, "POST", body)));
  return { status: response.status, data: (await response.json()) as MemoBatchResult & { code?: string } };
}

async function counter(): Promise<number> {
  return (await env.DB.prepare("SELECT n FROM sync_counter WHERE id = 1").first<{ n: number }>())!.n;
}

const item = (memo: MemoJson, expectedSeq = memo.seq) => ({ id: memo.id, expectedSeq });

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memo_images WHERE memo_id LIKE ?").bind(`${ID_PREFIX}%`),
    env.DB.prepare("DELETE FROM memos WHERE id LIKE ?").bind(`${ID_PREFIX}%`),
    env.DB.prepare("DELETE FROM tombstones WHERE id LIKE ?").bind(`${ID_PREFIX}%`),
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
  ]);
});

describe("POST /api/memos/batch", () => {
  it("trashes and restores many memos in one request, one seq each, reporting conflicts per item", async () => {
    const cookie = await authenticatedCookie();
    const a = await create(cookie, "a", "first");
    const b = await create(cookie, "b", "second");
    const stale = await create(cookie, "c", "third");
    const before = await counter();

    const trashed = await runBatch(cookie, { op: "trash", items: [item(a), item(b), item(stale, stale.seq - 1), { id: `${ID_PREFIX}gone`, expectedSeq: 1 }] });
    expect(trashed.status).toBe(200);
    expect(trashed.data.failed).toEqual([
      { id: stale.id, code: "VERSION_CONFLICT" },
      { id: `${ID_PREFIX}gone`, code: "MEMO_NOT_FOUND" }
    ]);
    expect(trashed.data.patches.map((patch) => patch.id)).toEqual([a.id, b.id]);
    expect(trashed.data.patches.every((patch) => patch.deletedAt !== null)).toBe(true);
    expect(new Set(trashed.data.patches.map((patch) => patch.seq))).toEqual(new Set([before + 1, before + 2]));
    expect(await counter()).toBe(before + 2);
    const staleRow = await env.DB.prepare("SELECT deleted_at, seq FROM memos WHERE id = ?").bind(stale.id).first();
    expect(staleRow).toEqual({ deleted_at: null, seq: stale.seq });

    // Replaying at the new versions is an idempotent no-op that claims nothing.
    const replay = await runBatch(cookie, { op: "trash", items: trashed.data.patches.map((patch) => ({ id: patch.id, expectedSeq: patch.seq })) });
    expect(replay.data.patches).toEqual(trashed.data.patches);
    expect(await counter()).toBe(before + 2);

    const restored = await runBatch(cookie, { op: "restore", items: trashed.data.patches.map((patch) => ({ id: patch.id, expectedSeq: patch.seq })) });
    expect(restored.data.failed).toEqual([]);
    expect(restored.data.patches.map((patch) => patch.deletedAt)).toEqual([null, null]);
    expect(await counter()).toBe(before + 4);
  });

  it("purges only trashed memos, leaving tombstones and answering replays from them", async () => {
    const cookie = await authenticatedCookie();
    const live = await create(cookie, "live", "keep");
    const doomed = await create(cookie, "doomed", "bye");
    const trashResponse = await deleteMemo(
      context(request(`/api/memos/${doomed.id}?expectedSeq=${doomed.seq}`, cookie, "DELETE"), { id: doomed.id })
    );
    const trashedDoomed = ((await trashResponse.json()) as { memo: MemoJson }).memo;
    await env.DB
      .prepare("INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at) VALUES (?, ?, 0, 'image/png', 1, 1, 1, 'AQ==', ?)")
      .bind(`${ID_PREFIX}img`, doomed.id, trashedDoomed.createdAt)
      .run();

    const purged = await runBatch(cookie, { op: "purge", items: [item(trashedDoomed), item(live)] });
    expect(purged.data.failed).toEqual([{ id: live.id, code: "MEMO_NOT_TRASHED" }]);
    expect(purged.data.purged.map((row) => row.id)).toEqual([doomed.id]);
    await expect(env.DB.prepare("SELECT id FROM memos WHERE id = ?").bind(doomed.id).first()).resolves.toBeNull();
    await expect(env.DB.prepare("SELECT id FROM memo_images WHERE memo_id = ?").bind(doomed.id).first()).resolves.toBeNull();

    const replay = await runBatch(cookie, { op: "purge", items: [item(trashedDoomed)] });
    expect(replay.data.purged).toEqual(purged.data.purged);
  });

  it("appends a tag server-side, skipping memos that already carry it or sit in Trash", async () => {
    const cookie = await authenticatedCookie();
    const plain = await create(cookie, "plain", "A thought");
    const fenced = await create(cookie, "fenced", "```c\n#include <stdio.h>");
    const tagged = await create(cookie, "tagged", "Already #work");
    const edited = await create(cookie, "edited", "Edited #work");
    const binned = await create(cookie, "binned", "Old");
    await deleteMemo(context(request(`/api/memos/${binned.id}?expectedSeq=${binned.seq}`, cookie, "DELETE"), { id: binned.id }));

    const result = await runBatch(cookie, {
      op: "tag",
      tag: "work",
      items: [item(plain), item(fenced), item(tagged), item(edited, edited.seq - 1), item(binned)]
    });
    expect(result.status).toBe(200);
    expect(result.data.unchanged).toEqual([tagged.id]);
    expect(result.data.failed).toEqual([{ id: binned.id, code: "MEMO_TRASHED" }]);
    const byId = new Map(result.data.memos.map((memo) => [memo.id, memo]));
    expect(byId.get(plain.id)?.content).toBe("A thought\n#work");
    expect(byId.get(fenced.id)?.content).toBe("```c\n#include <stdio.h>\n```\n#work");
    // The caller's copy was older: the server copy comes back even though it needed no write.
    expect(byId.get(edited.id)?.seq).toBe(edited.seq);
    expect(byId.get(plain.id)!.seq).not.toBe(byId.get(fenced.id)!.seq);
    await expect(env.DB.prepare("SELECT content FROM memos WHERE id = ?").bind(plain.id).first()).resolves.toEqual({
      content: "A thought\n#work"
    });
  });

  it("rejects unknown operations, oversized batches and invalid tags", async () => {
    const cookie = await authenticatedCookie();
    const memo = await create(cookie, "x", "x");
    expect((await runBatch(cookie, { op: "pin", items: [item(memo)] })).status).toBe(400);
    const tooMany = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => ({ id: `${ID_PREFIX}${index}`, expectedSeq: 1 }));
    expect((await runBatch(cookie, { op: "trash", items: tooMany })).status).toBe(400);
    expect((await runBatch(cookie, { op: "tag", tag: "two words", items: [item(memo)] })).data.code).toBe("TAG_INVALID");
  });
});
