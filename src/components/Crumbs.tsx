import { ChevronRight, Home } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

interface CrumbsProps {
  /** Active tag path, e.g. "欢迎/简介". */
  path: string;
  onHome: () => void;
  onPick: (path: string) => void;
}

function sharedCount(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Direction-aware tag breadcrumb: ⌂ / 欢迎 / 简介. Deliberately NOT re-keyed
 * by path — segments are keyed by their prefix, so drilling deeper mounts
 * (and animates in) only the added segments, and stepping back up keeps the
 * dropped segments around briefly as .is-leaving ghosts that retreat toward
 * their parent. Every segment stays a <button> (including the current one, a
 * no-op click) so moving the "current" highlight never remounts anything.
 */
export function Crumbs({ path, onHome, onPick }: CrumbsProps) {
  const { tr } = useI18n();
  const parts = path.split("/");
  // Segments from the previous, deeper path that are animating out.
  const [ghosts, setGhosts] = useState<string[]>([]);
  const prevRef = useRef<string[]>([]);
  // First index that is new this render — only those cascade in.
  const enterFrom = sharedCount(prevRef.current, parts);

  // Layout effect: the ghosts must be back in the DOM before paint, or the
  // dropped segments would vanish for one frame before their exit plays.
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = parts;
    if (parts.length < prev.length && sharedCount(prev, parts) === parts.length) {
      setGhosts(prev.slice(parts.length));
      const timer = window.setTimeout(() => setGhosts([]), 300);
      return () => window.clearTimeout(timer);
    }
    setGhosts([]);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const enterDelay = (index: number, offset: number) => `${Math.max(0, index - enterFrom) * 0.06 + offset}s`;

  return (
    <nav className="crumbs" aria-label={tr("Tag path", "标签路径")}>
      <button type="button" className="crumb crumb-home" onClick={onHome} aria-label={tr("All memos", "全部笔记")} style={{ animationDelay: "0s" }}>
        <Home size={15} aria-hidden="true" />
      </button>
      {parts.map((part, index) => {
        const prefix = parts.slice(0, index + 1).join("/");
        const isLast = index === parts.length - 1;
        return (
          <Fragment key={prefix}>
            <ChevronRight size={13} className="crumb-sep" aria-hidden="true" style={{ animationDelay: enterDelay(index, 0.03) }} />
            <button
              type="button"
              className={`crumb${isLast ? " is-current" : ""}`}
              aria-current={isLast ? "page" : undefined}
              onClick={() => onPick(prefix)}
              style={{ animationDelay: enterDelay(index, 0.07) }}
            >
              {part}
            </button>
          </Fragment>
        );
      })}
      {ghosts.map((part, ghostIndex) => {
        const prefix = [...parts, ...ghosts.slice(0, ghostIndex + 1)].join("/");
        // Deepest ghost leaves first — the trail folds back into its parent.
        const delay = `${(ghosts.length - 1 - ghostIndex) * 0.05}s`;
        return (
          <Fragment key={prefix}>
            <ChevronRight size={13} className="crumb-sep is-leaving" aria-hidden="true" style={{ animationDelay: delay }} />
            <span className="crumb is-leaving" aria-hidden="true" style={{ animationDelay: delay }}>
              {part}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
