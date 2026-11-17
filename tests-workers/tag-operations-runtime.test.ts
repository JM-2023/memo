import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import { InvalidTagTargetError, rewriteTag, TagRewriteBlockedError } from "../functions/api/_utils/tagops";
import { onRequestPost as removeTagEndpoint } from "../functions/api/tags/remove";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";

const appEnv: AppEnv = env;
const MEMO_ID = "tag-code-span-regression";

function context(): AppContext {
  const request = new Request("https://memo.example/api/tags/rename", { method: "POST" });
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

async function runTagOperation(from: string, to: string | null, operationId: string): Promise<void> {
  let after: string | null | undefined;
  for (let page = 0; page < 4; page += 1) {
    const result = await rewriteTag(context(), from, to, operationId, after);
    if (!result?.hasMore) return;
    after = result.nextAfter;
  }
  throw new Error("Tag operation did not finish within the expected bounded passes");
}

async function storedContent(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT content FROM memos WHERE id = ?").bind(MEMO_ID).first<{ content: string }>();
  return row?.content ?? null;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memo_images WHERE memo_id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(MEMO_ID),
    env.DB.prepare("DELETE FROM tag_operation_lock")
  ]);
});

describe("server tag operations and inline code", () => {
  it("renames rendered tags without rewriting code examples", async () => {
    await env.DB
      .prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(MEMO_ID, "Example `#work` and #work/project", "2026-07-26T00:00:00.000Z", "2026-07-26T00:00:00.000Z")
      .run();

    await runTagOperation("work", "life", "rename-code-span");

    await expect(storedContent()).resolves.toBe("Example `#work` and #life/project");
  });

  it("leaves fenced code blocks untouched when removing a tag found only in code", async () => {
    const content = "C snippet\n```c\n#include <stdio.h>\n```\n#work";
    await env.DB
      .prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(MEMO_ID, content, "2026-07-26T00:00:00.000Z", "2026-07-26T00:00:00.000Z")
      .run();

    await expect(rewriteTag(context(), "include", null, "remove-fenced-code")).resolves.toBeNull();
    await expect(storedContent()).resolves.toBe(content);

    await runTagOperation("work", "life", "rename-beside-fence");
    await expect(storedContent()).resolves.toBe("C snippet\n```c\n#include <stdio.h>\n```\n#life");
  });

  it("removes rendered tags without deleting code examples", async () => {
    await env.DB
      .prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(MEMO_ID, "Keep `#work` and remove #work", "2026-07-26T00:00:00.000Z", "2026-07-26T00:00:00.000Z")
      .run();

    await runTagOperation("work", null, "remove-code-span");

    await expect(storedContent()).resolves.toBe("Keep `#work` and remove");
  });
});

describe("server tag operation paging", () => {
  const PREFIX = "tag-paging-";
  const stamp = "2026-07-26T00:00:00.000Z";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memos WHERE id LIKE ?").bind(`${PREFIX}%`),
      env.DB.prepare("DELETE FROM tag_operation_lock")
    ]);
  });

  async function seed(contents: string[]): Promise<void> {
    await env.DB.batch(
      contents.map((content, index) =>
        env.DB
          .prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .bind(`${PREFIX}${String(index).padStart(4, "0")}`, content, stamp, stamp)
      )
    );
  }

  async function pages(from: string, to: string | null, operationId: string) {
    const results = [];
    let after: string | null | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const result = await rewriteTag(context(), from, to, operationId, after);
      if (!result) return results;
      results.push(result);
      if (!result.hasMore) return results;
      after = result.nextAfter;
    }
    throw new Error("Tag operation did not finish");
  }

  async function contents(): Promise<string[]> {
    const result = await env.DB.prepare("SELECT content FROM memos WHERE id LIKE ? ORDER BY id").bind(`${PREFIX}%`).all<{ content: string }>();
    return (result.results ?? []).map((row) => row.content);
  }

  it("scans a sparse notebook in a few large pages and reports progress", async () => {
    await seed(Array.from({ length: 450 }, (_, index) => (index % 150 === 0 ? `hit #sparse ${index}` : `plain ${index}`)));
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM memos").first<{ n: number }>())!.n;

    const results = await pages("sparse", "thin", "rename-sparse");
    // Two validation pages (400 rows each) plus three write pages (200 each),
    // where 20-row pages used to need 46 requests.
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.reduce((sum, page) => sum + page.updated, 0)).toBe(3);
    const progress = results.map((page) => page.progress);
    expect(progress.at(-1)).toEqual({ done: total * 2, total: total * 2 });
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index].done).toBeGreaterThanOrEqual(progress[index - 1].done);
    }
    expect((await contents()).filter((content) => content.includes("#thin"))).toHaveLength(3);
  });

  it("stops a write page before the change that would exceed the per-invocation budget", async () => {
    await seed(Array.from({ length: 45 }, (_, index) => `dense ${index} #dense`));
    const results = await pages("dense", null, "remove-dense");
    // One validation page writes nothing, then two capped write pages.
    expect(results.map((page) => page.updated)).toEqual([0, 30, 15]);
    expect((await contents()).every((content) => !content.includes("#dense"))).toBe(true);
  });

  it("caps a page by stored characters so long memos travel in small pages", async () => {
    const long = "x".repeat(150_000);
    await seed(Array.from({ length: 5 }, (_, index) => `${long} ${index} #long`));
    const results = await pages("long", null, "remove-long");
    // Validation first (800k per page holds all five), then 400k characters
    // per write page: three 150k memos start before the cut. Memos already
    // past the length limit are not the removal's doing and do not block it.
    expect(results.map((page) => page.updated)).toEqual([0, 3, 2]);
    expect((await contents()).every((content) => !content.includes("#long"))).toBe(true);
  });
});

