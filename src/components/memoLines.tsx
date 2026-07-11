import { Fragment, type CSSProperties, type ReactNode } from "react";
import { tokenizeLine } from "../lib/content";
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
  tagMode: TagMode;
  onPickTag?: (path: string) => void;
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
export function MemoLine({ raw, tagMode, onPickTag }: MemoLineProps) {
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

  const inline = renderInline(parseInline(block.text), tagMode, onPickTag);
  switch (block.kind) {
    case "heading":
      return <p className={`md-h${block.level}`}>{inline}</p>;
    case "quote":
      return <p className="md-quote">{inline}</p>;
    case "bullet":
    case "ordered":
    case "task": {
      // List markers live in ::before; the body span keeps the inline nodes
      // one wrapping flex item (bare text children would each become their
      // own flex item and stop wrapping as continuous text).
      const style = block.depth > 0 ? ({ "--md-depth": block.depth } as CSSProperties) : undefined;
      const className =
        block.kind === "bullet" ? "md-li md-bullet" : block.kind === "ordered" ? "md-li md-ordered" : `md-li md-task${block.checked ? " is-done" : ""}`;
      return (
        <p className={className} style={style} data-ord={block.kind === "ordered" ? block.ordinal : undefined}>
          <span className="md-body">{inline}</span>
        </p>
      );
    }
    default:
      return <p>{inline}</p>;
  }
}
