import { RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useModalA11y } from "../hooks/useModalA11y";
import { useCloseSignal, useOverlayExit } from "../hooks/useOverlayExit";
import type { StorageReport } from "../lib/api";
import { dateFormat } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { memoLabelLead } from "../lib/selection";
import {
  daysInTrash,
  formatBytes,
  NEARLY_FULL_RATIO,
  sortImageEntries,
  METER_NUB_RATIO,
  STALE_TRASH_DAYS,
  meterParts,
  staleTrash,
  storedBytesOf,
  storedImageEntries,
  summarizeStorage,
  type ImageSort,
  type StoragePartKey,
  type StoredImageEntry
} from "../lib/storage";
import type { Memo } from "../lib/types";
import { StoredImageButton } from "./StoredImage";
import { useTip } from "./Tip";

interface StorageModalProps {
  /** The notebook as the server holds it, Trash included. */
  memos: Memo[];
  /** Fetches the report through the owner's session guard; undefined when the session went. */
  loadReport: () => Promise<StorageReport | undefined>;
  onClose: () => void;
  /** Brings a memo's card into view — in Trash when it is there. */
  onOpenMemo: (id: string) => void;
  onOpenTrash: () => void;
  /** Permanently deletes these trashed memos; settles once the job (and its toast) has. */
  onPurge: (ids: string[]) => Promise<void>;
  /** Bumped by the owner to close the panel the way its own ✕ does (Back). */
  closeSignal?: number;
}

/** Tiles per page of the wall: divides evenly into 3–6 columns. */
const WALL_PAGE = 60;
/** An armed delete fires only on a fresh click this long after arming (App's Empty Trash beat). */
const ARM_BEAT_MS = 450;

/** "123 MB" → figure and unit, so the unit can step down from the figure. */
function splitSize(text: string): { value: string; unit: string } {
  const at = text.lastIndexOf(" ");
  return at < 0 ? { value: text, unit: "" } : { value: text.slice(0, at), unit: text.slice(at + 1) };
}

