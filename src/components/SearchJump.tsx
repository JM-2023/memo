import { Bookmark, Brain, Hash, History, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formatDayLabel } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { T_FAST } from "../lib/motion";
import type { SavedFilter } from "../lib/savedFilters";
import { completeTag, matchTags, type TagEntry, type TagHit } from "../lib/tagJump";
import { FACET_ROWS } from "./SearchFilter";

/** One row of the search box's list; `id` is stable across renders (not a DOM id). */
export type JumpRow =
  | { kind: "recent"; id: string; text: string }
  | { kind: "saved"; id: string; item: SavedFilter; summary: string }
  | { kind: "pinned"; id: string; path: string; count: number }
  | { kind: "tag"; id: string; hit: TagHit }
  | { kind: "search"; id: string; text: string }
  | { kind: "meaning"; id: string; text: string };

interface Section {
  key: string;
  title: string | null;
  rows: JumpRow[];
}

interface SearchJumpOptions {
  /** The text in the field (an IME's composition included). */
  query: string;
  /** Focused and not dismissed: the list shows whenever it has rows. */
  open: boolean;
  tags: readonly TagEntry[];
  pinned: readonly TagEntry[];
  saved: readonly SavedFilter[];
  recent: readonly string[];
  /** Offer "search by meaning" (the model is on this device and the lens is off). */
  meaningAvailable: boolean;
  onAct: (row: JumpRow) => void;
  /** Tab: the field takes this text. */
  onComplete: (text: string) => void;
  /** ↑ / ↓ on a closed list. */
  onOpen: () => void;
  /** The reader scrolled the page, or pressed Esc: the list gets out of the way. */
  onCollapse: () => void;
}

