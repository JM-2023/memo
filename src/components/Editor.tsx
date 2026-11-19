import { Bold, Hash, Image as ImageIcon, ImageOff, ImagePlus, Link2, List, Plus, Table } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { MAX_IMAGES, useAttachmentTiles } from "../hooks/useAttachmentTiles";
import { extractTypedDelta, useSubmission } from "../hooks/useSubmission";
import { isImageUrl } from "../lib/content";
import { fileDragKind, isFileDrag, pasteTakesImages, registerDropTarget, type FileDragKind } from "../lib/editorDropGuard";
import { htmlToMarkdown } from "../lib/htmlToMarkdown";
import { useI18n } from "../lib/i18n";
import { layerCount } from "../lib/layerStack";
import { announce } from "../lib/liveAnnouncer";
import { MAX_CONTENT_CHARS } from "../lib/memoRules";
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
import { AttachmentTiles } from "./AttachmentTiles";
import { EditorActions } from "./EditorActions";
import { useTip } from "./Tip";

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
  const { errorMessage, tr } = useI18n();
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
  // Bumped when a confirmed create clears (or hands off) the composer; the
  // layout effect below sizes the emptied field in that same commit.
  const [clears, setClears] = useState(0);
  const clearGrowRef = useRef<"instant" | "smooth" | null>(null);
  // Caret target after typing during `landing` pivots the field to the next draft.
  const landingCaretRef = useRef<number | null>(null);
  // If `onCommitted` fires mid-IME composition during `landing`, hold the
  // sent text baseline until compositionend so the browser's IME isn't aborted.
  const pendingLandingStripRef = useRef<string | null>(null);
  const addImageRef = useRef<HTMLButtonElement>(null);
  // Bold and List show whether the caret already sits in bold text or on a
  // list line (aria-pressed).
  const [pressed, setPressed] = useState({ bold: false, list: false });
  // The toolbar is one Tab stop; ←/→ move it between the tools.
  const [toolStop, setToolStop] = useState<ToolKey>("tag");
  // Bumped when another memo's Edit is refused: the field's border pulses.
  const [attention, setAttention] = useState(0);
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
  // Create mode: a send has just emptied the composer and nothing has been
  // typed since, so ⌘Z means the send (onUndoSend), not the field's history.
  const freshClearRef = useRef(false);
  const onUndoSendRef = useRef(onUndoSend);
  onUndoSendRef.current = onUndoSend;
  const mountedRef = useRef(true);
  // Bridges useAttachmentTiles and useSubmission without circular init order.
  const submissionRef = useRef<{
    isLocked: () => boolean;
    handoffLanding: () => boolean;
    cancelQueued: () => void;
    clearError: () => void;
  }>({
    isLocked: () => busy,
    handoffLanding: () => false,
    cancelQueued: () => undefined,
    clearError: () => undefined
  });

  function fail(text: string, cause: "link" | "limit" | "other" = "other") {
    errorSeqRef.current += 1;
    setError({ text, cause, seq: errorSeqRef.current });
    submissionRef.current.clearError();
    // Spoken through the standing region: a line mounted already filled
    // (the note below) is often skipped by screen readers.
    announce(text, "assertive");
  }
  function clearError(cause: "link" | "limit" | "other") {
    setError((current) => (current?.cause === cause ? null : current));
  }
  // The pictures: the memo's own, the draft's, and those still preparing.
  const attachments = useAttachmentTiles({
    existingImages,
    initialDraft,
    isLocked: () => submissionRef.current.isLocked(),
    notes: {
      fail,
      clear: clearError,
      reset: () => {
        setError(null);
        submissionRef.current.clearError();
      }
    },
    rootRef,
    areaRef,
    addImageRef,
    mountedRef,
    onNotice,
    onAdd: () => {
      freshClearRef.current = false;
      // Dropping/picking images during create `landing` pivots to the next draft
      // first, clearing the old memo's sent tiles and resetting the 9-slot ledger.
      if (submissionRef.current.handoffLanding()) {
        // The emptied field shrinks back from the sent text's height now,
        // not at the next keystroke ([clears] below).
        clearGrowRef.current = "smooth";
        setContent("");
      }
    },
    // The draft is not what Send was pressed on any more: hold it back.
    onImageRejected: () => submissionRef.current.cancelQueued()
  });
  const { newImages, compressing, totalImages, keptNewImages, removedImageIds } = attachments;
  const imageLimitExceeded = totalImages > MAX_IMAGES;
  const submittedContent = content.trim();
  const effectiveContent = mode === "create" && contextTag ? inheritTagContext(submittedContent, contextTag) : submittedContent;
  const effectiveContentLength = effectiveContent.length;
  const overLimit = effectiveContentLength > MAX_CONTENT_CHARS;
  // An edit is clean until its text or images differ from what it opened on
  // (an image still preparing counts as a change). Save rests until then,
  // and ⌘↩ on a clean edit just closes it, like Esc.
  const dirty =
    mode === "create" || content.trim() !== openedOn.trim() || keptNewImages.length > 0 || removedImageIds.length > 0 || compressing > 0;
  const hasPayload = submittedContent.length > 0 || totalImages > 0;
  const ready = !busy && !conflictMessage && !overLimit && !imageLimitExceeded && dirty;

  const submission = useSubmission({
    mode,
    busy,
    compressing,
    dirty,
    ready,
    hasPayload,
    mountedRef,
    readDraft: () => {
      const area = areaRef.current;
      const held = area ? { start: area.selectionStart, end: area.selectionEnd, scrollTop: area.scrollTop } : null;
      const sent = content.trim();
      const lead = content.length - content.trimStart().length;
      const caret = (offset: number) => Math.max(0, Math.min(sent.length, offset - lead));
      return {
        rawContent: content,
        content: sent,
        newImages: keptNewImages,
        removeImageIds: removedImageIds,
        selection: held ? { start: caret(held.start), end: caret(held.end) } : { start: sent.length, end: sent.length },
        held
      };
    },
    onSubmit,
    onCloseClean: cancel,
    onBeforeStart: () => setError(null),
    onQueued: () => {
      setError(null);
      announce(tr("Preparing image…", "正在处理图片…"));
    },
    onStoppedQueued: () => {
      const area = areaRef.current;
      const active = document.activeElement;
      if (!area || !mountedRef.current) return;
      const fromStop = active instanceof HTMLElement && active.closest(".editor-stop") !== null;
      if (fromStop || window.matchMedia?.("(pointer: fine)").matches) area.focus({ preventScroll: true });
    },
    onCommitEmpty: (animated, rawContent) => {
      // The sent images' previews went with the memo: the owner releases
      // them, or hands them back if the memo is taken back.
      attachments.clearSent();
      setSuggestion(null);
      setLinkOpen(false);
      setLinkValue("");
      if (composingRef.current) {
        // An IME composition started during `landing`: wait for compositionend
        // before stripping the sent text so the browser doesn't abort the IME.
        pendingLandingStripRef.current = rawContent;
        freshClearRef.current = false;
        return;
      }
      freshClearRef.current = true;
      setContent("");
      // A view transition morphs the composer shut itself; without one the
      // field eases down on its own height transition.
      clearGrowRef.current = animated ? "instant" : "smooth";
      setClears((value) => value + 1);
    },
    onHandoff: () => {
      attachments.clearSent();
      freshClearRef.current = false;
      setSuggestion(null);
      setLinkOpen(false);
      setLinkValue("");
      setClears((value) => value + 1);
    },
    onRestoreField: (held) => {
      const field = areaRef.current;
      if (!field || !held || !mountedRef.current) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(held.start, held.end);
      field.scrollTop = held.scrollTop;
      quietSelectRef.current = { start: held.start, end: held.end };
    },
    onReturnFocus: returnFocusToField,
    onError: (cause) => {
      const text = errorMessage(cause, "Couldn’t save the memo", "保存失败");
      if (mode === "edit") {
        errorSeqRef.current += 1;
        setError(null);
        announce(text, "assertive");
        return { text, seq: errorSeqRef.current };
      }
      fail(text);
      return { text, seq: errorSeqRef.current };
    }
  });
  submissionRef.current = submission;
  const { locked, sending, canSubmit, canQueue, uploadPercent } = submission;

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

  // Esc stops an in-flight save or queued send even if focus left the field
  // (e.g. clicking Send/Stop, or the disabled Send button dropping focus to body).
  // Not while anything sits over the page (lib/layerStack: a menu, the search
  // list, the filter panel, the drawer, a dialog) or select mode is on: that
  // Esc is the top layer's, and stopping the send under it too would spend
  // one press on two things.
  useEffect(() => {
    if (!submission.canStop) return;
    const onWindowKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (layerCount() > 0 || document.querySelector(".memo-feed.is-select")) return;
      if (document.querySelector(".overlay:not(.is-closing), .passcode-overlay:not(.is-closing), .action-menu:not(.is-closing)")) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const other = active.closest(".editor");
        if (other && other !== rootRef.current) return;
      }
      if (submission.stop()) event.preventDefault();
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission.canStop]);

  // A confirmed create emptied the field: size it in the same commit, so a
  // view transition captures the composer at its final height.
  useLayoutEffect(() => {
    const grow = clearGrowRef.current;
    if (!grow) return;
    clearGrowRef.current = null;
    autoGrow(grow === "instant");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clears]);

  // Typing during create `landing` pivoted the field straight to the next
  // draft: seat the caret at the end of the newly typed characters.
  useLayoutEffect(() => {
    const caret = landingCaretRef.current;
    const area = areaRef.current;
    if (caret === null || !area) return;
    landingCaretRef.current = null;
    const clamped = Math.min(caret, area.value.length);
    area.setSelectionRange(clamped, clamped);
    quietSelectRef.current = { start: clamped, end: clamped };
    autoGrow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
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
    if (submission.isLocked()) return;
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
  /**
   * Pivots a create-mode field mid-`landing` straight into the next draft with
   * `next` (and caret at `selStart..selEnd`), so neither typing nor a toolbar
   * press mixes into the already-sent text or gets wiped when it commits.
   */
  function pivotLanding(next: string, selStart = next.length, selEnd = selStart, suggest = true) {
    submission.handoffLanding();
    setContent(next);
    landingCaretRef.current = selEnd;
    clearError("other");
    submission.clearError();
    if (suggest) refreshSuggestion(next, selStart);
    else setSuggestion(null);
    autoGrow();
  }

  function landValue(next: string, selStart: number, selEnd = selStart, suggest = true) {
    const area = areaRef.current;
    if (!area || submission.isLocked()) return;
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
    if (next !== prev) {
      clearError("other");
      submission.clearError();
    }
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
    if (submission.isLocked()) return;
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
    if (submission.isLocked()) return;
    const area = areaRef.current;
    if (!area) return;
    if (submission.landingRawContent() !== null) {
      area.focus({ preventScroll: true });
      const inserted = padded ? `${text} ` : text;
      pivotLanding(inserted, inserted.length);
      return;
    }
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
    if (submission.isLocked()) return;
    const area = areaRef.current;
    if (!area) return;
    if (submission.landingRawContent() !== null) {
      area.focus({ preventScroll: true });
      pivotLanding("#", 1);
      return;
    }
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

  /** Land a markdown edit: new value plus an exact selection to restore. */
  function applyPatch(patch: EditPatch) {
    if (submission.isLocked()) return;
    landValue(patch.value, patch.start, patch.end);
  }

  /** Apply a formatting helper cleanly, starting fresh if mid-`landing`. */
  function applyTool(make: (value: string, start: number, end: number) => EditPatch) {
    if (submission.isLocked()) return;
    const area = areaRef.current;
    if (!area) return;
    if (submission.landingRawContent() !== null) {
      area.focus({ preventScroll: true });
      const patch = make("", 0, 0);
      pivotLanding(patch.value, patch.start, patch.end);
      return;
    }
    applyPatch(make(content, area.selectionStart, area.selectionEnd));
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

  function confirmLink() {
    if (submission.isLocked()) return;
    const url = linkValue.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      fail(tr("Enter an image URL beginning with http(s)://", "请输入以 http(s):// 开头的图片链接"), "link");
      return;
    }
    setError(null);
    submission.clearError();
    // ![](url) forces image rendering for any URL; the image itself stays
    // external and is never uploaded.
    insertAtCaret(`![](${url})`, true);
    setLinkValue("");
    setLinkOpen(false);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (submission.isLocked()) return;
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
      void attachments.addFiles(files);
      return;
    }
    const landingBase = submission.landingRawContent();
    if (landingBase !== null) {
      if (plainOnly) return;
      const markdown = htmlToMarkdown(event.clipboardData.getData("text/html"));
      if (markdown === null) return;
      event.preventDefault();
      pivotLanding(markdown, markdown.length);
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
  addFilesRef.current = (files) => void attachments.addFiles(files);
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
      if (!locked) void attachments.addFiles([...(event.dataTransfer?.files ?? [])]);
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
    // One stop() for Esc: halts a queued send (`preparing`), an edit save
    // (`saving`), or a create still landing before commit.
    if (event.key === "Escape" && submission.stop()) {
      event.preventDefault();
      return;
    }
    if (submission.isLocked()) return;
    const area = event.currentTarget;
    const landingPending = submission.landingRawContent() !== null;
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
    // Markdown aids (skipped against the already-sent text while `landing`
    // hasn't handed off yet, so the keystroke pivots into a clean new draft).
    if (!landingPending && event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
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
    if (!landingPending && event.key === "Backspace" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const patch = backspaceListMarker(content, area.selectionStart, area.selectionEnd);
      if (patch) {
        event.preventDefault();
        applyPatch(patch);
        return;
      }
    }
    // Tab hops table cells and indents list lines (every selected one);
    // anywhere else it keeps moving focus.
    if (!landingPending && event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
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
        applyTool((value, start, end) => wrapLink(value, start, end));
        return;
      }
      const marker =
        key === "b" ? "**" : key === "i" ? "*" : key === "e" ? "`" : key === "s" && event.shiftKey ? "~~" : key === "h" && event.shiftKey ? "==" : null;
      if (marker) {
        event.preventDefault();
        applyTool((value, start, end) => toggleWrap(value, start, end, marker));
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submission.submit();
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
    if (!onCancel || submission.isLocked()) return;
    const area = areaRef.current;
    if (!dirty) {
      onCancel(null);
      return;
    }
    onCancel({
      content,
      ...attachments.handOff(),
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

  // Create mode: a sent memo taken back from the feed (App's outbox) comes
  // back in here — only into an empty, idle composer, never over a draft.
  const recallRef = useRef<{ start: number; end: number } | null>(null);
  function recall(draft: ComposerDraft): boolean {
    const area = areaRef.current;
    if (mode !== "create" || !area || !mountedRef.current || recallRef.current || submission.isLocked() || submission.isInFlight()) return false;
    if (area.value.trim() || newImages.length > 0 || compressing > 0) return false;
    freshClearRef.current = false;
    recallRef.current = { start: draft.selectionStart, end: draft.selectionEnd };
    setError(null);
    submission.clearError();
    setContent(draft.content);
    attachments.setNewImages(draft.newImages);
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
  const activeError = error ?? submission.error;
  const errorText = imageLimitExceeded ? imageLimitText : (activeError?.text ?? null);
  if (errorText) lastErrorRef.current = errorText;
  if (conflictMessage) lastConflictRef.current = conflictMessage;
  // The line arrives once. Opening, the row's fold and fade are its entrance;
  // only a new complaint replacing one already showing rises in on its own
  // (decided once per line, as its key first renders).
  const errorKey = errorText ? (imageLimitExceeded ? "limit" : `error-${activeError?.seq ?? 0}`) : null;
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
            if (submission.isLocked()) return;
            freshClearRef.current = false;
            const next = event.target.value;
            const composingNow = composingRef.current || Boolean((event.nativeEvent as InputEvent).isComposing);
            const landingBase = submission.landingRawContent();
            if (landingBase !== null && !composingNow) {
              // Keystrokes during create `landing` start the next draft at
              // once instead of mixing into the memo already on its way out.
              const typed = extractTypedDelta(landingBase, next, (event.nativeEvent as InputEvent).data);
              pivotLanding(typed, typed.length);
              return;
            }
            setContent(next);
            // A refused file or a failed send is old news once the text moves on.
            clearError("other");
            submission.clearError();
            // Mid-composition the text is the IME's (pinyin, kana): the list
            // waits, stepped aside, until compositionend hands over the result.
            if (!composingNow) refreshSuggestion(next, event.target.selectionStart);
            autoGrow();
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            setComposing(false);
            const pendingStrip = pendingLandingStripRef.current;
            const landingBase = submission.landingRawContent();
            const stripBase = pendingStrip ?? landingBase;
            if (stripBase !== null) {
              const value = event.currentTarget.value;
              if (pendingStrip !== null || value !== stripBase) {
                pendingLandingStripRef.current = null;
                const typed = extractTypedDelta(stripBase, value);
                pivotLanding(typed, typed.length);
                return;
              }
            }
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

      <AttachmentTiles tiles={attachments} locked={locked || submission.landingHoldingTiles} onOpenImage={onOpenImage} />

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
                  <button
                    type="button"
                    className="ghost-button"
                    onMouseDown={keepFieldFocus}
                    onClick={() => {
                      // Return focus synchronously inside the click/Enter
                      // handler with the caret preserved so unmounting the
                      // conflict note never drops focus to <body>.
                      const area = areaRef.current;
                      const start = area?.selectionStart ?? content.length;
                      const end = area?.selectionEnd ?? content.length;
                      onAcceptRemoteBase();
                      if (area?.isConnected) {
                        area.focus({ preventScroll: true });
                        const limit = area.value.length;
                        area.setSelectionRange(Math.min(start, limit), Math.min(end, limit));
                        quietSelectRef.current = { start: area.selectionStart, end: area.selectionEnd };
                      }
                    }}
                    disabled={locked}
                  >
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
            onClick={() => applyTool((value, start, end) => toggleWrap(value, start, end, "**"))}
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
            onClick={() => applyTool((value, start, end) => toggleBulletLine(value, start, end))}
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
            onClick={() => applyTool((value, start) => insertTableTemplate(value, start, tr("Col 1", "列 1"), tr("Col 2", "列 2")))}
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
              submission.clearError();
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
              void attachments.addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </div>
        <EditorActions
          mode={mode}
          preparing={submission.phase === "preparing"}
          sending={sending}
          locked={locked}
          showStopButton={submission.showStopButton}
          spinnerShown={submission.spinnerShown}
          canSubmit={canSubmit}
          canQueue={canQueue}
          uploadPercent={uploadPercent}
          showCounter={showCounter}
          overLimit={overLimit}
          effectiveContentLength={effectiveContentLength}
          countId={countId}
          clears={clears}
          hasCancel={Boolean(onCancel)}
          onCancel={cancel}
          onStop={() => {
            submission.stop();
          }}
          onSubmit={() => void submission.submit()}
        />
      </div>

      <div className={`editor-drop${veil.refused ? " is-refusing" : ""}`} aria-hidden="true">
        {veil.refused ? <ImageOff size={22} aria-hidden="true" /> : <ImagePlus size={22} aria-hidden="true" />}
        <span>{veil.label}</span>
      </div>
    </div>
  );
}