export function StorageModal({ memos, loadReport, onClose, onOpenMemo, onOpenTrash, onPurge, closeSignal = 0 }: StorageModalProps) {
  const { count, errorMessage, formatNumber, locale, tr } = useI18n();
  const tip = useTip();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<ImageSort>("newest");
  const [trashOnly, setTrashOnly] = useState(false);
  const [shown, setShown] = useState(WALL_PAGE);
  const [armed, setArmed] = useState(false);
  const [purging, setPurging] = useState(false);
  const armedAtRef = useRef(0);
  const now = useMemo(() => Date.now(), []);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const callbacksRef = useRef({ onClose, onOpenMemo, onOpenTrash, loadReport });
  callbacksRef.current = { onClose, onOpenMemo, onOpenTrash, loadReport };
  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, initialFocusRef: closeButtonRef });
  const exit = useOverlayExit(overlayRef);
  const closing = exit.closing;
  const backdrop = useBackdropDismiss(requestClose);
  useCloseSignal(closeSignal, requestClose);

  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const refresh = useCallback(() => {
    if (!mountedRef.current) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    callbacksRef.current.loadReport().then(
      (next) => {
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
        if (!next) return;
        setReport(next);
        setFailure(null);
      },
      (cause: unknown) => {
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
        setFailure(errorMessage(cause, "Couldn’t measure storage.", "无法读取存储用量"));
      }
    );
  }, [errorMessage]);
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      // A purge that settles after the panel has gone asks for nothing more.
      mountedRef.current = false;
      loadSeqRef.current += 1;
    };
  }, [refresh]);

  function leave(callback: () => void) {
    if (exit.closingRef.current) return;
    tip.hide();
    exit.leave(callback);
  }

  function requestClose() {
    leave(() => callbacksRef.current.onClose());
  }

  // Sizes are shown once they are known: the report's, or — when it could
  // not be fetched — estimates, so the wall still sorts and reads offline.
  const sized = report !== null || failure !== null;
  const bytes = (value: number) => formatBytes(value, locale);

  const summary = useMemo(() => (report ? summarizeStorage(report) : null), [report]);
  const drawnParts = useMemo(() => (summary ? meterParts(summary) : null), [summary]);
  const trashed = useMemo(() => memos.filter((memo) => memo.deletedAt), [memos]);
  const stale = useMemo(() => staleTrash(memos, now), [memos, now]);
  const staleBytes = useMemo(() => storedBytesOf(stale, report), [stale, report]);
  const trashBytes = report ? report.trash.textBytes + report.trash.imageBytes : storedBytesOf(trashed, null);

  const entries = useMemo(() => storedImageEntries(memos, report), [memos, report]);
  const trashImageCount = useMemo(() => entries.reduce((sum, entry) => sum + (entry.memo.deletedAt ? 1 : 0), 0), [entries]);
  const scoped = trashOnly && trashImageCount > 0;
  const wall = useMemo(() => {
    const pool = scoped ? entries.filter((entry) => entry.memo.deletedAt) : entries;
    return sortImageEntries(pool, sort);
  }, [entries, scoped, sort]);
  const wallBytes = useMemo(() => wall.reduce((sum, entry) => sum + entry.bytes, 0), [wall]);
  const visible = wall.slice(0, shown);
  const more = wall.length - visible.length;

  // A purge shrinks the stale list under the armed button: the arm is for
  // the set it named, so any change to that set disarms it.
  const staleKey = stale.map((memo) => memo.id).join(",");
  useEffect(() => setArmed(false), [staleKey]);

  async function pressPurge(event: ReactMouseEvent<HTMLButtonElement>) {
    if (purging || stale.length === 0) return;
    if (!armed) {
      armedAtRef.current = performance.now();
      setArmed(true);
      return;
    }
    // The armed label lands under the cursor at once, so a double-click
    // must not carry through to a permanent delete.
    if (event.detail > 1 || performance.now() - armedAtRef.current < ARM_BEAT_MS) return;
    setPurging(true);
    try {
      await onPurge(stale.map((memo) => memo.id));
    } finally {
      setPurging(false);
      setArmed(false);
      refresh();
    }
  }

  const percent = (ratio: number) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: ratio > 0 && ratio < 0.1 ? 1 : 0 }).format(ratio);
  const dayFormat = dateFormat(locale, { year: "numeric", month: "short", day: "numeric" });

  const partNames: Record<StoragePartKey, string> = {
    images: tr("Images", "图片"),
    text: tr("Text", "文字"),
    trash: tr("Trash", "回收站"),
    other: tr("Other", "其他")
  };
  const partSubs: Record<StoragePartKey, string> = report
    ? {
        images: count(report.notes.images, "image"),
        text: count(report.notes.memos, "memo"),
        trash: count(report.trash.memos, "memo"),
        other: tr("Indexes and sync history", "索引与同步记录")
      }
    : { images: "", text: "", trash: "", other: "" };

  function heroNote() {
    if (!summary) {
      if (failure) return <span className="storage-failure">{failure}</span>;
      return tr("Measuring…", "正在计算…");
    }
    const free = bytes(Math.max(0, summary.limit - summary.used));
    const limit = bytes(summary.limit);
    if (summary.ratio >= 1) {
      return (
        <>
          <strong>{tr("Full.", "已满。")}</strong>
          {tr(" New memos and images can’t be saved until space is freed.", "释放空间之前，新的笔记和图片都无法保存。")}
        </>
      );
    }
    if (summary.ratio >= NEARLY_FULL_RATIO) {
      return (
        <>
          <strong>{tr("Nearly full.", "快满了。")}</strong>
          {tr(` ${free} left — at ${limit}, new memos and images stop saving.`, `还剩 ${free}，到 ${limit} 时将无法再保存新的笔记和图片。`)}
        </>
      );
    }
    // Under 1% a decimal reads as precision nobody needs ("0.1%"): say it
    // the way the nub shows it.
    if (summary.ratio < METER_NUB_RATIO) {
      return tr(`Under ${percent(METER_NUB_RATIO)} of the ${limit} limit · ${free} free`, `不到 ${limit} 上限的 ${percent(METER_NUB_RATIO)} · 剩余 ${free}`);
    }
    return tr(`${percent(summary.ratio)} of the ${limit} limit · ${free} free`, `已用 ${limit} 上限的 ${percent(summary.ratio)} · 剩余 ${free}`);
  }

  const used = summary ? splitSize(bytes(summary.used)) : null;
  const meterLabel = summary
    ? tr(
        `${bytes(summary.used)} of ${bytes(summary.limit)} used: ${summary.parts.map((part) => `${partNames[part.key]} ${bytes(part.bytes)}`).join(", ")}`,
        `已用 ${bytes(summary.used)}，共 ${bytes(summary.limit)}：${summary.parts.map((part) => `${partNames[part.key]} ${bytes(part.bytes)}`).join("，")}`
      )
    : tr("Measuring storage", "正在计算存储用量");

  function trashLine() {
    if (trashed.length === 0) return tr("Trash is empty.", "回收站是空的。");
    if (stale.length === 0) {
      return sized
        ? tr(
            `Nothing has been in Trash for over ${STALE_TRASH_DAYS} days. Emptying it would free ${bytes(trashBytes)}.`,
            `回收站里没有超过 ${STALE_TRASH_DAYS} 天的笔记。清空回收站可释放 ${bytes(trashBytes)}。`
          )
        : tr(`Nothing has been in Trash for over ${STALE_TRASH_DAYS} days.`, `回收站里没有超过 ${STALE_TRASH_DAYS} 天的笔记。`);
    }
    const held = sized ? tr(`, holding ${bytes(staleBytes)}`, `，占用 ${bytes(staleBytes)}`) : "";
    return (
      <>
        <strong>{count(stale.length, "memo")}</strong>
        {tr(
          ` ${stale.length === 1 ? "has" : "have"} been in Trash for over ${STALE_TRASH_DAYS} days${held}.`,
          ` 在回收站里已超过 ${STALE_TRASH_DAYS} 天${held}。`
        )}
      </>
    );
  }

  function tileLabel(entry: StoredImageEntry): string {
    const lead = memoLabelLead(entry.memo.content);
    const size = sized ? bytes(entry.bytes) : "";
    const where = entry.memo.deletedAt ? tr("in Trash", "回收站中") : dayFormat.format(new Date(entry.memo.createdAt));
    const parts = [lead, where, size].filter(Boolean).join(tr(", ", "，"));
    return tr(`Open memo: ${parts}`, `打开笔记：${parts}`);
  }

  function tileWhen(memo: Memo): string {
    if (!memo.deletedAt) return dayFormat.format(new Date(memo.createdAt));
    const days = daysInTrash(memo, now);
    return days === 0 ? tr("Trashed today", "今天移入回收站") : tr(`Trashed ${count(days, "day")} ago`, `${count(days, "day")}前移入回收站`);
  }

  const purgeLabel = purging
    ? tr("Deleting…", "正在删除…")
    : armed
      ? tr(`Delete ${count(stale.length, "memo")} forever?`, `彻底删除 ${count(stale.length, "memo")}？`)
      : tr("Delete forever", "彻底删除");

  return (
    <div
      ref={overlayRef}
      className={`overlay stats-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Storage", "存储空间")}
      aria-busy={purging || undefined}
      tabIndex={-1}
      {...backdrop}
    >
      <div className="stats-modal storage-modal" onClick={(event) => event.stopPropagation()}>
        <header className="stats-head">
          <h2>{tr("Storage", "存储空间")}</h2>
          <button ref={closeButtonRef} type="button" className="icon-button stats-close" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="stats-body scroll-edges">
          {/* The database against its ceiling: one figure, a sentence that
              says how close it is in words, and the meter split by what
              fills it. */}
          <section className="stats-section storage-overview" aria-busy={loading || undefined}>
            <div className="storage-hero">
              <p className="storage-hero-line">
                {used ? (
                  <span key={used.value + used.unit} className="stats-swap">
                    <span className="stats-hero-value">{used.value}</span>
                    <span className="stats-hero-unit"> {used.unit}</span>
                  </span>
                ) : (
                  <span className="stats-hero-value is-pending" aria-hidden="true">
                    —
                  </span>
                )}
                {summary ? <span className="storage-hero-limit">{tr(`of ${bytes(summary.limit)}`, `/ ${bytes(summary.limit)}`)}</span> : null}
                {summary && !summary.measured ? <span className="storage-hero-limit">{tr("(estimated)", "（估算）")}</span> : null}
              </p>
              {/* The sentence is what is read out when the figure lands or
                  fails, not every number around it. */}
              <p className="stats-hero-note storage-hero-note" aria-live="polite">
                <span key={summary ? `${summary.used}|${summary.limit}` : failure ?? "pending"} className="stats-swap">
                  {heroNote()}
                </span>
                {failure && !loading ? (
                  <button type="button" className="ghost-button storage-retry" onClick={refresh}>
                    <RotateCw size={14} aria-hidden="true" />
                    {tr("Try again", "重试")}
                  </button>
                ) : null}
              </p>
            </div>
            <div className="storage-meter" role="img" aria-label={meterLabel}>
              {drawnParts ? (
                <span className="storage-meter-fill">
                  {drawnParts
                    .filter((part) => part.bytes > 0)
                    .map((part) => (
                      <span
                        key={part.key}
                        className={`storage-meter-part is-${part.key}`}
                        style={{ "--share": `${(part.bytes / summary!.limit) * 100}%` } as CSSProperties}
                      />
                    ))}
                </span>
              ) : summary ? (
                <span className="storage-meter-nub" />
              ) : null}
            </div>
            <dl className="stats-kpis storage-kpis">
              {summary?.parts.map((part) => {
                const size = splitSize(bytes(part.bytes));
                return (
                  <div key={part.key} className="stats-kpi">
                    <dt className="stats-kpi-label">
                      <span className={`storage-swatch is-${part.key}`} aria-hidden="true" />
                      {partNames[part.key]}
                    </dt>
                    <dd className="stats-kpi-value">
                      <span key={size.value} className="stats-swap">
                        {size.value}
                        <span className="stats-kpi-unit"> {size.unit}</span>
                      </span>
                    </dd>
                    <dd className="stats-kpi-sub">{partSubs[part.key] || " "}</dd>
                  </div>
                );
              }) ??
                (["images", "text", "trash", "other"] as const).map((key) => (
                  <div key={key} className="stats-kpi">
                    <dt className="stats-kpi-label">
                      <span className={`storage-swatch is-${key}`} aria-hidden="true" />
                      {partNames[key]}
                    </dt>
                    <dd className="stats-kpi-value is-pending">—</dd>
                    <dd className="stats-kpi-sub"> </dd>
                  </div>
                ))}
            </dl>
          </section>

          {/* Trash is the one share a single action gives back. What has
              sat there longest goes first; the rest stays a visit away. */}
          <section className="stats-section" style={{ animationDelay: "0.03s" }}>
            <div className="stats-section-head">
              <h3 className="stats-section-title">{tr("Trash", "回收站")}</h3>
              {trashed.length > 0 ? (
                <p className="stats-section-note">
                  {count(trashed.length, "memo")}
                  {sized ? ` · ${bytes(trashBytes)}` : ""}
                </p>
              ) : null}
            </div>
            <div className="storage-trash">
              <p className="storage-trash-line">{trashLine()}</p>
              {trashed.length > 0 ? (
                <div className="storage-trash-actions">
                  {stale.length > 0 ? (
                    <button
                      type="button"
                      className={`trash-empty-button${armed || purging ? " is-confirm" : ""}`}
                      aria-disabled={purging || undefined}
                      onClick={(event) => void pressPurge(event)}
                      onBlur={() => {
                        if (!purging) setArmed(false);
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      <span>{purgeLabel}</span>
                    </button>
                  ) : null}
                  <button type="button" className="ghost-button" onClick={() => leave(() => callbacksRef.current.onOpenTrash())}>
                    {tr("Open Trash", "打开回收站")}
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          {/* Every stored attachment, newest or largest first; each opens
              the memo it belongs to. Linked pictures are not stored here. */}
          <section className="stats-section" style={{ animationDelay: "0.06s" }}>
            <div className="stats-section-head storage-wall-head">
              <div className="storage-wall-title">
                <h3 className="stats-section-title">{tr("Images", "图片")}</h3>
                <p className="storage-wall-note">
                  {entries.length === 0
                    ? tr("No stored images. Linked images aren’t stored and take no space.", "没有存储的图片。图片链接不占用存储空间。")
                    : `${count(wall.length, "image")}${sized ? ` · ${bytes(wallBytes)}` : ""}`}
                </p>
              </div>
              {entries.length > 0 ? (
                <div className="storage-wall-controls">
                  {trashImageCount > 0 ? (
                    <span className="lang-seg storage-seg" data-on={scoped ? "second" : "first"} role="group" aria-label={tr("Show images from", "显示范围")}>
                      <span className="lang-seg-thumb" aria-hidden="true" />
                      <button type="button" className={scoped ? "" : "is-active"} aria-pressed={!scoped} onClick={() => setTrashOnly(false)}>
                        {tr("All", "全部")}
                      </button>
                      <button type="button" className={scoped ? "is-active" : ""} aria-pressed={scoped} onClick={() => setTrashOnly(true)}>
                        {tr("In Trash", "回收站")}
                      </button>
                    </span>
                  ) : null}
                  <span className="lang-seg storage-seg" data-on={sort === "largest" ? "second" : "first"} role="group" aria-label={tr("Sort images", "图片排序")}>
                    <span className="lang-seg-thumb" aria-hidden="true" />
                    <button type="button" className={sort === "newest" ? "is-active" : ""} aria-pressed={sort === "newest"} onClick={() => setSort("newest")}>
                      {tr("Newest", "最新")}
                    </button>
                    <button type="button" className={sort === "largest" ? "is-active" : ""} aria-pressed={sort === "largest"} onClick={() => setSort("largest")}>
                      {tr("Largest", "最大")}
                    </button>
                  </span>
                </div>
              ) : null}
            </div>
            {visible.length > 0 ? (
              <ul key={`${sort}|${scoped}`} className="storage-wall" aria-label={tr("Stored images", "已存储的图片")}>
                {visible.map((entry) => {
                  const lead = memoLabelLead(entry.memo.content);
                  const hover = lead ? tip.bind({ text: lead }) : null;
                  return (
                    <li
                      key={entry.image.id}
                      className={`storage-tile${entry.memo.deletedAt ? " is-trashed" : ""}`}
                      onPointerEnter={hover?.onPointerEnter}
                      onPointerLeave={hover?.onPointerLeave}
                    >
                      <StoredImageButton
                        image={entry.image}
                        sizing="thumb"
                        label={tileLabel(entry)}
                        onOpen={() => leave(() => callbacksRef.current.onOpenMemo(entry.memo.id))}
                      />
                      <span className="storage-tile-size" aria-hidden="true">
                        {sized ? bytes(entry.bytes) : " "}
                      </span>
                      <span className="storage-tile-when" aria-hidden="true">
                        {tileWhen(entry.memo)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {more > 0 ? (
              <button type="button" className="ghost-button storage-more" onClick={() => setShown((value) => value + WALL_PAGE)}>
                {tr(`Show ${formatNumber(Math.min(WALL_PAGE, more))} more`, `再显示 ${formatNumber(Math.min(WALL_PAGE, more))} 张`)}
              </button>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
