import { apiError, nowIso } from "./response";
import type { AppContext, AppEnv } from "./types";

const encoder = new TextEncoder();
const SESSION_COOKIE = "memo_session";
// Migration 0005 keeps these legacy keys synchronized with auth_state during
// rolling deploys and rollbacks. They also seed an upgraded database once.
const PASSWORD_HASH_KEY = "local_password_hash";
const SESSION_GENERATION_KEY = "session_generation";
// The deployed Workers runtime rejects PBKDF2 above 100k iterations, so 100k
// is the strongest hash production can mint or verify.
const HASH_ITERATIONS = 100_000;

interface AuthStateRow {
  password_hash: string;
  session_generation: number;
}

interface LegacySettingRow {
  key: string;
  value_json: string;
}

export interface AuthStateSnapshot {
  passwordHash: string;
  sessionGeneration: number;
}

type AuthDatabase = Pick<D1Database, "prepare">;

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

function normalizePasswordHash(hashSetting: string | undefined | null): string | null {
  const normalized = hashSetting?.trim().replace(/^['"]|['"]$/g, "");
  return normalized || null;
}

function parseLegacyGeneration(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = Number(JSON.parse(raw));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function authStateFromRow(row: AuthStateRow): AuthStateSnapshot {
  const passwordHash = row.password_hash;
  const sessionGeneration = Number(row.session_generation);
  if (!normalizePasswordHash(passwordHash) || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) {
    throw new Error("The persisted authentication state is invalid");
  }
  return { passwordHash, sessionGeneration };
}

async function readAuthState(db: AuthDatabase): Promise<AuthStateSnapshot | null> {
  const row = await db
    .prepare("SELECT password_hash, session_generation FROM auth_state WHERE id = 1")
    .first<AuthStateRow>();
  return row ? authStateFromRow(row) : null;
}

async function legacyAuthSeed(db: AuthDatabase, env: AppEnv): Promise<AuthStateSnapshot | null> {
  const result = await db
    .prepare("SELECT key, value_json FROM app_settings WHERE key IN (?, ?)")
    .bind(PASSWORD_HASH_KEY, SESSION_GENERATION_KEY)
    .all<LegacySettingRow>();
  const settings = new Map((result.results ?? []).map((row) => [row.key, row.value_json]));

  let storedHash: string | null = null;
  const rawHash = settings.get(PASSWORD_HASH_KEY);
  if (rawHash) {
    try {
      const parsed = JSON.parse(rawHash) as { hash?: unknown };
      storedHash = typeof parsed.hash === "string" ? normalizePasswordHash(parsed.hash) : null;
    } catch {
      storedHash = null;
    }
  }

  // The in-database hash keeps precedence over the deploy-time seed so an old
  // secret cannot silently undo a passcode change during an upgrade.
  const passwordHash = storedHash ?? normalizePasswordHash(env.APP_PASSWORD_HASH);
  if (!passwordHash) return null;
  return {
    passwordHash,
    sessionGeneration: parseLegacyGeneration(settings.get(SESSION_GENERATION_KEY) ?? null)
  };
}

async function insertAuthState(db: AuthDatabase, state: AuthStateSnapshot): Promise<AuthStateSnapshot | null> {
  const row = await db
    .prepare(
      `INSERT INTO auth_state (id, password_hash, session_generation, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING
       RETURNING password_hash, session_generation`
    )
    .bind(state.passwordHash, state.sessionGeneration, nowIso())
    .first<AuthStateRow>();
  return row ? authStateFromRow(row) : null;
}

/**
 * Read the canonical password hash and cookie generation as one snapshot.
 * Existing app_settings rows, or APP_PASSWORD_HASH on a fresh deployment, are
 * claimed with a single INSERT. Concurrent requests therefore converge on the
 * same database row instead of choosing separate winners in application code.
 */
export async function configuredAuthState(env: AppEnv): Promise<AuthStateSnapshot | null> {
  const db = env.DB.withSession("first-primary");
  const current = await readAuthState(db);
  if (current) return current;

  const seed = await legacyAuthSeed(db, env);
  if (!seed) return null;
  return (await insertAuthState(db, seed)) ?? (await readAuthState(db));
}

/** The one successful INSERT is the sole winner of concurrent first setup. */
export async function claimInitialPassword(env: AppEnv, passwordHash: string): Promise<AuthStateSnapshot | null> {
  const normalized = normalizePasswordHash(passwordHash);
  if (!normalized) throw new Error("The password hash is invalid");
  const db = env.DB.withSession("first-primary");
  return insertAuthState(db, { passwordHash: normalized, sessionGeneration: 0 });
}

/**
 * Rotate hash and generation in one conditional statement. If another request
 * changed either value after verification, no row is returned and this caller
 * cannot overwrite the newer passcode.
 */
export async function changePasswordAtomically(
  env: AppEnv,
  expected: AuthStateSnapshot,
  passwordHash: string
): Promise<AuthStateSnapshot | null> {
  const normalized = normalizePasswordHash(passwordHash);
  if (!normalized) throw new Error("The password hash is invalid");
  const row = await env.DB
    .prepare(
      `UPDATE auth_state
       SET password_hash = ?, session_generation = session_generation + 1, updated_at = ?
       WHERE id = 1 AND password_hash = ? AND session_generation = ?
       RETURNING password_hash, session_generation`
    )
    .bind(normalized, nowIso(), expected.passwordHash, expected.sessionGeneration)
    .first<AuthStateRow>();
  return row ? authStateFromRow(row) : null;
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

export async function createSessionCookie(env: AppEnv, sessionGeneration: number): Promise<string> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) {
    throw new Error("The session generation is invalid");
  }
  const maxAge = 60 * 60 * 24 * 30;
  const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ sub: "owner", exp: expiresAt, gen: sessionGeneration, nonce: crypto.randomUUID() }))
  );
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
    // and stop being accepted. Reading the canonical row also lazily seeds a
    // fresh deployment from APP_PASSWORD_HASH.
    const state = await configuredAuthState(env);
    return state !== null && (parsed.gen ?? 0) === state.sessionGeneration;
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
