import { apiError, nowIso } from "./response";
import type { AppContext, AppEnv } from "./types";

const encoder = new TextEncoder();
const SESSION_COOKIE = "memo_session";
const PASSWORD_HASH_KEY = "local_password_hash";
// Bumped on every passcode change. Cookies embed the generation they were
// minted with; a mismatch invalidates them, so changing the passcode signs
// every other device out even though the HMAC secret stays the same.
const SESSION_GENERATION_KEY = "session_generation";
// The deployed Workers runtime rejects PBKDF2 above 100k iterations, so 100k
// is the strongest hash production can mint or verify.
const HASH_ITERATIONS = 100_000;

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(signature);
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
  if (subtle.timingSafeEqual) {
    return subtle.timingSafeEqual(leftHash, rightHash);
  }
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function readSetting(env: AppEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value_json FROM app_settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  return row ? row.value_json : null;
}

async function writeSetting(env: AppEnv, key: string, valueJson: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
    .bind(key, valueJson, nowIso())
    .run();
}

function normalizePasswordHash(hashSetting: string | undefined | null): string | null {
  const normalized = hashSetting?.trim().replace(/^['"]|['"]$/g, "");
  return normalized || null;
}

async function readStoredPasswordHash(env: AppEnv): Promise<string | null> {
  const raw = await readSetting(env, PASSWORD_HASH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { hash?: unknown };
    return typeof parsed.hash === "string" ? normalizePasswordHash(parsed.hash) : null;
  } catch {
    return null;
  }
}

/** The in-app hash wins; the deploy-time APP_PASSWORD_HASH only seeds a fresh DB. */
export async function configuredPasswordHash(env: AppEnv): Promise<string | null> {
  return (await readStoredPasswordHash(env)) ?? normalizePasswordHash(env.APP_PASSWORD_HASH);
}

export async function savePasswordHash(env: AppEnv, hash: string): Promise<void> {
  await writeSetting(env, PASSWORD_HASH_KEY, JSON.stringify({ hash }));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations: HASH_ITERATIONS }, key, 256);
  return `pbkdf2_sha256$${HASH_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

export async function verifyPassword(password: string, hashSetting: string | undefined | null): Promise<boolean> {
  const normalizedHash = normalizePasswordHash(hashSetting);
  if (!normalizedHash) {
    return false;
  }
  try {
    const [algorithm, iterationsText, saltText, expectedText] = normalizedHash.split("$");
    const iterations = Number(iterationsText);
    if (algorithm === "pbkdf2_sha256" && Number.isInteger(iterations) && iterations >= 100_000) {
      const salt = base64UrlDecode(saltText);
      const expected = base64UrlDecode(expectedText);
      const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations }, key, expected.length * 8);
      if (await timingSafeEqual(base64UrlEncode(derived), base64UrlEncode(expected))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export async function verifyLocalPassword(env: AppEnv, password: string): Promise<boolean> {
  return verifyPassword(password, await configuredPasswordHash(env));
}

async function readSessionGeneration(env: AppEnv): Promise<number> {
  const raw = await readSetting(env, SESSION_GENERATION_KEY);
  if (!raw) return 0;
  // Tolerate a hand-edited or corrupted row: a malformed value must degrade to
  // generation 0 (cookies just get invalidated), not crash login and setup.
  try {
    const parsed = Number(JSON.parse(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Invalidate every outstanding session cookie (called on passcode change). */
export async function bumpSessionGeneration(env: AppEnv): Promise<void> {
  const next = (await readSessionGeneration(env)) + 1;
  await writeSetting(env, SESSION_GENERATION_KEY, JSON.stringify(next));
}

export async function createSessionCookie(env: AppEnv): Promise<string> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  const generation = await readSessionGeneration(env);
  const maxAge = 60 * 60 * 24 * 30;
  const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ sub: "owner", exp: expiresAt, gen: generation, nonce: crypto.randomUUID() })));
  const signature = await hmac(env.SESSION_SECRET, payload);
  return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function hasValidSession(env: AppEnv, request: Request): Promise<boolean> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) {
    return false;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!(await timingSafeEqual(signature, expected))) {
    return false;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { sub?: string; exp?: number; gen?: number };
    if (parsed.sub !== "owner" || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }
    // Cookies minted before the last passcode change carry a stale generation
    // and stop being accepted.
    return (parsed.gen ?? 0) === (await readSessionGeneration(env));
  } catch {
    return false;
  }
}

/** Gate for every data endpoint: a Response means "denied", null means "go ahead". */
export async function requireAuth(context: AppContext): Promise<Response | null> {
  try {
    if (await hasValidSession(context.env, context.request)) {
      return null;
    }
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Authentication could not be verified.");
  }
  return apiError(401, "AUTH_REQUIRED", "Authentication required");
}
