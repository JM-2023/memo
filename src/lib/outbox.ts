import { ApiError, AuthRequiredError, isTransientImportFailure } from "./api";
import { primeImage, releaseImage, retainImage, type ImageVariant } from "./imageCache";
import type { Memo, MemoImage, NewImagePayload } from "./types";

/**
 * Sends that have landed as cards but not reached the server yet ("先落卡，
 * 后确认"). Memory only, by design, like the composer's draft: never written
 * to Web Storage, IndexedDB or the server, so a refresh loses an unsent memo
 * the way it loses unsent text.
 */
export type OutboxStatus = "sending" | "failed";

/**
 * Why a send failed. The network (or a server failing for a while) and a
 * lost session are retried on their own; a refusal only by hand.
 */
export type OutboxFailure = "network" | "auth" | "refused";

/**
 * What a card still on its way shows in its head: on its way, failed and
 * waiting for the connection, failed while online and trying again on its
 * own, or refused (only a press retries it).
 */
export type SendState = "sending" | "failed" | "retrying" | "refused";

export interface OutboxEntry {
  /** The composer's clientId: the card's key now, the memo's id once stored. */
  id: string;
  /** The card shown meanwhile. */
  memo: Memo;
  /** The text that goes to the server (the lens's tag inherited). */
  content: string;
  /** The text as the composer held it, for taking the memo back. */
  draft: string;
  /** The tag `content` inherited, if any. */
  tag: string | null;
  images: NewImagePayload[];
  /** The caret in `draft` when Send went. */
  selection: { start: number; end: number };
  status: OutboxStatus;
  failure: OutboxFailure | null;
}

export type Outbox = ReadonlyMap<string, OutboxEntry>;

/** The automatic retries while online, a few quick ones first… */
export const OUTBOX_RETRY_MS = [2_000, 6_000, 20_000] as const;
/** …then one a minute for as long as it fails, while online and in view. */
export const OUTBOX_SLOW_RETRY_MS = 60_000;

/** How long a failed send waits before its next automatic try, `spent` tries in. */
export function outboxRetryDelay(spent: number): number {
  return OUTBOX_RETRY_MS[spent] ?? OUTBOX_SLOW_RETRY_MS;
}
/** How long ⌘Z in the untouched composer takes back a confirmed send. */
export const SEND_UNDO_MS = 6_000;

/** Codes a server answers with that no retry on its own will change. */
const REFUSED = new Set(["STORAGE_FULL", "DECRYPTION_FAILED", "SERVER_MISCONFIGURED"]);

export function failureOf(cause: unknown, online = typeof navigator === "undefined" || navigator.onLine !== false): OutboxFailure {
  if (cause instanceof AuthRequiredError) return "auth";
  if (!online) return "network";
  if (cause instanceof ApiError && REFUSED.has(cause.code)) return "refused";
  return isTransientImportFailure(cause) ? "network" : "refused";
}

/** `online`: a failure the connection explains is being retried, not waiting for it. */
export function sendStateOf(entry: OutboxEntry, online: boolean): SendState {
  if (entry.status === "sending") return "sending";
  if (entry.failure === "refused") return "refused";
  return online && entry.failure === "network" ? "retrying" : "failed";
}

function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** The card a send shows until the server's answer replaces it. */
export function optimisticMemo(id: string, content: string, images: readonly NewImagePayload[], at = new Date()): Memo {
  const stamp = at.toISOString();
  return {
    id,
    content,
    createdAt: stamp,
    updatedAt: stamp,
    pinnedAt: null,
    deletedAt: null,
    // Never read: nothing versioned is ever asked of a memo still unsent.
    seq: 0,
    images: images.map((image): MemoImage => ({ id: image.id, mime: image.mime, width: image.width, height: image.height, bytes: base64Bytes(image.dataBase64) }))
  };
}

/**
 * The outbox with `entry` in it. A new entry takes its place by send time,
 * so one put back (a discard's Undo) goes out in the order it was written.
 */
export function withEntry(outbox: Outbox, entry: OutboxEntry): Outbox {
  if (outbox.has(entry.id)) {
    const next = new Map(outbox);
    next.set(entry.id, entry);
    return next;
  }
  return new Map([...outbox, [entry.id, entry] as const].sort((a, b) => a[1].memo.createdAt.localeCompare(b[1].memo.createdAt)));
}

export function withoutEntry(outbox: Outbox, id: string): Outbox {
  if (!outbox.has(id)) return outbox;
  const next = new Map(outbox);
  next.delete(id);
  return next;
}

/** Every entry `pick` chooses, changed by `change`; the same map when none is. */
export function mapEntries(outbox: Outbox, pick: (entry: OutboxEntry) => boolean, change: (entry: OutboxEntry) => OutboxEntry): Outbox {
  let next: Map<string, OutboxEntry> | null = null;
  for (const [id, entry] of outbox) {
    if (!pick(entry)) continue;
    next ??= new Map(outbox);
    next.set(id, change(entry));
  }
  return next ?? outbox;
}

/** The next send to go out: the oldest one waiting (a failed one waits on its own clock). */
export function nextQueued(outbox: Outbox): OutboxEntry | undefined {
  for (const entry of outbox.values()) if (entry.status === "sending") return entry;
  return undefined;
}

/** What each card still on its way shows, by memo id; one the server has shows as sent. */
export function sendStatesOf(outbox: Outbox, stored: ReadonlyMap<string, Memo>, online: boolean): ReadonlyMap<string, SendState> {
  const states = new Map<string, SendState>();
  for (const entry of outbox.values()) if (!stored.has(entry.id)) states.set(entry.id, sendStateOf(entry, online));
  return states;
}

/** The cards the server truth does not hold yet. */
export function unsentMemos(outbox: Outbox, stored: ReadonlyMap<string, Memo>): Memo[] {
  const memos: Memo[] = [];
  for (const entry of outbox.values()) if (!stored.has(entry.id)) memos.push(entry.memo);
  return memos;
}

function blobOf(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/**
 * Keep an unsent memo's pictures in the image cache for as long as it waits.
 * Its card draws them from there (compressImage primed them), and the stored
 * versions are the same bytes under the same ids, so the confirmed card
 * keeps drawing what it already shows. Held, they cannot be evicted and sent
 * to a server that does not have them yet; one missing (a taken-back memo
 * sent again under fresh ids) is primed from the payload. Returns the release.
 */
export function holdPreviews(images: readonly NewImagePayload[]): () => void {
  const held: Array<[string, ImageVariant, string]> = [];
  for (const image of images) {
    for (const variant of ["thumb", "full"] as const) {
      let url = retainImage(image.id, variant);
      if (!url) {
        const thumb = variant === "thumb" && image.thumbBase64 ? image.thumbBase64 : null;
        try {
          primeImage(image.id, variant, blobOf(thumb ?? image.dataBase64, thumb ? image.thumbMime ?? image.mime : image.mime));
        } catch {
          // No copy to draw from: the tile loads it once it is stored.
        }
        url = retainImage(image.id, variant);
      }
      if (url) held.push([image.id, variant, url]);
    }
  }
  return () => {
    for (const [id, variant, url] of held.splice(0)) releaseImage(id, variant, url);
  };
}

/**
 * The pictures of a memo taken back into the composer, under new ids: the
 * memo may have reached the server after all, and its attachments' ids are
 * its own.
 */
export function freshImages(images: readonly NewImagePayload[]): NewImagePayload[] {
  return images.map((image) => ({ ...image, id: crypto.randomUUID() }));
}
