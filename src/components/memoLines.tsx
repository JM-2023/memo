import { Fragment, type CSSProperties, type ReactNode } from "react";
import { tokenizeLine } from "../lib/content";
import { useI18n } from "../lib/i18n";
import { parseBlock, parseInline, type Inline } from "../lib/markdown";

/**
 * How a #tag renders inside a line:
 *  - "button": the live, clickable pill (normal feed cards);
 *  - "static": inert dimmed pill (trash cards);
 *  - "ghost":  inert pill that *looks* live — used by the edit-replay ghost
 *    and overlay clones, which must be pixel-identical to the real card.
 */
export type TagMode = "button" | "static" | "ghost";

interface MemoLineProps {
  raw: string;
  /**
   * The following visual line, when the caller knows it. Only used to bold a
   * table row that sits right above a "| --- |" delimiter — passing it as an
   * explicit prop (instead of a CSS sibling selector) keeps the replay
   * clones, which render one line each, pixel-identical to the real card.
   */
  nextRaw?: string;
  tagMode: TagMode;
  onPickTag?: (path: string) => void;
  /**
   * Live task checkbox: called with the desired checked state. Only honored
   * in "button" tag mode — trash cards, ghosts and replay clones render the
   * same-geometry inert box instead.
   */
  onToggleTask?: (checked: boolean) => void;
  /**
   * Optimistic checkbox override while a toggle is in flight. The raw line
   * stays the server truth; only the rendered mark (and its done styling)
   * follows the user's click ahead of the round trip.
   */
  taskCheckedOverride?: boolean;
}

function renderInline(nodes: Inline[], tagMode: TagMode, onPickTag?: (path: string) => void): ReactNode[] {
  return nodes.map((node, index): ReactNode => {
    switch (node.t) {
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.kids, tagMode, onPickTag)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.kids, tagMode, onPickTag)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.kids, tagMode, onPickTag)}</del>;
      case "mark":
        return <mark key={index}>{renderInline(node.kids, tagMode, onPickTag)}</mark>;
      case "link":
        return (
          <a key={index} href={node.url} target="_blank" rel="noreferrer noopener" title={node.url}>
            {renderInline(node.kids, tagMode, onPickTag)}
          </a>
        );
      case "url":
        return (
          <a key={index} href={node.url} target="_blank" rel="noreferrer noopener">
            {node.url}
          </a>
        );
      case "tag":
        if (tagMode === "button") {
          return (
            <button key={index} type="button" className="memo-tag" onClick={() => onPickTag?.(node.path)}>
              {node.raw}
            </button>
          );
        }
        return (
          <span key={index} className={`memo-tag${tagMode === "static" ? " is-static" : ""}`}>
            {node.raw}
          </span>
        );
      case "image":
        // Out of the text flow — the card renders it in the media grid.
        return null;
      default:
        return <Fragment key={index}>{node.text}</Fragment>;
    }
  });
}

/**
 * One rendered memo line: per-line markdown (block prefix + inline marks).
 * Callers feed it lines from visualLinesOf(), so the image-only-collapse case
 * never appears here; the null branch stays as a guard. The collapse decision
 * below stays on tokenizeLine — lineRenders() in lib/lineDiff mirrors it
 * exactly, and markdown only changes HOW a row renders, never WHETHER.
 */
export function MemoLine({ raw, nextRaw, tagMode, onPickTag, onToggleTask, taskCheckedOverride }: MemoLineProps) {
  const { tr } = useI18n();
  if (!raw) return <p className="memo-blank" />;
  const tokens = tokenizeLine(raw);
  // Image tokens leave the text flow (they render in the media grid); a line
  // that was only an image link collapses entirely.
  const visible = tokens.filter((token) => token.kind !== "image");
  if (visible.every((token) => token.kind === "text" && token.text.trim() === "")) {
    return tokens.length === visible.length ? <p className="memo-blank" /> : null;
  }

  const block = parseBlock(raw);
  if (block.kind === "hr") return <p className="md-hr" role="separator" />;
  if (block.kind === "trule") return <p className="md-trule" role="separator" />;
  if (block.kind === "trow") {
    const isHead = nextRaw !== undefined && parseBlock(nextRaw).kind === "trule";
    return (
      <p className={`md-tr${isHead ? " is-th" : ""}`} style={{ "--md-cols": block.cells.length } as CSSProperties}>
        {block.cells.map((cell, index) => (
          <span key={index} className="md-td">
            {renderInline(parseInline(cell), tagMode, onPickTag)}
          </span>
        ))}
      </p>
    );
  }

  const inline = renderInline(parseInline(block.text), tagMode, onPickTag);
  switch (block.kind) {
    case "heading":
      return <p className={`md-h${block.level}`}>{inline}</p>;
    case "quote":
      return <p className="md-quote">{inline}</p>;
    case "bullet":
    case "ordered": {
      // List markers live in ::before; the body span keeps the inline nodes
      // one wrapping flex item (bare text children would each become their
      // own flex item and stop wrapping as continuous text).
      const style = block.depth > 0 ? ({ "--md-depth": block.depth } as CSSProperties) : undefined;
      return (
        <p className={block.kind === "bullet" ? "md-li md-bullet" : "md-li md-ordered"} style={style} data-ord={block.kind === "ordered" ? block.ordinal : undefined}>
          <span className="md-body">{inline}</span>
        </p>
      );
    }
    case "task": {
      const style = block.depth > 0 ? ({ "--md-depth": block.depth } as CSSProperties) : undefined;
      const checked = taskCheckedOverride ?? block.checked;
      const live = tagMode === "button" && onToggleTask !== undefined;
      return (
        <p className={`md-li md-task${checked ? " is-done" : ""}`} style={style}>
          {/* One .md-task-box in every mode: the live feed gets the real
              control, everything else (trash, ghosts, replay clones) gets a
              pixel-identical inert span. */}
          {live ? (
            <button
              type="button"
              className="md-task-box"
              role="checkbox"
              aria-checked={checked}
              aria-label={block.text || tr("Task", "任务")}
              onClick={() => onToggleTask(!checked)}
            />
          ) : (
            <span className="md-task-box" aria-hidden="true" />
          )}
          <span className="md-body">{inline}</span>
        </p>
      );
    }
    default:
      return <p>{inline}</p>;
  }
}
