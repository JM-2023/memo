import { ChevronRight, Home } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";

interface CrumbsProps {
  /** Active tag path, e.g. "欢迎/简介"; null at the root (All memos). */
  path: string | null;
  onHome: () => void;
  onPick: (path: string) => void;
  /** The fused location pill (the sort/select dropdown) — always the trail's
      last stop. It carries view-transition-name: topbar-action, so the pill
      itself glides between positions; this component only animates ⌂ and the
      ancestor segments around it. */
  children: ReactNode;
}

function sharedCount(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Location trail: ⌂ / ancestor / ancestor / [current ⌄]. The current segment
 * is NOT rendered here — the caller passes the fused dropdown pill as
 * children and the view transition morphs it from its old to its new spot.
 * Around that glide this component choreographs the supporting cast:
 *
 * - drilling one level deeper leaves the old current behind as a real crumb
 *   that resolves in place (.is-settling) exactly where the pill just left;
 * - deeper new segments cascade in from the left (crumb-in), keyed by prefix
 *   so pre-existing segments never remount or replay;
 * - stepping up keeps segments that fully disappear around briefly as
 *   .is-leaving ghosts folding back toward their parent — but the segment
 *   that BECOMES the new current is deliberately not ghosted, because the
 *   morphing pill already animates into that spot (a ghost there would
 *   double-image it).
 */
export function Crumbs({ path, onHome, onPick, children }: CrumbsProps) {
  const { tr } = useI18n();
  const parts = path ? path.split("/") : [];
  const ancestors = parts.slice(0, -1);
  // Segments from the previous, deeper path that are animating out.
  const [ghosts, setGhosts] = useState<string[]>([]);
  const prevRef = useRef<string[]>([]);
  const prevParts = prevRef.current;
  const prevPath = prevParts.join("/");
  // First ancestor index that is new this render — only those cascade in.
  const enterFrom = sharedCount(prevParts, parts);

  // Layout effect: the ghosts must be back in the DOM before paint, or the
  // dropped segments would vanish for one frame before their exit plays.
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = parts;
    if (parts.length > 0 && parts.length < prev.length && sharedCount(prev, parts) === parts.length) {
      // Up-navigation. prev's last segment is the old current (the pill's old
      // snapshot), prev[parts.length - 1] becomes the new current (the pill's
      // new snapshot) — ghost only what lies strictly between them.
      const dropped = prev.slice(parts.length, prev.length - 1);
      if (dropped.length > 0) {
        setGhosts(dropped);
        const timer = window.setTimeout(() => setGhosts([]), 300);
        return () => window.clearTimeout(timer);
      }
    }
    setGhosts([]);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const enterDelay = (index: number, offset: number) => `${Math.max(0, index - enterFrom) * 0.06 + offset}s`;

  return (
    <>
      <nav className="crumbs" aria-label={tr("Location", "当前位置")}>
        {parts.length > 0 ? (
          <>
            <button type="button" className="crumb crumb-home" onClick={onHome} aria-label={tr("All memos", "全部笔记")} style={{ animationDelay: "0s" }}>
              <Home size={15} aria-hidden="true" />
            </button>
            {ancestors.map((part, index) => {
              const prefix = parts.slice(0, index + 1).join("/");
              // Drilled exactly one level: this crumb is where the pill just
              // was — resolve it in place instead of sliding it in.
              const settle = prefix === prevPath ? " is-settling" : "";
              return (
                <Fragment key={prefix}>
                  <ChevronRight
                    size={13}
                    className={`crumb-sep${settle}`}
                    aria-hidden="true"
                    style={settle ? undefined : { animationDelay: enterDelay(index, 0.03) }}
                  />
                  <button
                    type="button"
                    className={`crumb${settle}`}
                    onClick={() => onPick(prefix)}
                    style={settle ? undefined : { animationDelay: enterDelay(index, 0.07) }}
                  >
                    {part}
                  </button>
                </Fragment>
              );
            })}
            {/* The current segment's separator. Its own view-transition-name
                lets it glide alongside the pill instead of snapping when the
                ancestor list changes width. */}
            <ChevronRight size={13} className="crumb-sep loc-sep" aria-hidden="true" />
          </>
        ) : null}
        {children}
      </nav>
      {ghosts.length > 0 ? (
        // Zero-width overlay sibling: the fold-back plays where the segments
        // were, but the row's layout settles instantly — so anything after
        // the crumbs (the fused pill, the day chip) FLIPs straight to its
        // final spot instead of snapping when the ghosts unmount.
        <span className="crumb-ghosts" aria-hidden="true">
          {ghosts.map((part, ghostIndex) => {
            const prefix = [...parts, ...ghosts.slice(0, ghostIndex + 1)].join("/");
            // Deepest ghost leaves first — the trail folds back into its parent.
            const delay = `${(ghosts.length - 1 - ghostIndex) * 0.05}s`;
            return (
              <Fragment key={prefix}>
                <ChevronRight size={13} className="crumb-sep is-leaving" aria-hidden="true" style={{ animationDelay: delay }} />
                <span className="crumb is-leaving" style={{ animationDelay: delay }}>
                  {part}
                </span>
              </Fragment>
            );
          })}
        </span>
      ) : null}
    </>
  );
}
