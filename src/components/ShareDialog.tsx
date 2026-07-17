import { Check, Copy, Download, Loader2, NotebookPen, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { externalImagesOf, tokenizeLine } from "../lib/content";
import { dateKey } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { visualLinesOf } from "../lib/lineDiff";
import { parseBlock, parseInline, type Inline } from "../lib/markdown";
import { copyPngToClipboard, downloadBlob, nodeToPngBlob, supportsImageClipboard } from "../lib/shareImage";
import type { Memo } from "../lib/types";
import "../styles/shareCard.css";
import shareCardCss from "../styles/shareCard.css?raw";

/** The artifact's fixed layout width; the preview scales, the PNG never. */
const CARD_WIDTH = 400;
/** 400 CSS px → 1000 px PNG: crisp in feeds without absurd payloads. */
const EXPORT_SCALE = 2.5;

interface ShareDialogProps {
  memo: Memo;
  onToast: (text: string, tone?: "info" | "error") => void;
  onClose: () => void;
}

/**
 * Card-flavored inline nodes. Same grammar tree as the feed (parseInline);
 * only the shell differs — everything is inert print: links keep their label
 * as quietly-underlined ink, tags read as marginalia.
 */
function cardInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index): ReactNode => {
    switch (node.t) {
      case "code":
        return (
          <code key={index} className="sc-code">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{cardInline(node.kids)}</strong>;
      case "em":
        return <em key={index}>{cardInline(node.kids)}</em>;
      case "del":
        return <del key={index}>{cardInline(node.kids)}</del>;
      case "mark":
        return (
          <mark key={index} className="sc-mark">
            {cardInline(node.kids)}
          </mark>
        );
      case "link":
        return (
          <span key={index} className="sc-a">
            {cardInline(node.kids)}
          </span>
        );
      case "url":
        return (
          <span key={index} className="sc-a">
            {node.url}
          </span>
        );
      case "tag":
        return (
          <span key={index} className="sc-tag">
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

function depthStyle(depth: number): CSSProperties | undefined {
  return depth > 0 ? ({ "--sc-depth": depth } as CSSProperties) : undefined;
}

/**
 * One print-set memo line. Mirrors MemoLine's collapse rules exactly, but
 * every marker is a real element (dot, ordinal, task box, rules) — the
 * export serializes the DOM, and pseudo-elements would vanish from the PNG.
 */
function CardLine({ raw, nextRaw }: { raw: string; nextRaw?: string }) {
  if (!raw) return <div className="sc-blank" />;
  const tokens = tokenizeLine(raw);
  const visible = tokens.filter((token) => token.kind !== "image");
  if (visible.every((token) => token.kind === "text" && token.text.trim() === "")) {
    return tokens.length === visible.length ? <div className="sc-blank" /> : null;
  }

  const block = parseBlock(raw);
  if (block.kind === "hr") return <div className="sc-hr" />;
  if (block.kind === "trule") return <div className="sc-trule" />;
  if (block.kind === "trow") {
    const isHead = nextRaw !== undefined && parseBlock(nextRaw).kind === "trule";
    return (
      <div className={`sc-tr${isHead ? " is-th" : ""}`} style={{ "--sc-cols": block.cells.length } as CSSProperties}>
        {block.cells.map((cell, index) => (
          <span key={index} className="sc-td">
            {cardInline(parseInline(cell))}
          </span>
        ))}
      </div>
    );
  }

  const inline = cardInline(parseInline(block.text));
  switch (block.kind) {
    case "heading":
      return <div className={`sc-h${block.level}`}>{inline}</div>;
    case "quote":
      return <div className="sc-quote">{inline}</div>;
    case "bullet":
      return (
        <div className="sc-li" style={depthStyle(block.depth)}>
          <span className="sc-dot" />
          <span className="sc-text">{inline}</span>
        </div>
      );
    case "ordered":
      return (
        <div className="sc-li" style={depthStyle(block.depth)}>
          <span className="sc-ord">{block.ordinal}.</span>
          <span className="sc-text">{inline}</span>
        </div>
      );
    case "task":
      return (
        <div className={`sc-li sc-task${block.checked ? " is-done" : ""}`} style={depthStyle(block.depth)}>
          <span className="sc-box">{block.checked ? <Check size={10} strokeWidth={4} aria-hidden="true" /> : null}</span>
          <span className="sc-text">{inline}</span>
        </div>
      );
    default:
      return <div className="sc-p">{inline}</div>;
  }
}

/**
 * Share-as-image dialog: the paper artifact on a recessed stage, previewed
 * exactly as it exports (shareCard.css styles both; the dialog's own chrome
 * and motion live in app.css and never reach the PNG). Save downloads the
 * PNG, Copy places it on the clipboard; both close the dialog on success.
 */
export function ShareDialog({ memo, onToast, onClose }: ShareDialogProps) {
  const { language, locale, tr } = useI18n();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  // External links that refused CORS can't be rasterized; they drop from the
  // preview too, so what you see is exactly what exports.
  const [brokenExternals, setBrokenExternals] = useState<ReadonlySet<string>>(() => new Set());
  const [fit, setFit] = useState<{ scale: number; height: number } | null>(null);
  const reducedMotion = useReducedMotion();
  const closeTimer = useRef(0);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  /** Unconditional close — the success path after save/copy. */
  function beginClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reducedMotion) {
      closeRef.current();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => closeRef.current(), 170);
  }

  /** User-initiated close (Escape, backdrop, ×) — held while exporting. */
  function requestClose() {
    if (busyRef.current) return;
    beginClose();
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, escapeDisabled: busy !== null, initialFocusRef: saveRef });

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // The artifact keeps its true 400px layout; narrow dialogs show it through
  // a wrapper scale. Height rides along so the stage scrolls the visual size.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const card = cardRef.current;
    if (!stage || !card) return;
    const measure = () => {
      const styles = window.getComputedStyle(stage);
      const inset = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
      const scale = Math.min(1, Math.max(0.1, (stage.clientWidth - inset) / CARD_WIDTH));
      setFit((current) => {
        const next = { scale, height: card.offsetHeight * scale };
        return current && current.scale === next.scale && current.height === next.height ? current : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const lines = useMemo(() => {
    const all = visualLinesOf(memo.content);
    // Print discipline: the artifact drops blank edges the feed tolerates.
    let start = 0;
    let end = all.length;
    while (start < end && all[start].raw.trim() === "") start += 1;
    while (end > start && all[end - 1].raw.trim() === "") end -= 1;
    return all.slice(start, end);
  }, [memo.content]);

  const externalUrls = useMemo(() => externalImagesOf(memo.content), [memo.content]);
  const shownExternals = externalUrls.filter((url) => !brokenExternals.has(url));
  const excludedCount = externalUrls.length - shownExternals.length;
  const mediaCount = memo.images.length + shownExternals.length;

  const dateLabel = useMemo(() => {
    const created = new Date(memo.createdAt);
    const day = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(created);
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(created);
    return `${day} · ${weekday}`;
  }, [locale, memo.createdAt]);

  function markBroken(url: string) {
    setBrokenExternals((current) => {
      if (current.has(url)) return current;
      const next = new Set(current);
      next.add(url);
      return next;
    });
  }

  function renderPng(): Promise<Blob> {
    const card = cardRef.current;
    if (!card) return Promise.reject(new Error("Card is not mounted"));
    return nodeToPngBlob(card, { css: shareCardCss, scale: EXPORT_SCALE });
  }

  async function handleSave() {
    if (busy) return;
    setBusy("save");
    try {
      const blob = await renderPng();
      downloadBlob(blob, `memo-${dateKey(new Date(memo.createdAt))}.png`);
      setBusy(null);
      onToast(tr("Image saved", "图片已保存"));
      beginClose();
    } catch {
      setBusy(null);
      onToast(tr("Couldn’t create the image", "图片生成失败"), "error");
    }
  }

  async function handleCopy() {
    if (busy) return;
    setBusy("copy");
    try {
      await copyPngToClipboard(renderPng);
      setBusy(null);
      onToast(tr("Image copied", "图片已复制"));
      beginClose();
    } catch {
      setBusy(null);
      onToast(tr("Couldn’t copy the image", "复制图片失败"), "error");
    }
  }

  return (
    <div
      ref={overlayRef}
      className={`overlay share-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Share as image", "分享为图片")}
      aria-busy={busy !== null || undefined}
      tabIndex={-1}
      onClick={requestClose}
    >
      <div className="share-modal" onClick={(event) => event.stopPropagation()}>
        <header className="share-head">
          <h2>{tr("Share as image", "分享为图片")}</h2>
          <button type="button" className="icon-button" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div ref={stageRef} className="share-stage">
          <div className="share-fit" style={fit ? { width: CARD_WIDTH * fit.scale, height: fit.height } : undefined}>
            <div
              ref={cardRef}
              className="share-card"
              lang={language}
              style={fit && fit.scale < 1 ? { transform: `scale(${fit.scale})`, transformOrigin: "top left" } : undefined}
            >
              <span className="sc-date">{dateLabel}</span>
              {lines.length > 0 ? (
                <div className="sc-body">
                  {lines.map((line, index, all) => (
                    <CardLine key={line.key} raw={line.raw} nextRaw={all[index + 1]?.raw} />
                  ))}
                </div>
              ) : null}
              {mediaCount > 0 ? (
                <div className={`sc-media count-${Math.min(mediaCount, 3)}`}>
                  {memo.images.map((image) => (
                    <span key={image.id} className="sc-img">
                      <img src={`/api/images/${image.id}`} alt="" decoding="async" width={image.width || undefined} height={image.height || undefined} />
                    </span>
                  ))}
                  {shownExternals.map((url) => (
                    <span key={url} className="sc-img">
                      <img src={url} alt="" crossOrigin="anonymous" referrerPolicy="no-referrer" decoding="async" onError={() => markBroken(url)} />
                    </span>
                  ))}
                </div>
              ) : null}
              <footer className="sc-foot">
                <span className="sc-brand">MEMO</span>
                <span className="sc-seal" aria-hidden="true">
                  {language === "zh-CN" ? "记" : <NotebookPen size={12} strokeWidth={2.4} />}
                </span>
              </footer>
            </div>
          </div>
          {excludedCount > 0 ? (
            <p className="share-note" role="status">
              {tr(
                excludedCount === 1 ? "1 linked image can’t be included" : `${excludedCount} linked images can’t be included`,
                `${excludedCount} 张外链图片无法放入卡片`
              )}
            </p>
          ) : null}
        </div>

        <footer className="share-actions">
          {supportsImageClipboard() ? (
            <button type="button" className="ghost-button" onClick={handleCopy} disabled={busy !== null}>
              {busy === "copy" ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              {tr("Copy image", "复制图片")}
            </button>
          ) : null}
          <button ref={saveRef} type="button" className="accent-button" onClick={handleSave} disabled={busy !== null}>
            {busy === "save" ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
            {tr("Save image", "保存图片")}
          </button>
        </footer>
      </div>
    </div>
  );
}
