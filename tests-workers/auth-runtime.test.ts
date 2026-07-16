import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  changePasswordAtomically,
  claimInitialPassword,
  configuredAuthState,
  createSessionCookie,
  requireAuth
} from "../functions/api/_utils/auth";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestPost as logout } from "../functions/api/auth/logout";
import { onRequestPost as setupPasscode } from "../functions/api/auth/setup";
import { onRequestGet as getImage } from "../functions/api/images/[id]";

const appEnv: AppEnv = env;

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

function setupRequest(password: string, host = "localhost"): Request {
  const origin = `http://${host}`;
  return new Request(`${origin}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password })
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
  ]);
});

describe("atomic authentication state", () => {
  it("migrates existing legacy credentials and keeps both deploy generations synchronized", async () => {
    const legacyDb = env.LEGACY_DB;
    await applyD1Migrations(legacyDb, env.TEST_MIGRATIONS.slice(0, 4));
    await legacyDb.batch([
      legacyDb
        .prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
        .bind("local_password_hash", JSON.stringify({ hash: "pre-migration-hash" }), "2026-07-13T00:00:00.000Z"),
      legacyDb
        .prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
        .bind("session_generation", JSON.stringify(3), "2026-07-13T00:00:00.000Z")
    ]);

    await applyD1Migrations(legacyDb, env.TEST_MIGRATIONS);
    await expect(
      legacyDb.prepare("SELECT password_hash, session_generation FROM auth_state WHERE id = 1").first()
    ).resolves.toMatchObject({ password_hash: "pre-migration-hash", session_generation: 3 });

    await legacyDb
      .prepare("UPDATE app_settings SET value_json = ?, updated_at = ? WHERE key = 'local_password_hash'")
      .bind(JSON.stringify({ hash: "old-code-hash" }), "2026-07-13T00:01:00.000Z")
      .run();
    await legacyDb
      .prepare("UPDATE app_settings SET value_json = ?, updated_at = ? WHERE key = 'session_generation'")
      .bind(JSON.stringify(4), "2026-07-13T00:01:00.000Z")
      .run();
    await expect(
      legacyDb.prepare("SELECT password_hash, session_generation FROM auth_state WHERE id = 1").first()
    ).resolves.toMatchObject({ password_hash: "old-code-hash", session_generation: 4 });

    await legacyDb
      .prepare(
        `UPDATE auth_state
         SET password_hash = ?, session_generation = ?, updated_at = ?
         WHERE id = 1`
      )
      .bind("new-code-hash", 5, "2026-07-13T00:02:00.000Z")
      .run();
    const legacyRows = await legacyDb
      .prepare("SELECT key, value_json FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
      .all<{ key: string; value_json: string }>();
    const legacySettings = new Map(legacyRows.results.map((row) => [row.key, row.value_json]));
    expect(JSON.parse(legacySettings.get("local_password_hash") ?? "null")).toEqual({ hash: "new-code-hash" });
    expect(JSON.parse(legacySettings.get("session_generation") ?? "null")).toBe(5);
  });

  it("allows exactly one winner during concurrent local setup", async () => {
    const responses = await Promise.all([
      setupPasscode(context(setupRequest("2468"))),
      setupPasscode(context(setupRequest("1357")))
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const stateRows = await env.DB.prepare("SELECT COUNT(*) AS count FROM auth_state").first<{ count: number }>();
    expect(stateRows?.count).toBe(1);
  });

  it("refuses first-passcode provisioning from a public host", async () => {
    const request = new Request("https://memo.example/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://memo.example" },
      body: JSON.stringify({ password: "2468" })
    });

    const response = await setupPasscode(context(request));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "INTERNAL_ERROR"
    });
  });

  it("does not claim a passcode when the session secret is missing", async () => {
    const missingSecretEnv: AppEnv = { DB: appEnv.DB, SESSION_SECRET: "" };
    const response = await setupPasscode({ ...context(setupRequest("2468")), env: missingSecretEnv });

    expect(response.status).toBe(500);
    const stateRows = await env.DB.prepare("SELECT COUNT(*) AS count FROM auth_state").first<{ count: number }>();
    expect(stateRows?.count).toBe(0);
  });

  it("lets one conditional passcode rotation win and increments once", async () => {
    const initial = await claimInitialPassword(appEnv, "hash-old");
    expect(initial).not.toBeNull();
    const snapshot = await configuredAuthState(appEnv);
    expect(snapshot).toEqual(initial);

    const results = await Promise.all([
      changePasswordAtomically(appEnv, snapshot!, "hash-first"),
      changePasswordAtomically(appEnv, snapshot!, "hash-second")
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await configuredAuthState(appEnv);
    expect(stored?.sessionGeneration).toBe(1);
    expect(["hash-first", "hash-second"]).toContain(stored?.passwordHash);

    const legacy = await env.DB
      .prepare("SELECT key, value_json FROM app_settings WHERE key IN ('local_password_hash', 'session_generation') ORDER BY key")
      .all<{ key: string; value_json: string }>();
    const settings = new Map(legacy.results.map((row) => [row.key, row.value_json]));
    expect(JSON.parse(settings.get("local_password_hash") ?? "null")).toEqual({ hash: stored?.passwordHash });
    expect(JSON.parse(settings.get("session_generation") ?? "null")).toBe(1);
  });

  it("adopts a legacy hash and generation without resetting either value", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
        .bind("local_password_hash", JSON.stringify({ hash: "legacy-hash" }), "2026-07-13T00:00:00.000Z"),
      env.DB
        .prepare(
          `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
        )
        .bind("session_generation", JSON.stringify(4), "2026-07-13T00:00:00.000Z")
    ]);

    await expect(configuredAuthState(appEnv)).resolves.toEqual({
      passwordHash: "legacy-hash",
      sessionGeneration: 4
    });
  });

  it("tracks legacy writes during a rolling deploy and keeps rollback rows current", async () => {
    const initial = await claimInitialPassword(appEnv, "hash-canonical");
    expect(initial).toEqual({ passwordHash: "hash-canonical", sessionGeneration: 0 });

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
        )
        .bind("local_password_hash", JSON.stringify({ hash: "hash-from-old-code" }), "2026-07-13T00:02:00.000Z"),
      env.DB
        .prepare(
          `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
        )
        .bind("session_generation", JSON.stringify(7), "2026-07-13T00:02:00.000Z")
    ]);

    await expect(configuredAuthState(appEnv)).resolves.toEqual({
      passwordHash: "hash-from-old-code",
      sessionGeneration: 7
    });

    const changed = await changePasswordAtomically(
      appEnv,
      { passwordHash: "hash-from-old-code", sessionGeneration: 7 },
      "hash-from-new-code"
    );
    expect(changed).toEqual({ passwordHash: "hash-from-new-code", sessionGeneration: 8 });

    const legacy = await env.DB
      .prepare("SELECT key, value_json FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
      .all<{ key: string; value_json: string }>();
    const settings = new Map(legacy.results.map((row) => [row.key, row.value_json]));
    expect(JSON.parse(settings.get("local_password_hash") ?? "null")).toEqual({ hash: "hash-from-new-code" });
    expect(JSON.parse(settings.get("session_generation") ?? "null")).toBe(8);
  });

  it("keeps a pre-rotation cookie stale instead of upgrading its generation", async () => {
    const initial = await claimInitialPassword(appEnv, "hash-old");
    expect(initial).not.toBeNull();
    const oldCookie = await createSessionCookie(appEnv, initial!.sessionGeneration);

    const changed = await changePasswordAtomically(appEnv, initial!, "hash-new");
    expect(changed?.sessionGeneration).toBe(1);

    const cookieHeader = oldCookie.split(";", 1)[0];
    const denied = await requireAuth(
      context(new Request("https://memo.example/api/bootstrap", { headers: { Cookie: cookieHeader } }))
    );
    expect(denied?.status).toBe(401);
    expect(denied?.headers.get("Clear-Site-Data")).toBe('"cache"');
  });

  it("clears legacy authenticated cache entries on logout", async () => {
    const origin = "https://memo.example";
    const response = await logout(
      context(
        new Request(`${origin}/api/auth/logout`, {
          method: "POST",
          headers: { Origin: origin }
        })
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Clear-Site-Data")).toBe('"cache"');
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("serves an attachment while its memo is in Trash", async () => {
    const initial = await claimInitialPassword(appEnv, "hash-old");
    expect(initial).not.toBeNull();
    const cookie = await createSessionCookie(appEnv, initial!.sessionGeneration);

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO memos (id, content, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind("trash-memo", "", "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z", "2026-07-13T00:01:00.000Z"),
      env.DB
        .prepare(
          `INSERT INTO memo_images (id, memo_id, mime, data_base64, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind("trash-image", "trash-memo", "image/png", "AQID", "2026-07-13T00:00:00.000Z")
    ]);

    const request = new Request("https://memo.example/api/images/trash-image", {
      headers: { Cookie: cookie.split(";", 1)[0] }
    });
    const response = await getImage(context(request, { id: "trash-image" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