export interface SearchJump {
  listId: string;
  expanded: boolean;
  activeDescendant: string | undefined;
  /** The list's keys (↑ ↓ ↩ ⇧↩ Tab Esc); true when it took the press. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => boolean;
  popup: ReactNode;
}

/** The matched characters in the accent, the parent path dimmed. */
function markedPath(path: string, marks: readonly number[]): ReactNode[] {
  const marked = new Set(marks);
  const cut = path.lastIndexOf("/") + 1;
  const parts: ReactNode[] = [];
  let start = 0;
  while (start < path.length) {
    const hit = marked.has(start);
    const dim = start < cut;
    let end = start + 1;
    while (end < path.length && marked.has(end) === hit && (end < cut) === dim) end += 1;
    const text = path.slice(start, end);
    parts.push(
      hit ? (
        <mark key={start} className="jump-hit">
          {text}
        </mark>
      ) : (
        <span key={start} className={dim ? "jump-dim" : undefined}>
          {text}
        </span>
      )
    );
    start = end;
  }
  return parts;
}

/**
 * The search box as a search-and-jump field: focused empty it offers recent
 * searches, saved filters and pinned tags; typing, the tags that match and
 * the search itself (by meaning too, where that is on hand). The field stays
 * the one focus (combobox + listbox, aria-activedescendant); the feed keeps
 * filtering as it is typed, as before. Enter acts on the active row — the
 * search row by default, so Enter still means "search" — Tab completes a
 * tag into the field, ⇧Enter searches by meaning.
 */
export function useSearchJump(options: SearchJumpOptions): SearchJump {
  const { query, open, tags, pinned, saved, recent, meaningAvailable } = options;
  const { count, formatNumber, locale, tr } = useI18n();
  const listId = useId();
  const popRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const [activeId, setActiveId] = useState<string | null>(null);

  const typed = query.trim();
  const sections = useMemo<Section[]>(() => {
    if (!typed) {
      const summaryOf = (item: SavedFilter) =>
        [
          item.tag ? `#${item.tag}` : null,
          item.query.trim() ? tr(`“${item.query.trim()}”`, `「${item.query.trim()}」`) : null,
          item.day ? formatDayLabel(item.day, locale) : null,
          item.filters.dateFrom || item.filters.dateTo ? tr("Date range", "日期范围") : null,
          ...FACET_ROWS.filter((row) => item.filters[row.key]).map((row) => tr(row.en, row.zh))
        ]
          .filter(Boolean)
          .join(" · ");
      return [
        { key: "recent", title: tr("Recent searches", "最近搜索"), rows: recent.map((text, index): JumpRow => ({ kind: "recent", id: `recent:${index}`, text })) },
        { key: "saved", title: tr("Saved filters", "保存的筛选"), rows: saved.map((item): JumpRow => ({ kind: "saved", id: `saved:${item.id}`, item, summary: summaryOf(item) })) },
        { key: "pinned", title: tr("Pinned tags", "置顶标签"), rows: pinned.map((tag): JumpRow => ({ kind: "pinned", id: `pin:${tag.path}`, path: tag.path, count: tag.count })) }
      ].filter((section) => section.rows.length > 0);
    }
    const hits = matchTags(query, tags);
    const actions: JumpRow[] = [{ kind: "search", id: "search", text: typed }];
    if (meaningAvailable) actions.push({ kind: "meaning", id: "meaning", text: typed });
    return [
      ...(hits.length > 0 ? [{ key: "tags", title: tr("Jump to tag", "跳到标签"), rows: hits.map((hit): JumpRow => ({ kind: "tag", id: `tag:${hit.path}`, hit })) }] : []),
      { key: "actions", title: null, rows: actions }
    ];
  }, [typed, query, tags, pinned, saved, recent, meaningAvailable, locale, tr]);

  const flat = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const expanded = open && flat.length > 0;
  // A row kept across a keystroke stays active; otherwise typing rests on
  // the search row, and the empty list on none (Enter applies nothing).
  const active = flat.find((row) => row.id === activeId) ?? (typed ? flat.find((row) => row.kind === "search") : undefined);
  const activeIndex = active ? flat.indexOf(active) : -1;
  const domId = (index: number) => `${listId}-option-${index}`;
  const tagRows = flat.filter((row): row is Extract<JumpRow, { kind: "tag" }> => row.kind === "tag");
  // What Tab completes: the active tag row, else the best match.
  const completion = active?.kind === "tag" ? active : tagRows[0];

  useEffect(() => {
    if (!open) setActiveId(null);
  }, [open]);

  // The rows live only while the list shows, and for its fade out after
  // (the rows it closed on), so a closed list holds nothing to find.
  const lastSectionsRef = useRef<Section[]>([]);
  if (expanded) lastSectionsRef.current = sections;
  const [lingering, setLingering] = useState(false);
  const wasExpandedRef = useRef(expanded);
  useEffect(() => {
    const closed = wasExpandedRef.current && !expanded;
    wasExpandedRef.current = expanded;
    if (!closed) return;
    setLingering(true);
    const timer = window.setTimeout(() => setLingering(false), T_FAST + 40);
    return () => window.clearTimeout(timer);
  }, [expanded]);
  const shownSections = expanded ? sections : lingering ? lastSectionsRef.current : [];

  useLayoutEffect(() => {
    if (!expanded || activeIndex < 0) return;
    document.getElementById(domId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- domId only reads listId
  }, [expanded, activeIndex, listId]);

  // A wheel or a drag on the page means reading the feed: the list folds
  // away (the field keeps focus and reopens it on the next key). Scroll
  // events would also catch the feed's own jump to the top as it filters.
  useEffect(() => {
    if (!expanded) return;
    const onUserScroll = (event: Event) => {
      if (event.target instanceof Node && popRef.current?.contains(event.target)) return;
      callbacksRef.current.onCollapse();
    };
    window.addEventListener("wheel", onUserScroll, { passive: true });
    window.addEventListener("touchmove", onUserScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onUserScroll);
      window.removeEventListener("touchmove", onUserScroll);
    };
  }, [expanded]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    const plain = !event.altKey && !event.metaKey && !event.ctrlKey;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain && !event.shiftKey) {
      const down = event.key === "ArrowDown";
      if (!expanded) {
        if (flat.length === 0) return false;
        event.preventDefault();
        callbacksRef.current.onOpen();
        setActiveId((down ? flat[0] : flat[flat.length - 1]).id);
        return true;
      }
      event.preventDefault();
      const next = activeIndex < 0 ? (down ? 0 : flat.length - 1) : (activeIndex + (down ? 1 : flat.length - 1)) % flat.length;
      setActiveId(flat[next].id);
      return true;
    }
    if (!expanded) return false;
    // Esc closes the list first, as its foot says; the next Esc is the
    // field's again (clear, then let go). Consumed: select mode's window
    // listener must not also back out on the same press.
    if (event.key === "Escape" && plain && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      callbacksRef.current.onCollapse();
      return true;
    }
    if (event.key === "Enter" && plain) {
      const row = event.shiftKey ? flat.find((item) => item.kind === "meaning") : active;
      if (!row) return false;
      event.preventDefault();
      callbacksRef.current.onAct(row);
      return true;
    }
    if (event.key === "Tab" && plain && !event.shiftKey && completion) {
      event.preventDefault();
      callbacksRef.current.onComplete(completeTag(query, completion.hit.path));
      setActiveId(completion.id);
      return true;
    }
    return false;
  }