describe("server tag operation validation", () => {
  const PREFIX = "tag-valid-";
  const stamp = "2026-07-26T00:00:00.000Z";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memo_images WHERE memo_id LIKE ?").bind(`${PREFIX}%`),
      env.DB.prepare("DELETE FROM memos WHERE id LIKE ?").bind(`${PREFIX}%`),
      env.DB.prepare("DELETE FROM tag_operation_lock")
    ]);
  });

  const idOf = (index: number) => `${PREFIX}${String(index).padStart(4, "0")}`;

  async function seed(contents: string[]): Promise<void> {
    await env.DB.batch(
      contents.map((content, index) =>
        env.DB.prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(idOf(index), content, stamp, stamp)
      )
    );
  }

  async function run(from: string, to: string | null, operationId: string, resume?: string): Promise<void> {
    let after: string | null | undefined = resume;
    for (let guard = 0; guard < 50; guard += 1) {
      const result = await rewriteTag(context(), from, to, operationId, after);
      if (!result?.hasMore) return;
      after = result.nextAfter;
    }
    throw new Error("Tag operation did not finish");
  }

  async function contents(): Promise<string[]> {
    const result = await env.DB.prepare("SELECT content FROM memos WHERE id LIKE ? ORDER BY id").bind(`${PREFIX}%`).all<{ content: string }>();
    return (result.results ?? []).map((row) => row.content);
  }

  it("validates every page, so a too-long target on a later page stops the rename before any write", async () => {
    // 410 memos: the first validation page (400 rows) finds the tag; the
    // second holds a descendant whose renamed path would pass 128 bytes.
    const deep = `work/${"d".repeat(60)}`;
    const seeded = Array.from({ length: 410 }, (_, index) => (index === 0 ? "first #work" : index === 405 ? `late #${deep}` : `plain ${index}`));
    await seed(seeded);

    await expect(run("work", "w".repeat(70), "rename-late-long")).rejects.toBeInstanceOf(InvalidTagTargetError);
    // Nothing was written: the first memo still carries the old name.
    expect(await contents()).toEqual(seeded);
  });

  it("refuses a removal that would leave a text-only memo empty, naming it, and writes nothing", async () => {
    await seed(["#todo", "buy milk #todo", "  #todo  "]);
    // A memo whose only text is the tag but which carries a picture stays storable.
    await env.DB
      .prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(`${PREFIX}photo`, "#todo", stamp, stamp)
      .run();
    await env.DB
      .prepare("INSERT INTO memo_images (id, memo_id, ord, mime, data_base64, created_at) VALUES (?, ?, 0, 'image/webp', 'AAAA', ?)")
      .bind(`${PREFIX}img`, `${PREFIX}photo`, stamp)
      .run();

    const refusal = await run("todo", null, "remove-to-empty").catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(TagRewriteBlockedError);
    expect((refusal as TagRewriteBlockedError).blocked).toEqual({ empty: 2, tooLong: 0, ids: [idOf(0), idOf(2)] });
    expect(await contents()).toEqual(["#todo", "buy milk #todo", "  #todo  ", "#todo"]);
  });

  it("refuses a rename that would push a memo past the length limit", async () => {
    const near = `${"x".repeat(39_990)} #a`;
    await seed(["short #a", near]);

    const refusal = await run("a", "a-much-longer-name", "rename-too-long").catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(TagRewriteBlockedError);
    expect((refusal as TagRewriteBlockedError).blocked).toEqual({ empty: 0, tooLong: 1, ids: [idOf(1)] });
    expect(await contents()).toEqual(["short #a", near]);
  });

  it("answers a blocked removal with 409, the memos it names, and a released lock", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_state"),
      env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
    ]);
    const auth = await claimInitialPassword(appEnv, "tag-runtime-hash");
    if (!auth) throw new Error("Test authentication state was not created");
    const cookie = (await createSessionCookie(appEnv, auth.sessionGeneration)).split(";", 1)[0];
    await seed(["#chore", "wash up #chore"]);

    const post = (body: unknown) =>
      removeTagEndpoint({
        ...context(),
        request: new Request("https://memo.example/api/tags/remove", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://memo.example", "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
      } as AppContext);

    const response = await post({ path: "chore", operationId: "remove-chore" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "TAG_REWRITE_BLOCKED",
      params: { empty: 1, tooLong: 0, ids: idOf(0) }
    });
    expect(await contents()).toEqual(["#chore", "wash up #chore"]);
    // Nothing was written, so the lock is free for the next global change.
    const lock = await env.DB.prepare("SELECT operation_id, completed FROM tag_operation_lock WHERE id = 1").first<{ operation_id: string; completed: number }>();
    expect(lock).toEqual({ operation_id: "remove-chore", completed: 1 });
  });

  /** A continuation as the previous release minted it: v3, part-way through its write pass. */
  async function legacyWriteCursor(operationId: string, from: string, to: string | null, after: string, updated: number): Promise<string> {
    const counter = await env.DB.prepare("SELECT n FROM sync_counter WHERE id = 1").first<{ n: number }>();
    const max = await env.DB.prepare("SELECT MAX(id) AS id, COUNT(*) AS total FROM memos").first<{ id: string; total: number }>();
    await env.DB
      .prepare(
        `INSERT INTO tag_operation_lock (id, operation_id, operation_kind, from_path, to_path, expires_at, completed)
         VALUES (1, ?, ?, ?, ?, ?, 0)`
      )
      .bind(operationId, to === null ? "remove" : "rename", from, to, Date.now() + 60_000)
      .run();
    const cursor = {
      v: 3,
      op: to === null ? "remove" : "rename",
      phase: "write",
      operationId,
      from,
      to,
      after,
      maxId: max?.id ?? "",
      snapshotSeq: Number(counter?.n ?? 0),
      found: true,
      updated,
      retries: 0,
      scanned: updated,
      total: Number(max?.total ?? 0)
    };
    return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  it("checks what an older release's removal has left before writing more, and says how much it had done", async () => {
    // The older release removed #chore from the first two memos, then this
    // one took over: the third would be left empty, so nothing more is written.
    await seed(["one", "two", "#chore", "four #chore"]);
    const after = await legacyWriteCursor("remove-legacy", "chore", null, idOf(1), 2);

    // The resumed job validates the rest first, so "four #chore" — which
    // the write pass would reach first — is never rewritten.
    const refusal = await rewriteTag(context(), "chore", null, "remove-legacy", after).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(TagRewriteBlockedError);
    expect((refusal as TagRewriteBlockedError).blocked).toEqual({ empty: 1, tooLong: 0, ids: [idOf(2)] });
    expect((refusal as TagRewriteBlockedError).done).toBe(2);
    expect(await contents()).toEqual(["one", "two", "#chore", "four #chore"]);
  });

  it("finishes an older release's rename from where it stopped once the rest checks out", async () => {
    await seed(["one #life", "two #life", "three #work", "four #work/deep"]);
    const after = await legacyWriteCursor("rename-legacy", "work", "life", idOf(1), 2);

    await run("work", "life", "rename-legacy", after);
    expect(await contents()).toEqual(["one #life", "two #life", "three #life", "four #life/deep"]);
  });

  it("restarts an older release's validation from the first memo", async () => {
    await seed(["#chore", "four #chore"]);
    const legacy = await legacyWriteCursor("remove-legacy-validate", "chore", null, idOf(1), 0);
    const json = JSON.parse(atob(legacy.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    // As a v3 rename validation would have left it: past the empty memo already.
    const cursor = btoa(JSON.stringify({ ...json, phase: "validate" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

    const refusal = await run("chore", null, "remove-legacy-validate", cursor).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(TagRewriteBlockedError);
    expect((refusal as TagRewriteBlockedError).blocked.ids).toEqual([idOf(0)]);
    expect((refusal as TagRewriteBlockedError).done).toBe(0);
  });

  it("finishes in one request when no memo carries the tag", async () => {
    await seed(["nothing here"]);
    await expect(rewriteTag(context(), "absent", null, "remove-absent")).resolves.toBeNull();
    await expect(rewriteTag(context(), "absent", "present", "rename-absent")).resolves.toBeNull();
    const lock = await env.DB.prepare("SELECT completed FROM tag_operation_lock WHERE id = 1").first<{ completed: number }>();
    expect(lock?.completed).toBe(1);
  });
});
