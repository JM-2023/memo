// Content encryption at rest, plus the key that seals the client's local
// snapshot cache.
//
// Memo text is sealed with AES-256-GCM before it touches D1 and opened again
// at the API boundary, so the database (dumps, backups, console browsing)
// holds only ciphertext while every endpoint keeps speaking plaintext. The
// key lives in the deployment env (MEMO_ENC_KEY, 64 hex chars); whoever holds
// both the DB and the deployment secrets can still read memos — that is the
// accepted trade-off for a fully transparent API. Only memo content is
// sealed: images stay as-is (sealing base64 payloads would cost ~33% extra
// space for little gain), timestamps and tags-in-content metadata stay
// queryable through the content itself once opened.
//
// Stored format: "enc1:" + base64(iv[12] ‖ ciphertext‖tag[16]) — 28 bytes of
// fixed overhead per memo plus base64's 4/3 on the text bytes.

import type { AppContext, AppEnv } from "./types";
import { nowIso } from "./response";

export const ENC_PREFIX = "enc1:";

/** What readers see if a sealed row can no longer be opened (key rotated/lost). */
export const UNDECRYPTABLE_TEXT = "[Unable to decrypt this memo — the server encryption key changed or is missing.]";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  // String.fromCharCode(...spread) overflows the stack on big payloads, so
  // build the binary string in chunks.
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// One import per isolate; the env value never changes within a deployment.
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The content key, or null when MEMO_ENC_KEY is absent/malformed (plaintext mode). */
export function contentKeyOf(env: AppEnv): Promise<CryptoKey | null> {
  const hex = (env.MEMO_ENC_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return Promise.resolve(null);
  }
  let cached = keyCache.get(hex);
  if (!cached) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    cached = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(hex, cached);
  }
  return cached;
}

export async function sealContent(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(text));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return ENC_PREFIX + bytesToBase64(combined);
}

/**
 * Inverse of sealContent, forgiving by design: plaintext rows (pre-encryption
 * history, or plaintext mode) pass through untouched, and a sealed row that
 * won't open degrades to a readable marker instead of failing the request.
 */
export async function openContent(key: CryptoKey | null, stored: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored;
  }
  if (!key) {
    return UNDECRYPTABLE_TEXT;
  }
  try {
    const combined = base64ToBytes(stored.slice(ENC_PREFIX.length));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.subarray(0, 12) }, key, combined.subarray(12));
    return decoder.decode(plaintext);
  } catch {
    return UNDECRYPTABLE_TEXT;
  }
}

/** Open `content` on every row of a result set (mutates in place). */
export async function openContentRows<T extends { content: string }>(env: AppEnv, rows: T[]): Promise<CryptoKey | null> {
  const key = await contentKeyOf(env);
  await Promise.all(
    rows.map(async (row) => {
      row.content = await openContent(key, row.content);
    })
  );
  return key;
}

const CACHE_KEY_SETTING = "client_cache_key";

/**
 * The random key that encrypts the client's IndexedDB snapshot. It is only
 * ever handed out on authenticated responses, so a device that lost its
 * session holds an unreadable local cache. Created once, then stable — the
 * insert races benignly (DO NOTHING + re-read converge on one winner).
 */
export async function getOrCreateCacheKey(env: AppEnv): Promise<string> {
  const read = async () => {
    const row = await env.DB.prepare("SELECT value_json FROM app_settings WHERE key = ?").bind(CACHE_KEY_SETTING).first<{ value_json: string }>();
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value_json) as { key?: unknown };
      return typeof parsed.key === "string" && parsed.key ? parsed.key : null;
    } catch {
      return null;
    }
  };
  const existing = await read();
  if (existing) return existing;
  const fresh = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(CACHE_KEY_SETTING, JSON.stringify({ key: fresh }), nowIso())
    .run();
  return (await read()) ?? fresh;
}

// Once per isolate is plenty: the scan is only needed until legacy plaintext
// rows are gone, and isolates recycle often enough to converge quickly.
let backfillScheduled = false;

/**
 * Gradually seal rows written before encryption was enabled. Runs off the
 * request path (waitUntil), 100 rows per pass. Sealing is a storage-format
 * change, not an edit: seq stays put, so other devices never re-sync over it.
 * The `content = ?` guard makes each row a no-op if a real edit landed
 * between the read and the write.
 */
export function scheduleEncryptionBackfill(context: AppContext): void {
  if (backfillScheduled) return;
  backfillScheduled = true;
  context.waitUntil(
    (async () => {
      const key = await contentKeyOf(context.env);
      if (!key) return;
      const result = await context.env.DB.prepare("SELECT id, content FROM memos WHERE content NOT LIKE ? LIMIT 100")
        .bind(`${ENC_PREFIX}%`)
        .all<{ id: string; content: string }>();
      const rows = result.results ?? [];
      if (rows.length === 0) return;
      const statements: D1PreparedStatement[] = [];
      for (const row of rows) {
        statements.push(
          context.env.DB.prepare("UPDATE memos SET content = ? WHERE id = ? AND content = ?").bind(await sealContent(key, row.content), row.id, row.content)
        );
      }
      await context.env.DB.batch(statements);
    })().catch(() => {
      // Backfill is opportunistic; the next isolate retries.
    })
  );
}
