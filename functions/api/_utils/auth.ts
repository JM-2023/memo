import { cacheKeyLookup, getOrCreateCacheKey, pendingContentCheck, settleContentCheck } from "./crypto";
import { apiError, nowIso } from "./response";
import type { AppContext, AppEnv } from "./types";

const encoder = new TextEncoder();
const SESSION_COOKIE = "memo_session";
const DAY_SECONDS = 60 * 60 * 24;
/** Lifetime of one issued cookie. */
const SESSION_MAX_AGE = 30 * DAY_SECONDS;
/** A cookie with less than this left is re-signed on a renewing request. */
const SESSION_RENEW_WITHIN = 20 * DAY_SECONDS;
/** Renewal never carries a session past this long after the passcode entry. */
const SESSION_ABSOLUTE_MAX = 180 * DAY_SECONDS;
/**
 * Low-frequency authenticated GETs that may carry a renewed cookie: the
 * heartbeat/warm-start sync and the cold bootstrap. Image and mutation
 * responses never re-sign, and change-password stops the heartbeat while it
 * rotates the generation, so a renewal cannot overwrite the rotated cookie.
 */
const RENEWING_PATHS = new Set(["/api/sync", "/api/bootstrap"]);
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

function authStateLookup(db: AuthDatabase): D1PreparedStatement {
  return db.prepare("SELECT password_hash, session_generation FROM auth_state WHERE id = 1");
}

async function readAuthState(db: AuthDatabase): Promise<AuthStateSnapshot | null> {
  const row = await authStateLookup(db).first<AuthStateRow>();
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

/**
 * Mint a session cookie for `sessionGeneration`. `signedInAt` (epoch seconds)
 * is when the passcode was last entered; a renewal passes the original value
 * so sliding renewal stays inside SESSION_ABSOLUTE_MAX.
 */
export async function createSessionCookie(env: AppEnv, sessionGeneration: number, signedInAt?: number): Promise<string> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) {
    throw new Error("The session generation is invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  const auth = signedInAt !== undefined && Number.isSafeInteger(signedInAt) && signedInAt <= now ? signedInAt : now;
  const expiresAt = Math.min(now + SESSION_MAX_AGE, auth + SESSION_ABSOLUTE_MAX);
  const maxAge = Math.max(0, expiresAt - now);
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ sub: "owner", exp: expiresAt, gen: sessionGeneration, auth, nonce: crypto.randomUUID() }))
  );
  const signature = await hmac(env.SESSION_SECRET, payload);
  return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** What requireAuth established for this request; read back via verifiedSession. */
export interface VerifiedSession {
  /** The auth_state row read in this request (hash + current generation). */
  state: AuthStateSnapshot;
  expiresAt: number;
  signedInAt: number;
  /** The client cache-key row read in the same D1 batch. */
  cacheKeyRow: { value_json: string } | null;
}

/** Keyed by the request's shared `context.data`, so it lives exactly one request. */
const verifiedSessions = new WeakMap<object, VerifiedSession>();

type SessionCheck = { ok: true; session: VerifiedSession } | { ok: false; revoked: boolean };

interface SessionPayload {
  sub?: unknown;
  exp?: unknown;
  gen?: unknown;
  auth?: unknown;
}

function readSignedPayload(token: string): SessionPayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(token))) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SessionPayload) : null;
  } catch {
    return null;
  }
}

/**
 * The cookie half of session validation: signature, subject and expiry are
 * checked locally, with no D1 read. Returns the generation the cookie was
 * minted under, or null when the cookie itself is not acceptable. Callers
 * must still compare the generation with the canonical auth_state row.
 */
export async function readSessionClaims(env: AppEnv, request: Request): Promise<{ gen: number } | null> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!(await timingSafeEqual(signature, expected))) return null;
  const parsed = readSignedPayload(payload);
  if (!parsed || parsed.sub !== "owner" || typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { gen: typeof parsed.gen === "number" ? parsed.gen : 0 };
}

/** The 401 every data endpoint answers with once a session is not valid. */
export function authRequiredResponse(): Response {
  const denied = apiError(401, "AUTH_REQUIRED", "Authentication required");
  // A revoked/expired session is the other confidentiality boundary where a
  // browser must discard legacy authenticated image cache entries.
  denied.headers.set("Clear-Site-Data", '"cache"');
  return denied;
}

