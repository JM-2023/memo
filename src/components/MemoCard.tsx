import { Check, Copy, ImageOff, Link2, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { externalImagesOf } from "../lib/content";
import { formatTime } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { visualLinesOf } from "../lib/lineDiff";
import { wordCountOf } from "../lib/stats";
import type { LightboxItem, Memo, MemoImage, NewImagePayload } from "../lib/types";
import { Editor } from "./Editor";
import { MemoLine } from "./memoLines";
import { MemoStage } from "./MemoStage";
import { Menu } from "./Menu";

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
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (data: { clientId: string; content: string; newImages: NewImagePayload[]; removeImageIds: string[] }) => Promise<boolean>;
  onAcceptEditConflict: () => void;
  onTogglePin: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onPickTag: (path: string) => void;
  onOpenImage: (items: LightboxItem[], index: number) => void;
}

interface MemoMenuBodyProps {
  memo: Memo;
  close: () => void;
  inTrash: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onStartEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
}

/**
 * Menu rows with a two-step delete: the destructive item swaps the menu body
 * for a prompt + confirm/cancel pair instead of raising a modal. The state
 * lives here (the panel unmounts on close), so a reopened menu always starts
 * back at the action list.
 */
function MemoMenuBody({ memo, close, inTrash, pinned, onTogglePin, onStartEdit, onCopy, onDelete, onRestore, onPurge }: MemoMenuBodyProps) {
  const { count, locale, tr } = useI18n();
  const [confirming, setConfirming] = useState(false);

  let actions: ReactNode;
  if (confirming) {
    actions = (
      <>
        <span className="action-menu__prompt" role="presentation">
          {inTrash ? tr("Delete forever? This can’t be undone.", "彻底删除？此操作无法撤销") : tr("Delete this memo?", "删除这条笔记？")}
        </span>
        <button
          type="button"
          role="menuitem"
          className="danger"
          onClick={() => {
            close();
            if (inTrash) onPurge();
            else onDelete();
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {inTrash ? tr("Delete forever", "彻底删除") : tr("Move to Trash", "移入回收站")}
        </button>
        <button type="button" role="menuitem" onClick={() => setConfirming(false)}>
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
            onRestore();
          }}
        >
          <RotateCcw size={16} aria-hidden="true" />
          {tr("Restore", "恢复")}
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
          onClick={() => {
            close();
            onCopy();
          }}
        >
          <Copy size={16} aria-hidden="true" />
          {tr("Copy content", "复制内容")}
        </button>
        <span className="action-menu__sep" />
        <button type="button" role="menuitem" className="danger" onClick={() => setConfirming(true)}>
          <Trash2 size={16} aria-hidden="true" />
          {tr("Delete", "删除")}
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
                {tr("Edited", "编辑于")} {formatTime(memo.updatedAt, locale)}
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

  const externalUrls = useMemo(() => externalImagesOf(memo.content), [memo.content]);
  const lightboxItems = useMemo<LightboxItem[]>(
    () => [
      ...memo.images.map((image) => ({ src: `/api/images/${image.id}` })),
      ...externalUrls.filter((url) => !brokenUrls.has(url)).map((url) => ({ src: url, external: true }))
    ],
    [memo.images, externalUrls, brokenUrls]
  );

  const pinned = Boolean(memo.pinnedAt);
  const inTrash = variant === "trash";
  const mediaCount = memo.images.length + externalUrls.length;
  // Media-set fingerprint for the stage's change detection.
  const mediaKey = useMemo(() => [...memo.images.map((image) => image.id), ...externalUrls].join("|"), [memo.images, externalUrls]);

  function markBroken(url: string) {
    setBrokenUrls((value) => {
      const next = new Set(value);
      next.add(url);
      return next;
    });
  }

  const timeLabel = inTrash
    ? tr(`Deleted ${formatTime(memo.deletedAt ?? memo.createdAt, locale)}`, `删除于 ${formatTime(memo.deletedAt ?? memo.createdAt, locale)}`)
    : formatTime(memo.createdAt, locale);

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
      <div className={`memo-images count-${Math.min(count, 3)}`}>
        {images.map((image) => (
          <div key={image.id} className="memo-image">
            <img src={`/api/images/${image.id}`} alt="" decoding="async" width={image.width || undefined} height={image.height || undefined} />
          </div>
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
          <div className="memo-tool-slot" />
        </div>
      </header>
      <div className="memo-content">
        {visualLinesOf(content).map((line, index, lines) => (
          <MemoLine key={line.key} raw={line.raw} nextRaw={lines[index + 1]?.raw} tagMode={inTrash ? "static" : "ghost"} />
        ))}
      </div>
      {renderGhostMedia(content, images)}
    </>
  );

  const viewBody = (
    <>
      <header className="memo-head">
        <time className="memo-time" dateTime={inTrash ? memo.deletedAt ?? memo.createdAt : memo.createdAt}>
          {timeLabel}
        </time>
        <div className="memo-head-right">
          {pinned && !inTrash ? <Pin size={13} className="memo-pin-mark" aria-label={tr("Pinned", "已置顶")} /> : null}
          {/* The ⋯ menu and the select ring share one 26px cell: entering
              select mode swaps them in place with zero layout shift. */}
          <div className="memo-tool-slot">
            <Menu
              panelClassName="memo-action-menu"
              trigger={(open) => (
                <button
                  type="button"
                  className={`icon-button memo-menu-trigger${open ? " is-open" : ""}`}
                  aria-label={tr("Memo actions", "操作菜单")}
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
                  onTogglePin={props.onTogglePin}
                  onStartEdit={props.onStartEdit}
                  onCopy={props.onCopy}
                  onDelete={props.onDelete}
                  onRestore={props.onRestore}
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

      <div className="memo-content">
        {visualLinesOf(memo.content).map((line, index, lines) => (
          <MemoLine
            key={line.key}
            raw={line.raw}
            nextRaw={lines[index + 1]?.raw}
            tagMode={inTrash ? "static" : "button"}
            onPickTag={props.onPickTag}
          />
        ))}
      </div>

      {mediaCount > 0 ? (
        <div className={`memo-images count-${Math.min(mediaCount, 3)}`}>
          {memo.images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              className="memo-image"
              onClick={() => props.onOpenImage(lightboxItems, index)}
              aria-label={tr("View image", "查看图片")}
            >
              <img
                src={`/api/images/${image.id}`}
                alt=""
                loading="lazy"
                decoding="async"
                width={image.width || undefined}
                height={image.height || undefined}
              />
            </button>
          ))}
          {externalUrls.map((url) =>
            brokenUrls.has(url) ? (
              <a key={url} className="memo-image-broken" href={url} target="_blank" rel="noreferrer noopener" title={url}>
                <ImageOff size={16} aria-hidden="true" />
                <span>{tr("Image link is unavailable", "图片链接已失效")}</span>
              </a>
            ) : (
              <button
                key={url}
                type="button"
                className="memo-image is-external"
                onClick={() => props.onOpenImage(lightboxItems, Math.max(0, lightboxItems.findIndex((item) => item.src === url)))}
                aria-label={tr("View external image", "查看外链图片")}
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
