import { Bold, Hash, Image as ImageIcon, ImageOff, ImagePlus, Link2, List, Loader2, Plus, Table, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { ApiError } from "../lib/api";
import { isImageUrl } from "../lib/content";
import { htmlCarriesText, htmlToMarkdown } from "../lib/htmlToMarkdown";
import { ImageSlotLedger } from "../lib/imageSlots";
import { compressImage } from "../lib/images";
import { useI18n } from "../lib/i18n";
import { announce } from "../lib/liveAnnouncer";
import { BUSY_HOLD_MS, EASE_OUT, EXIT_MS, T_BASE, T_SLOW } from "../lib/motion";
import { inheritTagContext } from "../lib/tags";
import {
  backspaceListMarker,
  continueListOnEnter,
  insertTableTemplate,
  listLineAt,
  shiftListIndent,
  tableTabStop,
  toggleBulletLine,
  toggleWrap,
  wrapActiveAt,
  wrapLink,
  type EditPatch
} from "../lib/markdownEdit";
import { caretPoint } from "../lib/textareaCaret";
import type { LightboxItem, MemoImage, NewImagePayload } from "../lib/types";
import { openLightboxFrom } from "./Lightbox";
import { StoredImg } from "./StoredImage";
import { useTip } from "./Tip";

const MAX_IMAGES = 9;
/** Mirrors MAX_CONTENT_CHARS in functions/api/memos/index.ts. */
const MAX_CONTENT_CHARS = 40_000;
/** Hard input cap: lets pastes overshoot the limit (so the overflow can be
 * shown) without ever asking the mirror layer to render megabytes. */
const HARD_INPUT_CAP = 100_000;
/** The counter appears once this close to the cap. */
const COUNTER_FROM = MAX_CONTENT_CHARS - 2_000;
/** The field grows with its text up to this share of the visible viewport
 * (the visual viewport, so an open on-screen keyboard shrinks it and Save
 * stays reachable), then scrolls inside. With a keyboard up, it also stops
 * where the bar below it would go under the keys (see autoGrow). */
const GROW_SHARE = 0.7;
const GROW_FLOOR = 200;
/** Removed attachments held for their toast's Undo — as many as the toast
 * stack shows at once (TOAST_LIMIT in App); an older one's Undo is gone. */
const UNDO_HOLD = 3;
/** A tile that could not be made stays this long, marked, before it fades. */
const FAILED_TILE_MS = 2_000;
/** A finger lifts a tile to reorder after holding still this long (a mouse
 * lifts it as soon as it moves), so a swipe across the row still scrolls. */
const TOUCH_LIFT_MS = 300;
/** The other tiles' glide into place once a reordered one is let go. */
const REORDER_MS = T_SLOW;

/**
 * An edit discarded by Esc / Cancel, held in memory only (drafts are never
 * persisted) so the Undo on the "Discarded" toast can reopen it as it was.
 * Pending attachments travel with it: their preview URLs stay alive until
 * the draft is reopened or released.
 */
export interface EditDraft {
  content: string;
  newImages: NewImagePayload[];
  removedIds: string[];
  selectionStart: number;
  selectionEnd: number;
}

/** Shortcuts accept ⌘ or Ctrl everywhere; tips name the platform's own key. */
const APPLE_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const MOD = APPLE_KEYS ? "⌘" : "Ctrl+";
const SHIFT = APPLE_KEYS ? "⇧" : "Shift+";
/** How long the tag list outlives a blur of the field: a press on one of its
 * options still lands, wherever focus went first. */
const SUGGEST_BLUR_MS = 120;

/** Characters a tag can hold (TAG_PATTERN in lib/tags). */
const TAG_CHAR = /[\p{L}\p{N}_\-/·]/u;
/** What may stand right before a `#` that opens the tag list: whitespace or
 * punctuation (CJK punctuation included), or a Han or kana character, since
 * Chinese and Japanese run a tag into the sentence with no space. A Latin
 * letter or a digit is a word going on: C#, page#section. */
const TAG_LEAD = /[\s\p{P}\p{S}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** The `#run` the caret sits in (or right after), if any — only where a tag can start. */
function tagTokenAt(value: string, caret: number): { hashStart: number; query: string } | null {
  let start = caret;
  while (start > 0 && !/[\s#]/.test(value[start - 1])) start -= 1;
  if (start === 0 || value[start - 1] !== "#") return null;
  const hashStart = start - 1;
  // By code point, so an emoji before the # is one character, not two halves.
  const lead = [...value.slice(Math.max(0, hashStart - 2), hashStart)].pop();
  if (lead !== undefined && (lead === "#" || !TAG_LEAD.test(lead))) return null;
  // A fragment inside a link (x.com/#top) is the link's own.
  let word = hashStart;
  while (word > 0 && !/\s/.test(value[word - 1])) word -= 1;
  if (value.slice(word, hashStart).includes("://")) return null;
  return { hashStart, query: value.slice(start, caret) };
}

/** Where `tag` holds the letters of `query` in order (#wrk → work), the
 * offsets of the ones that matched, first fit; null where it does not. */
function subsequenceHits(tag: string, query: string): number[] | null {
  const hits: number[] = [];
  let at = 0;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index].toLowerCase();
    while (at < tag.length && tag[at].toLowerCase() !== char) at += 1;
    if (at === tag.length) return null;
    hits.push(at);
    at += 1;
  }
  return hits;
}

/**
 * What a file drag carries, read from its item types (dragenter cannot read
 * the files themselves). A browser that keeps the types back until the drop
 * counts as images: the veil must never refuse what it cannot see.
 */
type FileDragKind = "images" | "other";

function isFileDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function fileDragKind(data: DataTransfer | null): FileDragKind {
  const files = [...(data?.items ?? [])].filter((item) => item.kind === "file");
  return files.length > 0 && files.every((item) => item.type && !item.type.startsWith("image/")) ? "other" : "images";
}

/**
 * Whether a paste that carries image files adds them as attachments. Office
 * apps (Excel, PowerPoint, Word) put a rendered picture of the selection
 * beside its HTML and plain text: the words are what was copied, so they
 * win, and the HTML converter turns copied cells into a table. The picture
 * wins when the HTML is only that picture (a browser's "Copy image"), when
 * there is no text at all (a screenshot), or when the only text is the
 * files' own names (a file copied in Finder or Explorer).
 */
function pasteTakesImages(data: DataTransfer, files: File[]): boolean {
  const html = data.getData("text/html");
  if (html.trim()) return !htmlCarriesText(html);
  const names = new Set(files.map((file) => file.name));
  return data
    .getData("text/plain")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .every((line) => !line || names.has(line.split(/[\\/]/).pop() ?? line));
}

/** A preview URL for a file still compressing (null where none can be made). */
function previewOf(file: File): string | null {
  try {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

/**
 * Window-level file-drop guard, shared by every mounted editor. A file let
 * go anywhere but on an editor — a few pixels off the composer, over a card
 * or the sidebar — would open in the tab and take the in-memory draft and
 * any open edit with it. So file drags are claimed window-wide and land in
 * the active editor: the open inline edit, else the visible composer, whose
 * veil lights for as long as the drag is over the window.
 */
interface DropTarget {
  mode: "create" | "edit";
  root: () => HTMLElement | null;
  /** Whether a drop of this kind would add anything (room left, images). */
  accepts: (kind: FileDragKind) => boolean;
  /** Light the veil for a drag elsewhere in the window, or put it out. */
  light: (kind: FileDragKind | null) => void;
  take: (files: File[]) => void;
}

const dropTargets = new Set<DropTarget>();
let releaseDropGuard: (() => void) | null = null;

function activeDropTarget(): DropTarget | null {
  let composer: DropTarget | null = null;
  for (const target of dropTargets) {
    const root = target.root();
    if (!root || root.closest("[hidden]")) continue;
    if (target.mode === "edit") return target;
    composer ??= target;
  }
  return composer;
}

function installDropGuard(): () => void {
  // Counter, not boolean: dragenter/leave fire per element crossed.
  let depth = 0;
  let lit: DropTarget | null = null;
  let idle = 0;
  const reset = () => {
    depth = 0;
    window.clearTimeout(idle);
    lit?.light(null);
    lit = null;
  };
  const onEnter = (event: globalThis.DragEvent) => {
    if (!isFileDrag(event)) return;
    depth += 1;
    if (lit) return;
    lit = activeDropTarget();
    lit?.light(fileDragKind(event.dataTransfer));
  };
  const onLeave = (event: globalThis.DragEvent) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) reset();
  };
  const onOver = (event: globalThis.DragEvent) => {
    if (!isFileDrag(event)) return;
    // Some browsers skip the last dragleave when a drag leaves the window;
    // dragover repeats while it is still here, so its silence puts the
    // veil out.
    window.clearTimeout(idle);
    idle = window.setTimeout(reset, 1000);
    // An editor under the pointer has already answered for itself.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const target = activeDropTarget();
    if (event.dataTransfer) event.dataTransfer.dropEffect = target?.accepts(fileDragKind(event.dataTransfer)) ? "copy" : "none";
  };
  const onDrop = (event: globalThis.DragEvent) => {
    reset();
    if (!isFileDrag(event) || event.defaultPrevented) return;
    event.preventDefault();
    activeDropTarget()?.take([...(event.dataTransfer?.files ?? [])]);
  };
  window.addEventListener("dragenter", onEnter, true);
  window.addEventListener("dragleave", onLeave, true);
  window.addEventListener("dragover", onOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("dragend", reset, true);
  return () => {
    window.removeEventListener("dragenter", onEnter, true);
    window.removeEventListener("dragleave", onLeave, true);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("dragend", reset, true);
    reset();
  };
}

function registerDropTarget(target: DropTarget): () => void {
  dropTargets.add(target);
  releaseDropGuard ??= installDropGuard();
  return () => {
    dropTargets.delete(target);
    if (dropTargets.size > 0) return;
    releaseDropGuard?.();
    releaseDropGuard = null;
  };
}

/**
 * The Send/Save glyph: a solid paper dart, level with the label so the two
 * read as one direction. Drawn here rather than taken from lucide — the
 * outline plane sat at 45° in the accent green and read as a second, lighter
 * object beside the 600-weight label. The stroke only rounds the corners.
 */
function SendGlyph({ flying = false, onFlown }: { flying?: boolean; onFlown?: () => void }) {
  // `flying`: the composer just cleared after a send, and the dart flies
  // off and comes back round (app.css, .send-glyph.is-flying).
  return (
    <svg className={`send-glyph${flying ? " is-flying" : ""}`} width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" onAnimationEnd={onFlown}>
      <path fill="currentColor" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M3.6 3.7 20.9 12 3.6 20.3 6.7 13.25 13.4 12 6.7 10.75Z" />
    </svg>
  );
}

/** `text` with the characters at `hits` (sorted offsets into it) set in
 * weight 600 — what matched of a suggestion, runs drawn as one. */
function withHits(text: string, hits: number[]): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let index = 0; index < hits.length; ) {
    const start = hits[index];
    let end = start + 1;
    index += 1;
    while (index < hits.length && hits[index] === end) {
      end += 1;
      index += 1;
    }
    if (start < cursor || end > text.length) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <b key={start} className="tag-suggest-hit">
        {text.slice(start, end)}
      </b>
    );
    cursor = end;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

interface EditorProps {
  mode: "create" | "edit";
  initialContent?: string;
  /** Edit mode: attachments already on the memo. */
  existingImages?: MemoImage[];
  knownTags: string[];
  /** Create mode: the active feed tag that will be inherited on submit. */
  contextTag?: string | null;
  busy: boolean;
  onSubmit: (data: EditorSubmission) => Promise<boolean>;
  /** Edit mode: `draft` is null when nothing changed (a plain close). */
  onCancel?: (draft: EditDraft | null) => void;
  /** Edit mode: reopen a discarded draft instead of the memo's own text. */
  initialDraft?: EditDraft | null;
  /** Where autoFocus puts the caret (default: the end). `viewportY` is the
   * screen row the reader double-clicked, so that line stays under them. */
  initialCaret?: { offset: number; viewportY?: number } | null;
  autoFocus?: boolean;
  conflictMessage?: string | null;
  onAcceptRemoteBase?: () => void;
  /** Reports the text after every change, so the owner can hold an unsent draft in memory. */
  onDraftChange?: (content: string) => void;
  /** Raises a toast for something the editor did on its own (an image
   * removed), with an optional action such as Undo. Without it a removal
   * is final and its preview is released at once. */
  onNotice?: (text: string, action?: { label: string; run: () => void }) => void;
  /** Opens an attachment tile in the photo viewer (App's Lightbox). */
  onOpenImage?: (items: LightboxItem[], index: number) => void;
  /** Edit mode: hands the owner this edit's handle as it opens (`open`) and
   * takes it back as it goes. */
  onHandle?: (handle: EditHandle, open: boolean) => void;
  /** Create mode: the owner's handle for putting a sent memo back. */
  controlRef?: { current: ComposerControl | null };
  /** Create mode: whether the composer holds anything (text or images). */
  onOccupiedChange?: (occupied: boolean) => void;
  /** Create mode: ⌘Z / Ctrl+Z in the composer a send just emptied, before
   * anything else is typed. True when the owner took the memo back. */
  onUndoSend?: () => boolean;
}

/**
 * What the owner may ask of an open edit when another memo's Edit is
 * pressed (App, startEdit): whether there is anything to lose, and the two
 * ways on from there.
 */
export interface EditHandle {
  /** The text or images differ from what the edit opened on. */
  readonly dirty: boolean;
  /** Bring the edit back into view, focus it, and pulse its border. */
  attend: () => void;
  /** Close the edit as Esc does (a dirty one goes up through onCancel as a
   * draft, Undo and all); false while a save holds it. */
  discard: () => boolean;
}

/** A sent memo coming back into the composer (taken back, or to be edited). */
export interface ComposerDraft {
  content: string;
  newImages: NewImagePayload[];
  selectionStart: number;
  selectionEnd: number;
}

export interface ComposerControl {
  /** Puts `draft` in, caret and focus included; false, changing nothing,
   * unless the composer is empty and idle. */
  recall: (draft: ComposerDraft) => boolean;
}

/** One attachment tile: an image on the memo, one ready to upload, or one
 * still being compressed (shown from the original file meanwhile). */
type AttachmentTile =
  | { kind: "stored"; key: string; image: MemoImage }
  | { kind: "pending"; key: string; image: NewImagePayload }
  | ({ kind: "preparing" } & PreparingImage);

/** An image being compressed: its tile's key and a preview of the original.
 * One that failed keeps its tile a moment, marked, then fades (`leaving`). */
interface PreparingImage {
  key: string;
  url: string | null;
  failed?: boolean;
  leaving?: boolean;
}

/** A pending tile being dragged to a new place in the row. */
interface TileDrag {
  id: string;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  lifted: boolean;
  holdTimer: number;
  tile: HTMLElement;
  handle: HTMLElement;
  /** The movable tiles' boxes when it lifted, relative to the row. */
  slots: Array<{ id: string; left: number; top: number; right: number; bottom: number }>;
  /** Where letting go would put it: before this image, at the end (null),
   * or nowhere new (undefined). */
  before: string | null | undefined;
  /** Stops listening for a release the tile itself never hears. */
  unlisten: () => void;
}

/** The toolbar's buttons, in order (its one Tab stop roves among them). */
type ToolKey = "tag" | "bold" | "list" | "table" | "image" | "link";
const TOOL_ORDER: ToolKey[] = ["tag", "bold", "list", "table", "image", "link"];

export interface EditorSubmission {
  clientId: string;
  content: string;
  newImages: NewImagePayload[];
  removeImageIds: string[];
  /** Create mode: the caret in `content` when Send went. */
  selection?: { start: number; end: number };
  /** Set when a save (edit mode) carries new images: reports the sent
   * fraction (0..1). A send lands at once and uploads in the background. */
  onUploadProgress?: (fraction: number) => void;
  /** Aborted when Esc stops the send in flight. The owner hands it to the
   * request and, once it has fired, resolves false (or rejects) without
   * landing anything; the draft keeps its clientId, so sending it again is
   * still idempotent if the first request got through after all. */
  signal?: AbortSignal;
  /** Create mode: the owner calls this inside the update that lands the new
   * memo, so the composer clears in that same commit (and the same view
   * transition, `animated`) instead of a frame later. Optional: a create
   * resolved true without it clears afterwards as before. Once cleared, the
   * sent images and their preview URLs are the owner's to release. */
  onCommitted?: (animated: boolean) => void;
}

interface Suggestion {
  tokenStart: number;
  query: string;
  /** Empty when nothing matches: the list then only says a new tag is on its way. */
  items: string[];
  /** The lit row; -1 for none yet (a bare #: Enter still breaks the line,
      Tab or ↓ picks one). */
  index: number;
  /** The typed run already spells a known tag in full; Enter must not swap
      it for a longer suggestion (e.g. `#life` → `#life/cooking`). */
  exact: boolean;
  /** No tag spells the run outright; these only hold its letters in order. */
  fuzzy: boolean;
}

/**
 * The composer used both for new memos and in-place editing. Plain text with
 * #tag affordances: a toolbar "#" button, live tag autocomplete under the
 * caret token. Markdown is written as plain syntax (cards render it):
 * Enter continues list/task/quote lines and builds tables row by row, Tab
 * indents lists and hops table cells, ⌘B/⌘I/⌘E/⌘⇧S/⌘⇧H wrap the selection
 * (⌘K makes it a link), and the toolbar covers bold + list + table for touch. Images
 * arrive four ways: file picker, paste, drag-and-drop (all compressed
 * client-side and stored), or as an external link that renders as a preview
 * without touching the database.
 */
export function Editor({
  mode,
  initialContent = "",
  existingImages = [],
  knownTags,
  contextTag = null,
  busy,
  onSubmit,
  onCancel,
  initialDraft = null,
  initialCaret = null,
  autoFocus,
  conflictMessage,
  onAcceptRemoteBase,
  onDraftChange,
  onNotice,
  onOpenImage,
  onHandle,
  controlRef,
  onOccupiedChange,
  onUndoSend
}: EditorProps) {
  const { errorMessage, formatNumber, tr } = useI18n();
  const tip = useTip();
  const [content, setContent] = useState(initialDraft?.content ?? initialContent);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current?.(content);
  }, [content]);
  // What "unchanged" means for Cancel: the text this editor opened on (a
  // remote update arriving mid-edit does not make an untouched edit dirty).
  const [openedOn] = useState(initialContent);
  const [newImages, setNewImages] = useState<NewImagePayload[]>(() => initialDraft?.newImages ?? []);
  const [removedIds, setRemovedIds] = useState<string[]>(() => initialDraft?.removedIds ?? []);
  // Images still compressing, in the order they were added. Each already
  // has the tile it keeps once it lands (tileKeysRef carries the key over).
  const [preparing, setPreparing] = useState<PreparingImage[]>([]);
  const compressing = preparing.filter((item) => !item.failed).length;
  const tileKeysRef = useRef(new Map<string, string>());
  const preparingUrlsRef = useRef(new Set<string>());
  // Tiles the editor opened with (the memo's images, a reopened draft's):
  // they are already on screen in the card, so they do not pop in again.
  const [settledTiles] = useState(
    () => new Set([...existingImages.map((image) => image.id), ...(initialDraft?.newImages ?? []).map((image) => image.id)])
  );
  const [submitting, setSubmitting] = useState(false);
  // Whole percent of the image upload sent so far; null while none is running.
  // Held at 99 until the server answers: the last bytes leaving the browser
  // is not the memo being saved.
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  // The list as it was when it closed, held while it plays its exit (the
  // same element: it leaves from where it stood).
  const [leavingSuggestion, setLeavingSuggestion] = useState<Suggestion | null>(null);
  const [lastSuggestion, setLastSuggestion] = useState<Suggestion | null>(null);
  if (suggestion !== lastSuggestion) {
    setLastSuggestion(suggestion);
    setLeavingSuggestion(suggestion ? null : lastSuggestion);
  }
  // An IME is composing: the open list steps aside (the text is pinyin or
  // kana until it commits) and comes back for the committed word without
  // replaying its entrance, so a tag typed in two compositions never blinks.
  const [composing, setComposing] = useState(false);
  // `cause` lets an error leave once what raised it is gone: the link
  // complaint with the link row, the image cap once an image is removed,
  // anything else (a refused file, a failed send) once the text is edited.
  // `seq` gives each complaint its own line, so the same words a second time
  // (a retry that fails again) still arrive as news; fail() speaks them.
  const [error, setError] = useState<{ text: string; cause: "link" | "limit" | "other"; seq: number } | null>(null);
  const errorSeqRef = useRef(0);
  const lastErrorRef = useRef("");
  const errorLineRef = useRef<{ key: string | null; replacing: boolean }>({ key: null, replacing: false });
  const lastConflictRef = useRef("");
  // Counter, not boolean: dragenter/leave fire per child element.
  const [dragDepth, setDragDepth] = useState(0);
  // What a file drag over this editor carries.
  const [dragKind, setDragKind] = useState<FileDragKind>("images");
  // A file drag elsewhere in the window, when this is the editor it would land in.
  const [windowDrag, setWindowDrag] = useState<FileDragKind | null>(null);
  const veilRef = useRef({ label: "", refused: false });
  // Send pressed while an image was still compressing: it goes out on its own
  // once the last one lands.
  const [sendQueued, setSendQueued] = useState(false);
  const sendQueuedRef = useRef(false);
  sendQueuedRef.current = sendQueued;
  const [spinnerShown, setSpinnerShown] = useState(false);
  // Bumped when a confirmed create clears the composer; the layout effect
  // below then sizes the emptied field in that same commit.
  const [clears, setClears] = useState(0);
  const clearGrowRef = useRef<"instant" | "smooth" | null>(null);
  // Attachments play their exit animation before the state actually drops
  // them — keyed by image id, stored or pending.
  const [removingKeys, setRemovingKeys] = useState<ReadonlySet<string>>(new Set());
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  // Pending images removed with an Undo on offer: their previews stay alive
  // until the Undo is spent or out of reach (UNDO_HOLD), the draft is sent,
  // or the editor closes. A send bumps the epoch, so an Undo raised before
  // it cannot put an image into the next memo.
  const heldRemovalsRef = useRef<NewImagePayload[]>([]);
  const undoEpochRef = useRef(0);
  const addImageRef = useRef<HTMLButtonElement>(null);
  // A pending tile lifted to reorder, and the insertion bar's spot in the
  // row while letting go would move it.
  const [reorder, setReorder] = useState<{ id: string; bar: { left: number; top: number; height: number } | null } | null>(null);
  const tileDragRef = useRef<TileDrag | null>(null);
  // The click that trails a drag's release is not a tap to open the tile.
  const tileClickFloorRef = useRef(0);
  // Tile centres taken just before the order changes; the layout effect
  // after it glides each tile from there (FLIP). `flips` asks for that pass.
  const flipFromRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const refocusTileRef = useRef<string | null>(null);
  const [flips, setFlips] = useState(0);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  // Bold and List show whether the caret already sits in bold text or on a
  // list line (aria-pressed).
  const [pressed, setPressed] = useState({ bold: false, list: false });
  // The toolbar is one Tab stop; ←/→ move it between the tools.
  const [toolStop, setToolStop] = useState<ToolKey>("tag");
  // Bumped when another memo's Edit is refused: the field's border pulses.
  const [attention, setAttention] = useState(0);
  // Sends whose cleared composer the glyph has already flown for.
  const [flown, setFlown] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const suggestRef = useRef<HTMLDivElement>(null);
  // ⌘⇧V / Ctrl+Shift+V asks for plain text even when HTML is on offer.
  const plainPasteRef = useRef(false);
  // Between compositionstart and compositionend the IME owns the text.
  const composingRef = useRef(false);
  // A selection this editor set itself (landValue): its select event must
  // not reopen the tag list a completion just closed.
  const quietSelectRef = useRef<{ start: number; end: number } | null>(null);
  const suggestionListId = useId();
  const contextTagDescriptionId = useId();
  const countId = useId();
  const linkPopId = useId();
  // Stable across ambiguous network failures; rotate only after a confirmed
  // create so retrying the same draft remains idempotent.
  const draftIdRef = useRef(crypto.randomUUID());
  const submittingRef = useRef(false);
  // The send in flight, until the owner lands it (onCommitted) or it settles:
  // Esc aborts it through this.
  const abortRef = useRef<AbortController | null>(null);
  // Create mode: a send has just emptied the composer and nothing has been
  // typed since, so ⌘Z means the send (onUndoSend), not the field's history.
  const freshClearRef = useRef(false);
  const onUndoSendRef = useRef(onUndoSend);
  onUndoSendRef.current = onUndoSend;
  const mountedRef = useRef(true);
  const [imageSlots] = useState(() => new ImageSlotLedger(MAX_IMAGES, existingImages.length));

  const keptExisting = useMemo(() => existingImages.filter((image) => !removedIds.includes(image.id)), [existingImages, removedIds]);

  /**
   * Start an attachment's exit. Focus on its × would fall to <body> once the
   * tile unmounts, so it moves on first: to the next tile's ×, else the one
   * before, else Add image (or, for a keyboard reader, the field).
   */
  function beginRemove(id: string, button: HTMLButtonElement) {
    if (busy || submittingRef.current || sendQueuedRef.current) return;
    if (document.activeElement === button) {
      const others = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>(".attachment:not(.is-removing) .attachment-remove") ?? [])];
      const at = others.indexOf(button);
      let keyboard = false;
      try {
        keyboard = button.matches(":focus-visible");
      } catch {
        keyboard = false;
      }
      const add = addImageRef.current;
      const target = others[at + 1] ?? others[at - 1] ?? (add && !add.disabled ? add : keyboard ? areaRef.current : null);
      target?.focus({ preventScroll: true });
    }
    // A tile coming back through Undo pops in like any new one.
    settledTiles.delete(id);
    setRemovingKeys((value) => new Set(value).add(id));
  }
  function settleRemove(key: string, drop: () => void) {
    setRemovingKeys((value) => {
      if (!value.has(key)) return value;
      const next = new Set(value);
      next.delete(key);
      return next;
    });
    drop();
    clearError("limit");
  }
  /** Raise the "Removed the image" toast; its Undo runs `restore` if it still can. */
  function offerUndo(restore: () => void) {
    const notice = onNoticeRef.current;
    if (!notice) return;
    const epoch = undoEpochRef.current;
    notice(tr("Removed the image", "已移除图片"), {
      label: tr("Undo", "撤销"),
      run: () => {
        if (!mountedRef.current || epoch !== undoEpochRef.current || submittingRef.current || sendQueuedRef.current) return;
        restore();
      }
    });
  }
  /** Claim a slot for an image coming back; false (and says so) when full. */
  function reclaimSlot(): boolean {
    if (imageSlots.reserve(1) < 1) {
      fail(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`), "limit");
      return false;
    }
    imageSlots.settle(true);
    return true;
  }
  /** Hold a removed pending image for its Undo; the oldest beyond UNDO_HOLD is released. */
  function holdRemoval(image: NewImagePayload) {
    const held = [...heldRemovalsRef.current, image];
    for (const stale of held.splice(0, Math.max(0, held.length - UNDO_HOLD))) URL.revokeObjectURL(stale.previewUrl);
    heldRemovalsRef.current = held;
  }
  function releaseHeldRemovals() {
    for (const image of heldRemovalsRef.current) URL.revokeObjectURL(image.previewUrl);
    heldRemovalsRef.current = [];
  }
  function fail(text: string, cause: "link" | "limit" | "other" = "other") {
    errorSeqRef.current += 1;
    setError({ text, cause, seq: errorSeqRef.current });
    // Spoken through the standing region: a line mounted already filled
    // (the note below) is often skipped by screen readers.
    announce(text, "assertive");
  }
  function clearError(cause: "link" | "limit" | "other") {
    setError((current) => (current?.cause === cause ? null : current));
  }
  const totalImages = keptExisting.length + newImages.length;
  const sending = submitting || sendQueued;
  const locked = busy || sending;
  const imageLimitExceeded = totalImages > MAX_IMAGES;
  const submittedContent = content.trim();
  const effectiveContent = mode === "create" && contextTag ? inheritTagContext(submittedContent, contextTag) : submittedContent;
  const effectiveContentLength = effectiveContent.length;
  const overLimit = effectiveContentLength > MAX_CONTENT_CHARS;
  // Attachments mid-exit-animation count as removed already.
  const keptNewImages = newImages.filter((image) => !removingKeys.has(image.id));
  const removedImageIds = [...removedIds, ...existingImages.filter((image) => removingKeys.has(image.id)).map((image) => image.id)];
  // An edit is clean until its text or images differ from what it opened on
  // (an image still compressing counts as a change). Save rests until then,
  // and ⌘↩ on a clean edit just closes it, like Esc.
  const dirty =
    mode === "create" || content.trim() !== openedOn.trim() || keptNewImages.length > 0 || removedImageIds.length > 0 || compressing > 0;
  const hasPayload = submittedContent.length > 0 || totalImages > 0;
  const ready = !busy && !submitting && !conflictMessage && !overLimit && !imageLimitExceeded && dirty;
  const canSubmit = ready && !sendQueued && compressing === 0 && hasPayload;
  // Send pressed mid-compression is accepted and held (see submit).
  const canQueue = ready && !sendQueued && compressing > 0;

  // The owner's handle on this edit (see EditHandle): one stable object
  // reading the latest render through a ref, so App can hold it across
  // renders and tell it from an outgoing editor still finishing its morph.
  const handleRef = useRef<{ dirty: boolean; attend: () => void; discard: () => boolean }>({ dirty, attend, discard: () => false });
  handleRef.current = {
    dirty,
    attend,
    discard: () => {
      if (!onCancel || locked) return false;
      cancel();
      return true;
    }
  };
  const [handle] = useState<EditHandle>(() => ({
    get dirty() {
      return handleRef.current.dirty;
    },
    attend: () => handleRef.current.attend(),
    discard: () => handleRef.current.discard()
  }));
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  useEffect(() => {
    const report = onHandleRef.current;
    report?.(handle, true);
    return () => report?.(handle, false);
  }, [handle]);

  useLayoutEffect(() => {
    imageSlots.syncCommitted(totalImages);
  }, [imageSlots, totalImages]);

  // Too many images (an accepted remote base can bring more) is said like any
  // complaint; fail() speaks the others.
  const imageLimitText = tr(`Remove images until no more than ${MAX_IMAGES} remain`, `请移除图片，最多保留 ${MAX_IMAGES} 张`);
  useEffect(() => {
    if (imageLimitExceeded) announce(imageLimitText, "assertive");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageLimitExceeded]);

  // A save conflict is said once, calmly, by its note: the draft is safe, and
  // the note carries the way on.
  useEffect(() => {
    if (conflictMessage) announce(conflictMessage);
  }, [conflictMessage]);

  // Never split a surrogate pair at the highlight boundary — the mirror would
  // render two replacement glyphs at a different width and the red region
  // would drift off the real text.
  let overflowCut = MAX_CONTENT_CHARS;
  if (overLimit) {
    const boundary = content.charCodeAt(overflowCut - 1);
    if (boundary >= 0xd800 && boundary <= 0xdbff) overflowCut -= 1;
  }

  /** The mirror is its own (hidden) scroller; keep it glued to the textarea. */
  function syncOverflowScroll() {
    const layer = overflowRef.current;
    const area = areaRef.current;
    if (layer && area) layer.scrollTop = area.scrollTop;
  }
  useLayoutEffect(() => {
    if (overLimit) syncOverflowScroll();
  }, [content, overLimit]);

  // Layout effect: the textarea must reach its grown height before the card
  // stage measures the editor scene for its height morph. preventScroll keeps
  // entering edit mode from yanking the page — the stage animates instead.
  // The caret goes where the reader asked for it: a reopened draft's own
  // selection, the double-clicked spot, or else the end (menu › Edit, the
  // usual "add a line" case).
  useLayoutEffect(() => {
    autoGrow(true);
    if (autoFocus) {
      const area = areaRef.current;
      if (area) {
        area.focus({ preventScroll: true });
        const end = area.value.length;
        if (initialDraft) {
          area.setSelectionRange(Math.min(initialDraft.selectionStart, end), Math.min(initialDraft.selectionEnd, end));
          revealCaret(area, area.selectionEnd);
        } else if (initialCaret && initialCaret.offset < end) {
          area.setSelectionRange(initialCaret.offset, initialCaret.offset);
          revealCaret(area, initialCaret.offset, initialCaret.viewportY);
        } else {
          area.setSelectionRange(end, end);
        }
        // Opening an edit is not a caret move: a memo that ends on a tag
        // must not open with the tag list up.
        quietSelectRef.current = { start: area.selectionStart, end: area.selectionEnd };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The grow cap follows the visual viewport (an on-screen keyboard opening
  // or closing resizes it).
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onResize = () => autoGrow(true);
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (linkOpen) linkRef.current?.focus();
  }, [linkOpen]);

  // Every edit can move the caret into or out of bold text or a list line
  // (caret moves alone are caught by onCaretMove).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(syncPressed, [content]);

  // A reorder just landed: each tile glides from where it was to its new
  // place (under reduced motion a tile that moved fades in there instead),
  // and a tile moved from the keyboard keeps focus through its DOM move.
  useLayoutEffect(() => {
    const from = flipFromRef.current;
    flipFromRef.current = null;
    if (from) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      const to = tileCentres();
      for (const tile of attachmentsRef.current?.querySelectorAll<HTMLElement>(".attachment[data-image-id]") ?? []) {
        const was = from.get(tile.dataset.imageId ?? "");
        const now = to.get(tile.dataset.imageId ?? "");
        if (!was || !now || typeof tile.animate !== "function") continue;
        const dx = was.x - now.x;
        const dy = was.y - now.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        tile.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: reduced ? T_BASE : REORDER_MS,
          easing: EASE_OUT
        });
      }
    }
    const refocus = refocusTileRef.current;
    refocusTileRef.current = null;
    if (refocus) {
      const row = [...(attachmentsRef.current?.querySelectorAll<HTMLElement>(".attachment[data-image-id]") ?? [])];
      row.find((tile) => tile.dataset.imageId === refocus)?.querySelector<HTMLElement>(".attachment-open")?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flips]);

  // A finger that lifted a tile drags it, not the page. Registered up front
  // (and not passive): a browser decides whether a touch may scroll as it
  // starts, so a listener added mid-drag would come too late.
  const hasTiles = keptExisting.length + newImages.length + preparing.length > 0;
  useEffect(() => {
    const row = attachmentsRef.current;
    if (!row) return;
    const hold = (event: TouchEvent) => {
      if (tileDragRef.current?.lifted) event.preventDefault();
    };
    row.addEventListener("touchmove", hold, { passive: false });
    return () => row.removeEventListener("touchmove", hold);
  }, [hasTiles]);

  /**
   * The tag list opens at the "#" being typed, not pinned under the field:
   * just below that line (above it when the viewport has no room below),
   * with its first "#" over the typed one. Anchored to the token start, so
   * it holds still while the query grows. Placed before paint. The room is
   * the visual viewport's — with a keyboard up on a phone that strip may be
   * scrolled down the page (offsetTop), and the list must fit inside it.
   * Above the line it rises from the line, like a menu opened upward
   * (data-side picks the mirrored keyframes in app.css).
   */
  function placeSuggest() {
    const pop = suggestRef.current;
    const area = areaRef.current;
    const host = pop?.offsetParent as HTMLElement | null | undefined;
    if (!pop || !area || !host || !suggestion) return;
    const caret = caretPoint(area, suggestion.tokenStart);
    const areaRect = area.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    // A token scrolled out of the field pins the list to the field's edge.
    const lineTop = Math.min(Math.max(areaRect.top + caret.top - area.scrollTop, areaRect.top), areaRect.bottom - caret.height);
    const below = lineTop + caret.height + 4;
    const above = lineTop - 4 - pop.offsetHeight;
    const viewport = window.visualViewport;
    const visibleTop = viewport?.offsetTop ?? 0;
    const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight);
    const flip = below + pop.offsetHeight > visibleBottom && above >= visibleTop;
    // 16 = list padding + option padding: option text starts over the "#".
    const left = areaRect.left + caret.left - area.scrollLeft - 16 - hostRect.left - host.clientLeft;
    pop.style.top = `${(flip ? above : below) - hostRect.top - host.clientTop}px`;
    pop.style.left = `${Math.max(0, Math.min(left, host.clientWidth - pop.offsetWidth))}px`;
    pop.style.transformOrigin = flip ? "bottom left" : "top left";
    pop.dataset.side = flip ? "up" : "down";
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(placeSuggest, [suggestion, content]);

  useEffect(() => {
    if (!locked) return;
    setDragDepth(0);
    setSuggestion(null);
  }, [locked]);

  // Sending reads the same as resting for a beat (the busy hold, --t-hold):
  // a fast send never flashes the spinner, a slow one fades it in.
  useEffect(() => {
    if (!sending) {
      setSpinnerShown(false);
      return;
    }
    const timer = window.setTimeout(() => setSpinnerShown(true), BUSY_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [sending]);

  // A queued send goes out as soon as the last image has landed; one that
  // can no longer go (a compression failed, a conflict arrived) is dropped.
  useEffect(() => {
    if (!sendQueued || compressing > 0) return;
    setSendQueued(false);
    if (ready && hasPayload) void submit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendQueued, compressing]);

  // A confirmed create emptied the field: size it in the same commit, so a
  // view transition captures the composer at its final height.
  useLayoutEffect(() => {
    const grow = clearGrowRef.current;
    if (!grow) return;
    clearGrowRef.current = null;
    autoGrow(grow === "instant");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clears]);

  // The window-wide file-drop guard (see installDropGuard). The callbacks
  // read the latest render through refs; the registration lives as long as
  // the editor.
  const addFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const acceptsRef = useRef<(kind: FileDragKind) => boolean>(() => false);
  useEffect(
    () =>
      registerDropTarget({
        mode,
        root: () => rootRef.current,
        accepts: (kind) => acceptsRef.current(kind),
        light: setWindowDrag,
        take: (files) => addFilesRef.current(files)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // If an update committed but its response was lost, the conflict payload
  // will contain our stable image ids. Retire the matching local payloads so
  // accepting the new base does not try to insert the same attachments again.
  useEffect(() => {
    if (newImages.length === 0 || existingImages.length === 0) return;
    const storedIds = new Set(existingImages.map((image) => image.id));
    const committed = newImages.filter((image) => storedIds.has(image.id));
    if (committed.length === 0) return;
    for (const image of committed) URL.revokeObjectURL(image.previewUrl);
    setNewImages((current) => current.filter((image) => !storedIds.has(image.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingImages]);

  // Object URLs for pending attachments leak unless revoked; only revoke on
  // unmount (successful submit unmounts or clears the list). Previews of
  // images still compressing and of removals held for Undo go too.
  const previewUrls = useRef<string[]>([]);
  useEffect(() => {
    previewUrls.current = newImages.map((image) => image.previewUrl);
  }, [newImages]);
  useEffect(() => {
    mountedRef.current = true;
    const preparingUrls = preparingUrlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      for (const url of preparingUrls) URL.revokeObjectURL(url);
      releaseHeldRemovals();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * How tall the field may grow: GROW_SHARE of the visible viewport. With an
   * on-screen keyboard up (the visual viewport shorter than the layout one,
   * and not from a pinch) the share alone is not enough — a field that
   * starts a hundred pixels down would push the bar, and Send, under the
   * keys — so it also stops where everything below it in the editor still
   * fits above the keyboard, counted from where the field starts in the
   * visible strip (useKeyboardInset reads the strip the same way).
   */
  function growCap(area: HTMLTextAreaElement): number {
    const viewport = window.visualViewport;
    const visible = viewport?.height ?? window.innerHeight;
    const share = Math.max(GROW_FLOOR, Math.round(visible * GROW_SHARE));
    if (!viewport || viewport.scale > 1.01 || window.innerHeight - visible < 1) return share;
    const field = area.getBoundingClientRect();
    const below = (rootRef.current?.getBoundingClientRect().bottom ?? field.bottom) - field.bottom;
    const top = Math.max(0, field.top - viewport.offsetTop);
    const room = Math.floor(visible - top - below - 8);
    return Math.max(mode === "create" ? 68 : 96, Math.min(share, room));
  }

  /**
   * Size the field to its text (up to the cap). Measuring goes through
   * height "auto", which no transition can interpolate from — so a growing
   * or shrinking field puts its current height back and commits it before
   * writing the new one, and `transition: height` (app.css) eases each new
   * line in and an emptied composer shut. `instant` skips the ease: the
   * first sizing on mount (the card stage measures the editor right after),
   * a viewport resize, and a clear that a view transition is morphing.
   */
  function autoGrow(instant = false) {
    const area = areaRef.current;
    if (!area) return;
    const cap = growCap(area);
    // Measuring at "auto" resets the inner scroll; put it back so a long
    // draft does not jump while it is typed into.
    const scrollTop = area.scrollTop;
    // The height on screen right now — mid-ease if a line was just added.
    const from = area.style.height ? area.offsetHeight : 0;
    area.style.height = "auto";
    const textHeight = area.scrollHeight;
    const next = Math.min(cap, Math.max(mode === "create" ? 68 : 96, textHeight));
    if (!instant && from > 0 && from !== next) {
      area.style.height = `${from}px`;
      // Commit the start height so the write below transitions from it.
      void area.offsetHeight;
    }
    area.style.height = `${next}px`;
    // Text that fits the new height starts at the top: the new line is
    // uncovered as the field eases open instead of the text sliding down.
    area.scrollTop = textHeight <= next ? 0 : scrollTop;
  }

  /**
   * Bring the caret line of a long draft into view, aiming it at
   * `viewportY` (the line the reader double-clicked stays under the
   * pointer) or else 40% down the screen. The field's own scroll absorbs
   * what it can; the page moves only as far as needed to keep the caret
   * inside the field's visible rows. A card taller than its editor shrinks
   * as the stage morphs, and the browser may then clamp the page scroll —
   * that shifts the field, but the caret stays within it.
   */
  function revealCaret(area: HTMLTextAreaElement, offset: number, viewportY?: number) {
    const caret = caretPoint(area, offset);
    const rect = area.getBoundingClientRect();
    const viewport = window.visualViewport;
    const target = (viewportY ?? (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) * 0.4) - caret.height / 2;
    const room = Math.max(0, area.scrollHeight - area.clientHeight);
    // Field tops (on screen) that can show the caret line at `target`.
    const lowest = target - Math.min(Math.max(0, area.clientHeight - caret.height), caret.top);
    const highest = target - Math.max(0, caret.top - room);
    const fieldTop = Math.min(Math.max(rect.top, lowest), Math.max(lowest, highest));
    area.scrollTop = Math.min(room, Math.max(0, caret.top - (target - fieldTop)));
    if (Math.abs(rect.top - fieldTop) >= 1) window.scrollBy(0, rect.top - fieldTop);
  }

  function refreshSuggestion(value: string, caret: number) {
    if (busy || submittingRef.current || sendQueuedRef.current) return;
    const token = tagTokenAt(value, caret);
    if (!token || knownTags.length === 0) {
      setSuggestion(null);
      return;
    }
    const { hashStart, query } = token;
    // A bare # offers the tags used last (knownTags arrives ranked by recent
    // use, then by count — App), with no row lit: Enter still breaks the line.
    if (!query) {
      setSuggestion({ tokenStart: hashStart, query, items: knownTags.slice(0, 5), index: -1, exact: false, fuzzy: false });
      return;
    }
    // A character no tag can hold has ended the tag ("#work," is #work).
    if (![...query].every((char) => TAG_CHAR.test(char))) {
      setSuggestion(null);
      return;
    }
    const lowered = query.toLowerCase();
    const exact = knownTags.some((tag) => tag.toLowerCase() === lowered);
    // Tags that begin with the run lead the list, then any that contain it;
    // the tag typed out in full is left off (nothing left to complete). The
    // sort is stable, so each group keeps knownTags' own order.
    const direct = knownTags
      .filter((tag) => tag.toLowerCase().includes(lowered) && tag.toLowerCase() !== lowered)
      .sort((a, b) => Number(!a.toLowerCase().startsWith(lowered)) - Number(!b.toLowerCase().startsWith(lowered)));
    // Nothing spells the run outright: tags that hold its letters in order
    // (#wrk → work) are offered as a guess, and the list says so.
    const guess = direct.length === 0 && !exact;
    const items = (guess ? knownTags.filter((tag) => subsequenceHits(tag, query) !== null) : direct).slice(0, 6);
    // The tag is typed out and nothing longer starts with it: nothing to say.
    if (items.length === 0 && exact) {
      setSuggestion(null);
      return;
    }
    setSuggestion({ tokenStart: hashStart, query, items, index: items.length > 0 ? 0 : -1, exact, fuzzy: guess && items.length > 0 });
  }

  /**
   * Land a programmatic edit through the browser's own editing pipeline so
   * it joins the native undo stack: ⌘Z steps back over one list
   * continuation, one ⌘B, one tag completion — instead of losing the history
   * to a controlled-value write. Only the changed span is replaced, and
   * insertText fires a real input event, so onChange keeps state in step.
   * Where execCommand is missing or refuses (deprecated, yet still the only
   * undo-preserving path for a textarea), the value is written directly:
   * that costs the undo history, never the text. Focus is taken right here,
   * inside the click or key handler, so iOS keeps its keyboard up.
   */
  function landValue(next: string, selStart: number, selEnd = selStart, suggest = true) {
    const area = areaRef.current;
    if (!area || sendQueuedRef.current) return;
    const prev = area.value;
    area.focus({ preventScroll: true });
    let landed = prev === next;
    if (!landed) {
      const max = Math.min(prev.length, next.length);
      let head = 0;
      while (head < max && prev.charCodeAt(head) === next.charCodeAt(head)) head += 1;
      let tail = 0;
      while (tail < max - head && prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail += 1;
      // Never cut a surrogate pair in half at either seam.
      if (head > 0 && /[\ud800-\udbff]/.test(prev[head - 1])) head -= 1;
      if (tail > 0 && /[\udc00-\udfff]/.test(prev[prev.length - tail])) tail -= 1;
      const mid = next.slice(head, next.length - tail);
      area.setSelectionRange(head, prev.length - tail);
      try {
        landed = typeof document.execCommand === "function" && document.execCommand(mid ? "insertText" : "delete", false, mid);
      } catch {
        landed = false;
      }
      landed = landed && area.value === next;
    }
    setContent(next);
    if (next !== prev) clearError("other");
    if (!suggest) setSuggestion(null);
    const settle = () => {
      area.setSelectionRange(selStart, selEnd);
      quietSelectRef.current = { start: selStart, end: selEnd };
      if (suggest) refreshSuggestion(next, selStart);
      syncPressed();
      autoGrow();
    };
    if (landed) settle();
    else requestAnimationFrame(settle);
  }

  /**
   * Swap the `#token` under the caret for the picked tag. The run after the
   * caret joins the swap only while the whole token still spells part of the
   * tag, so `#wo|rk` becomes `#work`, never `#work rk`. Any other run is the
   * writer's own text — in Chinese prose, the rest of the sentence, since
   * nothing there ends a tag — and stays put behind the inserted tag. A space
   * follows unless the text already goes on with one (or with punctuation or
   * a line break); the caret lands after it.
   */
  function applySuggestion(tag: string) {
    if (busy || submittingRef.current) return;
    const area = areaRef.current;
    if (!area || !suggestion) return;
    const value = area.value;
    const caret = Math.max(area.selectionEnd, suggestion.tokenStart + 1);
    let runEnd = caret;
    while (runEnd < value.length && TAG_CHAR.test(value[runEnd])) runEnd += 1;
    const token = value.slice(suggestion.tokenStart + 1, runEnd).toLowerCase();
    const end = tag.toLowerCase().includes(token) ? runEnd : caret;
    const after = value[end];
    const spacer = after === undefined || after === "#" || TAG_CHAR.test(after) ? " " : "";
    const position = suggestion.tokenStart + 1 + tag.length + spacer.length + (after === " " ? 1 : 0);
    landValue(`${value.slice(0, suggestion.tokenStart)}#${tag}${spacer}${value.slice(end)}`, position, position, false);
  }

  /**
   * The caret moved without the text changing — arrow keys, Home/End,
   * ⌘←/→, a click: the tag list follows the token now under the caret, or
   * closes. (It used to refresh only on typing and clicks, so Enter could
   * apply a list left over from another spot.) A selection this editor just
   * set itself is skipped, so a completion's list stays shut.
   */
  function onCaretMove() {
    const area = areaRef.current;
    if (!area) return;
    syncPressed();
    if (composingRef.current) return;
    const quiet = quietSelectRef.current;
    quietSelectRef.current = null;
    if (quiet && quiet.start === area.selectionStart && quiet.end === area.selectionEnd) return;
    if (area.selectionStart !== area.selectionEnd) setSuggestion(null);
    else refreshSuggestion(area.value, area.selectionStart);
  }

  /**
   * One suggestion row: the parent path gives way (ellipsized) before the
   * leaf, so a deep tag still shows its own name; what matched — the run, or
   * a guess's scattered letters — is set a step heavier.
   */
  function suggestionRow(tag: string, query: string, fuzzy: boolean): ReactNode {
    const split = tag.lastIndexOf("/") + 1;
    let hits: number[] = [];
    if (fuzzy) hits = subsequenceHits(tag, query) ?? [];
    else if (query) {
      const at = tag.toLowerCase().indexOf(query.toLowerCase());
      if (at >= 0) hits = Array.from({ length: query.length }, (_, offset) => at + offset);
    }
    return (
      <>
        <span className="tag-suggest-path">{withHits(`#${tag.slice(0, split)}`, hits.filter((at) => at < split).map((at) => at + 1))}</span>
        <span className="tag-suggest-leaf">{withHits(tag.slice(split), hits.filter((at) => at >= split).map((at) => at - split))}</span>
      </>
    );
  }

  /** Insert text at the caret (textareas keep their selection while blurred). */
  function insertAtCaret(text: string, padded = false) {
    if (busy || submittingRef.current) return;
    const area = areaRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const before = padded && start > 0 && !/\s/.test(content[start - 1]) ? " " : "";
    const after = padded && (end >= content.length || !/\s/.test(content[end])) ? " " : "";
    const inserted = `${before}${text}${after}`;
    const next = `${content.slice(0, start)}${inserted}${content.slice(end)}`;
    const position = start + inserted.length;
    landValue(next, position);
  }

  function insertHash() {
    const area = areaRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const needsSpace = start > 0 && !/\s/.test(content[start - 1]);
    insertAtCaret(`${needsSpace ? " " : ""}#`);
  }

  /** Toolbar buttons never take focus from the field: on iOS a blurred
   * textarea drops the keyboard, and a refocus outside the tap cannot raise
   * it again. Keyboard users still Tab to them (one stop, then ←/→). */
  function keepFieldFocus(event: ReactMouseEvent) {
    event.preventDefault();
  }
  /** Send keeps the caret for a mouse too, so a failed send (or the next
   * memo) goes on in the field. A tap still lets the keyboard go: sending
   * on a phone hands the screen back to the feed. */
  function keepSendFocus(event: ReactMouseEvent) {
    if (window.matchMedia?.("(pointer: fine)").matches) event.preventDefault();
  }

  /** Land a markdown edit: new value plus an exact selection to restore. */
  function applyPatch(patch: EditPatch) {
    if (busy || submittingRef.current) return;
    landValue(patch.value, patch.start, patch.end);
  }

  /** Read Bold's and List's pressed state off the caret. */
  function syncPressed() {
    const area = areaRef.current;
    if (!area) return;
    const bold = wrapActiveAt(area.value, area.selectionStart, area.selectionEnd, "**");
    const list = listLineAt(area.value, area.selectionStart);
    setPressed((current) => (current.bold === bold && current.list === list ? current : { bold, list }));
  }

  /**
   * Another memo's Edit was refused for this one: bring its caret line ~40%
   * down the screen (where revealCaret puts it), take focus, and pulse the
   * field's border twice (app.css, .is-attending-*) so the eye finds it.
   */
  function attend() {
    const area = areaRef.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    const rect = area.getBoundingClientRect();
    const caret = caretPoint(area, area.selectionEnd);
    const line = Math.min(Math.max(rect.top + caret.top - area.scrollTop, rect.top), rect.bottom - caret.height) + caret.height / 2;
    const viewport = window.visualViewport;
    const target = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) * 0.4;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (Math.abs(line - target) >= 1) window.scrollBy({ top: line - target, behavior: reduced ? "instant" : "smooth" });
    setAttention((value) => value + 1);
  }

  /* ---- The toolbar: one Tab stop, ←/→ (Home/End) between its tools ---- */

  function onToolsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-tool]:not(:disabled)")];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const last = buttons.length - 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? last : (at + (event.key === "ArrowRight" ? 1 : last)) % buttons.length;
    buttons[next].focus();
  }

  function onToolsFocus(event: ReactFocusEvent<HTMLDivElement>) {
    const key = (event.target as HTMLElement).dataset.tool as ToolKey | undefined;
    if (key && TOOL_ORDER.includes(key)) setToolStop(key);
  }

  /* ---- Attachment tiles: open, reorder ---- */

  /** Each tile's centre on screen, by image id. */
  function tileCentres(): Map<string, { x: number; y: number }> {
    const centres = new Map<string, { x: number; y: number }>();
    for (const tile of attachmentsRef.current?.querySelectorAll<HTMLElement>(".attachment[data-image-id]") ?? []) {
      const box = tile.getBoundingClientRect();
      centres.set(tile.dataset.imageId ?? "", { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    }
    return centres;
  }

  /** Change the tile order with every tile gliding on from where it is now. */
  function glideTiles(change: () => void) {
    flipFromRef.current = tileCentres();
    change();
    setFlips((value) => value + 1);
  }

  /** Put a pending image before `before` (null: at the end). The order is the one sent. */
  function moveImage(id: string, before: string | null) {
    setNewImages((value) => {
      const moving = value.find((image) => image.id === id);
      if (!moving) return value;
      const rest = value.filter((image) => image !== moving);
      const at = before === null ? rest.length : rest.findIndex((image) => image.id === before);
      return at < 0 ? value : [...rest.slice(0, at), moving, ...rest.slice(at)];
    });
  }

  /** The photo viewer, on the tiles that stay (a preview for an image not yet sent). */
  function openTile(event: ReactMouseEvent<HTMLButtonElement>, id: string) {
    if (!onOpenImage || event.timeStamp < tileClickFloorRef.current) return;
    const shown = tiles.filter(
      (tile): tile is Exclude<AttachmentTile, { kind: "preparing" }> => tile.kind !== "preparing" && !removingKeys.has(tile.image.id)
    );
    const items: LightboxItem[] = shown.map((tile) =>
      tile.kind === "stored" ? { src: `/api/images/${tile.image.id}`, imageId: tile.image.id } : { src: tile.image.previewUrl }
    );
    const index = Math.max(0, shown.findIndex((tile) => tile.image.id === id));
    openLightboxFrom(event.currentTarget.closest<HTMLElement>(".attachment"), () => onOpenImage(items, index));
  }

  /** The pending images in the row's order, those leaving left out. */
  function movableIds(): string[] {
    return newImages.filter((image) => !removingKeys.has(image.id)).map((image) => image.id);
  }

  /** Alt+←/→ moves the focused tile one place and says where it now is. */
  function onTileKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Alt+← is Back in some browsers: never leave the page from here.
    event.preventDefault();
    if (locked) return;
    const order = movableIds();
    const at = order.indexOf(id);
    if (at < 0) return;
    const to = Math.min(order.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1)));
    if (to !== at) {
      refocusTileRef.current = id;
      glideTiles(() => moveImage(id, event.key === "ArrowRight" ? (order[to + 1] ?? null) : order[to]));
    }
    // The memo's own images stay first; the moved one is counted after them.
    const position = removable.length - order.length + to + 1;
    announce(tr(`Image ${position} of ${removable.length}`, `第 ${position} 张，共 ${removable.length} 张`));
  }

  function onTilePointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    // A fresh press is a new gesture: only the click trailing a drag is held back.
    tileClickFloorRef.current = 0;
    if (!event.isPrimary || event.button !== 0 || locked || tileDragRef.current) return;
    const tile = event.currentTarget.closest<HTMLElement>(".attachment");
    if (!tile) return;
    const drag: TileDrag = {
      id,
      pointerId: event.pointerId,
      touch: event.pointerType !== "mouse",
      x0: event.clientX,
      y0: event.clientY,
      lifted: false,
      holdTimer: 0,
      tile,
      handle: event.currentTarget,
      slots: [],
      before: undefined,
      unlisten: () => undefined
    };
    tileDragRef.current = drag;
    if (drag.touch) drag.holdTimer = window.setTimeout(() => liftTile(drag), TOUCH_LIFT_MS);
  }

  /** Lift the pressed tile: it follows the pointer from here, and the row's
   * movable tiles are measured once as the slots it can land between. */
  function liftTile(drag: TileDrag) {
    const row = attachmentsRef.current;
    if (tileDragRef.current !== drag || drag.lifted || !row) return;
    drag.lifted = true;
    try {
      drag.handle.setPointerCapture?.(drag.pointerId);
    } catch {
      // Capture is a nicety; the drag still tracks without it.
    }
    // Without capture a release off the tile goes elsewhere: the window
    // still hears it (after the tile's own handlers, which end it first).
    const release = (event: PointerEvent) => {
      if (event.pointerId === drag.pointerId) endTileDrag(drag, event.type === "pointerup", event.timeStamp);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    drag.unlisten = () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
    const origin = row.getBoundingClientRect();
    drag.slots = [...row.querySelectorAll<HTMLElement>(".attachment[data-movable]")].map((tile) => {
      const box = tile.getBoundingClientRect();
      return { id: tile.dataset.imageId ?? "", left: box.left - origin.left, top: box.top - origin.top, right: box.right - origin.left, bottom: box.bottom - origin.top };
    });
    setReorder({ id: drag.id, bar: null });
  }

  function onTilePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = tileDragRef.current;
    const row = attachmentsRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !row) return;
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;
    if (!drag.lifted) {
      // A finger that moves before its hold is up is scrolling the page.
      if (drag.touch) {
        if (Math.hypot(dx, dy) > 8) endTileDrag(drag, false);
        return;
      }
      if (Math.hypot(dx, dy) < 4) return;
      liftTile(drag);
      if (!drag.lifted) return;
    }
    // Written straight to the tile: a render per pointer move would be waste.
    drag.tile.style.translate = `${dx}px ${dy}px`;
    const origin = row.getBoundingClientRect();
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    let nearest = -1;
    let distance = Infinity;
    drag.slots.forEach((slot, index) => {
      const away = Math.hypot(x - (slot.left + slot.right) / 2, y - (slot.top + slot.bottom) / 2);
      if (away < distance) {
        distance = away;
        nearest = index;
      }
    });
    if (nearest < 0) return;
    const target = drag.slots[nearest];
    const index = nearest + (x > (target.left + target.right) / 2 ? 1 : 0);
    const from = drag.slots.findIndex((slot) => slot.id === drag.id);
    // Either side of the tile's own place is where it already is.
    const before = index === from || index === from + 1 ? undefined : index < drag.slots.length ? drag.slots[index].id : null;
    if (before === drag.before) return;
    drag.before = before;
    const anchor = before === undefined ? null : before === null ? drag.slots[drag.slots.length - 1] : drag.slots[index];
    // The bar stands in the 8px gap: before its tile, or after the last.
    const bar = anchor ? { left: before === null ? anchor.right + 3 : anchor.left - 5, top: anchor.top, height: anchor.bottom - anchor.top } : null;
    setReorder({ id: drag.id, bar });
  }

  /** Let the tile go — into its new place when `drop` (and one was found), else home. */
  function endTileDrag(drag: TileDrag, drop: boolean, timeStamp = 0) {
    window.clearTimeout(drag.holdTimer);
    drag.unlisten();
    if (tileDragRef.current !== drag) return;
    tileDragRef.current = null;
    if (!drag.lifted) return;
    tileClickFloorRef.current = timeStamp + 400;
    glideTiles(() => {
      drag.tile.style.translate = "";
      setReorder(null);
      if (drop && drag.before !== undefined && !locked) moveImage(drag.id, drag.before);
    });
  }

  /** What a file that could not be added says, by name. */
  function failureText(file: File, cause: unknown): string {
    const name = file.name;
    if (/^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(name)) {
      return tr(`${name}: this browser can’t read HEIC — export it as JPG first`, `${name}：这个浏览器读不出 HEIC，可以先导出成 JPG 再拖进来`);
    }
    const reason = errorMessage(cause, "Couldn’t process the image", "图片处理失败");
    return name ? tr(`${name}: ${reason}`, `${name}：${reason}`) : reason;
  }

  function confirmLink() {
    if (busy || submittingRef.current) return;
    const url = linkValue.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      fail(tr("Enter an image URL beginning with http(s)://", "请输入以 http(s):// 开头的图片链接"), "link");
      return;
    }
    setError(null);
    // ![](url) forces image rendering for any URL; the image itself stays
    // external and is never uploaded.
    insertAtCaret(`![](${url})`, true);
    setLinkValue("");
    setLinkOpen(false);
  }

  async function addFiles(files: File[]) {
    if (busy || submittingRef.current || sendQueuedRef.current) return;
    freshClearRef.current = false;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      if (files.length > 0) fail(tr("Only images can be added", "只能添加图片"));
      return;
    }
    const acceptedCount = imageSlots.reserve(images.length);
    if (acceptedCount <= 0) {
      fail(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`), "limit");
      return;
    }
    setError(null);
    // Each image gets its tile at once, showing the file itself while it
    // compresses; the compressed image then takes over that same tile
    // (tileKeysRef), so it pops in once and never trades places with a
    // spinner.
    const batch = images.slice(0, acceptedCount).map((file) => ({ file, key: crypto.randomUUID(), url: previewOf(file) }));
    for (const { url } of batch) if (url) preparingUrlsRef.current.add(url);
    setPreparing((value) => [...value, ...batch.map(({ key, url }) => ({ key, url }))]);
    let added = 0;
    for (const { file, key, url } of batch) {
      let reservationOpen = true;
      let failed = false;
      try {
        if (!mountedRef.current) continue;
        const payload = await compressImage(file);
        if (!mountedRef.current) {
          URL.revokeObjectURL(payload.previewUrl);
          continue;
        }
        const accepted = imageSlots.settle(true);
        reservationOpen = false;
        if (!accepted) {
          URL.revokeObjectURL(payload.previewUrl);
          fail(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`), "limit");
          // The draft is not what Send was pressed on any more: hold it back.
          setSendQueued(false);
          continue;
        }
        tileKeysRef.current.set(payload.id, key);
        setNewImages((value) => [...value, payload]);
        added += 1;
      } catch (cause) {
        if (mountedRef.current) {
          failed = true;
          fail(failureText(file, cause));
          // A queued send would go out without the image it was waiting for.
          setSendQueued(false);
        }
      } finally {
        if (reservationOpen) imageSlots.settle(false);
        if (url) {
          URL.revokeObjectURL(url);
          preparingUrlsRef.current.delete(url);
        }
        if (mountedRef.current && failed) {
          // The tile it would have been stays a moment, marked, so the
          // reader sees which one it was; then it fades out. Timers, not
          // animationend: an edit scrolled off screen runs no animations.
          setPreparing((value) => value.map((item) => (item.key === key ? { ...item, url: null, failed: true } : item)));
          window.setTimeout(() => {
            if (!mountedRef.current) return;
            setPreparing((value) => value.map((item) => (item.key === key ? { ...item, leaving: true } : item)));
            window.setTimeout(() => {
              if (mountedRef.current) setPreparing((value) => value.filter((item) => item.key !== key));
            }, EXIT_MS);
          }, FAILED_TILE_MS);
        } else if (mountedRef.current) setPreparing((value) => value.filter((item) => item.key !== key));
      }
    }
    // The tiles are silent to a screen reader until they land: say so then.
    if (added > 0 && mountedRef.current) announce(added === 1 ? tr("Added the image", "已添加图片") : tr(`Added ${added} images`, `已添加 ${added} 张图片`));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (busy || submittingRef.current) return;
    const plainOnly = plainPasteRef.current;
    plainPasteRef.current = false;
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    // ⌘⇧V asks for the words: a picture wins only where there are none.
    const takesImages = plainOnly ? !event.clipboardData.getData("text/plain").trim() : pasteTakesImages(event.clipboardData, files);
    if (files.length > 0 && takesImages) {
      event.preventDefault();
      void addFiles(files);
      return;
    }
    const area = event.currentTarget;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const text = event.clipboardData.getData("text/plain");
    // A lone URL pasted over selected words links them: [words](url).
    const url = text.trim();
    const selected = content.slice(start, end);
    const label = selected.trim();
    if (
      label &&
      /^https?:\/\/\S+$/i.test(url) &&
      !/^https?:\/\//i.test(label) &&
      !/[\n[\]]/.test(label)
    ) {
      event.preventDefault();
      const lead = /^\s*/.exec(selected)![0];
      const trail = /\s*$/.exec(selected)![0];
      const link = `${lead}[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})${trail}`;
      landValue(`${content.slice(0, start)}${link}${content.slice(end)}`, start + link.length);
      return;
    }
    // Rich text (web pages, docs) arrives as Markdown the card can render;
    // plain text, code-editor copies and ⌘⇧V paste exactly as before.
    if (plainOnly) return;
    const markdown = htmlToMarkdown(event.clipboardData.getData("text/html"));
    if (markdown === null) return;
    event.preventDefault();
    landValue(`${content.slice(0, start)}${markdown}${content.slice(end)}`, start + markdown.length);
  }

  /** Whether a file drop of this kind would add anything right now. */
  function acceptsDrop(kind: FileDragKind) {
    return !locked && kind === "images" && totalImages + compressing < MAX_IMAGES;
  }
  addFilesRef.current = (files) => void addFiles(files);
  acceptsRef.current = acceptsDrop;

  // Files light the veil and are claimed here. Links and plain text are
  // left to the field: the browser drops them at the drop caret (and a
  // selection dragged within the field moves), and onChange keeps state in
  // step. Only an image link is taken over — it becomes ![](url).
  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (locked) return;
    setDragKind(fileDragKind(event.dataTransfer));
    setDragDepth((value) => value + 1);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (isFileDrag(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = acceptsDrop(fileDragKind(event.dataTransfer)) ? "copy" : "none";
      return;
    }
    // Beside the field (toolbar, attachments) a link has no drop caret of
    // its own: accept it there, and it lands at the field's caret.
    if (!locked && event.target !== areaRef.current && [...(event.dataTransfer?.types ?? [])].includes("text/uri-list")) event.preventDefault();
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    setDragDepth((value) => Math.max(0, value - 1));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    setDragDepth(0);
    if (isFileDrag(event)) {
      // Never the browser's: it would open the file in the tab.
      event.preventDefault();
      if (!locked) void addFiles([...(event.dataTransfer?.files ?? [])]);
      return;
    }
    if (locked) return;
    // A dragged image from another page stays an external image reference
    // (never uploaded); any other link lands as a plain link. The image is
    // known by the <img> in the drag's HTML (unless the drag is the link
    // wrapped around it), or by an image file extension.
    const data = event.dataTransfer;
    const uri = (data?.getData("text/uri-list") || data?.getData("text/plain") || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    let image: string | null = null;
    const html = data?.getData("text/html") ?? "";
    if (html && typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const src = doc.querySelector("img")?.getAttribute("src")?.trim();
      const draggedLink = uri !== undefined && uri !== src && [...doc.querySelectorAll("a[href]")].some((a) => a.getAttribute("href") === uri);
      if (src && !draggedLink && /^https?:\/\/\S+$/i.test(src)) image = src;
    }
    if (!image && uri && isImageUrl(uri)) image = uri;
    const encode = (url: string) => url.replace(/\(/g, "%28").replace(/\)/g, "%29");
    const link = [...(data?.types ?? [])].includes("text/uri-list");
    if (!image && link && uri && /^(blob|data|file):/i.test(uri)) {
      // A card's own picture (an object URL) or a local path: nothing a
      // memo can keep, so nothing lands — the field must not take it either.
      event.preventDefault();
      return;
    }
    if (image) {
      event.preventDefault();
      insertAtCaret(`![](${encode(image)})`, true);
    } else if (event.target !== areaRef.current && link && uri && /^https?:\/\/\S+$/i.test(uri)) {
      event.preventDefault();
      insertAtCaret(uri, true);
    }
  }

  function closeLink() {
    setLinkOpen(false);
    clearError("link");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Candidate navigation and confirmation belong to the IME while text is
    // composing. Some WebKit versions clear isComposing on the final Enter
    // keydown but retain the conventional 229 keyCode, so honor both signals
    // before tag suggestions or markdown shortcuts see the event.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (busy || submittingRef.current || sendQueued) {
      // A send is under way — held for a compressing image, or out on the
      // wire: Esc takes it back (the draft stays as it was); nothing else
      // may change the draft before it goes.
      if (event.key === "Escape") {
        event.preventDefault();
        if (sendQueued) setSendQueued(false);
        else abortRef.current?.abort();
      }
      return;
    }
    const area = event.currentTarget;
    if (
      mode === "create" &&
      freshClearRef.current &&
      !area.value &&
      newImages.length === 0 &&
      compressing === 0 &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "z" &&
      onUndoSendRef.current?.()
    ) {
      event.preventDefault();
      return;
    }
    // The list belongs to the token under the caret. One left behind by a
    // caret move would splice its tag over the wrong span: drop it and let
    // the key do what it would have done.
    let active = suggestion;
    if (active) {
      const token = area.selectionStart === area.selectionEnd ? tagTokenAt(area.value, area.selectionStart) : null;
      if (!token || token.hashStart !== active.tokenStart) {
        setSuggestion(null);
        active = null;
      }
    }
    if (active) {
      const count = active.items.length;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        // With no row lit yet, ↓ lights the first and ↑ the last.
        const index = active.index < 0 ? (delta > 0 ? 0 : count - 1) : (active.index + delta + count) % count;
        setSuggestion({ ...active, index });
        return;
      }
      const modified = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
      if (event.key === "Enter" || event.key === "Tab") {
        if (count === 0 || modified || (event.key === "Enter" && (active.exact || active.index < 0))) {
          // Enter keeps its ordinary meaning (a new line, a continued list)
          // and only puts the list away when the run is already a tag — it
          // used to take the first child, `#life` became `#life/cooking` and
          // the line never broke — or when no row is lit yet: a bare # is
          // not a request for a tag until a letter follows; Tab or ↓ picks one.
          // A held modifier means the key's own job — ⌘↩ sends, Shift+↩
          // breaks the line, Shift+Tab steps back — so it too only closes,
          // as both keys do on a list that only says a new tag is coming.
          setSuggestion(null);
        } else {
          event.preventDefault();
          applySuggestion(active.items[Math.max(0, active.index)]);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestion(null);
        return;
      }
    }
    // Markdown aids. Plain Enter continues a list/task/quote line (an empty
    // item exits instead); Shift+Enter stays a plain newline escape hatch,
    // and Enter while the IME is composing must never be intercepted.
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
      if (area.selectionStart === area.selectionEnd) {
        const patch = continueListOnEnter(content, area.selectionStart);
        if (patch) {
          event.preventDefault();
          applyPatch(patch);
          return;
        }
      }
    }
    // Backspace right after an empty item's marker takes the whole marker
    // (or one level of indent), not one character of it.
    if (event.key === "Backspace" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const patch = backspaceListMarker(content, area.selectionStart, area.selectionEnd);
      if (patch) {
        event.preventDefault();
        applyPatch(patch);
        return;
      }
    }
    // Tab hops table cells and indents list lines (every selected one);
    // anywhere else it keeps moving focus.
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const dir = event.shiftKey ? -1 : 1;
      const patch = tableTabStop(content, area.selectionStart, dir) ?? shiftListIndent(content, area.selectionStart, dir, area.selectionEnd);
      if (patch) {
        event.preventDefault();
        applyPatch(patch);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey) {
        // The field's own: the page's ⌘K (search) must not hear it too.
        event.preventDefault();
        event.stopPropagation();
        applyPatch(wrapLink(content, area.selectionStart, area.selectionEnd));
        return;
      }
      const marker =
        key === "b" ? "**" : key === "i" ? "*" : key === "e" ? "`" : key === "s" && event.shiftKey ? "~~" : key === "h" && event.shiftKey ? "==" : null;
      if (marker) {
        event.preventDefault();
        applyPatch(toggleWrap(content, area.selectionStart, area.selectionEnd, marker));
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    // Paste-and-match-style: the paste handler below skips the HTML path.
    plainPasteRef.current = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v";
    // Esc peels one layer per press: the tag list (above), the image-link
    // row, then the editor itself — an edit is discarded (with Undo on its
    // toast), the composer just lets go of focus.
    if (event.key === "Escape") {
      if (linkOpen) {
        event.preventDefault();
        closeLink();
      } else if (mode === "edit" && onCancel) {
        cancel();
      } else if (mode === "create") {
        event.preventDefault();
        area.blur();
      }
    }
  }

  /**
   * Esc / Cancel close the editor at once. An edit with real changes is
   * handed up as a draft first, so the "Discarded" toast can offer Undo
   * (in memory only — drafts are never persisted); an untouched one just
   * closes. Attachments mid-exit-animation count as removed, and pending
   * ones leave with the draft, so their preview URLs must outlive unmount.
   */
  function cancel() {
    if (!onCancel || locked) return;
    const area = areaRef.current;
    if (!dirty) {
      onCancel(null);
      return;
    }
    const handedOff = new Set(keptNewImages.map((image) => image.previewUrl));
    previewUrls.current = previewUrls.current.filter((url) => !handedOff.has(url));
    onCancel({
      content,
      newImages: keptNewImages,
      removedIds: removedImageIds,
      selectionStart: area?.selectionStart ?? content.length,
      selectionEnd: area?.selectionEnd ?? content.length
    });
  }

  /**
   * Keep writing after a send: Send's own press keeps the caret for a mouse
   * (keepSendFocus), but a keyboard press leaves focus on a button that is
   * now disabled (or on <body> in Safari). Not on touch, where focusing
   * would raise the keyboard, and not if the reader has moved on meanwhile.
   */
  function returnFocusToField() {
    const area = areaRef.current;
    const active = document.activeElement;
    if (!area || active === area || !mountedRef.current) return;
    const stayed = !active || active === document.body || rootRef.current?.contains(active);
    if (stayed && window.matchMedia?.("(pointer: fine)").matches) area.focus({ preventScroll: true });
  }

  /**
   * Send / Save. Pressed while an image is still compressing, the press is
   * held (`sendQueued`) and the save goes out by itself once the last image
   * lands; `fromQueue` is that deferred run. ⌘↩ on an untouched edit has
   * nothing to save and closes it quietly, like Esc.
   */
  async function submit(fromQueue = false) {
    if (submittingRef.current) return;
    if (!fromQueue) {
      if (mode === "edit" && !dirty && !locked) {
        cancel();
        return;
      }
      if (canQueue) {
        setSendQueued(true);
        setError(null);
        announce(tr("Preparing image…", "正在处理图片…"));
        return;
      }
      if (!canSubmit) return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    // Where the caret was when Send went: a stopped send hands the field
    // back exactly so (text and images never left it).
    const area = areaRef.current;
    const held = area ? { start: area.selectionStart, end: area.selectionEnd, scrollTop: area.scrollTop } : null;
    const restoreField = () => {
      const field = areaRef.current;
      if (!field || !held || !mountedRef.current) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(held.start, held.end);
      field.scrollTop = held.scrollTop;
      quietSelectRef.current = { start: held.start, end: held.end };
    };
    // Set once the composer is cleared — by the owner through onCommitted,
    // inside the update that lands the memo, or else right after.
    let cleared = false;
    const clearComposer = (animated: boolean) => {
      if (cleared || !mountedRef.current) return;
      cleared = true;
      // Landed: from here Esc has nothing left to stop.
      if (abortRef.current === controller) abortRef.current = null;
      draftIdRef.current = crypto.randomUUID();
      imageSlots.syncCommitted(existingImages.length);
      // The sent images' previews went with the memo: the owner releases
      // them, or hands them back if the memo is taken back. Only a tile
      // still playing its exit stays behind.
      for (const image of newImages) if (removingKeys.has(image.id)) URL.revokeObjectURL(image.previewUrl);
      freshClearRef.current = true;
      // An Undo still on a toast belongs to the memo just sent, not the next.
      undoEpochRef.current += 1;
      releaseHeldRemovals();
      tileKeysRef.current.clear();
      setContent("");
      setNewImages([]);
      setRemovingKeys(new Set());
      previewUrls.current = [];
      setSuggestion(null);
      setLinkOpen(false);
      setLinkValue("");
      // A view transition morphs the composer shut itself; without one the
      // field eases down on its own height transition.
      clearGrowRef.current = animated ? "instant" : "smooth";
      setClears((value) => value + 1);
    };
    try {
      const uploading = keptNewImages;
      // Only a save waits on its upload; a send lands at once and goes out
      // in the background (App's outbox).
      const tracksUpload = mode === "edit" && uploading.length > 0;
      if (tracksUpload) setUploadPercent(0);
      const sent = content.trim();
      const lead = content.length - content.trimStart().length;
      const caret = (offset: number) => Math.max(0, Math.min(sent.length, offset - lead));
      const ok = await onSubmit({
        clientId: draftIdRef.current,
        content: sent,
        newImages: uploading,
        removeImageIds: removedImageIds,
        selection: held ? { start: caret(held.start), end: caret(held.end) } : { start: sent.length, end: sent.length },
        onUploadProgress:
          tracksUpload
            ? (fraction) => {
                if (mountedRef.current) setUploadPercent(Math.min(99, Math.round(fraction * 100)));
              }
            : undefined,
        signal: controller.signal,
        onCommitted: mode === "create" ? clearComposer : undefined
      });
      if (ok && mode === "create") {
        clearComposer(false);
        returnFocusToField();
      } else if (!ok && controller.signal.aborted) {
        restoreField();
      }
    } catch (cause) {
      // Stopped with Esc: the owner says so; the draft is as it was.
      if (controller.signal.aborted && !cleared) {
        restoreField();
        return;
      }
      // The draft is still here to fix and send again.
      returnFocusToField();
      const rotateCreateId =
        mode === "create" && cause instanceof ApiError && (cause.code === "MEMO_ID_RETIRED" || cause.code === "VERSION_CONFLICT");
      if (rotateCreateId) {
        // Keep the draft, but rotate the stable create id so another save can
        // neither resurrects a purge nor overwrites an edited existing memo.
        draftIdRef.current = crypto.randomUUID();
        fail(
          tr(
            "The existing memo was kept. Your draft is safe; save again to create it as a new memo.",
            "现有笔记已保留。草稿仍然安全；再次保存会另建一条笔记。"
          )
        );
        return;
      }
      fail(errorMessage(cause, "Couldn’t save the memo", "保存失败"));
    } finally {
      submittingRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) {
        setSubmitting(false);
        setUploadPercent(null);
      }
    }
  }

  // Create mode: a sent memo taken back from the feed (App's outbox) comes
  // back in here — only into an empty, idle composer, never over a draft.
  const recallRef = useRef<{ start: number; end: number } | null>(null);
  function recall(draft: ComposerDraft): boolean {
    const area = areaRef.current;
    if (mode !== "create" || !area || !mountedRef.current || recallRef.current || submittingRef.current || sendQueuedRef.current) return false;
    if (area.value.trim() || newImages.length > 0 || compressing > 0) return false;
    freshClearRef.current = false;
    recallRef.current = { start: draft.selectionStart, end: draft.selectionEnd };
    setError(null);
    setContent(draft.content);
    setNewImages(draft.newImages);
    return true;
  }
  if (controlRef) controlRef.current = { recall };
  // The caret goes back where it was when Send went, once the text is in.
  useLayoutEffect(() => {
    const caret = recallRef.current;
    const area = areaRef.current;
    if (!caret || !area) return;
    recallRef.current = null;
    autoGrow();
    const end = area.value.length;
    area.focus({ preventScroll: true });
    area.setSelectionRange(Math.min(caret.start, end), Math.min(caret.end, end));
    quietSelectRef.current = { start: area.selectionStart, end: area.selectionEnd };
    // The composer heads the feed: a reader scrolled down it (or with it
    // under the sticky bar) goes up to it.
    const band = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    if ((rootRef.current?.getBoundingClientRect().top ?? 0) < Math.max(0, band)) {
      window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, newImages]);
  const occupied = content.trim().length > 0 || newImages.length > 0 || compressing > 0;
  const onOccupiedChangeRef = useRef(onOccupiedChange);
  onOccupiedChangeRef.current = onOccupiedChange;
  useEffect(() => {
    onOccupiedChangeRef.current?.(occupied);
  }, [occupied]);

  // The drop veil: lit while a file drag is over this editor, or anywhere in
  // the window when this is the editor a stray drop would land in. It says
  // what letting go would do — or why it would do nothing. The last words
  // stay put while it fades out.
  const dropKind = locked ? null : dragDepth > 0 ? dragKind : windowDrag;
  if (dropKind !== null) {
    const full = totalImages + compressing >= MAX_IMAGES;
    veilRef.current = {
      refused: full || dropKind === "other",
      label: full
        ? tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`)
        : dropKind === "other"
          ? tr("Only images can be added", "只能添加图片")
          : dragDepth > 0
            ? tr("Release to add images", "松开以添加图片")
            : tr("Drop here to add images", "拖到这里添加图片")
    };
  }
  const veil = veilRef.current;
  const showCounter = effectiveContentLength >= COUNTER_FROM;

  // One flat list of tiles, so a compressing image keeps its tile (same
  // key, same element) when its compressed self lands in newImages.
  const tiles: AttachmentTile[] = [
    ...keptExisting.map((image): AttachmentTile => ({ kind: "stored", key: image.id, image })),
    ...newImages.map((image): AttachmentTile => ({ kind: "pending", key: tileKeysRef.current.get(image.id) ?? image.id, image })),
    ...preparing.map((item): AttachmentTile => ({ kind: "preparing", ...item }))
  ];
  // What stays, numbered like the card's own "View image 2 of 3".
  const removable = tiles.flatMap((tile) => (tile.kind !== "preparing" && !removingKeys.has(tile.image.id) ? [tile.image.id] : []));
  // The row folds shut while its last tile leaves, and unmounts after.
  const attachmentsOpen = removable.length > 0 || preparing.length > 0;
  // Only images not yet sent can be reordered: the server keeps a memo's own
  // images in their order, so an edit's new ones line up after them.
  const movableCount = newImages.filter((image) => !removingKeys.has(image.id)).length;
  // The toolbar's one Tab stop: the tool last focused, or the first that
  // can take focus when that one is disabled.
  const toolEnabled: Record<ToolKey, boolean> = {
    tag: !locked,
    bold: !locked,
    list: !locked,
    table: !locked,
    image: !locked && totalImages + compressing < MAX_IMAGES,
    link: !locked
  };
  const tabStop = toolEnabled[toolStop] ? toolStop : (TOOL_ORDER.find((key) => toolEnabled[key]) ?? toolStop);
  const toolTab = (key: ToolKey) => (key === tabStop ? 0 : -1);
  // The note rows fold open and shut (see .editor-note); a closing one keeps
  // its last words while it folds, as an aria-hidden copy.
  const errorText = imageLimitExceeded ? imageLimitText : (error?.text ?? null);
  if (errorText) lastErrorRef.current = errorText;
  if (conflictMessage) lastConflictRef.current = conflictMessage;
  // The line arrives once. Opening, the row's fold and fade are its entrance;
  // only a new complaint replacing one already showing rises in on its own
  // (decided once per line, as its key first renders).
  const errorKey = errorText ? (imageLimitExceeded ? "limit" : `error-${error?.seq ?? 0}`) : null;
  if (errorKey !== errorLineRef.current.key) errorLineRef.current = { key: errorKey, replacing: errorLineRef.current.key !== null };
  const errorReplacing = errorLineRef.current.replacing;
  // The tag list: open, stepped aside for an IME, or playing its exit.
  const list = suggestion ?? leavingSuggestion;
  const listOpen = suggestion !== null && !composing;
  const suggestOptions = list === null ? null : list.items.map((tag, index) => (
    <button
      key={tag}
      id={listOpen ? `${suggestionListId}-option-${index}` : undefined}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={index === list.index}
      className={index === list.index ? "is-active" : ""}
      onMouseDown={(event) => {
        event.preventDefault();
        if (listOpen) applySuggestion(tag);
      }}
      onMouseMove={(event) => {
        // The pointer picks the row the keyboard would act on, so only one
        // row is ever lit. A list redrawn under a resting pointer
        // (movement 0) leaves the keyboard's row alone.
        if (!suggestion || composing || (event.movementX === 0 && event.movementY === 0)) return;
        if (index !== suggestion.index) setSuggestion({ ...suggestion, index });
      }}
      disabled={locked}
    >
      {suggestionRow(tag, list.query, list.fuzzy)}
    </button>
  ));
  // The tag a list with no match says is on its way, trimmed as a card trims it.
  const newTagName = list?.query.replace(/^[/·]+|[/·]+$/g, "") ?? "";

  return (
    <div
      ref={rootRef}
      // The attending class alternates, so each call replays the pulse.
      className={`editor ${mode === "create" ? "editor-create" : "editor-edit"}${dropKind !== null ? " is-dropping" : ""}${
        attention > 0 ? ` is-attending-${attention % 2 ? "a" : "b"}` : ""
      }`}
      aria-busy={locked}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {mode === "create" && contextTag ? (
        <div
          key={contextTag}
          id={contextTagDescriptionId}
          className="editor-context-tag"
          aria-label={tr(`Inherited tag: ${contextTag}`, `自动继承标签：${contextTag}`)}
        >
          <Hash size={13} aria-hidden="true" />
          <span>{contextTag}</span>
        </div>
      ) : null}

      <div className="editor-field">
        <textarea
          ref={areaRef}
          role="combobox"
          aria-label={tr("Memo content", "笔记内容")}
          aria-describedby={[mode === "create" && contextTag ? contextTagDescriptionId : "", overLimit ? countId : ""].filter(Boolean).join(" ") || undefined}
          // Past the cap the text cannot be sent; the count says by how much.
          aria-invalid={overLimit || undefined}
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listOpen ? suggestionListId : undefined}
          aria-activedescendant={listOpen && suggestion.index >= 0 ? `${suggestionListId}-option-${suggestion.index}` : undefined}
          // The wraps act on the field's selection; Bold's tip names them.
          aria-keyshortcuts="Meta+B Control+B Meta+I Control+I Meta+E Control+E Meta+Shift+S Control+Shift+S Meta+Shift+H Control+Shift+H Meta+K Control+K"
          value={content}
          placeholder={tr("What’s on your mind…", "现在的想法是……")}
          rows={mode === "create" ? 2 : 3}
          maxLength={HARD_INPUT_CAP}
          readOnly={locked}
          onChange={(event) => {
            if (busy || submittingRef.current) return;
            freshClearRef.current = false;
            setContent(event.target.value);
            // A refused file or a failed send is old news once the text moves on.
            clearError("other");
            // Mid-composition the text is the IME's (pinyin, kana): the list
            // waits, stepped aside, until compositionend hands over the result.
            if (!composingRef.current && !(event.nativeEvent as InputEvent).isComposing) refreshSuggestion(event.target.value, event.target.selectionStart);
            autoGrow();
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            setComposing(false);
            refreshSuggestion(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onScroll={() => {
            syncOverflowScroll();
            placeSuggest();
          }}
          onSelect={onCaretMove}
          onClick={onCaretMove}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => window.setTimeout(() => setSuggestion(null), SUGGEST_BLUR_MS)}
        />
        {overLimit ? (
          <div ref={overflowRef} className="editor-overflow" aria-hidden="true">
            {content.slice(0, overflowCut)}
            <mark>{content.slice(overflowCut)}</mark>
          </div>
        ) : null}
      </div>

      {list ? (
        <div
          ref={suggestRef}
          id={suggestionListId}
          className={`tag-suggest${suggestion ? "" : " is-closing"}${suggestion && composing ? " is-paused" : ""}`}
          role="listbox"
          aria-label={tr("Tag suggestions", "标签建议")}
          aria-hidden={listOpen ? undefined : true}
          onAnimationEnd={(event) => {
            // menu-out, or the dissolve that stands in for it under reduced motion.
            if (event.target !== event.currentTarget) return;
            if (event.animationName.startsWith("menu-out") || event.animationName === "fade-out") setLeavingSuggestion(null);
          }}
        >
          {list.fuzzy ? (
            // Guesses come under their own overline; the group's name says it aloud.
            <div className="tag-suggest-group" role="group" aria-label={tr("Did you mean", "是不是想用")}>
              <div className="tag-suggest-overline" aria-hidden="true">
                {tr("Did you mean", "是不是想用")}
              </div>
              {suggestOptions}
            </div>
          ) : list.items.length > 0 ? (
            suggestOptions
          ) : (
            // Nothing matches: no row to pick (Enter, Tab and the arrows
            // keep their own jobs), only word that writing on makes it a
            // new tag — a card takes any #word as one.
            <div className="tag-suggest-create" role="option" aria-disabled="true" aria-selected="false" onMouseDown={(event) => event.preventDefault()}>
              <Plus size={14} aria-hidden="true" />
              <span>{tr(`Keep typing to create #${newTagName}`, `继续输入会新建 #${newTagName}`)}</span>
            </div>
          )}
        </div>
      ) : null}

      <div className={`editor-attach${attachmentsOpen ? " is-open" : ""}${reorder ? " is-reordering" : ""}`}>
        <div className="editor-attach-clip">
          {tiles.length > 0 ? (
            <div ref={attachmentsRef} className="editor-attachments">
              {tiles.map((tile) => {
                if (tile.kind === "preparing" && tile.failed) {
                  // A file that could not be made into an image keeps its
                  // tile a moment, marked; the error line names it.
                  return (
                    <div key={tile.key} className={`attachment is-failed${tile.leaving ? " is-leaving" : ""}`} aria-hidden="true">
                      <ImageOff size={18} aria-hidden="true" />
                    </div>
                  );
                }
                if (tile.kind === "preparing") {
                  // The file itself stands in while it compresses; the
                  // compressed image takes over this same tile.
                  return (
                    <div key={tile.key} className="attachment is-busy" role="img" aria-label={tr("Compressing image", "压缩图片中")}>
                      {tile.url ? <img src={tile.url} alt="" decoding="async" /> : null}
                      <span className="attachment-spinner">
                        <Loader2 size={16} className="spin" aria-hidden="true" />
                      </span>
                    </div>
                  );
                }
                const image = tile.image;
                const removing = removingKeys.has(image.id);
                const position = removable.indexOf(image.id);
                const movable = tile.kind === "pending" && !removing && !locked && movableCount > 1;
                return (
                  <div
                    key={tile.key}
                    className={`attachment${removing ? " is-removing" : ""}${settledTiles.has(image.id) ? " is-settled" : ""}${
                      reorder?.id === image.id ? " is-lifted" : ""
                    }`}
                    // A send names the tile after this id, so the picture
                    // rides into the new card (App, landCreated).
                    data-image-id={image.id}
                    data-movable={movable ? "" : undefined}
                    aria-hidden={removing || undefined}
                    onAnimationEnd={(event) => {
                      // The exit, or its reduced-motion dissolve (app.css).
                      if (event.animationName !== "attach-out" && event.animationName !== "attach-dissolve") return;
                      if (tile.kind === "stored") {
                        settleRemove(image.id, () => {
                          imageSlots.releaseCommitted();
                          setRemovedIds((value) => [...value, image.id]);
                          offerUndo(() => {
                            if (reclaimSlot()) setRemovedIds((value) => value.filter((id) => id !== image.id));
                          });
                        });
                        return;
                      }
                      // Undo puts a pending image back in the slot it left.
                      const pending = tile.image;
                      const slot = newImages.findIndex((item) => item.id === pending.id);
                      settleRemove(pending.id, () => {
                        imageSlots.releaseCommitted();
                        setNewImages((value) => value.filter((item) => item.id !== pending.id));
                        if (!onNoticeRef.current) {
                          URL.revokeObjectURL(pending.previewUrl);
                          return;
                        }
                        holdRemoval(pending);
                        offerUndo(() => {
                          if (!heldRemovalsRef.current.includes(pending) || !reclaimSlot()) return;
                          heldRemovalsRef.current = heldRemovalsRef.current.filter((item) => item !== pending);
                          setNewImages((value) =>
                            value.some((item) => item.id === pending.id) ? value : [...value.slice(0, slot), pending, ...value.slice(slot)]
                          );
                        });
                      });
                    }}
                  >
                    {/* The picture is a button: a click (or Enter) opens it in
                        the viewer; a drag — or Alt+←/→ — moves an image not
                        yet sent to another place in the row. */}
                    <button
                      type="button"
                      className="attachment-open"
                      aria-label={
                        removable.length > 1 && position >= 0
                          ? onOpenImage
                            ? tr(`View image ${position + 1} of ${removable.length}`, `查看图片 ${position + 1}/${removable.length}`)
                            : tr(`Image ${position + 1} of ${removable.length}`, `第 ${position + 1} 张，共 ${removable.length} 张`)
                          : onOpenImage
                            ? tr("View image", "查看图片")
                            : tr("Image", "图片")
                      }
                      aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
                      tabIndex={removing ? -1 : undefined}
                      onMouseDown={keepFieldFocus}
                      onClick={(event) => openTile(event, image.id)}
                      onKeyDown={movable ? (event) => onTileKeyDown(event, image.id) : undefined}
                      onPointerDown={movable ? (event) => onTilePointerDown(event, image.id) : undefined}
                      onPointerMove={onTilePointerMove}
                      onPointerUp={(event) => {
                        const drag = tileDragRef.current;
                        if (drag && drag.pointerId === event.pointerId) endTileDrag(drag, true, event.timeStamp);
                      }}
                      onPointerCancel={(event) => {
                        const drag = tileDragRef.current;
                        if (drag && drag.pointerId === event.pointerId) endTileDrag(drag, false, event.timeStamp);
                      }}
                      // A long press lifts the tile; no image menu over it.
                      onContextMenu={(event) => {
                        if (tileDragRef.current) event.preventDefault();
                      }}
                    >
                      {tile.kind === "stored" ? (
                        <StoredImg image={tile.image} />
                      ) : (
                        <img src={tile.image.previewUrl} alt="" decoding="async" draggable={false} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="attachment-remove"
                      aria-label={
                        removable.length > 1 && position >= 0
                          ? tr(`Remove image ${position + 1} of ${removable.length}`, `移除图片 ${position + 1}/${removable.length}`)
                          : tr("Remove image", "移除图片")
                      }
                      tabIndex={removing ? -1 : undefined}
                      onMouseDown={keepFieldFocus}
                      onClick={(event) => beginRemove(image.id, event.currentTarget)}
                      disabled={locked}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              {reorder?.bar ? (
                <span className="attachment-slot" style={{ left: reorder.bar.left, top: reorder.bar.top, height: reorder.bar.height }} aria-hidden="true" />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* The note slot: the image-link row, then the error and conflict
          lines, each folding open and shut in place (see .editor-notes). */}
      <div className="editor-notes">
        <div id={linkPopId} className={`link-pop${linkOpen ? " is-open" : ""}`} aria-hidden={!linkOpen}>
          <div className="link-pop-inner">
            <Link2 size={14} aria-hidden="true" />
            <input
              ref={linkRef}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              value={linkValue}
              placeholder={tr(
                "Paste an image URL https://… (external preview; uses no storage)",
                "粘贴图片链接 https://…（外链预览，不占用存储）"
              )}
              tabIndex={linkOpen ? 0 : -1}
              disabled={locked}
              onChange={(event) => {
                setLinkValue(event.target.value);
                clearError("link");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  confirmLink();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeLink();
                  areaRef.current?.focus();
                }
              }}
            />
            <button type="button" className="ghost-button link-pop-add" tabIndex={linkOpen ? 0 : -1} onClick={confirmLink} disabled={locked}>
              {tr("Insert", "插入")}
            </button>
          </div>
        </div>

        <div className={`editor-note${errorText ? " is-open" : ""}`}>
          <div className="editor-note-inner">
            {errorText ? (
              <p key={errorKey} className={`editor-error${errorReplacing ? " is-replacing" : ""}`}>
                {errorText}
              </p>
            ) : (
              <p key="leaving" className="editor-error" aria-hidden="true">
                {lastErrorRef.current}
              </p>
            )}
          </div>
        </div>

        <div className={`editor-note${conflictMessage ? " is-open" : ""}`}>
          <div className="editor-note-inner">
            {conflictMessage ? (
              <div key="conflict" className="editor-conflict">
                <p>{conflictMessage}</p>
                {onAcceptRemoteBase ? (
                  <button type="button" className="ghost-button" onClick={onAcceptRemoteBase} disabled={locked}>
                    {tr("Keep my draft and continue", "保留草稿并继续")}
                  </button>
                ) : null}
              </div>
            ) : lastConflictRef.current ? (
              <div key="leaving" className="editor-conflict" aria-hidden="true">
                <p>{lastConflictRef.current}</p>
                {onAcceptRemoteBase ? (
                  <button type="button" className="ghost-button" tabIndex={-1}>
                    {tr("Keep my draft and continue", "保留草稿并继续")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="editor-bar">
        {/* One Tab stop for the whole toolbar; ←/→ (Home/End) move along it. */}
        <div className="editor-tools" role="toolbar" aria-label={tr("Writing tools", "编辑工具")} onKeyDown={onToolsKeyDown} onFocus={onToolsFocus}>
          <button
            type="button"
            data-tool="tag"
            tabIndex={toolTab("tag")}
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={insertHash}
            disabled={!toolEnabled.tag}
            aria-label={tr("Insert tag", "插入标签")}
            {...tip.bind({ text: tr("Insert tag", "插入标签") })}
          >
            <Hash size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-tool="bold"
            tabIndex={toolTab("bold")}
            onMouseDown={keepFieldFocus}
            className={`icon-button${pressed.bold ? " is-active-tool" : ""}`}
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(toggleWrap(content, area.selectionStart, area.selectionEnd, "**"));
            }}
            aria-label={tr("Bold", "加粗")}
            aria-pressed={pressed.bold}
            disabled={!toolEnabled.bold}
            aria-keyshortcuts="Meta+B Control+B"
            // The other wraps have no button of their own; their keys ride
            // along here (and on the field's aria-keyshortcuts).
            {...tip.bind({
              text: tr(
                `Bold (${MOD}B) · italic ${MOD}I · code ${MOD}E · strike ${MOD}${SHIFT}S · highlight ${MOD}${SHIFT}H · link ${MOD}K`,
                `加粗（${MOD}B）· 斜体 ${MOD}I · 代码 ${MOD}E · 删除线 ${MOD}${SHIFT}S · 高亮 ${MOD}${SHIFT}H · 链接 ${MOD}K`
              )
            })}
          >
            <Bold size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-tool="list"
            tabIndex={toolTab("list")}
            onMouseDown={keepFieldFocus}
            className={`icon-button${pressed.list ? " is-active-tool" : ""}`}
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(toggleBulletLine(content, area.selectionStart, area.selectionEnd));
            }}
            aria-label={tr("Bullet list", "列表")}
            aria-pressed={pressed.list}
            disabled={!toolEnabled.list}
            {...tip.bind({ text: tr("Bullet list (again for a checklist)", "无序列表（再按一次变为待办）") })}
          >
            <List size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-tool="table"
            tabIndex={toolTab("table")}
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(insertTableTemplate(content, area.selectionStart, tr("Col 1", "列 1"), tr("Col 2", "列 2")));
            }}
            aria-label={tr("Insert table", "插入表格")}
            disabled={!toolEnabled.table}
            {...tip.bind({ text: tr("Insert table", "插入表格") })}
          >
            <Table size={16} aria-hidden="true" />
          </button>
          <button
            ref={addImageRef}
            type="button"
            data-tool="image"
            tabIndex={toolTab("image")}
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={() => fileRef.current?.click()}
            disabled={!toolEnabled.image}
            aria-label={tr("Add image", "添加图片")}
            {...tip.bind({ text: tr("Add image (or drag and paste)", "添加图片（可拖拽/粘贴）") })}
          >
            <ImageIcon size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-tool="link"
            tabIndex={toolTab("link")}
            onMouseDown={keepFieldFocus}
            aria-expanded={linkOpen}
            aria-controls={linkPopId}
            className={`icon-button${linkOpen ? " is-active-tool" : ""}`}
            onClick={() => {
              // Focus inside the tap itself, or iOS will not raise the keyboard.
              if (!linkOpen) linkRef.current?.focus({ preventScroll: true });
              else areaRef.current?.focus({ preventScroll: true });
              setLinkOpen((value) => !value);
              setError(null);
            }}
            aria-label={tr("Insert image link", "插入图片链接")}
            disabled={!toolEnabled.link}
            {...tip.bind({ text: tr("Insert image link", "插入图片链接") })}
          >
            <Link2 size={16} aria-hidden="true" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={locked}
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </div>
        <div className="editor-actions">
          {sendQueued ? <span className="editor-status">{tr("Preparing image…", "正在处理图片…")}</span> : null}
          {showCounter ? (
            overLimit ? (
              // Over the cap the count says so in words; the bubble names the cap.
              <span
                id={countId}
                className="editor-count is-over"
                {...tip.bind({ text: tr(`A memo holds up to ${formatNumber(MAX_CONTENT_CHARS)} characters`, `单条笔记最多 ${formatNumber(MAX_CONTENT_CHARS)} 字`) })}
              >
                {tr(`${formatNumber(effectiveContentLength - MAX_CONTENT_CHARS)} over`, `超出 ${formatNumber(effectiveContentLength - MAX_CONTENT_CHARS)} 字`)}
                <span className="sr-only">
                  {tr(` — a memo holds up to ${formatNumber(MAX_CONTENT_CHARS)} characters`, `，单条笔记最多 ${formatNumber(MAX_CONTENT_CHARS)} 字`)}
                </span>
              </span>
            ) : (
              <span className="editor-count">
                {formatNumber(effectiveContentLength)} / {formatNumber(MAX_CONTENT_CHARS)}
              </span>
            )
          ) : null}
          {mode === "edit" && onCancel ? (
            <button type="button" className="ghost-button" onClick={cancel} disabled={locked}>
              {tr("Cancel", "取消")}
            </button>
          ) : null}
          <button
            type="button"
            className={`send-button${uploadPercent !== null ? " is-uploading" : ""}${sending ? " is-sending" : ""}`}
            onMouseDown={keepSendFocus}
            onClick={() => void submit()}
            disabled={!canSubmit && !canQueue}
            aria-label={mode === "create" ? tr("Send", "发送") : tr("Save", "保存")}
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {uploadPercent !== null ? (
              // Images can take a while on a slow uplink: the fill and the
              // figure track the bytes actually sent. Decoration only: a
              // button's children are presentational, so the progressbar
              // screen readers can reach sits beside the button.
              <span className="send-progress" aria-hidden="true" style={{ transform: `scaleX(${uploadPercent / 100})` }} />
            ) : null}
            {sending && spinnerShown ? (
              <span className="send-spinner" aria-hidden="true">
                <Loader2 size={17} className="spin" aria-hidden="true" />
              </span>
            ) : (
              // Keyed by the clears, so each emptied composer replays the flight.
              <SendGlyph key={clears} flying={clears > flown} onFlown={() => setFlown(clears)} />
            )}
            {/* Label and percentage share one grid cell with hidden sizers for
                both, so the chip is the same width idle, at 0% and at 99%
                (tabular digits) and never jumps when an upload starts. */}
            <span className="send-percent" aria-hidden="true">
              <span className={uploadPercent !== null ? "send-percent-sizer" : undefined}>
                {mode === "create" ? tr("Send", "发送") : tr("Save", "保存")}
              </span>
              <span className="send-percent-sizer">{formatNumber(99)}%</span>
              {uploadPercent !== null ? <span>{formatNumber(uploadPercent)}%</span> : null}
            </span>
          </button>
          {uploadPercent !== null ? (
            <span
              className="send-progress-sr"
              role="progressbar"
              aria-label={tr("Uploading images", "正在上传图片")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={uploadPercent}
            />
          ) : null}
        </div>
      </div>

      <div className={`editor-drop${veil.refused ? " is-refusing" : ""}`} aria-hidden="true">
        {veil.refused ? <ImageOff size={22} aria-hidden="true" /> : <ImagePlus size={22} aria-hidden="true" />}
        <span>{veil.label}</span>
      </div>
    </div>
  );
}