async function checkSession(env: AppEnv, secret: string, request: Request): Promise<SessionCheck> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) {
    return { ok: false, revoked: false };
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return { ok: false, revoked: false };
  }
  const expected = await hmac(secret, payload);
  if (!(await timingSafeEqual(signature, expected))) {
    return { ok: false, revoked: false };
  }
  const parsed = readSignedPayload(payload);
  const now = Math.floor(Date.now() / 1000);
  // Browsers drop a cookie at Max-Age, so an expired one rarely arrives; when
  // it does it is treated like no cookie at all, never as a revocation.
  if (!parsed || parsed.sub !== "owner" || typeof parsed.exp !== "number" || parsed.exp < now) {
    return { ok: false, revoked: false };
  }

  // One D1 round trip: the generation check, the client cache key this
  // request may hand out, and (on a cold isolate) the content-key sample.
  const db = env.DB.withSession("first-primary");
  const contentCheck = pendingContentCheck(env, db);
  const [stateResult, cacheKeyResult, sampleResult] = await db.batch([
    authStateLookup(db),
    cacheKeyLookup(db),
    ...(contentCheck ? [contentCheck] : [])
  ]);
  if (sampleResult) {
    await settleContentCheck(env, (sampleResult.results?.[0] as { content: string } | undefined) ?? null);
  }
  const stateRow = stateResult.results?.[0] as unknown as AuthStateRow | undefined;
  // A missing row lazily seeds a fresh deployment from APP_PASSWORD_HASH.
  const state = stateRow ? authStateFromRow(stateRow) : await configuredAuthState(env);

  // A correctly signed, unexpired cookie whose generation no longer matches
  // was revoked by a passcode change (or its database was replaced). The
  // client treats only this case like a logout and clears the device.
  const generation = typeof parsed.gen === "number" ? parsed.gen : 0;
  if (state === null || generation !== state.sessionGeneration) {
    return { ok: false, revoked: true };
  }
  const signedInAt =
    typeof parsed.auth === "number" && Number.isSafeInteger(parsed.auth) ? parsed.auth : parsed.exp - SESSION_MAX_AGE;
  return {
    ok: true,
    session: {
      state,
      expiresAt: parsed.exp,
      signedInAt,
      cacheKeyRow: (cacheKeyResult.results?.[0] as { value_json: string } | undefined) ?? null
    }
  };
}

/** Gate for every data endpoint: a Response means "denied", null means "go ahead". */
export async function requireAuth(context: AppContext): Promise<Response | null> {
  const { env } = context;
  if (!env.SESSION_SECRET) {
    return serverMisconfigured();
  }
  let check: SessionCheck;
  try {
    check = await checkSession(env, env.SESSION_SECRET, context.request);
  } catch {
    // A D1 hiccup is not a sign-out: answering 401 here would send a
    // signed-in device back to the passcode gate.
    return apiError(500, "INTERNAL_ERROR", "Authentication could not be verified.");
  }
  if (check.ok) {
    verifiedSessions.set(context.data, check.session);
    return null;
  }
  const denied = check.revoked
    ? apiError(401, "AUTH_REQUIRED", "Authentication required", { reason: "revoked" })
    : apiError(401, "AUTH_REQUIRED", "Authentication required");
  // A revoked/expired session is the other confidentiality boundary where a
  // browser must discard legacy authenticated image cache entries.
  denied.headers.set("Clear-Site-Data", '"cache"');
  return denied;
}

/** The session requireAuth verified for this request, or null before/without it. */
export function verifiedSession(context: AppContext): VerifiedSession | null {
  return verifiedSessions.get(context.data) ?? null;
}

/** The client snapshot key for an authenticated request, reusing requireAuth's read. */
export function sessionCacheKey(context: AppContext): Promise<string> {
  return getOrCreateCacheKey(context.env, verifiedSession(context)?.cacheKeyRow);
}

/**
 * Sliding renewal: a fresh cookie for a successful renewing GET whose session
 * has less than SESSION_RENEW_WITHIN left. It carries the generation read in
 * this same request and the original sign-in time, so it can neither outlive
 * SESSION_ABSOLUTE_MAX nor resurrect a generation that was already stale.
 * Costs no D1 work; null means "leave the cookie alone".
 */
export async function renewedSessionCookie(context: AppContext): Promise<string | null> {
  const { request, env } = context;
  if (request.method !== "GET" || !RENEWING_PATHS.has(new URL(request.url).pathname)) return null;
  const session = verifiedSession(context);
  if (!session || !env.SESSION_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt - now >= SESSION_RENEW_WITHIN) return null;
  // Already at the absolute cap: re-signing could not extend it.
  if (session.signedInAt + SESSION_ABSOLUTE_MAX <= session.expiresAt) return null;
  return createSessionCookie(env, session.state.sessionGeneration, session.signedInAt);
}

/** SESSION_SECRET is a deploy-time secret; say so instead of "try again". */
export function serverMisconfigured(): Response {
  return apiError(500, "SERVER_MISCONFIGURED", "The server is missing SESSION_SECRET.", { secret: "SESSION_SECRET" });
}
