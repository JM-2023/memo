import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { changePasswordAtomically, claimInitialPassword, createSessionCookie } from "../functions/api/_utils/auth";
import type { AppContext, AppEnv } from "../functions/api/_utils/types";
import { onRequestGet as getImage } from "../functions/api/images/[id]";
import { onRequestPut as updateMemo } from "../functions/api/memos/[id]";
import { MAX_THUMB_BASE64_CHARS, onRequestPost as createMemo } from "../functions/api/memos/index";

const appEnv: AppEnv = env;
const ORIGIN = "https://memo.example";
// Original bytes [1, 2, 3] and preview bytes [9, 8].
const ORIGINAL = "AQID";
const PREVIEW = "CQg=";

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

function jsonRequest(path: string, cookie: string, method: "POST" | "PUT", body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { Cookie: cookie.split(";", 1)[0], Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function imageRequest(id: string, cookie: string | null, size?: "thumb"): Request {
  return new Request(`${ORIGIN}/api/images/${id}${size ? `?size=${size}` : ""}`, {
    headers: cookie ? { Cookie: cookie.split(";", 1)[0] } : {}
  });
}

async function bytesOf(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

let cookie = "";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_state"),
    env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')"),
    env.DB.prepare("DELETE FROM memo_images WHERE id LIKE 'thumb-%'"),
    env.DB.prepare("DELETE FROM memos WHERE id LIKE 'thumb-%'")
  ]);
  const auth = await claimInitialPassword(appEnv, "thumb-test-hash");
  cookie = await createSessionCookie(appEnv, auth!.sessionGeneration);
});

describe("feed previews", () => {
  it("stores a client preview and serves it for size=thumb, the original otherwise", async () => {
    const created = await createMemo(
      context(
        jsonRequest("/api/memos", cookie, "POST", {
          id: "thumb-memo",
          content: "",
          images: [
            { id: "thumb-a", dataBase64: ORIGINAL, mime: "image/jpeg", width: 1600, height: 1200, thumbBase64: PREVIEW, thumbMime: "image/webp" }
          ]
        })
      )
    );
    expect(created.status).toBe(200);
    // Previews never travel in memo metadata.
    expect(JSON.stringify(await created.json())).not.toContain(PREVIEW);

    const thumb = await getImage(context(imageRequest("thumb-a", cookie, "thumb"), { id: "thumb-a" }));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/webp");
    expect(thumb.headers.get("Cache-Control")).toBe("no-store");
    expect(thumb.headers.get("X-Image-Variant")).toBe("preview");
    expect(await bytesOf(thumb)).toEqual([9, 8]);

    const full = await getImage(context(imageRequest("thumb-a", cookie), { id: "thumb-a" }));
    expect(full.headers.get("Content-Type")).toBe("image/jpeg");
    expect(full.headers.get("X-Image-Variant")).toBe("original");
    expect(await bytesOf(full)).toEqual([1, 2, 3]);
  });

  it("falls back to the original for rows stored without a preview", async () => {
    await createMemo(
      context(
        jsonRequest("/api/memos", cookie, "POST", {
          id: "thumb-legacy",
          content: "",
          images: [{ id: "thumb-old", dataBase64: ORIGINAL, mime: "image/png", width: 10, height: 10 }]
        })
      )
    );
    const response = await getImage(context(imageRequest("thumb-old", cookie, "thumb"), { id: "thumb-old" }));
    expect(response.headers.get("Content-Type")).toBe("image/png");
    // Marked, so the client derives and seals a real preview from it.
    expect(response.headers.get("X-Image-Variant")).toBe("original");
    expect(await bytesOf(response)).toEqual([1, 2, 3]);
  });

  it("keeps previews of attachments added by an edit", async () => {
    const created = await createMemo(context(jsonRequest("/api/memos", cookie, "POST", { id: "thumb-edit", content: "text", images: [] })));
    const { memo } = (await created.json()) as { memo: { seq: number } };
    const updated = await updateMemo(
      context(
        jsonRequest("/api/memos/thumb-edit", cookie, "PUT", {
          expectedSeq: memo.seq,
          addImages: [{ id: "thumb-added", dataBase64: ORIGINAL, mime: "image/jpeg", width: 900, height: 900, thumbBase64: PREVIEW, thumbMime: "image/jpeg" }]
        }),
        { id: "thumb-edit" }
      )
    );
    expect(updated.status).toBe(200);
    const response = await getImage(context(imageRequest("thumb-added", cookie, "thumb"), { id: "thumb-added" }));
    expect(await bytesOf(response)).toEqual([9, 8]);
  });

  it("rejects malformed or oversized previews", async () => {
    const attempt = (thumb: Record<string, unknown>) =>
      createMemo(
        context(
          jsonRequest("/api/memos", cookie, "POST", {
            id: `thumb-bad-${Math.random().toString(36).slice(2)}`,
            content: "",
            images: [{ id: `thumb-bad-image-${Math.random().toString(36).slice(2)}`, dataBase64: ORIGINAL, mime: "image/jpeg", width: 1, height: 1, ...thumb }]
          })
        )
      );
    expect((await attempt({ thumbBase64: "not base64!", thumbMime: "image/webp" })).status).toBe(400);
    expect((await attempt({ thumbBase64: PREVIEW, thumbMime: "text/html" })).status).toBe(400);
    const tooLarge = await attempt({ thumbBase64: "A".repeat(MAX_THUMB_BASE64_CHARS + 4), thumbMime: "image/webp" });
    expect(tooLarge.status).toBe(400);
    expect(((await tooLarge.json()) as { code: string }).code).toBe("IMAGE_TOO_LARGE");
  });
});

