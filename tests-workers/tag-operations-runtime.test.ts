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

  it("removes rendered tags without deleting code examples", async () => {
    await env.DB
      .prepare("INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(MEMO_ID, "Keep `#work` and remove #work", "2026-07-26T00:00:00.000Z", "2026-07-26T00:00:00.000Z")
      .run();

    await runTagOperation("work", null, "remove-code-span");

    await expect(storedContent()).resolves.toBe("Keep `#work` and remove");
  });
});
