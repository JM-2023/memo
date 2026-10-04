export interface MemoImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export interface Memo {
  id: string;
  content: string;
  /** Immutable initial send time; edits and memo actions never rewrite it. */
  createdAt: string;
  /** Latest content/attachment edit, equal to createdAt until the first edit. */
  updatedAt: string;
  pinnedAt: string | null;
  /** Non-null = the memo sits in the recycle bin. */
  deletedAt: string | null;
  /** Global change sequence — drives incremental sync. */
  seq: number;
  images: MemoImage[];
}

export interface NewImagePayload {
  /** Stable client-generated id; retries must not duplicate an attachment. */
  id: string;
  dataBase64: string;
  mime: string;
  width: number;
  height: number;
  /** Small feed preview; absent when the attachment is already small. */
  thumbBase64?: string;
  thumbMime?: string;
  /** Local-only preview URL while composing. */
  previewUrl: string;
}

/** Server-side tag decoration (pin state); the tag itself lives in memo text. */
export interface TagMeta {
  path: string;
  pinnedAt: string | null;
  seq: number;
}

/** One lightbox entry: a stored attachment or an external image link. */
export interface LightboxItem {
  src: string;
  external?: boolean;
  /** A stored attachment's id: the lightbox draws it through the image cache. */
  imageId?: string;
}

export type SortKey = "created-desc" | "created-asc" | "updated-desc" | "updated-asc";
