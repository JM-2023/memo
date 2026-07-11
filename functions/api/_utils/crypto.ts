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

export type ContentFormat = "plain" | "enc1";

/** A sealed row must never degrade into ordinary text that a mutation can save. */
export class DecryptionError extends Error {
  constructor(message = "Memo content could not be decrypted.") {
    super(message);
    this.name = "DecryptionError";
  }
}

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
// Store only completed verification facts globally. Never share an in-flight
// D1 promise across requests; Workers forbids performing I/O on behalf of a
// different request context.
const verifiedContentModes = new Set<string>();

/** The content key, or null when MEMO_ENC_KEY is absent (plaintext mode). */
export async function contentKeyOf(env: AppEnv): Promise<CryptoKey | null> {
  const hex = (env.MEMO_ENC_KEY ?? "").trim();
  if (hex && !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new DecryptionError("MEMO_ENC_KEY is malformed.");
  }
  let key: CryptoKey | null = null;
  if (hex) {
    let cached = keyCache.get(hex);
    if (!cached) {
      const bytes = new Uint8Array(32);
      for (let index = 0; index < 32; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      cached = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      keyCache.set(hex, cached);
    }
    key = await cached;
  }

  // Verify a representative existing ciphertext once per isolate before any
  // content write or destructive bulk operation. This prevents a valid-looking
  // but wrong/missing deployment key from creating a mixed-key database.
  const mode = hex || "<plaintext>";
  if (!verifiedContentModes.has(mode)) {
    const sample = await env.DB.prepare("SELECT content FROM memos WHERE content_format = 'enc1' LIMIT 1").first<{ content: string }>();
    if (sample) {
      if (!key) throw new DecryptionError("MEMO_ENC_KEY is missing for encrypted content.");
      await openContent(key, sample.content, "enc1");
    }
    verifiedContentModes.add(mode);
  }
  return key;
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
 * Inverse of sealContent. Explicit row metadata prevents a plaintext memo that
 * happens to begin with "enc1:" from being mistaken for ciphertext. The
 * optional format is only a compatibility bridge for callers being migrated.
 */
export async function openContent(key: CryptoKey | null, stored: string, format?: string): Promise<string> {
  if (format !== undefined && format !== "plain" && format !== "enc1") {
    throw new DecryptionError(`Unsupported memo content format: ${format}`);
  }
  const resolvedFormat: ContentFormat = format === "plain" || format === "enc1" ? format : stored.startsWith(ENC_PREFIX) ? "enc1" : "plain";
  if (resolvedFormat === "plain") {
    return stored;
  }
  if (!key) {
    throw new DecryptionError("MEMO_ENC_KEY is missing for encrypted content.");
  }
  try {
    const combined = base64ToBytes(stored.slice(ENC_PREFIX.length));
    // Minimum valid payload is 28 bytes: 12-byte IV + 16-byte GCM tag around an
    // EMPTY plaintext — image-only memos store content "" and must round-trip.
    if (!stored.startsWith(ENC_PREFIX) || combined.byteLength < 28) throw new Error("Invalid encrypted payload");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.subarray(0, 12) }, key, combined.subarray(12));
    return decoder.decode(plaintext);
  } catch (cause) {
    throw new DecryptionError(cause instanceof Error ? `Memo content could not be decrypted: ${cause.message}` : undefined);
  }
}

/** Open `content` on every row of a result set (mutates in place). */
export async function openContentRows<T extends { content: string; content_format?: string }>(env: AppEnv, rows: T[]): Promise<CryptoKey | null> {
  const key = await contentKeyOf(env);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      row.content = await openContent(key, row.content, row.content_format);
    }
  });
  await Promise.all(workers);
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

let backfillScheduled = false;
const BACKFILL_ROWS_PER_PASS = 16;

/**
 * Gradually seal rows written before encryption was enabled. Runs off the
 * request path (waitUntil), 16 rows per pass to stay inside the Free-plan D1
 * per-invocation query budget. Sealing is a storage-format
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
      const result = await context.env.DB.prepare("SELECT id, content FROM memos WHERE content_format = 'plain' LIMIT ?")
        .bind(BACKFILL_ROWS_PER_PASS)
        .all<{ id: string; content: string }>();
      const rows = result.results ?? [];
      if (rows.length === 0) return;
      const statements: D1PreparedStatement[] = [];
      for (const row of rows) {
        statements.push(
          context.env.DB
            .prepare("UPDATE memos SET content = ?, content_format = 'enc1' WHERE id = ? AND content = ? AND content_format = 'plain'")
            .bind(await sealContent(key, row.content), row.id, row.content)
        );
      }
      await context.env.DB.batch(statements);
    })()
      .catch((error) => {
        console.error("Encryption backfill failed", error);
      })
      .finally(() => {
        backfillScheduled = false;
      })
  );
}
