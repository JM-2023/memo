import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestGet as exportBackup } from "../functions/api/export";
import { onRequestPost as importBackup } from "../functions/api/import";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";

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

function post(cookie: string, body: unknown): Request {
  return new Request(`${ORIGIN}/api/import`, {
    method: "POST",
    headers: { Cookie: cookie.split(";", 1)[0], Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function get(cookie: string, path: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie.split(";", 1)[0] } });
}

async function authenticatedCookie(): Promise<string> {
  const auth = await claimInitialPassword(appEnv, "backup-runtime-hash");
  if (!auth) throw new Error("Test authentication state was not created");
  return createSessionCookie(appEnv, auth.sessionGeneration);
}

function memo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: `memo ${id}`,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    images: [],
    ...overrides
  };
}

function backup(memos: unknown[], tags: unknown[] = []) {
  return { format: "memo-backup", version: 1, exportedAt: "2026-07-16T00:00:00.000Z", memos, tags };
}

async function counter(): Promise<number> {
  const row = await env.DB.prepare("SELECT n FROM sync_counter WHERE id = 1").first<{ n: number }>();
  return row?.n ?? 0;
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
});

describe("backup import throughput", () => {
  it("writes a 100-memo chunk set-wise with contiguous seqs in file order", async () => {
    const cookie = await authenticatedCookie();
    const ids = Array.from({ length: 100 }, (_, index) => `bulk-${String(99 - index).padStart(3, "0")}`);
    // One memo already exists (skipped); one id left a tombstone behind.
    const first = await importBackup(context(post(cookie, backup([memo(ids[10])]))));
    await expect(first.json()).resolves.toEqual({ imported: 1, skipped: 0, images: 0 });
    await env.DB.prepare("INSERT INTO tombstones (id, seq) VALUES (?, 0)").bind(ids[20]).run();
    const before = await counter();

    const response = await importBackup(
      context(
        post(
          cookie,
          backup(
            ids.map((id, index) =>
              memo(id, index === 30 ? { images: [{ id: "bulk-image", mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" }] } : {})
            ),
            [{ path: "work", pinnedAt: "2026-07-16T00:00:00.000Z" }]
          )
        )
      )
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ imported: 99, skipped: 1, images: 1 });

    const rows = await env.DB
      .prepare("SELECT id, seq, content_format, created_at, pinned_at FROM memos WHERE seq > ? ORDER BY seq")
      .bind(before)
      .all<{ id: string; seq: number; content_format: string; created_at: string; pinned_at: string | null }>();
    expect(rows.results.map((row) => row.id)).toEqual(ids.filter((_, index) => index !== 10));
    expect(rows.results.map((row) => row.seq)).toEqual(Array.from({ length: 99 }, (_, index) => before + 1 + index));
    expect(rows.results[0]).toMatchObject({ created_at: "2026-07-16T00:00:00.000Z", pinned_at: null });
    // 99 memos + one pinned tag.
    expect(await counter()).toBe(before + 100);
    await expect(env.DB.prepare("SELECT id FROM tombstones WHERE id = ?").bind(ids[20]).first()).resolves.toBeNull();
    await expect(env.DB.prepare("SELECT memo_id FROM memo_images WHERE id = 'bulk-image'").first()).resolves.toEqual({
      memo_id: ids[30]
    });

    const retry = await importBackup(context(post(cookie, backup(ids.map((id) => memo(id))))));
    await expect(retry.json()).resolves.toEqual({ imported: 0, skipped: 100, images: 0 });
    expect(await counter()).toBe(before + 100);
  });

  it("splits text past the bound-value ceiling into several groups", async () => {
    const cookie = await authenticatedCookie();
    const before = await counter();
    const memos = Array.from({ length: 20 }, (_, index) => memo(`long-${String(index).padStart(2, "0")}`, { content: `${index}`.padEnd(39_000, "x") }));

    const response = await importBackup(context(post(cookie, backup(memos))));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ imported: 20, skipped: 0, images: 0 });
    const rows = await env.DB.prepare("SELECT id, seq, length(content) AS chars FROM memos ORDER BY seq").all<{ id: string; seq: number; chars: number }>();
    expect(rows.results.map((row) => row.id)).toEqual(memos.map((item) => item.id));
    expect(rows.results.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_, index) => before + 1 + index));
    expect(rows.results.every((row) => row.chars === 39_000)).toBe(true);
  });

  it("still caps a chunk's memo count", async () => {
    const cookie = await authenticatedCookie();
    const response = await importBackup(context(post(cookie, backup(Array.from({ length: 101 }, (_, index) => memo(`cap-${index}`))))));
    expect(response.status).toBe(413);
  });
});

