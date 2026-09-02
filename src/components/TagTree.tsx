import { ChevronRight, Hash, MoreHorizontal, Pencil, Pin, PinOff, Tag, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { TagNode } from "../lib/tags";
import { Menu } from "./Menu";

/** Every path under `node`, depth-first — what a removal takes with it. */
function descendantPaths(node: TagNode): string[] {
  const paths: string[] = [];
  for (const child of node.children) {
    paths.push(child.path, ...descendantPaths(child));
  }
  return paths;
}

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
    // Removal matches the tag and everything under it (tagMatches on the
    // server), so the question names that whole reach — and lists it.
    const below = descendantPaths(node);
    const shown = below.slice(0, 3);
    const more = below.length - shown.length;
    return (
      <>
        <span className="action-menu__prompt" role="presentation">
          {below.length === 0
            ? tr(`Remove #${node.path} from ${count(node.count, "memo")}? The memos stay.`, `从 ${count(node.count, "memo")}中移除 #${node.path}？笔记本身保留`)
            : tr(
                `Remove #${node.path} and the ${count(below.length, "tag")} under it from ${count(node.count, "memo")}? The memos stay.`,
                `从 ${count(node.count, "memo")}中移除 #${node.path} 及其下的 ${count(below.length, "tag")}？笔记本身保留`
              )}
        </span>
        {below.length > 0 ? (
          <span className="action-menu__prompt-detail" role="presentation">
            {shown.map((path) => `#${path}`).join(" · ")}
            {more > 0 ? tr(` · ${more} more`, ` · 还有 ${more} 个`) : null}
          </span>
        ) : null}
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
  /** Subtrees that are open — and the ones still folding shut (mounted, inert). */
  openPaths: ReadonlySet<string>;
  closingPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
}

/** Every ancestor path of a tag: "a/b/c" → ["a", "a/b"]. */
function ancestorsOf(path: string | null): string[] {
  if (!path) return [];
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function TagRow({ node, depth, activeTag, pinnedTags, openPaths, closingPaths, onToggle, onPickTag, onPinTag, onRenameTag, onRemoveTag }: TagRowProps) {
  const { count, formatNumber, tr } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const hasChildren = node.children.length > 0;
  const isActive = activeTag === node.path;
  const expanded = openPaths.has(node.path);
  const closing = closingPaths.has(node.path);
  const pinned = pinnedTags.has(node.path);
  const named = tr(`${node.name}, ${count(node.count, "memo")}`, `${node.name}，${count(node.count, "memo")}`);
  const label = pinned ? tr(`${named}, pinned`, `${named}，已置顶`) : named;

  // Arriving from elsewhere, the row surfaces in the sidebar's own scroll —
  // after the parents' children tracks have finished opening above it.
  useEffect(() => {
    if (!isActive) return;
    const row = rowRef.current;
    if (!row || typeof row.scrollIntoView !== "function") return;
    const timer = window.setTimeout(() => row.scrollIntoView({ block: "nearest" }), 200);
    return () => window.clearTimeout(timer);
  }, [isActive]);

  return (
    <li className="tag-item" data-flip={node.path}>
      <div ref={rowRef} className={`tag-row${isActive ? " is-active" : ""}${pinned ? " is-pinned" : ""}`} style={{ paddingLeft: `${10 + depth * 18}px` }}>
        {hasChildren ? (
          <button
            type="button"
            className={`tag-expand${expanded ? " is-expanded" : ""}`}
            onClick={() => onToggle(node.path)}
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
        {/* Name and count share the button so the blank space beside a short
            name stays a hit target. Named explicitly because the bare digits sit
            flush against the name in the markup — the derived name would come
            out "work2" — and because the pinned state is drawn as a mark in the
            row's margin, which no assistive tech can read. */}
        <button
          type="button"
          className="tag-label"
          aria-pressed={isActive}
          aria-label={label}
          onClick={() => onPickTag(isActive ? null : node.path)}
        >
          <span className="tag-name">{node.name}</span>
          <span className="tag-count">{formatNumber(node.count)}</span>
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
      {/* A folding subtree stays mounted, inert, until its track has closed
          (TagTree's effect removes it); a fresh one unfolds from 0. */}
      {hasChildren && (expanded || closing) ? (
        <div
          className={`tag-children${closing ? " is-closing" : ""}`}
          data-path={node.path}
          ref={(el) => {
            if (el) {
              if (closing) el.setAttribute("inert", "");
              else el.removeAttribute("inert");
            }
          }}
        >
          <ul>
            {node.children.map((child) => (
              <TagRow
                key={child.path}
                node={child}
                depth={depth + 1}
                activeTag={activeTag}
                pinnedTags={pinnedTags}
                openPaths={openPaths}
                closingPaths={closingPaths}
                onToggle={onToggle}
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

const TRACK_EASING = "cubic-bezier(0.22, 0.9, 0.24, 1)";

export function TagTree({ tree, activeTag, pinnedTags, onPickTag, onPinTag, onRenameTag, onRemoveTag }: TagTreeProps) {
  const { tr } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const positionsRef = useRef(new Map<string, number>());

  // Which subtrees are open lives here, not in the rows: a chevron toggle
  // must re-render the whole tree, because the motion below is measured at
  // tree level. (Kept per row, a toggle re-rendered that row alone, nothing
  // was measured, and the next tree-wide render — picking a child — found
  // the rows below still "at" their pre-unfold positions and glided them a
  // second time.) A subtree opens when the lens lands inside it and stays
  // open until folded by hand; folding parks it in `closing` while its track
  // shuts, then the effect below drops it.
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set(ancestorsOf(activeTag)));
  const [closingPaths, setClosingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [seenTag, setSeenTag] = useState(activeTag);
  if (activeTag !== seenTag) {
    // Derived in render, so the subtree opens in the same commit that moves
    // the lens and takes part in that view transition.
    setSeenTag(activeTag);
    const missing = ancestorsOf(activeTag).filter((path) => !openPaths.has(path));
    if (missing.length > 0) {
      setOpenPaths(new Set([...openPaths, ...missing]));
      if (missing.some((path) => closingPaths.has(path))) setClosingPaths(new Set([...closingPaths].filter((path) => !missing.includes(path))));
    }
  }

  const toggle = (path: string) => {
    if (openPaths.has(path)) {
      setOpenPaths(new Set([...openPaths].filter((p) => p !== path)));
      setClosingPaths(new Set([...closingPaths, path]));
    } else {
      setOpenPaths(new Set([...openPaths, path]));
      if (closingPaths.has(path)) setClosingPaths(new Set([...closingPaths].filter((p) => p !== path)));
    }
  };
  const settle = (path: string) => setClosingPaths((current) => (current.has(path) ? new Set([...current].filter((p) => p !== path)) : current));

  // Set while a fold has just finished: that render only removes the closed
  // track, whose space the rows below already took while it shut.
  const settlingRef = useRef(false);

  // Motion, measured at tree level after every render:
  //
  // Subtree tracks unfold and fold as height — a fresh .tag-children grows
  // from 0 to its own height, a closing one shrinks back — and the rows below
  // ride the layout, so nothing there is animated separately. A toggle that
  // reverses a track mid-flight takes over from its current height.
  //
  // FLIP: when the tree re-renders for another reason (pin/unpin reorders
  // siblings), rows glide from their previous position to the new one.
  // Positions are taken relative to the list so sidebar scrolling never fakes
  // a move; nested rows subtract their parent's delta so a moving subtree
  // doesn't double-animate. A render that starts or settles a track skips the
  // glides (the layout is doing the moving) but still records where rows
  // ended up, so the next glide starts from the truth.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canAnimate = !reduced && typeof list.animate === "function";
    // Rows are measured before any track starts moving: this is the layout the
    // tracks animate towards, and what the next glide must start from.
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
    const tracks = [...list.querySelectorAll<HTMLElement>(".tag-children")];
    // Nothing moves on the tree's first appearance (a lens restored inside a
    // subtree shows it open, it doesn't unfold it).
    const firstPass = positionsRef.current.size === 0;
    let trackMoved = settlingRef.current;
    settlingRef.current = false;
    for (const track of tracks) {
      const path = track.dataset.path ?? "";
      const closing = track.classList.contains("is-closing");
      const state = track.dataset.state ?? "";
      if (state === (closing ? "closing" : "open")) continue;
      trackMoved = true;
      track.dataset.state = closing ? "closing" : "open";
      if (firstPass && !closing) continue;
      const running = track.getAnimations().find((animation) => animation.id === "track");
      // Height as currently painted (mid-flight if reversing), before the
      // running animation is cancelled and the track snaps to full height.
      const fromHeight = running ? track.getBoundingClientRect().height : closing ? track.offsetHeight : 0;
      running?.cancel();
      if (!canAnimate) {
        if (closing) {
          settlingRef.current = true;
          settle(path);
        }
        continue;
      }
      const fullHeight = track.offsetHeight;
      const toHeight = closing ? 0 : fullHeight;
      track.style.overflow = "hidden";
      const animation = track.animate(
        [
          { height: `${fromHeight}px`, opacity: closing ? String(Math.max(0.2, fromHeight / Math.max(fullHeight, 1))) : String(fromHeight / Math.max(fullHeight, 1)) },
          { height: `${toHeight}px`, opacity: closing ? 0 : 1 }
        ],
        // fill: both — a closed track must hold at 0 until React removes it,
        // or it springs back to full height for the frame in between (the
        // folded rows flashed over the row below). An opened track's end
        // state is its natural one, so that animation is dropped on finish
        // rather than left pinning the height.
        { id: "track", duration: closing ? 180 : 220, easing: TRACK_EASING, fill: "both" }
      );
      void animation.finished.then(
        () => {
          if (closing) {
            settlingRef.current = true;
            settle(path);
          } else {
            animation.cancel();
            track.style.overflow = "";
          }
        },
        () => undefined
      );
    }

    if (trackMoved || !canAnimate) return;
    for (const row of rows) {
      const parentFlip = row.parentElement?.closest<HTMLElement>("[data-flip]") ?? null;
      const delta = (deltas.get(row) ?? 0) - (parentFlip ? deltas.get(parentFlip) ?? 0 : 0);
      if (Math.abs(delta) > 1) {
        row.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
          id: "flip",
          duration: 220,
          easing: TRACK_EASING
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
              openPaths={openPaths}
              closingPaths={closingPaths}
              onToggle={toggle}
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
