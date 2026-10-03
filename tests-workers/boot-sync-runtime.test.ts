import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import { getOrCreateCacheKey } from "../functions/api/_utils/crypto";
import type { MemoJson, TagMetaJson } from "../functions/api/_utils/memos";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { BOOTSTRAP_PAGE_CHARS, onRequestGet as bootstrapHandler } from "../functions/api/bootstrap";
import { onRequestGet as syncHandler } from "../functions/api/sync";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";

interface BootstrapBody {
  memos: MemoJson[];
  tags: TagMetaJson[];
  cursor: number;
  syncEpoch: string;
  cacheKey?: string;
  hasMore: boolean;
  nextAfter: string | null;
  total?: number;
}

interface SyncBody {
  memos: MemoJson[];
  purged: { id: string; seq: number }[];
  tags: TagMetaJson[];
  cursor: number;
  syncEpoch: string;
  hasMore: boolean;
  cacheKey?: string;
}

function context(request: Request): AppContext {
  return {
    request,
    env: appEnv,
    functionPath: new URL(request.url).pathname,
    params: {},
    data: {},
    waitUntil() {},
    passThroughOnException() {},
    async next() {
      return new Response(null, { status: 404 });
    }
  } as AppContext;
}

let cookie = "";

async function get<T>(handler: (context: AppContext) => Promise<Response>, path: string): Promise<{ status: number; body: T }> {
  const response = await handler(context(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } })));
  return { status: response.status, body: (await response.json()) as T };
}

function bootstrapPage(after?: string | null, snapshot?: number, limit?: number) {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  if (snapshot !== undefined) params.set("snapshot", String(snapshot));
  if (limit !== undefined) params.set("limit", String(limit));
  return get<BootstrapBody>(bootstrapHandler, `/api/bootstrap${params.size ? `?${params}` : ""}`);
}

async function claimSeq(): Promise<number> {
  const row = await env.DB.prepare("UPDATE sync_counter SET n = n + 1 WHERE id = 1 RETURNING n").first<{ n: number }>();
  return row!.n;
}

async function insertMemo(id: string, createdAt: string, options: { content?: string; pinnedAt?: string | null } = {}): Promise<number> {
  const seq = await claimSeq();
  await env.DB
    .prepare(
      `INSERT INTO memos (id, content, content_format, created_at, updated_at, pinned_at, deleted_at, seq)
       VALUES (?, ?, 'plain', ?, ?, ?, NULL, ?)`
    )
    .bind(id, options.content ?? `memo ${id}`, createdAt, createdAt, options.pinnedAt ?? null, seq)
    .run();
  return seq;
}

async function editMemo(id: string, content: string): Promise<number> {
  const seq = await claimSeq();
  await env.DB.prepare("UPDATE memos SET content = ?, seq = ? WHERE id = ?").bind(content, seq, id).run();
  return seq;
}

async function purgeMemo(id: string): Promise<number> {
  const seq = await claimSeq();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(id),
    env.DB.prepare("INSERT INTO tombstones (id, seq) VALUES (?, ?)").bind(id, seq)
  ]);
  return seq;
}

function day(index: number): string {
  return new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
}

/** Every page of one cold start, following nextAfter under the frozen cursor. */
async function allPages(limit?: number): Promise<BootstrapBody[]> {
  const first = await bootstrapPage(undefined, undefined, limit);
  expect(first.status).toBe(200);
  const pages = [first.body];
  while (pages[pages.length - 1].hasMore) {
    const previous = pages[pages.length - 1];
    const next = await bootstrapPage(previous.nextAfter, first.body.cursor, limit);
    expect(next.status).toBe(200);
    pages.push(next.body);
  }
  return pages;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memo_images"),
    env.DB.prepare("DELETE FROM memos"),
    env.DB.prepare("DELETE FROM tombstones"),
    env.DB.prepare("DELETE FROM tag_meta"),
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
  ]);
  const auth = await claimInitialPassword(appEnv, "boot-sync-hash");
  if (!auth) throw new Error("Test authentication state was not created");
  cookie = (await createSessionCookie(appEnv, auth.sessionGeneration)).split(";", 1)[0];
});

