import { Check, Copy, ImageOff, Link2, ListChecks, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Share, Tags, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { externalImagesOf } from "../lib/content";
import { formatCardTime } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { mediaGridProps } from "../lib/imageLayout";
import { visualLinesOf } from "../lib/lineDiff";
import { wordCountOf } from "../lib/stats";
import type { LightboxItem, Memo, MemoImage, NewImagePayload } from "../lib/types";
import { Editor, type EditDraft } from "./Editor";
import { MemoFold, mightFold } from "./MemoFold";
import { MemoLine } from "./memoLines";
import { MemoStage } from "./MemoStage";
import { Menu } from "./Menu";
import { StoredImageButton, StoredImageFrame } from "./StoredImage";

interface MemoCardProps {
  memo: Memo;
  variant: "normal" | "trash";
  knownTags: string[];
  editing: boolean;
  savingEdit: boolean;
  editConflict: boolean;
  /** Multi-select mode: the whole card becomes a toggle, actions retire. */
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  /** Enter select mode with this card picked; absent where a view has none. */
  onSelect?: () => void;
  onStartEdit: () => void;
  /** `draft` carries a dirty edit for the Undo on its "Discarded" toast. */
  onCancelEdit: (draft: EditDraft | null) => void;
  /** A discarded draft being reopened by that Undo. */
  editDraft?: EditDraft | null;
  onSaveEdit: (data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  onAcceptEditConflict: () => void;
  onTogglePin: () => void;
  onAddTag: () => void;
  onCopy: () => void;
  onShare: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onPickTag: (path: string) => void;
  onOpenImage: (items: LightboxItem[], index: number) => void;
  /** Feed checkbox click; lineKey indexes memo.content.split("\n"). */
  onToggleTask: (lineKey: number, checked: boolean) => void;
  /** Optimistic per-line checkbox states while toggles are in flight. */
  pendingTaskFlips?: ReadonlyMap<number, boolean>;
  /** Text an edit resumes with after a re-login, instead of memo.content. */
  resumeContent?: string;
  /** The open editor's text after each change (held in memory only). */
  onEditDraftChange?: (content: string) => void;
  /** A pin / trash / restore for this memo is in flight (already shown
      optimistically): those actions hold until it settles. */
  busy?: boolean;
}

interface MemoMenuBodyProps {
  memo: Memo;
  close: () => void;
  inTrash: boolean;
  pinned: boolean;
  busy: boolean;
  onTogglePin: () => void;
  onStartEdit: () => void;
  onAddTag: () => void;
  onCopy: () => void;
  onShare: () => void;
  onSelect?: () => void;
  onDelete: () => void;
  onPurge: () => void;
}

/**
 * Menu rows. Moving to Trash is one step — its toast carries Undo — so only
 * the permanent delete inside Trash keeps a confirmation: that item swaps the
 * menu body for a prompt + confirm/cancel pair instead of raising a modal.
 * The state lives here (the panel unmounts on close), so a reopened menu
 * always starts back at the action list. Restore lives on the trash card
 * itself, not in here.
 */
function MemoMenuBody({ memo, close, inTrash, pinned, busy, onTogglePin, onStartEdit, onAddTag, onCopy, onShare, onSelect, onDelete, onPurge }: MemoMenuBodyProps) {
  const { count, locale, tr } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const promptId = useId();

  let actions: ReactNode;
  if (confirming) {
    // The prompt is the confirm item's description, so a screen reader
    // hears "can't be undone" along with the button itself. Focus starts on
    // Cancel (data-menu-autofocus): a reflexive second Enter backs out.
    actions = (
      <>
        <span id={promptId} className="action-menu__prompt">
          {tr("Delete forever? This can’t be undone.", "彻底删除？此操作无法撤销")}
        </span>
        <button
          type="button"
          role="menuitem"
          className="danger"
          aria-describedby={promptId}
          onClick={() => {
            close();
            onPurge();
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {tr("Delete forever", "彻底删除")}
        </button>
        <button type="button" role="menuitem" data-menu-autofocus="" onClick={() => setConfirming(false)}>
          <X size={16} aria-hidden="true" />
          {tr("Cancel", "取消")}
        </button>
      </>
    );
  } else if (inTrash) {
    actions = (
      <>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onCopy();
          }}
        >
          <Copy size={16} aria-hidden="true" />
          {tr("Copy content", "复制内容")}
        </button>
        {onSelect ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onSelect();
            }}
          >
            <ListChecks size={16} aria-hidden="true" />
            {tr("Select", "多选")}
          </button>
        ) : null}
        <span className="action-menu__sep" />
        <button type="button" role="menuitem" className="danger" onClick={() => setConfirming(true)}>
          <Trash2 size={16} aria-hidden="true" />
          {tr("Delete permanently", "彻底删除")}
        </button>
      </>
    );
  } else {
    actions = (
      <>
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            close();
            onTogglePin();
          }}
        >
          {pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
          {pinned ? tr("Unpin", "取消置顶") : tr("Pin", "置顶")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onStartEdit();
          }}
        >
          <Pencil size={16} aria-hidden="true" />
          {tr("Edit", "编辑")}
        </button>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="dialog"
          onClick={() => {
            close();
            onAddTag();
          }}
        >
          <Tags size={16} aria-hidden="true" />
          {tr("Add tag", "添加标签")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onCopy();
          }}
        >
          <Copy size={16} aria-hidden="true" />
          {tr("Copy content", "复制内容")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onShare();
          }}
        >
          <Share size={16} aria-hidden="true" />
          {tr("Share as image", "分享为图片")}
        </button>
        {onSelect ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onSelect();
            }}
          >
            <ListChecks size={16} aria-hidden="true" />
            {tr("Select", "多选")}
          </button>
        ) : null}
        <span className="action-menu__sep" />
        <button
          type="button"
          role="menuitem"
          className="danger"
          disabled={busy}
          onClick={() => {
            close();
            onDelete();
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {tr("Move to Trash", "移入回收站")}
        </button>
      </>
    );
  }

  return (
    <>
      {actions}
      {/* The confirm swap takes over the whole panel; a meta footer under a
          destructive prompt just competes with it, so it retires while
          confirming. */}
      {!confirming ? (
        <>
          <span className="action-menu__sep" role="separator" />
          <div className="memo-menu-meta" role="presentation">
            <span>{count(wordCountOf(memo), "character")}</span>
            {/* updatedAt equals createdAt until the first real edit — only then
                is an "Edited" time worth showing (the card already carries the
                send time). */}
            {memo.updatedAt !== memo.createdAt ? (
              <time dateTime={memo.updatedAt}>
                {tr("Edited", "编辑于")} {formatCardTime(memo.updatedAt, locale)}
              </time>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

export function MemoCard(props: MemoCardProps) {
  const { locale, tr } = useI18n();
  const { memo, variant, editing, selecting, selected } = props;
  // External links that failed to load render as a compact fallback chip.
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(new Set());
  const viewSurfaceRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const previousEditingRef = useRef(editing);
  // Where a double-click asked the editor to put its caret; null = the end.
  const editCaretRef = useRef<{ offset: number; viewportY: number } | null>(null);
  // Long bodies fold to a fixed height; this card's reader can unfold it.
  const [expanded, setExpanded] = useState(false);
  const foldId = useId();

  // One stable task callback for every row (rows pass their own lineKey), so
  // memoized MemoLines don't re-render just because the card did.
  const onToggleTaskRef = useRef(props.onToggleTask);
  onToggleTaskRef.current = props.onToggleTask;
  const toggleTask = useCallback((lineKey: number, checked: boolean) => onToggleTaskRef.current(lineKey, checked), []);

  // The select overlay is the card's only control in selection mode. `inert`
  // keeps the covered tag/image/link controls out of keyboard navigation,
  // while aria-hidden removes the duplicate surface from virtual cursors.
  useLayoutEffect(() => {
    if (viewSurfaceRef.current) viewSurfaceRef.current.inert = selecting;
  }, [selecting]);

  // Cancel/save unmounts the focused editor. Once the steady card surface has
  // committed, return focus to its action trigger instead of letting it fall
  // back to <body> and restart the page's tab order.
  useEffect(() => {
    const wasEditing = previousEditingRef.current;
    previousEditingRef.current = editing;
    if (!wasEditing || editing) return;
    // MemoStage deliberately keeps the outgoing editor connected during its
    // exit morph, so connectivity cannot be used as a focus-restoration guard.
    const frame = window.requestAnimationFrame(() => menuTriggerRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  const externalUrls = useMemo(() => externalImagesOf(memo.content), [memo.content]);
  const lightboxItems = useMemo<LightboxItem[]>(
    () => [
      // The id lets the viewer draw the copy the tile already holds.
      ...memo.images.map((image) => ({ src: `/api/images/${image.id}`, imageId: image.id })),
      ...externalUrls.filter((url) => !brokenUrls.has(url)).map((url) => ({ src: url, external: true }))
    ],
    [memo.images, externalUrls, brokenUrls]
  );

  const lines = useMemo(() => visualLinesOf(memo.content), [memo.content]);
  const foldable = useMemo(() => mightFold(memo.content), [memo.content]);
  const pinned = Boolean(memo.pinnedAt);
  const inTrash = variant === "trash";
  const busy = Boolean(props.busy);
  const mediaCount = memo.images.length + externalUrls.length;
  // Media-set fingerprint for the stage's change detection.
  const mediaKey = useMemo(() => [...memo.images.map((image) => image.id), ...externalUrls].join("|"), [memo.images, externalUrls]);

  function startEditFromDoubleClick(target: EventTarget, clientY: number) {
    if (editing || selecting || inTrash) return;

    // Preserve the behavior of controls embedded in a memo. A double-click on
    // a tag, link, image or action button belongs to that control, and one
    // inside a code or formula block selects a word (a triple-click, a line)
    // to copy; the card's otherwise inert surface is the shortcut for
    // entering edit mode.
    if (target instanceof Element && target.closest("button, a, input, textarea, select, [contenteditable], .md-codeblock, .md-math-block")) return;

    editCaretRef.current = caretFromDoubleClick(target, clientY);
    props.onStartEdit();
  }

  /**
   * Map a double-click on the rendered text back to a source offset, so the
   * editor opens with its caret on that line: after the clicked word when
   * the browser's word selection can be found in the source line, else at
   * the line's end. Rows in .memo-content are 1:1 with visualLinesOf (see
   * lib/lineDiff), whose keys index content.split("\n").
   */
  function caretFromDoubleClick(target: EventTarget, clientY: number): { offset: number; viewportY: number } | null {
    const container = target instanceof Element ? target.closest(".memo-content") : null;
    let row = target instanceof Element ? target : null;
    while (row && row.parentElement !== container) row = row.parentElement;
    if (!container || !row) return null;
    const line = visualLinesOf(memo.content)[Array.prototype.indexOf.call(container.children, row)];
    if (!line) return null;
    let lineStart = 0;
    for (let k = 0; k < line.key; k++) lineStart = memo.content.indexOf("\n", lineStart) + 1;
    // line.raw is display text (references resolved, "| " added to unbordered
    // table rows); measure on the row's own source lines instead. Only fenced
    // code and math rows span more than one.
    const source = memo.content
      .split("\n")
      .slice(line.key, line.key + line.raw.split("\n").length)
      .join("\n");
    let offset = lineStart + source.length;
    const selection = window.getSelection();
    const word = selection?.toString().trim() ?? "";
    if (selection && selection.rangeCount > 0 && word && !word.includes("\n")) {
      const picked = selection.getRangeAt(0);
      if (row.contains(picked.startContainer)) {
        const before = document.createRange();
        before.setStart(row, 0);
        before.setEnd(picked.startContainer, picked.startOffset);
        // Markers and hidden syntax make the source longer than the text:
        // pick the occurrence nearest the same relative spot.
        const rowLength = row.textContent?.length ?? 0;
        const expected = rowLength > 0 ? (before.toString().length / rowLength) * source.length : 0;
        let best = -1;
        for (let at = source.indexOf(word); at !== -1; at = source.indexOf(word, at + 1)) {
          if (best === -1 || Math.abs(at - expected) < Math.abs(best - expected)) best = at;
        }
        if (best !== -1) offset = lineStart + best + word.length;
      }
    }
    return { offset: Math.min(offset, memo.content.length), viewportY: clientY };
  }

  function markBroken(url: string) {
    setBrokenUrls((value) => {
      const next = new Set(value);
      next.add(url);
      return next;
    });
  }

  // In Trash the stamp is the deletion time, and the state is said in words
  // and weight ("Deleted" at 600) rather than in alarm red.
  const stamp = formatCardTime(inTrash ? memo.deletedAt ?? memo.createdAt : memo.createdAt, locale);
  const timeLabel = inTrash ? (
    <>
      <span className="memo-time-state">{tr("Deleted", "删除于")}</span> {stamp}
    </>
  ) : (
    stamp
  );
  // Each card's controls are told apart by its time — 80 identical "Memo
  // actions" buttons give a screen-reader user nothing to choose by.
  const menuLabel = inTrash ? tr(`Memo actions, deleted ${stamp}`, `笔记操作，删除于 ${stamp}`) : tr(`Memo actions, ${stamp}`, `笔记操作，${stamp}`);

  const renderBody = (content: string, contentLines: ReturnType<typeof visualLinesOf>, live: boolean) => {
    const body = (
      <div className="memo-content">
        {contentLines.map((line, index, all) =>
          live ? (
            <MemoLine
              key={line.key}
              raw={line.raw}
              nextRaw={all[index + 1]?.raw}
              tagMode={inTrash ? "static" : "button"}
              onPickTag={props.onPickTag}
              lineKey={line.key}
              onToggleTask={toggleTask}
              taskCheckedOverride={props.pendingTaskFlips?.get(line.key)}
            />
          ) : (
            <MemoLine key={line.key} raw={line.raw} nextRaw={all[index + 1]?.raw} tagMode={inTrash ? "static" : "ghost"} />
          )
        )}
      </div>
    );
    if (!(live ? foldable : mightFold(content))) return body;
    return (
      <MemoFold content={content} expanded={expanded} onExpandedChange={live ? setExpanded : undefined} regionId={live ? foldId : undefined}>
        {body}
      </MemoFold>
    );
  };

  // Inert clone of one content line — replay overlay + ghost measure layer.
  // Tags keep their live look (ghosts must be pixel-identical to the card).
  const renderGhostLine = (raw: string, nextRaw?: string) => (
    <MemoLine raw={raw} nextRaw={nextRaw} tagMode={inTrash ? "static" : "ghost"} />
  );

  // Inert media grid of an arbitrary (content, images) state — same classes
  // as the live grid so geometry and paint match exactly.
  const renderGhostMedia = (content: string, images: MemoImage[]) => {
    const urls = externalImagesOf(content);
    const count = images.length + urls.length;
    if (count === 0) return null;
    return (
      <div {...mediaGridProps(count, images[0])}>
        {images.map((image) => (
          <StoredImageFrame key={image.id} image={image} sizing={count === 1 ? "auto" : "thumb"} />
        ))}
        {urls.map((url) =>
          brokenUrls.has(url) ? (
            <div key={url} className="memo-image-broken">
              <ImageOff size={16} aria-hidden="true" />
              <span>{tr("Image link is unavailable", "图片链接已失效")}</span>
            </div>
          ) : (
            <div key={url} className="memo-image is-external">
              <img src={url} alt="" decoding="async" referrerPolicy="no-referrer" />
              <span className="ext-badge" aria-hidden="true">
                <Link2 size={11} />
              </span>
            </div>
          )
        )}
      </div>
    );
  };

  const renderGhost = (content: string, images: MemoImage[]) => (
    <>
      <header className="memo-head">
        <time className="memo-time">{timeLabel}</time>
        <div className="memo-head-right">
          {inTrash ? (
            <span className="memo-restore">
              <RotateCcw size={13} aria-hidden="true" />
              {tr("Restore", "恢复")}
            </span>
          ) : null}
          <div className="memo-tool-slot" />
        </div>
      </header>
      {renderBody(content, visualLinesOf(content), false)}
      {renderGhostMedia(content, images)}
    </>
  );

  const viewBody = (
    <>
      <div ref={viewSurfaceRef} className="memo-view-surface" aria-hidden={selecting || undefined}>
        <header className="memo-head">
          <time className="memo-time" dateTime={inTrash ? memo.deletedAt ?? memo.createdAt : memo.createdAt}>
            {timeLabel}
          </time>
          <div className="memo-head-right">
            {pinned && !inTrash ? <Pin size={13} className="memo-pin-mark" aria-label={tr("Pinned", "已置顶")} /> : null}
            {/* Restore is the one thing a trashed memo is for: it sits on the
                card, always visible, instead of behind a hover-only ⋯. */}
            {inTrash ? (
              <button
                type="button"
                className="memo-restore"
                disabled={busy}
                tabIndex={selecting ? -1 : undefined}
                aria-label={tr(`Restore memo deleted ${stamp}`, `恢复删除于 ${stamp} 的笔记`)}
                onClick={props.onRestore}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {tr("Restore", "恢复")}
              </button>
            ) : null}
            {/* The ⋯ menu and the select ring share one 26px cell: entering
                select mode swaps them in place with zero layout shift. */}
            <div className="memo-tool-slot">
              <Menu
                panelClassName="memo-action-menu"
                trigger={(open, triggerProps) => (
                  <button
                    ref={menuTriggerRef}
                    type="button"
                    {...triggerProps}
                    className={`icon-button memo-menu-trigger${open ? " is-open" : ""}`}
                    aria-label={menuLabel}
                    tabIndex={selecting ? -1 : 0}
                  >
                    <MoreHorizontal size={17} aria-hidden="true" />
                  </button>
                )}
              >
                {(close) => (
                  <MemoMenuBody
                    memo={memo}
                    close={close}
                    inTrash={inTrash}
                    pinned={pinned}
                    busy={busy}
                    onTogglePin={props.onTogglePin}
                    onStartEdit={() => {
                      editCaretRef.current = null;
                      props.onStartEdit();
                    }}
                    onAddTag={props.onAddTag}
                    onCopy={props.onCopy}
                    onShare={props.onShare}
                    onSelect={props.onSelect}
                    onDelete={props.onDelete}
                    onPurge={props.onPurge}
                  />
                )}
              </Menu>
              <span className="memo-select-box" aria-hidden="true">
                <Check size={13} strokeWidth={3.2} />
              </span>
            </div>
          </div>
        </header>

        {/* Tags stay live buttons while selecting: the surface is inert then,
            and CSS dims them — re-rendering every row as static pills made
            entering select mode re-parse the whole mounted feed. */}
        {renderBody(memo.content, lines, true)}

        {mediaCount > 0 ? (
          <div {...mediaGridProps(mediaCount, memo.images[0])}>
            {memo.images.map((image, index) => (
              <StoredImageButton
                key={image.id}
                image={image}
                sizing={mediaCount === 1 ? "auto" : "thumb"}
                tabIndex={selecting ? -1 : undefined}
                lightboxIndex={index}
                onOpen={() => props.onOpenImage(lightboxItems, index)}
                label={mediaCount > 1 ? tr(`View image ${index + 1} of ${mediaCount}`, `查看图片 ${index + 1}/${mediaCount}`) : tr("View image", "查看图片")}
              />
            ))}
            {externalUrls.map((url, urlIndex) =>
              brokenUrls.has(url) ? (
                <a
                  key={url}
                  className="memo-image-broken"
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={url}
                  tabIndex={selecting ? -1 : undefined}
                >
                  <ImageOff size={16} aria-hidden="true" />
                  <span>{tr("Image link is unavailable", "图片链接已失效")}</span>
                </a>
              ) : (
                <button
                  key={url}
                  type="button"
                  className="memo-image is-external"
                  tabIndex={selecting ? -1 : undefined}
                  data-lightbox-index={lightboxItems.findIndex((item) => item.src === url)}
                  onClick={() => props.onOpenImage(lightboxItems, Math.max(0, lightboxItems.findIndex((item) => item.src === url)))}
                  aria-label={
                    mediaCount > 1
                      ? tr(
                          `View external image ${memo.images.length + urlIndex + 1} of ${mediaCount}`,
                          `查看外链图片 ${memo.images.length + urlIndex + 1}/${mediaCount}`
                        )
                      : tr("View external image", "查看外链图片")
                  }
                >
                  <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => markBroken(url)} />
                  <span className="ext-badge" aria-hidden="true">
                    <Link2 size={11} />
                  </span>
                </button>
              )
            )}
          </div>
        ) : null}
      </div>

      {selecting ? (
        // One interactive surface for the whole card: it sits above every
        // inner control (tags, images, the retired ⋯ menu), so a tap
        // anywhere toggles selection and nothing else can fire.
        <button
          type="button"
          className="memo-select-overlay"
          aria-pressed={selected}
          aria-label={selected ? tr("Deselect this memo", "取消选择这条笔记") : tr("Select this memo", "选择这条笔记")}
          onClick={props.onToggleSelect}
        />
      ) : null}
    </>
  );

  return (
    <article
      className={`memo-card${pinned && !inTrash ? " is-pinned" : ""}${inTrash ? " is-trash" : ""}${selecting ? " is-selecting" : ""}${
        selected ? " is-selected" : ""
      }`}
      onDoubleClick={(event) => startEditFromDoubleClick(event.target, event.clientY)}
    >
      <MemoStage
        editing={editing}
        content={memo.content}
        mediaKey={mediaKey}
        images={memo.images}
        view={viewBody}
        editor={
          editing ? (
            <Editor
              mode="edit"
              initialContent={memo.content}
              onDraftChange={props.onEditDraftChange}
              existingImages={memo.images}
              knownTags={props.knownTags}
              busy={props.savingEdit}
              conflictMessage={
                props.editConflict
                  ? tr(
                      "This memo changed elsewhere. Your draft is preserved. Continue only if you intend to save it over the latest version.",
                      "这条笔记已在别处更新。你的草稿已保留；确认要基于最新版本继续后，再次保存会覆盖远端内容。"
                    )
                  : null
              }
              onAcceptRemoteBase={props.onAcceptEditConflict}
              onSubmit={props.onSaveEdit}
              onCancel={props.onCancelEdit}
              initialDraft={
                props.editDraft ??
                (props.resumeContent !== undefined
                  ? {
                      content: props.resumeContent,
                      newImages: [],
                      removedIds: [],
                      selectionStart: props.resumeContent.length,
                      selectionEnd: props.resumeContent.length
                    }
                  : null)
              }
              initialCaret={editCaretRef.current}
              autoFocus
            />
          ) : null
        }
        renderGhost={renderGhost}
        renderGhostMedia={renderGhostMedia}
        renderLine={renderGhostLine}
      />
    </article>
  );
}
