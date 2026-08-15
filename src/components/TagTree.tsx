import { ChevronRight, Hash, MoreHorizontal, Pencil, Pin, PinOff, Tag, Trash2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { TagNode } from "../lib/tags";
import { Menu } from "./Menu";

interface TagMenuBodyProps {
  close: () => void;
  node: TagNode;
  pinned: boolean;
  onPinTag: (path: string, pinned: boolean) => void;
  onRenameTag: (path: string) => void;
  onRemoveTag: (path: string) => void;
}

/**
 * Tag menu rows with a two-step removal: "Remove tag" swaps the menu body for
 * a prompt naming the blast radius plus confirm/cancel — no modal. State
 * resets with the panel (it unmounts on close).
 */
function TagMenuBody({ close, node, pinned, onPinTag, onRenameTag, onRemoveTag }: TagMenuBodyProps) {
  const { count, tr } = useI18n();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <>
        <span className="action-menu__prompt" role="presentation">
          {tr(`Remove #${node.path} from ${count(node.count, "memo")}? The memos stay.`, `从 ${count(node.count, "memo")}中移除 #${node.path}？笔记本身保留`)}
        </span>
        <button
          type="button"
          role="menuitem"
          className="danger"
          onClick={() => {
            close();
            onRemoveTag(node.path);
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {tr("Remove tag", "移除标签")}
        </button>
        <button type="button" role="menuitem" onClick={() => setConfirming(false)}>
          <X size={16} aria-hidden="true" />
          {tr("Cancel", "取消")}
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
          onPinTag(node.path, !pinned);
        }}
      >
        {pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
        {pinned ? tr("Unpin", "取消置顶") : tr("Pin tag", "置顶标签")}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          close();
          onRenameTag(node.path);
        }}
      >
        <Pencil size={16} aria-hidden="true" />
        {tr("Rename", "重命名")}
      </button>
      <span className="action-menu__sep" />
      <button type="button" role="menuitem" className="danger" onClick={() => setConfirming(true)}>
        <Trash2 size={16} aria-hidden="true" />
        {tr("Remove tag", "移除标签")}
      </button>
    </>
  );
}

interface TagCallbacks {
  onPickTag: (path: string | null) => void;
  onPinTag: (path: string, pinned: boolean) => void;
  onRenameTag: (path: string) => void;
  onRemoveTag: (path: string) => void;
}

interface TagTreeProps extends TagCallbacks {
  tree: TagNode[];
  activeTag: string | null;
  /** path → pinnedAt for pinned tags (drives the pin mark + menu labels). */
  pinnedTags: Map<string, string>;
}

interface TagRowProps extends TagCallbacks {
  node: TagNode;
  depth: number;
  activeTag: string | null;
  pinnedTags: Map<string, string>;
}