describe("cold bootstrap paging", () => {
  it("pages newest first by a (created_at, id) keyset and covers every memo once", async () => {
    // Two memos share a created_at: the id breaks the tie deterministically.
    await insertMemo("m-a", day(0));
    await insertMemo("m-b", day(2));
    await insertMemo("m-c", day(1));
    await insertMemo("m-d", day(2));
    await insertMemo("m-e", day(3));

    const pages = await allPages(2);
    expect(pages.map((page) => page.memos.map((memo) => memo.id))).toEqual([["m-e", "m-d"], ["m-b", "m-c"], ["m-a"]]);
    expect(pages[0].total).toBe(5);
    expect(pages[0].cacheKey).toBe(await getOrCreateCacheKey(appEnv));
    expect(pages.slice(1).every((page) => page.cacheKey === undefined && page.total === undefined)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ hasMore: false, nextAfter: null });
    expect(new Set(pages.map((page) => page.cursor)).size).toBe(1);
  });

  it("caps a page by stored content size but always advances", async () => {
    const long = "x".repeat(Math.ceil(BOOTSTRAP_PAGE_CHARS / 2));
    await insertMemo("big-1", day(0), { content: long });
    await insertMemo("big-2", day(1), { content: long });
    await insertMemo("big-3", day(2), { content: long });
    await insertMemo("big-4", day(3), { content: "x".repeat(BOOTSTRAP_PAGE_CHARS + 10) });

    const pages = await allPages();
    // The oversized newest row fills a page alone; two half-budget rows fit
    // together; the size limit, not the row cap, decides every boundary.
    expect(pages.map((page) => page.memos.map((memo) => memo.id))).toEqual([["big-4"], ["big-3", "big-2"], ["big-1"]]);
  });

  it("sends every pinned memo with the first page, once", async () => {
    await insertMemo("old-pinned", day(0), { pinnedAt: day(10) });
    await insertMemo("mid", day(1));
    await insertMemo("new-pinned", day(2), { pinnedAt: day(11) });

    const first = await bootstrapPage(undefined, undefined, 1);
    expect(first.body.memos.map((memo) => memo.id)).toEqual(["new-pinned", "old-pinned"]);
    expect(first.body.hasMore).toBe(true);
  });

  it("sends a pinned memo's images once when it sits just past the row limit or the size budget", async () => {
    async function addImage(id: string, memoId: string, ord: number): Promise<void> {
      await env.DB
        .prepare(
          `INSERT INTO memo_images (id, memo_id, ord, mime, width, height, bytes, data_base64, created_at)
           VALUES (?, ?, ?, 'image/png', 1, 1, 1, 'AA==', ?)`
        )
        .bind(id, memoId, ord, day(0))
        .run();
    }
    const imagesOf = (body: BootstrapBody) => Object.fromEntries(body.memos.map((memo) => [memo.id, memo.images.map((image) => image.id)]));

    // Row limit: the pinned memo is the look-ahead candidate, not on the page.
    await insertMemo("old-pinned", day(0), { pinnedAt: day(10) });
    await addImage("img-1", "old-pinned", 0);
    await addImage("img-2", "old-pinned", 1);
    await insertMemo("n1", day(1));
    await insertMemo("n2", day(2));
    await addImage("img-n2", "n2", 0);
    const byLimit = await bootstrapPage(undefined, undefined, 2);
    expect(byLimit.body.memos.map((memo) => memo.id)).toEqual(["n2", "n1", "old-pinned"]);
    expect(imagesOf(byLimit.body)).toEqual({ n2: ["img-n2"], n1: [], "old-pinned": ["img-1", "img-2"] });

    // Size budget: a full-budget newest memo cuts the page before the pinned one.
    await insertMemo("huge", day(3), { content: "x".repeat(BOOTSTRAP_PAGE_CHARS) });
    const byBudget = await bootstrapPage();
    expect(byBudget.body.memos.map((memo) => memo.id)).toEqual(["huge", "old-pinned"]);
    expect(byBudget.body.hasMore).toBe(true);
    expect(imagesOf(byBudget.body)).toEqual({ huge: [], "old-pinned": ["img-1", "img-2"] });
    // The memo's own keyset page later carries the same single copy.
    const pages = await allPages(2);
    const later = pages.slice(1).flatMap((page) => page.memos).find((memo) => memo.id === "old-pinned");
    expect(later?.images.map((image) => image.id)).toEqual(["img-1", "img-2"]);
  });

  it("hands off to sync from the frozen cursor without missing or resurrecting a concurrent change", async () => {
    for (let index = 0; index < 6; index += 1) await insertMemo(`h-${index}`, day(index));
    const first = await bootstrapPage(undefined, undefined, 2);
    const frozen = first.body.cursor;
    expect(first.body.memos.map((memo) => memo.id)).toEqual(["h-5", "h-4"]);

    // While the rest is still loading: one unloaded row is edited, one is
    // purged, and a new memo arrives (older-looking created_at than any page).
    const editedSeq = await editMemo("h-1", "edited while paging");
    const purgedSeq = await purgeMemo("h-2");
    await insertMemo("h-new", day(-1));

    const rest: BootstrapBody[] = [];
    let after = first.body.nextAfter;
    while (after) {
      const page = await bootstrapPage(after, frozen, 2);
      expect(page.status).toBe(200);
      expect(page.body.cursor).toBe(frozen);
      rest.push(page.body);
      after = page.body.hasMore ? page.body.nextAfter : null;
    }
    const paged = [...first.body.memos, ...rest.flatMap((page) => page.memos)];
    // Pages never carry a row newer than the frozen cursor.
    expect(paged.every((memo) => memo.seq <= frozen)).toBe(true);
    expect(paged.map((memo) => memo.id)).toEqual(["h-5", "h-4", "h-3", "h-0"]);

    const sync = await get<SyncBody>(syncHandler, `/api/sync?since=${frozen}`);
    expect(sync.body.memos.map((memo) => [memo.id, memo.seq])).toEqual([
      ["h-1", editedSeq],
      ["h-new", purgedSeq + 1]
    ]);
    expect(sync.body.memos[0].content).toBe("edited while paging");
    expect(sync.body.purged).toEqual([{ id: "h-2", seq: purgedSeq }]);
  });

  it("rejects malformed or future continuations", async () => {
    await insertMemo("only", day(0));
    const first = await bootstrapPage();
    expect((await bootstrapPage("no-separator", first.body.cursor)).status).toBe(400);
    expect((await bootstrapPage(`${day(0)}~bad id!`, first.body.cursor)).status).toBe(400);
    expect((await get(bootstrapHandler, `/api/bootstrap?after=${encodeURIComponent(`${day(0)}~only`)}`)).status).toBe(400);
    expect((await bootstrapPage(`${day(0)}~only`, first.body.cursor + 50)).status).toBe(400);
  });
});

