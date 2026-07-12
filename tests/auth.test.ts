import { describe, expect, it } from "vitest";
import { createSessionCookie, hashPassword, verifyPassword } from "../functions/api/_utils/auth";
import { allowsInAppSetup } from "../functions/api/auth/setup";
import type { AppEnv } from "../functions/api/_utils/types";

function authEnv(): AppEnv {
  return {
    DB: {} as D1Database,
    SESSION_SECRET: "unit-test-session-secret"
  };
}

function sessionPayload(setCookie: string): { sub: string; exp: number; gen: number; nonce: string } {
  const encodedToken = setCookie.match(/^memo_session=([^;]+)/)?.[1];
  if (!encodedToken) throw new Error("Session cookie is missing");
  const [payload] = decodeURIComponent(encodedToken).split(".");
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(base64)) as { sub: string; exp: number; gen: number; nonce: string };
}

describe("authentication primitives", () => {
  it("round-trips the supported PBKDF2 passcode hash", async () => {
    const hash = await hashPassword("0802");

    await expect(verifyPassword("0802", hash)).resolves.toBe(true);
    await expect(verifyPassword("0803", hash)).resolves.toBe(false);
  });

  it("rejects malformed and unsupported password hashes", async () => {
    await expect(verifyPassword("0802", "pbkdf2_sha1$100000$bad$bad")).resolves.toBe(false);
    await expect(verifyPassword("0802", "")).resolves.toBe(false);
  });

  it("embeds the caller's authentication snapshot generation in the cookie", async () => {
    const cookie = await createSessionCookie(authEnv(), 7);
    const payload = sessionPayload(cookie);

    expect(payload.sub).toBe("owner");
    expect(payload.gen).toBe(7);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.nonce).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("refuses invalid cookie generations before signing", async () => {
    await expect(createSessionCookie(authEnv(), -1)).rejects.toThrow("session generation");
    await expect(createSessionCookie(authEnv(), 1.5)).rejects.toThrow("session generation");
  });
});

describe("first-run setup boundary", () => {
  it.each([
    "http://localhost/api/auth/setup",
    "http://127.0.0.1:8788/api/auth/setup",
    "http://[::1]:8788/api/auth/setup",
    "http://0.0.0.0:8788/api/auth/setup"
  ])("allows an explicitly local request at %s", (url) => {
    expect(allowsInAppSetup(new Request(url))).toBe(true);
  });

  it.each([
    "https://notes.example/api/auth/setup",
    "https://project.pages.dev/api/auth/setup",
    "https://localhost.example/api/auth/setup"
  ])("blocks public provisioning at %s", (url) => {
    expect(allowsInAppSetup(new Request(url))).toBe(false);
  });
});
