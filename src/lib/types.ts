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
  createdAt: string;
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
}

export type SortKey = "created-desc" | "created-asc" | "updated-desc" | "updated-asc";
