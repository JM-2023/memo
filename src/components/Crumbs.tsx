import { ChevronRight, Home } from "lucide-react";
import { Fragment } from "react";
import { useI18n } from "../lib/i18n";

interface CrumbsProps {
  /** Active tag path, e.g. "欢迎/简介". */
  path: string;
  onHome: () => void;
  onPick: (path: string) => void;
}

/**
 * Tag-drilldown breadcrumb replacing "全部笔记" while a tag filter is active:
 *   ⌂ / 欢迎 / 简介
 * Every ancestor is clickable (filters to that prefix), the home icon clears
 * the tag filter, the last segment marks where you are. Re-keyed by path at
 * the call site so each navigation replays the staggered entrance.
 */
export function Crumbs({ path, onHome, onPick }: CrumbsProps) {
  const { tr } = useI18n();
  const parts = path.split("/");

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
            <ChevronRight size={13} className="crumb-sep" aria-hidden="true" style={{ animationDelay: `${index * 0.05 + 0.03}s` }} />
            {isLast ? (
              <span className="crumb is-current" aria-current="page" style={{ animationDelay: `${index * 0.05 + 0.06}s` }}>
                {part}
              </span>
            ) : (
              <button type="button" className="crumb" onClick={() => onPick(prefix)} style={{ animationDelay: `${index * 0.05 + 0.06}s` }}>
                {part}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