describe("backup export pages", () => {
  async function seed(cookie: string, count: number) {
    const ids = Array.from({ length: count }, (_, index) => `page-${String(index).padStart(3, "0")}`);
    for (let start = 0; start < count; start += 100) {
      const response = await importBackup(
        context(post(cookie, backup(ids.slice(start, start + 100).map((id) => memo(id)), start === 0 ? [{ path: "pinned", pinnedAt: "2026-07-16T00:00:00.000Z" }] : [])))
      );
      expect(response.status).toBe(200);
    }
    return ids;
  }

  it("serves verbatim file slices whose concatenation is the backup", async () => {
    const cookie = await authenticatedCookie();
    const ids = await seed(cookie, 120);

    const bodies: string[] = [];
    const counts: number[] = [];
    let total: string | null = null;
    let next: string | null = null;
    do {
      const response = await exportBackup(context(get(cookie, `/api/export?parts=1${next ? `&after=${encodeURIComponent(next)}` : ""}`)));
      expect(response.status).toBe(200);
      if (bodies.length === 0) total = response.headers.get("X-Export-Total");
      else expect(response.headers.get("X-Export-Total")).toBeNull();
      counts.push(Number(response.headers.get("X-Export-Count")));
      next = response.headers.get("X-Export-Next");
      bodies.push(await response.text());
    } while (next && bodies.length < 10);

    expect(total).toBe("120");
    expect(bodies).toHaveLength(3);
    expect(counts).toEqual([50, 50, 20]);
    const file = JSON.parse(bodies.join("")) as { format: string; version: number; memos: { id: string }[]; tags: { path: string }[] };
    expect(file.format).toBe("memo-backup");
    expect(file.version).toBe(1);
    expect(file.memos.map((item) => item.id)).toEqual(ids);
    expect(file.tags).toEqual([{ path: "pinned", pinnedAt: "2026-07-16T00:00:00.000Z" }]);
  });

  it("closes an empty notebook in one page", async () => {
    const cookie = await authenticatedCookie();
    const response = await exportBackup(context(get(cookie, "/api/export?parts=1")));
    expect(response.headers.get("X-Export-Total")).toBe("0");
    expect(response.headers.get("X-Export-Next")).toBeNull();
    expect(JSON.parse(await response.text())).toMatchObject({ format: "memo-backup", version: 1, memos: [], tags: [] });
  });

  it("keeps self-contained JSON pages for clients without parts", async () => {
    const cookie = await authenticatedCookie();
    await seed(cookie, 60);
    const first = (await (await exportBackup(context(get(cookie, "/api/export")))).json()) as {
      memos: unknown[];
      tags: unknown[];
      hasMore: boolean;
      nextAfter: string;
    };
    expect(first).toMatchObject({ format: "memo-backup", version: 1, hasMore: true });
    expect(first.memos).toHaveLength(50);
    expect(first.tags).toHaveLength(1);
    const second = (await (await exportBackup(context(get(cookie, `/api/export?after=${encodeURIComponent(first.nextAfter)}`)))).json()) as {
      memos: unknown[];
      tags: unknown[];
      hasMore: boolean;
      nextAfter: string | null;
    };
    expect(second).toMatchObject({ hasMore: false, nextAfter: null, tags: [] });
    expect(second.memos).toHaveLength(10);
  });
});