function TagRow({ node, depth, activeTag, pinnedTags, onPickTag, onPinTag, onRenameTag, onRemoveTag }: TagRowProps) {
  const { count, formatNumber, tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  const isActive = activeTag === node.path;
  const pinned = pinnedTags.has(node.path);

  return (
    <li className="tag-item" data-flip={node.path}>
      <div className={`tag-row${isActive ? " is-active" : ""}`} style={{ paddingLeft: `${8 + depth * 18}px` }}>
        {hasChildren ? (
          <button
            type="button"
            className={`tag-expand${expanded ? " is-expanded" : ""}`}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={
              expanded ? tr(`Collapse tag ${node.path}`, `收起标签 ${node.path}`) : tr(`Expand tag ${node.path}`, `展开标签 ${node.path}`)
            }
          >
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        ) : (
          <span className="tag-expand-spacer">
            <Hash size={12} aria-hidden="true" />
          </span>
        )}
        {/* Name, pin mark and count live inside the button: the count trails the
            name as one unit instead of being flung to the far edge of a sidebar
            that can be 392px wide, while the button still spans the row so the
            empty space to its right stays a hit target. */}
        {/* Named explicitly: the bare digits sit flush against the name in the
            markup, so the derived name would come out "work2". */}
        <button
          type="button"
          className="tag-label"
          aria-pressed={isActive}
          aria-label={tr(`${node.name}, ${count(node.count, "memo")}`, `${node.name}，${count(node.count, "memo")}`)}
          onClick={() => onPickTag(isActive ? null : node.path)}
        >
          <span className="tag-name">{node.name}</span>
          <span className="tag-count">{formatNumber(node.count)}</span>
          {pinned ? <Pin size={12} className="tag-pin-mark" aria-label={tr("Pinned", "已置顶")} /> : null}
        </button>
        <Menu
          portal
          align="right"
          trigger={(open) => (
            <button
              type="button"
              className={`tag-more${open ? " is-open" : ""}`}
              aria-label={tr(`Actions for tag ${node.path}`, `标签 ${node.path} 的操作`)}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          )}
        >
          {(close) => (
            <TagMenuBody
              close={close}
              node={node}
              pinned={pinned}
              onPinTag={onPinTag}
              onRenameTag={onRenameTag}
              onRemoveTag={onRemoveTag}
            />
          )}
        </Menu>
      </div>
      {hasChildren && expanded ? (
        <div className="tag-children is-open">
          <ul>
            {node.children.map((child) => (
              <TagRow
                key={child.path}
                node={child}
                depth={depth + 1}
                activeTag={activeTag}
                pinnedTags={pinnedTags}
                onPickTag={onPickTag}
                onPinTag={onPinTag}
                onRenameTag={onRenameTag}
                onRemoveTag={onRemoveTag}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

export function TagTree({ tree, activeTag, pinnedTags, onPickTag, onPinTag, onRenameTag, onRemoveTag }: TagTreeProps) {
  const { tr } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const positionsRef = useRef(new Map<string, number>());

  // FLIP: whenever the tree re-renders (pin/unpin reorders siblings), rows
  // glide from their previous position to the new one. Positions are taken
  // relative to the list so sidebar scrolling never fakes a move; nested rows
  // subtract their parent's delta so a moving subtree doesn't double-animate.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-flip]")];
    const listTop = list.getBoundingClientRect().top;
    for (const row of rows) {
      for (const animation of row.getAnimations()) {
        if (animation.id === "flip") animation.cancel();
      }
    }
    const previous = positionsRef.current;
    const next = new Map<string, number>();
    const deltas = new Map<HTMLElement, number>();
    for (const row of rows) {
      const key = row.dataset.flip ?? "";
      const top = row.getBoundingClientRect().top - listTop;
      next.set(key, top);
      const before = previous.get(key);
      deltas.set(row, before === undefined ? 0 : before - top);
    }
    positionsRef.current = next;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const row of rows) {
      const parentFlip = row.parentElement?.closest<HTMLElement>("[data-flip]") ?? null;
      const delta = (deltas.get(row) ?? 0) - (parentFlip ? deltas.get(parentFlip) ?? 0 : 0);
      if (Math.abs(delta) > 1) {
        row.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
          id: "flip",
          duration: 220,
          easing: "cubic-bezier(0.22, 0.9, 0.24, 1)"
        });
      }
    }
  });

  return (
    <div className="tag-section">
      <div className="tag-section-head">
        <Tag size={13} aria-hidden="true" />
        <span>{tr("All tags", "全部标签")}</span>
      </div>
      {tree.length === 0 ? (
        <p className="tag-empty">{tr("Type #tag in a memo to create one", "在笔记里输入 #标签 即可创建")}</p>
      ) : (
        <ul className="tag-list" ref={listRef}>
          {tree.map((node) => (
            <TagRow
              key={node.path}
              node={node}
              depth={0}
              activeTag={activeTag}
              pinnedTags={pinnedTags}
              onPickTag={onPickTag}
              onPinTag={onPinTag}
              onRenameTag={onRenameTag}
              onRemoveTag={onRemoveTag}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
