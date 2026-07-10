import { Fragment, type ReactNode } from "react";
import { tokenizeLine } from "../lib/content";

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

/**
 * One rendered memo line. Callers feed it lines from visualLinesOf(), so the
 * image-only-collapse case never appears here; the null branch stays as a
 * guard. Rendering must stay in lockstep with lineRenders() in lib/lineDiff.
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
  return (
    <p>
      {visible.map((token, index): ReactNode => {
        if (token.kind === "tag") {
          if (tagMode === "button") {
            return (
              <button key={index} type="button" className="memo-tag" onClick={() => onPickTag?.(token.path)}>
                {token.raw}
              </button>
            );
          }
          return (
            <span key={index} className={`memo-tag${tagMode === "static" ? " is-static" : ""}`}>
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