describe("image endpoint authentication", () => {
  beforeEach(async () => {
    await createMemo(
      context(
        jsonRequest("/api/memos", cookie, "POST", {
          id: "thumb-auth",
          content: "",
          images: [{ id: "thumb-auth-image", dataBase64: ORIGINAL, mime: "image/png", width: 1, height: 1 }]
        })
      )
    );
  });

  it("refuses a request without a session cookie", async () => {
    const response = await getImage(context(imageRequest("thumb-auth-image", null), { id: "thumb-auth-image" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Clear-Site-Data")).toBe('"cache"');
  });

  it("refuses a cookie minted before a passcode change", async () => {
    const state = await env.DB.prepare("SELECT password_hash, session_generation FROM auth_state WHERE id = 1").first<{
      password_hash: string;
      session_generation: number;
    }>();
    await changePasswordAtomically(appEnv, { passwordHash: state!.password_hash, sessionGeneration: state!.session_generation }, "thumb-new-hash");
    const response = await getImage(context(imageRequest("thumb-auth-image", cookie, "thumb"), { id: "thumb-auth-image" }));
    expect(response.status).toBe(401);
  });

  it("answers 404 for an unknown image only to an authenticated caller", async () => {
    const response = await getImage(context(imageRequest("thumb-missing", cookie), { id: "thumb-missing" }));
    expect(response.status).toBe(404);
  });

  it("still seeds a fresh deployment's auth state before serving", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_state"),
      env.DB.prepare("DELETE FROM app_settings WHERE key IN ('local_password_hash', 'session_generation')")
    ]);
    const seeded = { ...appEnv, APP_PASSWORD_HASH: "thumb-seed-hash" } as AppEnv;
    const fresh = await createSessionCookie(seeded, 0);
    const response = await getImage({
      ...context(imageRequest("thumb-auth-image", fresh), { id: "thumb-auth-image" }),
      env: seeded
    } as AppContext);
    expect(response.status).toBe(200);
    await expect(env.DB.prepare("SELECT session_generation FROM auth_state WHERE id = 1").first()).resolves.toMatchObject({
      session_generation: 0
    });
  });
});
