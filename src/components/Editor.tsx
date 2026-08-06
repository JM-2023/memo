import { Bold, Hash, Image as ImageIcon, ImagePlus, Link2, List, Loader2, Send, Table, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ApiError } from "../lib/api";
import { ImageSlotLedger } from "../lib/imageSlots";
import { compressImage } from "../lib/images";
import { useI18n } from "../lib/i18n";
import { inheritTagContext } from "../lib/tags";
import {
  continueListOnEnter,
  insertTableTemplate,
  shiftListIndent,
  tableTabStop,
  toggleBulletLine,
  toggleWrap,
  type EditPatch
} from "../lib/markdownEdit";
import type { MemoImage, NewImagePayload } from "../lib/types";
import { useTip } from "./Tip";

const MAX_IMAGES = 9;
/** Mirrors MAX_CONTENT_CHARS in functions/api/memos/index.ts. */
const MAX_CONTENT_CHARS = 40_000;
/** Hard input cap: lets pastes overshoot the limit (so the overflow can be
 * shown) without ever asking the mirror layer to render megabytes. */
const HARD_INPUT_CAP = 100_000;
/** The counter appears once this close to the cap. */
const COUNTER_FROM = MAX_CONTENT_CHARS - 2_000;

interface EditorProps {
  mode: "create" | "edit";
  initialContent?: string;
  /** Edit mode: attachments already on the memo. */
  existingImages?: MemoImage[];
  knownTags: string[];
  /** Create mode: the active feed tag that will be inherited on submit. */
  contextTag?: string | null;
  busy: boolean;
  onSubmit: (data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
  conflictMessage?: string | null;
  onAcceptRemoteBase?: () => void;
}

interface Suggestion {
  tokenStart: number;
  query: string;
  items: string[];
  index: number;
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
  autoFocus,
  conflictMessage,
  onAcceptRemoteBase
}: EditorProps) {
  const { errorMessage, formatNumber, tr } = useI18n();
  const tip = useTip();
  const [content, setContent] = useState(initialContent);
  const [newImages, setNewImages] = useState<NewImagePayload[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [compressing, setCompressing] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counter, not boolean: dragenter/leave fire per child element.
  const [dragDepth, setDragDepth] = useState(0);
  // Attachments play their exit animation before the state actually drops
  // them — keys are image ids (existing) or preview URLs (pending).
  const [removingKeys, setRemovingKeys] = useState<ReadonlySet<string>>(new Set());
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const suggestionListId = useId();
  const contextTagDescriptionId = useId();
  // Stable across ambiguous network failures; rotate only after a confirmed
  // create so retrying the same draft remains idempotent.
  const draftIdRef = useRef(crypto.randomUUID());
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const [imageSlots] = useState(() => new ImageSlotLedger(MAX_IMAGES, existingImages.length));

  const keptExisting = useMemo(() => existingImages.filter((image) => !removedIds.includes(image.id)), [existingImages, removedIds]);

  function beginRemove(key: string) {
    if (busy || submittingRef.current) return;
    setRemovingKeys((value) => new Set(value).add(key));
  }
  function settleRemove(key: string, drop: () => void) {
    setRemovingKeys((value) => {
      if (!value.has(key)) return value;
      const next = new Set(value);
      next.delete(key);
      return next;
    });
    drop();
  }
  const totalImages = keptExisting.length + newImages.length;
  const locked = busy || submitting;
  const imageLimitExceeded = totalImages > MAX_IMAGES;
  const submittedContent = content.trim();
  const effectiveContent = mode === "create" && contextTag ? inheritTagContext(submittedContent, contextTag) : submittedContent;
  const effectiveContentLength = effectiveContent.length;
  const overLimit = effectiveContentLength > MAX_CONTENT_CHARS;
  const canSubmit =
    !locked && !conflictMessage && compressing === 0 && !overLimit && !imageLimitExceeded && (submittedContent.length > 0 || totalImages > 0);

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
  useLayoutEffect(() => {
    autoGrow();
    if (autoFocus) {
      const area = areaRef.current;
      if (area) {
        area.focus({ preventScroll: true });
        area.setSelectionRange(area.value.length, area.value.length);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (linkOpen) linkRef.current?.focus();
  }, [linkOpen]);

  useEffect(() => {
    if (!locked) return;
    setDragDepth(0);
    setSuggestion(null);
  }, [locked]);

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
  // unmount (successful submit unmounts or clears the list).
  const previewUrls = useRef<string[]>([]);
  useEffect(() => {
    previewUrls.current = newImages.map((image) => image.previewUrl);
  }, [newImages]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
    };
  }, []);

  function autoGrow() {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(360, Math.max(mode === "create" ? 68 : 96, area.scrollHeight))}px`;
  }

  function refreshSuggestion(value: string, caret: number) {
    if (busy || submittingRef.current) return;
    let start = caret;
    while (start > 0 && !/[\s#]/.test(value[start - 1])) start -= 1;
    const hashStart = start > 0 && value[start - 1] === "#" ? start - 1 : -1;
    if (hashStart < 0 || knownTags.length === 0) {
      setSuggestion(null);
      return;
    }
    const query = value.slice(hashStart + 1, caret);
    if (/\s/.test(query)) {
      setSuggestion(null);
      return;
    }
    const lowered = query.toLowerCase();
    const items = knownTags.filter((tag) => tag.toLowerCase().includes(lowered) && tag !== query).slice(0, 6);
    setSuggestion(items.length > 0 ? { tokenStart: hashStart, query, items, index: 0 } : null);
  }

  function applySuggestion(tag: string) {
    if (busy || submittingRef.current) return;
    const area = areaRef.current;
    if (!area || !suggestion) return;
    const caret = area.selectionStart;
    const next = `${content.slice(0, suggestion.tokenStart)}#${tag} ${content.slice(caret)}`;
    setContent(next);
    setSuggestion(null);
    requestAnimationFrame(() => {
      const position = suggestion.tokenStart + tag.length + 2;
      area.focus();
      area.setSelectionRange(position, position);
      autoGrow();
    });
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
    setContent(next);
    requestAnimationFrame(() => {
      const position = start + inserted.length;
      area.focus();
      area.setSelectionRange(position, position);
      refreshSuggestion(next, position);
      autoGrow();
    });
  }

  function insertHash() {
    const area = areaRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const needsSpace = start > 0 && !/\s/.test(content[start - 1]);
    insertAtCaret(`${needsSpace ? " " : ""}#`);
  }

  /** Land a markdown edit: new value plus an exact selection to restore. */
  function applyPatch(patch: EditPatch) {
    if (busy || submittingRef.current) return;
    setContent(patch.value);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(patch.start, patch.end);
      refreshSuggestion(patch.value, patch.start);
      autoGrow();
    });
  }

  function confirmLink() {
    if (busy || submittingRef.current) return;
    const url = linkValue.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setError(tr("Enter an image URL beginning with http(s)://", "请输入以 http(s):// 开头的图片链接"));
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
    if (busy || submittingRef.current) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const acceptedCount = imageSlots.reserve(images.length);
    if (acceptedCount <= 0) {
      setError(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`));
      return;
    }
    setError(null);
    setCompressing((value) => value + acceptedCount);
    for (const file of images.slice(0, acceptedCount)) {
      if (!mountedRef.current) {
        imageSlots.settle(false);
        continue;
      }
      let reservationOpen = true;
      try {
        const payload = await compressImage(file);
        if (!mountedRef.current) {
          imageSlots.settle(false);
          reservationOpen = false;
          URL.revokeObjectURL(payload.previewUrl);
          continue;
        }
        const accepted = imageSlots.settle(true);
        reservationOpen = false;
        if (!accepted) {
          URL.revokeObjectURL(payload.previewUrl);
          setError(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`));
          continue;
        }
        setNewImages((value) => [...value, payload]);
      } catch (cause) {
        if (reservationOpen) imageSlots.settle(false);
        if (mountedRef.current) setError(errorMessage(cause, "Couldn’t process the image", "图片处理失败"));
      } finally {
        if (mountedRef.current) setCompressing((value) => value - 1);
      }
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (busy || submittingRef.current) return;
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  }

  function hasFiles(event: DragEvent) {
    return [...(event.dataTransfer?.types ?? [])].some((type) => type === "Files" || type === "text/uri-list");
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (busy || submittingRef.current) return;
    setDragDepth((value) => value + 1);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (busy || submittingRef.current) return;
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    setDragDepth((value) => Math.max(0, value - 1));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (busy || submittingRef.current) return;
    setDragDepth(0);
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      void addFiles(files);
      return;
    }
    // Dragged link (e.g. an image from another page): keep it as an external
    // image reference instead of uploading.
    const uri = (event.dataTransfer?.getData("text/uri-list") || event.dataTransfer?.getData("text/plain") || "").split("\n")[0]?.trim();
    if (uri && /^https?:\/\/\S+$/i.test(uri)) {
      insertAtCaret(`![](${uri})`, true);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (busy || submittingRef.current) return;
    // Candidate navigation and confirmation belong to the IME while text is
    // composing. Some WebKit versions clear isComposing on the final Enter
    // keydown but retain the conventional 229 keyCode, so honor both signals
    // before tag suggestions or markdown shortcuts see the event.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (suggestion) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSuggestion({ ...suggestion, index: (suggestion.index + delta + suggestion.items.length) % suggestion.items.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applySuggestion(suggestion.items[suggestion.index]);
        return;
      }
      if (event.key === "Escape") {
        setSuggestion(null);
        return;
      }
    }
    // Markdown aids. Plain Enter continues a list/task/quote line (an empty
    // item exits instead); Shift+Enter stays a plain newline escape hatch,
    // and Enter while the IME is composing must never be intercepted.
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
      const area = event.currentTarget;
      if (area.selectionStart === area.selectionEnd) {
        const patch = continueListOnEnter(content, area.selectionStart);
        if (patch) {
          event.preventDefault();
          applyPatch(patch);
          return;
        }
      }
    }
    // Tab hops table cells and indents list lines; anywhere else it keeps
    // moving focus.
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const dir = event.shiftKey ? -1 : 1;
      const patch =
        tableTabStop(content, event.currentTarget.selectionStart, dir) ??
        shiftListIndent(content, event.currentTarget.selectionStart, dir);
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
        const area = event.currentTarget;
        applyPatch(toggleWrap(content, area.selectionStart, area.selectionEnd, marker));
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape" && mode === "edit" && onCancel) {
      onCancel();
    }
  }

  async function submit() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Attachments mid-exit-animation count as removed already.
      const ok = await onSubmit({
        clientId: draftIdRef.current,
        content: content.trim(),
        newImages: newImages.filter((image) => !removingKeys.has(image.previewUrl)),
        removeImageIds: [...removedIds, ...existingImages.filter((image) => removingKeys.has(image.id)).map((image) => image.id)]
      });
      if (ok && mode === "create") {
        draftIdRef.current = crypto.randomUUID();
        imageSlots.syncCommitted(existingImages.length);
        for (const image of newImages) URL.revokeObjectURL(image.previewUrl);
        setContent("");
        setNewImages([]);
        previewUrls.current = [];
        setSuggestion(null);
        setLinkOpen(false);
        setLinkValue("");
        requestAnimationFrame(autoGrow);
      }
    } catch (cause) {
      const rotateCreateId =
        mode === "create" && cause instanceof ApiError && (cause.code === "MEMO_ID_RETIRED" || cause.code === "VERSION_CONFLICT");
      if (rotateCreateId) {
        // Keep the draft, but rotate the stable create id so another save can
        // neither resurrects a purge nor overwrites an edited existing memo.
        draftIdRef.current = crypto.randomUUID();
        setError(
          tr(
            "The existing memo was kept. Your draft is safe; save again to create it as a new memo.",
            "现有笔记已保留。草稿仍然安全；再次保存会另建一条笔记。"
          )
        );
        return;
      }
      setError(errorMessage(cause, "Couldn’t save the memo", "保存失败"));
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <div
      className={`editor ${mode === "create" ? "editor-create" : "editor-edit"}${dragDepth > 0 ? " is-dropping" : ""}`}
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
          aria-expanded={suggestion !== null}
          aria-controls={suggestion ? suggestionListId : undefined}
          aria-activedescendant={suggestion ? `${suggestionListId}-option-${suggestion.index}` : undefined}
          value={content}
          placeholder={tr("What’s on your mind…", "现在的想法是……")}
          rows={mode === "create" ? 2 : 3}
          maxLength={HARD_INPUT_CAP}
          readOnly={locked}
          onChange={(event) => {
            if (busy || submittingRef.current) return;
            setContent(event.target.value);
            refreshSuggestion(event.target.value, event.target.selectionStart);
            autoGrow();
          }}
          onScroll={syncOverflowScroll}
          onClick={(event) => refreshSuggestion(content, event.currentTarget.selectionStart)}
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

      {suggestion ? (
        <div id={suggestionListId} className="tag-suggest" role="listbox" aria-label={tr("Tag suggestions", "标签建议")}>
          {suggestion.items.map((tag, index) => (
            <button
              key={tag}
              id={`${suggestionListId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === suggestion.index}
              className={index === suggestion.index ? "is-active" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                applySuggestion(tag);
              }}
              disabled={locked}
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}

      {totalImages > 0 || compressing > 0 ? (
        <div className="editor-attachments">
          {keptExisting.map((image) => (
            <div
              key={image.id}
              className={`attachment${removingKeys.has(image.id) ? " is-removing" : ""}`}
              onAnimationEnd={(event) => {
                if (event.animationName !== "attach-out") return;
                settleRemove(image.id, () => {
                  imageSlots.releaseCommitted();
                  setRemovedIds((value) => [...value, image.id]);
                });
              }}
            >
              <img src={`/api/images/${image.id}`} alt="" decoding="async" />
              <button
                type="button"
                className="attachment-remove"
                aria-label={tr("Remove image", "移除图片")}
                onClick={() => beginRemove(image.id)}
                disabled={locked}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
          {newImages.map((image) => (
            <div
              key={image.previewUrl}
              className={`attachment${removingKeys.has(image.previewUrl) ? " is-removing" : ""}`}
              onAnimationEnd={(event) => {
                if (event.animationName !== "attach-out") return;
                settleRemove(image.previewUrl, () => {
                  imageSlots.releaseCommitted();
                  URL.revokeObjectURL(image.previewUrl);
                  setNewImages((value) => value.filter((item) => item.previewUrl !== image.previewUrl));
                });
              }}
            >
              <img src={image.previewUrl} alt="" decoding="async" />
              <button
                type="button"
                className="attachment-remove"
                aria-label={tr("Remove image", "移除图片")}
                onClick={() => beginRemove(image.previewUrl)}
                disabled={locked}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
          {Array.from({ length: compressing }).map((_, index) => (
            <div key={`busy-${index}`} className="attachment is-busy" aria-label={tr("Compressing image", "压缩图片中")}>
              <Loader2 size={18} className="spin" aria-hidden="true" />
            </div>
          ))}
        </div>
      ) : null}

      <div className={`link-pop${linkOpen ? " is-open" : ""}`} aria-hidden={!linkOpen}>
        <div className="link-pop-inner">
          <Link2 size={14} aria-hidden="true" />
          <input
            ref={linkRef}
            value={linkValue}
            placeholder={tr(
              "Paste an image URL https://… (external preview; uses no storage)",
              "粘贴图片链接 https://…（外链预览，不占用存储）"
            )}
            tabIndex={linkOpen ? 0 : -1}
            disabled={locked}
            onChange={(event) => setLinkValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmLink();
              }
              if (event.key === "Escape") {
                setLinkOpen(false);
                areaRef.current?.focus();
              }
            }}
          />
          <button type="button" className="ghost-button link-pop-add" tabIndex={linkOpen ? 0 : -1} onClick={confirmLink} disabled={locked}>
            {tr("Insert", "插入")}
          </button>
        </div>
      </div>

      {imageLimitExceeded ? (
        <p className="editor-error" role="alert">
          {tr(`Remove images until no more than ${MAX_IMAGES} remain`, `请移除图片，最多保留 ${MAX_IMAGES} 张`)}
        </p>
      ) : error ? (
        <p className="editor-error" role="alert">
          {error}
        </p>
      ) : null}
      {conflictMessage ? (
        <div className="editor-conflict" role="alert">
          <p>{conflictMessage}</p>
          {onAcceptRemoteBase ? (
            <button type="button" className="ghost-button" onClick={onAcceptRemoteBase} disabled={locked}>
              {tr("Keep my draft and continue", "保留草稿并继续")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="editor-bar">
        <div className="editor-tools">
          <button
            type="button"
            className="icon-button"
            onClick={insertHash}
            disabled={locked}
            aria-label={tr("Insert tag", "插入标签")}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Insert tag", "插入标签") })}
            onMouseLeave={tip.hide}
          >
            <Hash size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(toggleWrap(content, area.selectionStart, area.selectionEnd, "**"));
            }}
            aria-label={tr("Bold", "加粗")}
            disabled={locked}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Bold (⌘B)", "加粗（⌘B）") })}
            onMouseLeave={tip.hide}
          >
            <Bold size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(toggleBulletLine(content, area.selectionStart));
            }}
            aria-label={tr("Bullet list", "列表")}
            disabled={locked}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Bullet list", "无序列表") })}
            onMouseLeave={tip.hide}
          >
            <List size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              const area = areaRef.current;
              if (area) applyPatch(insertTableTemplate(content, area.selectionStart, tr("Col 1", "列 1"), tr("Col 2", "列 2")));
            }}
            aria-label={tr("Insert table", "插入表格")}
            disabled={locked}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Insert table", "插入表格") })}
            onMouseLeave={tip.hide}
          >
            <Table size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => fileRef.current?.click()}
            disabled={locked || totalImages + compressing >= MAX_IMAGES}
            aria-label={tr("Add image", "添加图片")}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Add image (or drag and paste)", "添加图片（可拖拽/粘贴）") })}
            onMouseLeave={tip.hide}
          >
            <ImageIcon size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`icon-button${linkOpen ? " is-active-tool" : ""}`}
            onClick={() => {
              setLinkOpen((value) => !value);
              setError(null);
            }}
            aria-label={tr("Insert image link", "插入图片链接")}
            disabled={locked}
            onMouseEnter={(event) => tip.show(event.currentTarget, { text: tr("Insert image link", "插入图片链接") })}
            onMouseLeave={tip.hide}
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
        {effectiveContentLength >= COUNTER_FROM ? (
          <span
            className={`editor-count${overLimit ? " is-over" : ""}`}
            title={overLimit ? tr("Over the memo length limit", "已超出单条笔记字数上限") : undefined}
          >
              {formatNumber(effectiveContentLength)} / {formatNumber(MAX_CONTENT_CHARS)}
          </span>
        ) : null}
          {mode === "edit" && onCancel ? (
            <button type="button" className="ghost-button" onClick={onCancel} disabled={locked}>
              {tr("Cancel", "取消")}
            </button>
          ) : null}
          <button
            type="button"
            className="send-button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            aria-label={mode === "create" ? tr("Send", "发送") : tr("Save", "保存")}
          >
            {locked ? <Loader2 size={17} className="spin" aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
            <span>{mode === "create" ? tr("Send", "发送") : tr("Save", "保存")}</span>
          </button>
        </div>
      </div>

      <div className="editor-drop" aria-hidden="true">
        <ImagePlus size={22} aria-hidden="true" />
        <span>{tr("Release to add images", "松开以添加图片")}</span>
      </div>
    </div>
  );
}