describe("incremental sync in one batch", () => {
  it("pages the combined change stream without splitting a seq and returns the cache key on request", async () => {
    const base = (await get<SyncBody>(syncHandler, "/api/sync?since=0")).body.cursor;
    await insertMemo("s-1", day(0));
    await insertMemo("s-2", day(1));
    const tagSeq = await claimSeq();
    await env.DB.prepare("INSERT INTO tag_meta (path, pinned_at, updated_at, seq) VALUES ('work', ?, ?, ?)").bind(day(5), day(5), tagSeq).run();
    const purgedSeq = await insertMemo("s-3", day(2)).then(() => purgeMemo("s-3"));

    const first = await get<SyncBody>(syncHandler, `/api/sync?since=${base}&limit=2&cacheKey=1`);
    expect(first.body.memos.map((memo) => memo.id)).toEqual(["s-1", "s-2"]);
    expect(first.body).toMatchObject({ hasMore: true, cursor: base + 2, purged: [], tags: [] });
    expect(first.body.cacheKey).toBe(await getOrCreateCacheKey(appEnv));

    const second = await get<SyncBody>(syncHandler, `/api/sync?since=${first.body.cursor}&limit=2`);
    expect(second.body.memos).toEqual([]);
    expect(second.body.tags.map((tag) => tag.path)).toEqual(["work"]);
    expect(second.body.purged).toEqual([{ id: "s-3", seq: purgedSeq }]);
    expect(second.body).toMatchObject({ hasMore: false, cursor: purgedSeq });
    expect(second.body.cacheKey).toBeUndefined();

    const idle = await get<SyncBody>(syncHandler, `/api/sync?since=${second.body.cursor}&cacheKey=1`);
    expect(idle.body).toMatchObject({ memos: [], purged: [], tags: [], hasMore: false, cursor: purgedSeq });
    expect(idle.body.cacheKey).toBe(first.body.cacheKey);
  });

  it("repairs a malformed stored cache key instead of handing it out", async () => {
    await env.DB
      .prepare(
        "INSERT INTO app_settings (key, value_json, updated_at) VALUES ('client_cache_key', '{\"key\":\"short\"}', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
      )
      .bind(day(0))
      .run();
    const response = await get<SyncBody>(syncHandler, "/api/sync?since=0&cacheKey=1");
    expect(response.body.cacheKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(response.body.cacheKey).toBe(await getOrCreateCacheKey(appEnv));
  });
});
