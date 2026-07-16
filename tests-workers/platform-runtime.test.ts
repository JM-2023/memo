import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../functions/api/_utils/auth";
import { getOrCreateCacheKey } from "../functions/api/_utils/crypto";
import { readJson } from "../functions/api/_utils/response";

describe("Workers runtime and D1 migrations", () => {
  it("applies the complete schema to a real D1 test binding", async () => {
    const tables = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((row) => row.name);

    expect(names).toContain("memos");
    expect(names).toContain("memo_images");
    expect(names).toContain("auth_state");
    expect(names).toContain("sync_counter");
    expect(names).toContain("d1_migrations");

    const sync = await env.DB.prepare("SELECT n, sync_epoch FROM sync_counter WHERE id = 1").first<{
      n: number;
      sync_epoch: string;
    }>();
    expect(sync?.n).toBe(0);
    expect(sync?.sync_epoch).toMatch(/^[a-f0-9]{32}$/);
  });

  it("runs the production password hash in workerd Web Crypto", async () => {
    const hash = await hashPassword("2468");
    await expect(verifyPassword("2468", hash)).resolves.toBe(true);
    await expect(verifyPassword("1357", hash)).resolves.toBe(false);
  });

  it("enforces bounded JSON parsing with Workers streams", async () => {
    const request = new Request("https://memo.test/api/example", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          controller.enqueue(new TextEncoder().encode("true}"));
          controller.close();
        }
      })
    });

    await expect(readJson<{ ok: boolean }>(request, 32)).resolves.toEqual({ ok: true });
  });

  it("atomically repairs a malformed persisted client cache key", async () => {
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'client_cache_key'").run();
    await env.DB
      .prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('client_cache_key', ?, ?)")
      .bind(JSON.stringify({ key: "AQ==" }), "2026-07-16T00:00:00.000Z")
      .run();

    const keys = await Promise.all(Array.from({ length: 6 }, () => getOrCreateCacheKey(env)));
    expect(new Set(keys)).toHaveLength(1);
    expect(Uint8Array.from(atob(keys[0]), (character) => character.charCodeAt(0))).toHaveLength(32);

    const stored = await env.DB
      .prepare("SELECT value_json FROM app_settings WHERE key = 'client_cache_key'")
      .first<{ value_json: string }>();
    expect(JSON.parse(stored?.value_json ?? "null")).toEqual({ key: keys[0] });
  });
});