  const keycap = (text: string) => (
    <kbd className="keycap" aria-hidden="true">
      {text}
    </kbd>
  );

  function rowBody(row: JumpRow): { icon: ReactNode; body: ReactNode; aside?: ReactNode; label?: string } {
    switch (row.kind) {
      case "recent":
        return { icon: <History size={15} aria-hidden="true" />, body: <span className="jump-text">{row.text}</span> };
      case "saved":
        return {
          icon: <Bookmark size={15} aria-hidden="true" />,
          body: <span className="jump-text">{row.item.name}</span>,
          aside: row.summary ? <span className="jump-aside">{row.summary}</span> : undefined,
          label: row.summary ? `${row.item.name}, ${row.summary}` : undefined
        };
      case "pinned":
        return {
          icon: <Hash size={15} aria-hidden="true" />,
          body: <span className="jump-text">{markedPath(row.path, [])}</span>,
          aside: <span className="jump-count">{formatNumber(row.count)}</span>,
          label: tr(`#${row.path}, ${count(row.count, "memo")}`, `#${row.path}，${count(row.count, "memo")}`)
        };
      case "tag":
        return {
          icon: <Hash size={15} aria-hidden="true" />,
          body: <span className="jump-text">{markedPath(row.hit.path, row.hit.marks)}</span>,
          aside: (
            <>
              {completion?.id === row.id ? (
                <span className="jump-keys" aria-hidden="true">
                  {keycap("Tab")}
                  {tr("complete", "补全")}
                </span>
              ) : null}
              <span className="jump-count">{formatNumber(row.hit.count)}</span>
            </>
          ),
          label: tr(`Go to #${row.hit.path}, ${count(row.hit.count, "memo")}`, `跳到 #${row.hit.path}，${count(row.hit.count, "memo")}`)
        };
      case "search":
        return {
          icon: <Search size={15} aria-hidden="true" />,
          body: <span className="jump-text">{tr(`Search “${row.text}”`, `搜索「${row.text}」`)}</span>,
          aside: keycap("↩")
        };
      case "meaning":
        return {
          icon: <Brain size={15} aria-hidden="true" />,
          body: <span className="jump-text">{tr(`Search “${row.text}” by meaning`, `按意思搜索「${row.text}」`)}</span>,
          aside: keycap("⇧↩")
        };
    }
  }

  let index = -1;
  const popup = (
    <div
      ref={popRef}
      className={`search-jump-pop${expanded ? " is-open" : ""}`}
      aria-hidden={expanded ? undefined : true}
      // Rows act on click; the field keeps focus throughout.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div id={listId} role="listbox" aria-label={tr("Search suggestions", "搜索建议")} className="search-jump-list">
        {shownSections.map((section, sectionIndex) => (
          <div
            key={section.key}
            role="group"
            className={`search-jump-group${sectionIndex > 0 ? " is-divided" : ""}`}
            aria-labelledby={section.title ? `${listId}-${section.key}` : undefined}
            aria-label={section.title ? undefined : tr("Search", "搜索")}
          >
            {section.title ? (
              <div id={`${listId}-${section.key}`} className="search-jump-title" aria-hidden="true">
                {section.title}
              </div>
            ) : null}
            {section.rows.map((row) => {
              index += 1;
              const at = index;
              const { icon, body, aside, label } = rowBody(row);
              const isActive = expanded && at === activeIndex;
              return (
                <div
                  key={row.id}
                  id={domId(at)}
                  role="option"
                  aria-selected={isActive}
                  aria-label={label}
                  className={`search-jump-row${isActive ? " is-active" : ""}`}
                  onMouseMove={() => {
                    if (!isActive) setActiveId(row.id);
                  }}
                  onClick={() => callbacksRef.current.onAct(row)}
                >
                  {icon}
                  {body}
                  {aside ? <span className="jump-end">{aside}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="search-jump-foot" aria-hidden="true">
        <span>
          {keycap("↑")}
          {keycap("↓")} {tr("select", "选择")}
        </span>
        <span>
          {keycap("↩")} {tr("open", "打开")}
        </span>
        <span>
          {keycap("esc")} {tr("close", "关闭")}
        </span>
      </div>
    </div>
  );

  return {
    listId,
    expanded,
    activeDescendant: expanded && activeIndex >= 0 ? domId(activeIndex) : undefined,
    onKeyDown,
    popup
  };
}
