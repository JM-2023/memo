import type { BackupItem, BackupMemo, BackupTag } from "./api";

/** The file is not a readable memo-backup v1 object. */
export class BackupFormatError extends Error {
  constructor(message = "This is not a memo backup file.") {
    super(message);
    this.name = "BackupFormatError";
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0xfeff;
}

/** Top-level scalars kept for validation; everything else is skipped unread. */
const HEADER_KEYS = new Set(["format", "version"]);
const ARRAY_KINDS: Record<string, "memo" | "tag"> = { memos: "memo", tags: "tag" };

/**
 * Incremental reader for the backup-v1 object. It tracks only strings and
 * nesting depth, hands out each element of the top-level `memos` and `tags`
 * arrays as its own JSON text the moment it closes, and keeps the small
 * header fields. Key order does not matter (old files put tags last, newer
 * exports put them first), and no more than one element is ever buffered,
 * so a file of any size reads in bounded memory.
 */
export class BackupScanner {
  readonly header = new Map<string, unknown>();
  readonly arrays = new Set<"memo" | "tag">();
  private depth = 0;
  private inString = false;
  private escaped = false;
  private closed = false;
  private expectKey = false;
  private key = "";
  private valuePending = false;
  private arrayKind: "memo" | "tag" | null = null;
  private elementPending = false;
  private capture: "key" | "value" | "element" | null = null;
  private captureParts: string[] = [];
  private captureStart = -1;
  private out: { kind: "memo" | "tag"; json: string }[] = [];

  /** Feed the next run of text; returns the elements it completed. */
  push(text: string): { kind: "memo" | "tag"; json: string }[] {
    let nextSlash = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          continue;
        }
        // Strings (memo text, base64 images) are nearly all of the file:
        // jump to the next quote or backslash instead of walking each char.
        if (nextSlash < i) {
          const found = text.indexOf("\\", i);
          nextSlash = found === -1 ? text.length : found;
        }
        const found = text.indexOf('"', i);
        const quote = found === -1 ? text.length : found;
        if (nextSlash < quote) {
          i = nextSlash;
          this.escaped = true;
          continue;
        }
        i = quote;
        if (quote === text.length) break;
        this.inString = false;
        if (this.capture === "key") this.key = String(JSON.parse(this.finishCapture(text, i + 1)));
        continue;
      }
      const code = text.charCodeAt(i);
      if (isSpace(code)) continue;
      if (this.closed) throw new BackupFormatError();
      if (this.depth === 0) {
        if (code !== OPEN_BRACE) throw new BackupFormatError();
        this.depth = 1;
        this.expectKey = true;
        continue;
      }
      if (this.depth === 1 && this.expectKey) {
        if (code === QUOTE) {
          this.inString = true;
          this.beginCapture("key", i);
          continue;
        }
        if (code === CLOSE_BRACE) {
          this.depth = 0;
          this.closed = true;
          continue;
        }
        if (code === COLON) {
          this.expectKey = false;
          this.valuePending = true;
          continue;
        }
        throw new BackupFormatError();
      }
      if (this.valuePending) {
        this.valuePending = false;
        if (code === OPEN_BRACKET && ARRAY_KINDS[this.key]) {
          this.arrayKind = ARRAY_KINDS[this.key];
          this.arrays.add(this.arrayKind);
          this.elementPending = true;
          this.depth = 2;
          continue;
        }
        if (HEADER_KEYS.has(this.key)) this.beginCapture("value", i);
      } else if (this.elementPending && this.depth === 2) {
        this.elementPending = false;
        if (code !== CLOSE_BRACKET) this.beginCapture("element", i);
      }
      if (code === QUOTE) {
        this.inString = true;
      } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
        this.depth += 1;
      } else if (code === COMMA || code === CLOSE_BRACE || code === CLOSE_BRACKET) {
        if (this.depth === 1) {
          if (this.capture === "value") this.header.set(this.key, JSON.parse(this.finishCapture(text, i)));
          if (code === COMMA) this.expectKey = true;
          else if (code === CLOSE_BRACE) {
            this.depth = 0;
            this.closed = true;
          } else throw new BackupFormatError();
        } else if (this.depth === 2 && this.arrayKind) {
          if (this.capture === "element") this.out.push({ kind: this.arrayKind, json: this.finishCapture(text, i) });
          if (code === COMMA) this.elementPending = true;
          else {
            this.arrayKind = null;
            this.depth = 1;
          }
        } else if (code !== COMMA) {
          this.depth -= 1;
        }
      }
    }
    if (this.capture) {
      this.captureParts.push(text.slice(this.captureStart));
      this.captureStart = 0;
    }
    const done = this.out;
    this.out = [];
    return done;
  }

  /** Throws unless the whole object was read and it is a backup-v1 file. */
  finish(): void {
    if (!this.closed || this.header.get("format") !== "memo-backup" || this.header.get("version") !== 1 || !this.arrays.has("memo")) {
      throw new BackupFormatError();
    }
  }

  private beginCapture(kind: "key" | "value" | "element", start: number) {
    this.capture = kind;
    this.captureParts = [];
    this.captureStart = start;
  }

  private finishCapture(text: string, end: number): string {
    const tail = text.slice(this.captureStart, end);
    const value = this.captureParts.length > 0 ? this.captureParts.join("") + tail : tail;
    this.capture = null;
    this.captureParts = [];
    this.captureStart = -1;
    return value.trim();
  }
}

/** Read a Blob as text a slice at a time; nothing holds the whole file. */
async function* blobText(blob: Blob, sliceBytes = 4 * 1024 * 1024): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for (let offset = 0; offset < blob.size; offset += sliceBytes) {
    const bytes = await blob.slice(offset, offset + sliceBytes).arrayBuffer();
    yield decoder.decode(bytes, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function parseElement(kind: "memo" | "tag", json: string): BackupItem {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new BackupFormatError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BackupFormatError();
  return kind === "memo" ? { kind, memo: value as BackupMemo } : { kind, tag: value as BackupTag };
}

/** Every memo and tag in the file, in file order, one parsed record at a time. */
export async function* readBackupItems(blob: Blob): AsyncGenerator<BackupItem> {
  const scanner = new BackupScanner();
  for await (const text of blobText(blob)) {
    for (const element of scanner.push(text)) yield parseElement(element.kind, element.json);
  }
  scanner.finish();
}

/**
 * Validate a backup file and count what it holds without keeping any of it,
 * so the confirm dialog can name the totals while only the File is retained.
 */
export async function inspectBackup(blob: Blob): Promise<{ memoCount: number; imageCount: number }> {
  let memoCount = 0;
  let imageCount = 0;
  for await (const item of readBackupItems(blob)) {
    if (item.kind !== "memo") continue;
    memoCount += 1;
    if (Array.isArray(item.memo.images)) imageCount += item.memo.images.length;
  }
  return { memoCount, imageCount };
}
