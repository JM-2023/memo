import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { rewriteTag } from "../functions/api/_utils/tagops";
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
    expect(results.map((page) => page.updated)).toEqual([30, 15]);
    expect((await contents()).every((content) => !content.includes("#dense"))).toBe(true);
  });

  it("caps a page by stored characters so long memos travel in small pages", async () => {
    const long = "x".repeat(150_000);
    await seed(Array.from({ length: 5 }, (_, index) => `${long} ${index} #long`));
    const results = await pages("long", null, "remove-long");
    // 400k characters per write page: three 150k memos start before the cut.
    expect(results.map((page) => page.updated)).toEqual([3, 2]);
    expect((await contents()).every((content) => !content.includes("#long"))).toBe(true);
  });
});
