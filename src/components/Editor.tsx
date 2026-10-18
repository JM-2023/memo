import { Bold, Hash, Image as ImageIcon, ImageOff, ImagePlus, Link2, List, Loader2, Table, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { isImageUrl } from "../lib/content";
import { htmlCarriesText, htmlToMarkdown } from "../lib/htmlToMarkdown";
import { ImageSlotLedger } from "../lib/imageSlots";
import { compressImage } from "../lib/images";
import { useI18n } from "../lib/i18n";
import { announce } from "../lib/liveAnnouncer";
import { inheritTagContext } from "../lib/tags";
import {
  backspaceListMarker,
  continueListOnEnter,
  insertTableTemplate,
  shiftListIndent,
  tableTabStop,
  toggleBulletLine,
  toggleWrap,
  type EditPatch
} from "../lib/markdownEdit";
import { caretPoint } from "../lib/textareaCaret";
import type { MemoImage, NewImagePayload } from "../lib/types";
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
/** A fast send never shows the spinner: the Send glyph holds this long first. */
const SPINNER_DELAY_MS = 150;

/** Characters a tag can hold (TAG_PATTERN in lib/tags). */
const TAG_CHAR = /[\p{L}\p{N}_\-/·]/u;

/** The `#run` the caret sits in (or right after), if any. */
function tagTokenAt(value: string, caret: number): { hashStart: number; query: string } | null {
  let start = caret;
  while (start > 0 && !/[\s#]/.test(value[start - 1])) start -= 1;
  if (start === 0 || value[start - 1] !== "#") return null;
  return { hashStart: start - 1, query: value.slice(start, caret) };
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
function SendGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M3.6 3.7 20.9 12 3.6 20.3 6.7 13.25 13.4 12 6.7 10.75Z" />
    </svg>
  );
}

/** `text` with [from, to) set in weight 600, the matched run of a suggestion. */
function withHit(text: string, from: number, to: number): ReactNode {
  const start = Math.max(0, Math.min(text.length, from));
  const end = Math.max(start, Math.min(text.length, to));
  if (start === end) return text;
  return (
    <>
      {text.slice(0, start)}
      <b className="tag-suggest-hit">{text.slice(start, end)}</b>
      {text.slice(end)}
    </>
  );
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
}

/** One attachment tile: an image on the memo, one ready to upload, or one
 * still being compressed (shown from the original file meanwhile). */
type AttachmentTile =
  | { kind: "stored"; key: string; image: MemoImage }
  | { kind: "pending"; key: string; image: NewImagePayload }
  | { kind: "preparing"; key: string; url: string | null };

/** An image being compressed: its tile's key and a preview of the original. */
interface PreparingImage {
  key: string;
  url: string | null;
}

export interface EditorSubmission {
  clientId: string;
  content: string;
  newImages: NewImagePayload[];
  removeImageIds: string[];
  /** Set when the save carries new images: reports the sent fraction (0..1). */
  onUploadProgress?: (fraction: number) => void;
  /** Create mode: the owner calls this inside the update that lands the new
   * memo, so the composer clears in that same commit (and the same view
   * transition, `animated`) instead of a frame later. Optional: a create
   * resolved true without it clears afterwards as before. */
  onCommitted?: (animated: boolean) => void;
}

interface Suggestion {
  tokenStart: number;
  query: string;
  items: string[];
  index: number;
  /** The typed run already spells a known tag in full; Enter must not swap
      it for a longer suggestion (e.g. `#life` → `#life/cooking`). */
  exact: boolean;
}

/**
 * The composer used both for new memos and in-place editing. Plain text with
 * #tag affordances: a toolbar "#" button, live tag autocomplete under the
 * caret token. Markdown is written as plain syntax (cards render it):
 * Enter continues list/task/quote lines and builds tables row by row, Tab
 * indents lists and hops table cells, ⌘B/⌘I/⌘E/⌘⇧S/⌘⇧H wrap the selection,
 * and the toolbar covers bold + list + table for touch. Images
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
  onNotice
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
  const compressing = preparing.length;
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
  // `seq` gives each complaint its own alert element, so the same words a
  // second time (a retry that fails again) are still announced.
  const [error, setError] = useState<{ text: string; cause: "link" | "limit" | "other"; seq: number } | null>(null);
  const errorSeqRef = useRef(0);
  const lastErrorRef = useRef("");
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
  // Stable across ambiguous network failures; rotate only after a confirmed
  // create so retrying the same draft remains idempotent.
  const draftIdRef = useRef(crypto.randomUUID());
  const submittingRef = useRef(false);
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

  useLayoutEffect(() => {
    imageSlots.syncCommitted(totalImages);
  }, [imageSlots, totalImages]);

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

  // Sending reads the same as resting for a beat: a fast send never flashes
  // the spinner, a slow one fades it in.
  useEffect(() => {
    if (!sending) {
      setSpinnerShown(false);
      return;
    }
    const timer = window.setTimeout(() => setSpinnerShown(true), SPINNER_DELAY_MS);
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
    const lowered = query.toLowerCase();
    const exact = lowered.length > 0 && knownTags.some((tag) => tag.toLowerCase() === lowered);
    // Tags that begin with the run lead the list, then any that contain it;
    // the tag typed out in full is left off (nothing left to complete).
    // knownTags arrives sorted, and the sort is stable, so each group stays
    // alphabetical.
    const items = knownTags
      .filter((tag) => tag.toLowerCase().includes(lowered) && tag.toLowerCase() !== lowered)
      .sort((a, b) => Number(!a.toLowerCase().startsWith(lowered)) - Number(!b.toLowerCase().startsWith(lowered)))
      .slice(0, 6);
    setSuggestion(items.length > 0 ? { tokenStart: hashStart, query, items, index: 0, exact } : null);
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
    if (!area || composingRef.current) return;
    const quiet = quietSelectRef.current;
    quietSelectRef.current = null;
    if (quiet && quiet.start === area.selectionStart && quiet.end === area.selectionEnd) return;
    if (area.selectionStart !== area.selectionEnd) setSuggestion(null);
    else refreshSuggestion(area.value, area.selectionStart);
  }

  /**
   * One suggestion row: the parent path gives way (ellipsized) before the
   * leaf, so a deep tag still shows its own name; the run that matched is
   * set a step heavier.
   */
  function suggestionRow(tag: string, query: string): ReactNode {
    const split = tag.lastIndexOf("/") + 1;
    const hit = query ? tag.toLowerCase().indexOf(query.toLowerCase()) : -1;
    const from = hit < 0 ? 0 : hit;
    const to = hit < 0 ? 0 : hit + query.length;
    return (
      <>
        <span className="tag-suggest-path">{withHit(`#${tag.slice(0, split)}`, from + 1, to + 1)}</span>
        <span className="tag-suggest-leaf">{withHit(tag.slice(split), from - split, to - split)}</span>
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
   * it again. Keyboard users still Tab to them as before. */
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
          fail(errorMessage(cause, "Couldn’t process the image", "图片处理失败"));
          // A queued send would go out without the image it was waiting for.
          setSendQueued(false);
        }
      } finally {
        if (reservationOpen) imageSlots.settle(false);
        if (url) {
          URL.revokeObjectURL(url);
          preparingUrlsRef.current.delete(url);
        }
        if (mountedRef.current) setPreparing((value) => value.filter((item) => item.key !== key));
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
    if (busy || submittingRef.current) return;
    // Candidate navigation and confirmation belong to the IME while text is
    // composing. Some WebKit versions clear isComposing on the final Enter
    // keydown but retain the conventional 229 keyCode, so honor both signals
    // before tag suggestions or markdown shortcuts see the event.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (sendQueued) {
      // Held for a compressing image: Esc takes the press back; nothing
      // else may change the draft before it goes.
      if (event.key === "Escape") {
        event.preventDefault();
        setSendQueued(false);
      }
      return;
    }
    const area = event.currentTarget;
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
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSuggestion({ ...active, index: (active.index + delta + active.items.length) % active.items.length });
        return;
      }
      const modified = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
      if ((event.key === "Enter" && active.exact) || ((event.key === "Enter" || event.key === "Tab") && modified)) {
        // The run is already a tag: Enter keeps its ordinary meaning (a new
        // line, a continued list) and only puts the list away. It used to
        // take the first child instead — `#life` became `#life/cooking` and
        // the line never broke. Tab still accepts the highlighted one.
        // A held modifier means the key's own job — ⌘↩ sends, Shift+↩
        // breaks the line, Shift+Tab steps back — so it too only closes.
        setSuggestion(null);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applySuggestion(active.items[active.index]);
        return;
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
    // Set once the composer is cleared — by the owner through onCommitted,
    // inside the update that lands the memo, or else right after.
    let cleared = false;
    const clearComposer = (animated: boolean) => {
      if (cleared || !mountedRef.current) return;
      cleared = true;
      draftIdRef.current = crypto.randomUUID();
      imageSlots.syncCommitted(existingImages.length);
      for (const image of newImages) URL.revokeObjectURL(image.previewUrl);
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
      if (uploading.length > 0) setUploadPercent(0);
      const ok = await onSubmit({
        clientId: draftIdRef.current,
        content: content.trim(),
        newImages: uploading,
        removeImageIds: removedImageIds,
        onUploadProgress:
          uploading.length > 0
            ? (fraction) => {
                if (mountedRef.current) setUploadPercent(Math.min(99, Math.round(fraction * 100)));
              }
            : undefined,
        onCommitted: mode === "create" ? clearComposer : undefined
      });
      if (ok && mode === "create") {
        clearComposer(false);
        returnFocusToField();
      }
    } catch (cause) {
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
      if (mountedRef.current) {
        setSubmitting(false);
        setUploadPercent(null);
      }
    }
  }

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
    ...preparing.map(({ key, url }): AttachmentTile => ({ kind: "preparing", key, url }))
  ];
  // What stays, numbered like the card's own "View image 2 of 3".
  const removable = tiles.flatMap((tile) => (tile.kind !== "preparing" && !removingKeys.has(tile.image.id) ? [tile.image.id] : []));
  // The row folds shut while its last tile leaves, and unmounts after.
  const attachmentsOpen = removable.length > 0 || compressing > 0;
  // The note rows fold open and shut (see .editor-note); a closing one keeps
  // its last words while it folds, as an aria-hidden copy.
  const errorText = imageLimitExceeded
    ? tr(`Remove images until no more than ${MAX_IMAGES} remain`, `请移除图片，最多保留 ${MAX_IMAGES} 张`)
    : (error?.text ?? null);
  if (errorText) lastErrorRef.current = errorText;
  if (conflictMessage) lastConflictRef.current = conflictMessage;
  // The tag list: open, stepped aside for an IME, or playing its exit.
  const list = suggestion ?? leavingSuggestion;
  const listOpen = suggestion !== null && !composing;

  return (
    <div
      ref={rootRef}
      className={`editor ${mode === "create" ? "editor-create" : "editor-edit"}${dropKind !== null ? " is-dropping" : ""}`}
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
          aria-describedby={mode === "create" && contextTag ? contextTagDescriptionId : undefined}
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listOpen ? suggestionListId : undefined}
          aria-activedescendant={listOpen ? `${suggestionListId}-option-${suggestion.index}` : undefined}
          // The wraps act on the field's selection; Bold's tip names them.
          aria-keyshortcuts="Meta+B Control+B Meta+I Control+I Meta+E Control+E Meta+Shift+S Control+Shift+S Meta+Shift+H Control+Shift+H"
          value={content}
          placeholder={tr("What’s on your mind…", "现在的想法是……")}
          rows={mode === "create" ? 2 : 3}
          maxLength={HARD_INPUT_CAP}
          readOnly={locked}
          onChange={(event) => {
            if (busy || submittingRef.current) return;
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
          onBlur={() => window.setTimeout(() => setSuggestion(null), 120)}
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
          {list.items.map((tag, index) => (
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
                // The pointer picks the row the keyboard would act on, so
                // only one row is ever lit. A list redrawn under a resting
                // pointer (movement 0) leaves the keyboard's row alone.
                if (!listOpen || (event.movementX === 0 && event.movementY === 0)) return;
                if (index !== suggestion.index) setSuggestion({ ...suggestion, index });
              }}
              disabled={locked}
            >
              {suggestionRow(tag, list.query)}
            </button>
          ))}
        </div>
      ) : null}

      <div className={`editor-attach${attachmentsOpen ? " is-open" : ""}`}>
        <div className="editor-attach-clip">
          {tiles.length > 0 ? (
            <div className="editor-attachments">
              {tiles.map((tile) => {
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
                return (
                  <div
                    key={tile.key}
                    className={`attachment${removing ? " is-removing" : ""}${settledTiles.has(image.id) ? " is-settled" : ""}`}
                    aria-hidden={removing || undefined}
                    onAnimationEnd={(event) => {
                      if (event.animationName !== "attach-out") return;
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
                    {tile.kind === "stored" ? <StoredImg image={tile.image} /> : <img src={tile.image.previewUrl} alt="" decoding="async" />}
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
            </div>
          ) : null}
        </div>
      </div>

      {/* The note slot: the image-link row, then the error and conflict
          lines, each folding open and shut in place (see .editor-notes). */}
      <div className="editor-notes">
        <div className={`link-pop${linkOpen ? " is-open" : ""}`} aria-hidden={!linkOpen}>
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
              <p key={imageLimitExceeded ? "limit" : `error-${error?.seq ?? 0}`} className="editor-error" role="alert">
                {errorText}
              </p>
            ) : (
              <p key="leaving" className="editor-error is-leaving" aria-hidden="true">
                {lastErrorRef.current}
              </p>
            )}
          </div>
        </div>

        <div className={`editor-note${conflictMessage ? " is-open" : ""}`}>
          <div className="editor-note-inner">
            {conflictMessage ? (
              <div key="conflict" className="editor-conflict" role="alert">
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
        <div className="editor-tools">
          <button
            type="button"
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={insertHash}
            disabled={locked}
            aria-label={tr("Insert tag", "插入标签")}
            {...tip.bind({ text: tr("Insert tag", "插入标签") })}
          >
            <Hash size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(toggleWrap(content, area.selectionStart, area.selectionEnd, "**"));
            }}
            aria-label={tr("Bold", "加粗")}
            disabled={locked}
            aria-keyshortcuts="Meta+B Control+B"
            // The other wraps have no button of their own; their keys ride
            // along here (and on the field's aria-keyshortcuts).
            {...tip.bind({
              text: tr(
                `Bold (${MOD}B) · italic ${MOD}I · code ${MOD}E · strike ${MOD}${SHIFT}S · highlight ${MOD}${SHIFT}H`,
                `加粗（${MOD}B）· 斜体 ${MOD}I · 代码 ${MOD}E · 删除线 ${MOD}${SHIFT}S · 高亮 ${MOD}${SHIFT}H`
              )
            })}
          >
            <Bold size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(toggleBulletLine(content, area.selectionStart, area.selectionEnd));
            }}
            aria-label={tr("Bullet list", "列表")}
            disabled={locked}
            {...tip.bind({ text: tr("Bullet list (again for a checklist)", "无序列表（再按一次变为待办）") })}
          >
            <List size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(insertTableTemplate(content, area.selectionStart, tr("Col 1", "列 1"), tr("Col 2", "列 2")));
            }}
            aria-label={tr("Insert table", "插入表格")}
            disabled={locked}
            {...tip.bind({ text: tr("Insert table", "插入表格") })}
          >
            <Table size={16} aria-hidden="true" />
          </button>
          <button
            ref={addImageRef}
            type="button"
            onMouseDown={keepFieldFocus}
            className="icon-button"
            onClick={() => fileRef.current?.click()}
            disabled={locked || totalImages + compressing >= MAX_IMAGES}
            aria-label={tr("Add image", "添加图片")}
            {...tip.bind({ text: tr("Add image (or drag and paste)", "添加图片（可拖拽/粘贴）") })}
          >
            <ImageIcon size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            onMouseDown={keepFieldFocus}
            className={`icon-button${linkOpen ? " is-active-tool" : ""}`}
            onClick={() => {
              // Focus inside the tap itself, or iOS will not raise the keyboard.
              if (!linkOpen) linkRef.current?.focus({ preventScroll: true });
              else areaRef.current?.focus({ preventScroll: true });
              setLinkOpen((value) => !value);
              setError(null);
            }}
            aria-label={tr("Insert image link", "插入图片链接")}
            disabled={locked}
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
              <SendGlyph />
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
