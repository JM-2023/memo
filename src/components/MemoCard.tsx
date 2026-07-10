import { Check, Copy, ImageOff, Link2, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Trash2, X } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { externalImagesOf, tokenizeLine } from "../lib/content";
import { formatTime } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import type { LightboxItem, Memo, NewImagePayload } from "../lib/types";
import { Editor } from "./Editor";
import { Menu } from "./Menu";

function renderLine(line: string, key: number, interactive: boolean, onPickTag: (path: string) => void): ReactNode {
  if (!line) return <p key={key} className="memo-blank" />;
  const tokens = tokenizeLine(line);
  // Image tokens leave the text flow (they render in the media grid); a line
  // that was only an image link collapses entirely.
  const visible = tokens.filter((token) => token.kind !== "image");
  if (visible.every((token) => token.kind === "text" && token.text.trim() === "")) {
    return tokens.length === visible.length ? <p key={key} className="memo-blank" /> : null;
  }
  return (
    <p key={key}>
      {visible.map((token, index) => {
        if (token.kind === "tag") {
          return interactive ? (
            <button key={index} type="button" className="memo-tag" onClick={() => onPickTag(token.path)}>
              {token.raw}
            </button>
          ) : (
            <span key={index} className="memo-tag is-static">
              {token.raw}
            </span>
          );
        }
        if (token.kind === "link") {
          return (
            <a key={index} href={token.url} target="_blank" rel="noreferrer noopener">
              {token.url}
            </a>
          );
        }
        return <Fragment key={index}>{token.kind === "text" ? token.text : null}</Fragment>;
      })}
    </p>
  );
}

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
function MemoMenuBody({ close, inTrash, pinned, onTogglePin, onStartEdit, onCopy, onDelete, onRestore, onPurge }: MemoMenuBodyProps) {
  const { tr } = useI18n();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
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
  }

  if (inTrash) {
    return (
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
  }

  return (
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

  function markBroken(url: string) {
    setBrokenUrls((value) => {
      const next = new Set(value);
      next.add(url);
      return next;
    });
  }

  return (
    <article
      className={`memo-card${pinned && !inTrash ? " is-pinned" : ""}${inTrash ? " is-trash" : ""}${selecting ? " is-selecting" : ""}${
        selected ? " is-selected" : ""
      }`}
    >
      {editing ? (
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
      ) : (
        <>
          <header className="memo-head">
            <time className="memo-time" dateTime={inTrash ? memo.deletedAt ?? memo.createdAt : memo.createdAt}>
              {inTrash
                ? tr(
                    `Deleted ${formatTime(memo.deletedAt ?? memo.createdAt, locale)}`,
                    `删除于 ${formatTime(memo.deletedAt ?? memo.createdAt, locale)}`
                  )
                : formatTime(memo.createdAt, locale)}
            </time>
            <div className="memo-head-right">
              {pinned && !inTrash ? <Pin size={13} className="memo-pin-mark" aria-label={tr("Pinned", "已置顶")} /> : null}
              {/* The ⋯ menu and the select ring share one 26px cell: entering
                  select mode swaps them in place with zero layout shift. */}
              <div className="memo-tool-slot">
                <Menu
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

          <div className="memo-content">{memo.content.split("\n").map((line, index) => renderLine(line, index, !inTrash, props.onPickTag))}</div>

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
      )}
    </article>
  );
}
