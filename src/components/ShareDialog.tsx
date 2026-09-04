import { MathFormula } from "./MathFormula";
import {
  Calendar,
  Check,
  Copy,
  Download,
  EyeOff,
  Loader2,
  NotebookPen,
  RectangleHorizontal,
  RectangleVertical,
  X
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { externalImagesOf, tokenizeLine } from "../lib/content";
import { dateKey } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { visualLinesOf } from "../lib/lineDiff";
import { parseBlock, parseInline, type Inline } from "../lib/markdown";
import { handFontCss } from "../lib/shareFont";
import { copyPngToClipboard, downloadBlob, nodeToPngBlob, supportsImageClipboard } from "../lib/shareImage";
import type { Memo } from "../lib/types";
import "../styles/shareCard.css";
import shareCardCss from "../styles/shareCard.css?raw";
import { InkText, inkWriteMs, useInkPhase, type InkPhase } from "./inkText";

type CardLayout = "portrait" | "landscape";
/** The sheet's stock: warm cream, or the neutral gray for images that have
    to sit beside UI screenshots. Both live in shareCard.css. */
type CardTone = "paper" | "gray";

/**
 * What privacy mode does to the page, and where the ink is on its way to or
 * from while it happens. `redact` is the setting; the marks are only really
 * off the sheet once nothing is still being drunk.
 */
interface CardInk {
  redact: boolean;
  phase: InkPhase;
}

/** True once the removable marks are genuinely gone — not merely on their
    way out, which is still a mark on the page and still in the export. */
function inkGone({ redact, phase }: CardInk): boolean {
  return redact && phase !== "drink";
}

/** The artifact's fixed layout widths; the preview scales, the PNG never.
    Portrait is a phone-reading measure, landscape a desktop one — the same
    sheet cut wider, not smaller type. */
const CARD_WIDTHS: Record<CardLayout, number> = { portrait: 400, landscape: 640 };
/** Dialog width per layout — mirrored by .share-modal / .share-modal.is-wide. */
const MODAL_WIDTHS: Record<CardLayout, number> = { portrait: 478, landscape: 690 };
/** Between dialog edge and card space: 1px modal borders + 24px stage padding
    per side — mirror .share-modal / .share-stage. */
const MODAL_CHROME = 50;
/** 400/640 CSS px → 1000/1600 px PNG: crisp in feeds without absurd payloads. */
const EXPORT_SCALE = 2.5;
/** How long a lifted seal stays in the tree to animate away — mirrors
    seal-lift in app.css. */
const SEAL_LIFT_MS = 200;
/** How long the dateline's room takes to open before the pen touches down —
    mirrors date-open in app.css, and leads the writing by exactly that. */
const DATE_OPEN_MS = 180;
/** The wordmark, which privacy mode takes off the sheet along with the tags.
    A constant because the ink has to know how long it is. */
const BRAND = "MEMO";

const LAYOUT_KEY = "memo:share-layout";
const TONE_KEY = "memo:share-tone";
const SEAL_KEY = "memo:share-seal";
const HAND_KEY = "memo:share-hand";
const DATE_KEY = "memo:share-date";
const PRIVACY_KEY = "memo:share-privacy";

function loadLayout(): CardLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "landscape" ? "landscape" : "portrait";
  } catch {
    return "portrait";
  }
}

function storeLayout(layout: CardLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // private mode — the pick just won't persist
  }
}

function loadTone(): CardTone {
  try {
    return localStorage.getItem(TONE_KEY) === "gray" ? "gray" : "paper";
  } catch {
    return "paper";
  }
}

function storeTone(tone: CardTone): void {
  try {
    localStorage.setItem(TONE_KEY, tone);
  } catch {
    // private mode — the pick just won't persist
  }
}

/** The sheet's four switches. Each has a way it comes out of the box — the
    dateline and the seal are on the page unless the reader takes them off,
    the hand and privacy mode are off until asked for — and `fallback` is
    that, for the first dialog before anything has been picked. */
function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "on";
  } catch {
    return fallback;
  }
}

function storeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // private mode — the pick just won't persist
  }
}

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
function cardInline(nodes: Inline[], ink: CardInk): ReactNode[] {
  return nodes.map((node, index): ReactNode => {
    switch (node.t) {
      case "math":
        return <MathFormula key={index} text={node.text} />;
      case "code":
        return (
          <code key={index} className="sc-code">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{cardInline(node.kids, ink)}</strong>;
      case "em":
        return <em key={index}>{cardInline(node.kids, ink)}</em>;
      case "del":
        return <del key={index}>{cardInline(node.kids, ink)}</del>;
      case "mark":
        return (
          <mark key={index} className="sc-mark">
            {cardInline(node.kids, ink)}
          </mark>
        );
      case "link":
        return (
          <span key={index} className="sc-a">
            {cardInline(node.kids, ink)}
          </span>
        );
      case "url":
        return (
          <span key={index} className="sc-a">
            {node.url}
          </span>
        );
      case "tag":
        // A tag is one of the two marks privacy mode takes off the sheet —
        // it names the writer's own filing system, which is nobody else's
        // business. It stays in the tree while the paper drinks it.
        if (inkGone(ink)) return null;
        return <InkText key={index} className="sc-tag" text={node.raw} phase={ink.phase} />;
      case "image":
        // Out of the text flow — the card renders it in the media grid.
        return null;
      default:
        return <Fragment key={index}>{node.text}</Fragment>;
    }
  });
}

/** A line that carried nothing but tags has nothing left to say once they
    are off the sheet, so it leaves with them rather than ruling off a blank. */
function isOnlyTags(nodes: Inline[]): boolean {
  let sawTag = false;
  for (const node of nodes) {
    if (node.t === "tag") sawTag = true;
    else if (node.t !== "text" || node.text.trim()) return false;
  }
  return sawTag;
}

/** Drop the page's blank edges, for whatever the caller counts as blank. */
function trimBlankEdges<T extends { raw: string }>(all: readonly T[], isBlank: (raw: string) => boolean): T[] {
  let start = 0;
  let end = all.length;
  while (start < end && isBlank(all[start].raw)) start += 1;
  while (end > start && isBlank(all[end - 1].raw)) end -= 1;
  return all.slice(start, end);
}

/** Whether a redacted sheet would print anything at all for this line —
    used to re-trim the page's edges, since a tag line that leaves from the
    end of an entry would otherwise leave its blank behind. */
function printsNothingRedacted(raw: string): boolean {
  if (raw.trim() === "") return true;
  const block = parseBlock(raw);
  if (block.kind === "hr" || block.kind === "trule" || block.kind === "trow") return false;
  return isOnlyTags(parseInline(block.text));
}

function depthStyle(depth: number): CSSProperties | undefined {
  return depth > 0 ? ({ "--sc-depth": depth } as CSSProperties) : undefined;
}

/**
 * One print-set memo line. Mirrors MemoLine's collapse rules exactly, but
 * every marker is a real element (dot, ordinal, task box, rules) — the
 * export serializes the DOM, and pseudo-elements would vanish from the PNG.
 */
function CardLine({ raw, nextRaw, ink }: { raw: string; nextRaw?: string; ink: CardInk }) {
  if (!raw) return <div className="sc-blank" />;
  const tokens = tokenizeLine(raw);
  const visible = tokens.filter((token) => token.kind !== "image");
  if (visible.every((token) => token.kind === "text" && token.text.trim() === "")) {
    return tokens.length === visible.length ? <div className="sc-blank" /> : null;
  }

  const block = parseBlock(raw);
  if (block.kind === "codeblock") return <div className="md-codeblock"><code>{block.text}</code></div>;
  if (block.kind === "math") return <div className="md-math-block"><MathFormula text={block.text} display /></div>;
  if (block.kind === "hr") return <div className="sc-hr" />;
  if (block.kind === "trule") return <div className="sc-trule" />;
  if (block.kind === "trow") {
    const isHead = nextRaw !== undefined && parseBlock(nextRaw).kind === "trule";
    return (
      <div className={`sc-tr${isHead ? " is-th" : ""}`} style={{ "--sc-cols": block.cells.length } as CSSProperties}>
        {block.cells.map((cell, index) => (
          <span key={index} className="sc-td">
            {cardInline(parseInline(cell), ink)}
          </span>
        ))}
      </div>
    );
  }

  const nodes = parseInline(block.text);
  if (inkGone(ink) && isOnlyTags(nodes)) return null;
  const inline = cardInline(nodes, ink);
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
  const [layout, setLayout] = useState<CardLayout>(loadLayout);
  const [tone, setTone] = useState<CardTone>(loadTone);
  const [sealed, setSealed] = useState<boolean>(() => loadFlag(SEAL_KEY, true));
  const [dated, setDated] = useState<boolean>(() => loadFlag(DATE_KEY, true));
  const [hand, setHand] = useState<boolean>(() => loadFlag(HAND_KEY, false));
  const [privacy, setPrivacy] = useState<boolean>(() => loadFlag(PRIVACY_KEY, false));
  // A lifted seal outlives its own removal by one beat so it can animate
  // away; `sealTouched` marks the moment the control took over from the
  // sheet's arrival choreography, after which a press follows the finger.
  const [sealExit, setSealExit] = useState(false);
  const sealExitTimer = useRef(0);
  const sealTouched = useRef(false);
  // How many face swaps the page has been through — the counter is the
  // entry's key, so each swap re-mounts it and its re-inking pulse plays
  // again.
  const [handSwaps, setHandSwaps] = useState(0);
  // External links that refused CORS can't be rasterized; they drop from the
  // preview too, so what you see is exactly what exports.
  const [brokenExternals, setBrokenExternals] = useState<ReadonlySet<string>>(() => new Set());
  const [fit, setFit] = useState<{ scale: number; height: number } | null>(null);
  const reducedMotion = useReducedMotion();
  // One clock per mark that can leave the page: the dateline at the head,
  // and the wordmark and tags privacy mode takes together. Separate, so
  // dropping the date while the paper is still drinking a tag doesn't cut
  // either gesture short.
  const head = useInkPhase(reducedMotion);
  const marks = useInkPhase(reducedMotion);
  const closeTimer = useRef(0);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
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

  useEffect(
    () => () => {
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(sealExitTimer.current);
    },
    []
  );

  // The artifact keeps its true layout width; narrow dialogs show it through
  // a wrapper scale, and height rides along so the stage scrolls the visual
  // size. Sizes derive from the overlay — which never animates — rather than
  // the stage, so a layout swap sets the wrapper's final size in one step and
  // its width/height transitions glide there in sync with the dialog's.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const card = cardRef.current;
    if (!overlay || !card) return;
    const measure = () => {
      const styles = window.getComputedStyle(overlay);
      const inset = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
      const room = Math.min(MODAL_WIDTHS[layout], overlay.clientWidth - inset) - MODAL_CHROME;
      const scale = Math.min(1, Math.max(0.1, room / CARD_WIDTHS[layout]));
      setFit((current) => {
        const next = { scale, height: card.offsetHeight * scale };
        return current && current.scale === next.scale && current.height === next.height ? current : next;
      });
    };
    measure();
    // The window listener re-measures on viewport changes (drag-resize,
    // rotation); the observer catches the card's own height changes (an
    // external image dropping out). Both funnel into the same math.
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(overlay);
    observer?.observe(card);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [layout]);

  // Print discipline: the artifact drops blank edges the feed tolerates.
  const lines = useMemo(() => trimBlankEdges(visualLinesOf(memo.content), (raw) => raw.trim() === ""), [memo.content]);

  // The longest mark privacy mode can take off the page. The pen writes them
  // all back at once, so this one sets how long the whole gesture runs.
  const longestMark = useMemo(() => {
    let longest = BRAND.length;
    for (const line of lines) {
      const block = parseBlock(line.raw);
      if (block.kind === "hr" || block.kind === "trule") continue;
      for (const text of block.kind === "trow" ? block.cells : [block.text]) {
        for (const node of parseInline(text)) {
          if (node.t === "tag") longest = Math.max(longest, [...node.raw].length);
        }
      }
    }
    return longest;
  }, [lines]);

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

  /** Swap the sheet's orientation; the pick is remembered across dialogs. */
  function pickLayout(next: CardLayout) {
    if (next === layout || busy) return;
    setLayout(next);
    storeLayout(next);
  }

  /** Swap the stock the sheet is printed on — also remembered. Unlike the
      layout it changes nothing about the card's geometry, so the same sheet
      stays in place and only its color crossfades. */
  function pickTone(next: CardTone) {
    if (next === tone || busy) return;
    setTone(next);
    storeTone(next);
  }

  /** Press or lift the seal. Off leaves the wordmark alone on the footer
      rule — a plain sheet, for anywhere a mark would read as a watermark.
      Lifting keeps the mark in the tree for one beat so it can pull away
      rather than blink out; renderPng cuts that beat short if an export
      lands inside it. */
  function toggleSeal() {
    if (busy) return;
    const next = !sealed;
    sealTouched.current = true;
    window.clearTimeout(sealExitTimer.current);
    setSealed(next);
    setSealExit(!next && !reducedMotion);
    storeFlag(SEAL_KEY, next);
    if (next || reducedMotion) return;
    sealExitTimer.current = window.setTimeout(() => setSealExit(false), SEAL_LIFT_MS);
  }

  /** Set the page in the other face. Nothing can tween between two
      typefaces, so the page goes down and comes back up in the new one —
      one soft re-inking, under cover of which the swap happens. */
  function toggleHand() {
    if (busy) return;
    const next = !hand;
    setHand(next);
    setHandSwaps((count) => count + 1);
    storeFlag(HAND_KEY, next);
    // Warm the copy the export will need, so Save doesn't wait on a fetch.
    if (next) void handFontCss();
  }

  /** Take the wordmark and the tags off the sheet, or let them back on.
      Neither blinks: the paper drinks them, and the pen writes them back.
      The marks stay in the tree for the length of the gesture — renderPng
      settles it first if an export lands inside one. */
  function togglePrivacy() {
    if (busy) return;
    const next = !privacy;
    setPrivacy(next);
    storeFlag(PRIVACY_KEY, next);
    marks.run(next, inkWriteMs(longestMark));
  }

  /** Take the dateline off the head of the sheet, or write it back. Its line
      closes and opens with it (date-close / date-open in app.css), so the
      entry glides rather than jumping when the last glyph goes; on the way
      back the room opens first and the pen follows it in. */
  function toggleDate() {
    if (busy) return;
    const next = !dated;
    setDated(next);
    storeFlag(DATE_KEY, next);
    head.run(!next, inkWriteMs([...dateLabel].length, DATE_OPEN_MS));
  }

  async function renderPng(): Promise<Blob> {
    // What you see is what exports — so a seal still mid-lift, or a mark the
    // paper is still drinking, has to settle before the clone is taken;
    // flushed rather than scheduled, and before the first await.
    if (sealExit) {
      window.clearTimeout(sealExitTimer.current);
      flushSync(() => setSealExit(false));
    }
    if (head.phase || marks.phase) {
      flushSync(() => {
        head.settle();
        marks.settle();
      });
    }
    const card = cardRef.current;
    if (!card) throw new Error("Card is not mounted");
    // The SVG the export rasterizes is its own document with no network, so
    // a handwritten sheet has to carry the face along with it.
    const css = hand ? shareCardCss + (await handFontCss()) : shareCardCss;
    return nodeToPngBlob(card, { css, scale: EXPORT_SCALE });
  }

  async function handleSave() {
    if (busy) return;
    setBusy("save");
    try {
      const blob = await renderPng();
      downloadBlob(blob, `memo-${dateKey(new Date(memo.createdAt))}.png`);
      setBusy(null);
      onToast(tr("Saved the image", "已保存图片"));
      beginClose();
    } catch {
      setBusy(null);
      onToast(tr("Couldn’t create the image.", "生成图片失败"), "error");
    }
  }

  async function handleCopy() {
    if (busy) return;
    setBusy("copy");
    try {
      await copyPngToClipboard(renderPng);
      setBusy(null);
      onToast(tr("Copied the image", "已复制图片"));
      beginClose();
    } catch {
      setBusy(null);
      onToast(tr("Couldn’t copy the image.", "复制图片失败"), "error");
    }
  }

  const ink: CardInk = { redact: privacy, phase: marks.phase };
  const redacted = inkGone(ink);
  const dateless = inkGone({ redact: !dated, phase: head.phase });
  // Print discipline again, one pass later: with the tags off a sheet whose
  // last line was nothing but tags, the page has a new blank edge to drop.
  const printed = redacted ? trimBlankEdges(lines, printsNothingRedacted) : lines;

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
      <div className={`share-modal${layout === "landscape" ? " is-wide" : ""}`} onClick={(event) => event.stopPropagation()}>
        <header className="share-head">
          <h2>{tr("Share as image", "分享为图片")}</h2>
          <button type="button" className="icon-button" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="share-stage">
          <div className="share-fit" style={fit ? { width: CARD_WIDTHS[layout] * fit.scale, height: fit.height } : undefined}>
            {/* Keyed by layout: a swap lays a fresh sheet (fade + seal re-stamp)
                while the persistent frame around it glides between sizes. */}
            <div
              key={layout}
              ref={cardRef}
              className={`share-card${layout === "landscape" ? " is-landscape" : ""}${tone === "gray" ? " is-gray" : ""}${
                hand ? " is-hand" : ""
              }${dateless ? " is-dateless" : ""}`}
              lang={language}
              style={fit && fit.scale < 1 ? { transform: `scale(${fit.scale})`, transformOrigin: "top left" } : undefined}
            >
              {!dateless ? <InkText className="sc-date" text={dateLabel} phase={head.phase} lead={DATE_OPEN_MS} /> : null}
              {printed.length > 0 ? (
                // Keyed by the face-swap count: a swap re-mounts the entry so
                // it can be re-inked, and leaves the sheet around it in place.
                <div key={handSwaps} className={`sc-body${handSwaps > 0 ? " is-reinking" : ""}`}>
                  {printed.map((line, index, all) => (
                    <CardLine key={line.key} raw={line.raw} nextRaw={all[index + 1]?.raw} ink={ink} />
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
              {/* Provenance. With the wordmark drunk and the seal lifted
                  there is nothing left to rule off, so the band goes too
                  rather than closing the page on an empty line. */}
              {!redacted || sealed || sealExit ? (
                <footer className="sc-foot">
                  {!redacted ? <InkText className="sc-brand" text={BRAND} phase={marks.phase} /> : null}
                  {sealed || sealExit ? (
                    <span
                      className={`sc-seal${sealExit ? " is-lifting" : sealTouched.current ? " is-quick" : ""}`}
                      aria-hidden="true"
                    >
                      <NotebookPen size={12} strokeWidth={2.4} />
                    </span>
                  ) : null}
                </footer>
              ) : null}
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

        {/* Sheet setup — how the artifact is made, kept under the artifact
            and out of the row you leave by. One track, four properties:
            shape and stock to pick, hand and seal to switch on. Each cell is
            a miniature of what it changes, so none of them needs a word —
            and beside the track, the one option that does. */}
        <div className="share-setup">
          <span className="share-seg">
            <span className="share-seg-group" role="group" aria-label={tr("Card layout", "卡片版式")} data-layout={layout}>
              <span className="share-seg-thumb" aria-hidden="true" />
              <button
                type="button"
                className={layout === "portrait" ? "is-active" : ""}
                aria-pressed={layout === "portrait"}
                aria-label={tr("Portrait card", "竖版卡片")}
                title={tr("Portrait card", "竖版卡片")}
                disabled={busy !== null}
                onClick={() => pickLayout("portrait")}
              >
                <RectangleVertical size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={layout === "landscape" ? "is-active" : ""}
                aria-pressed={layout === "landscape"}
                aria-label={tr("Landscape card", "横版卡片")}
                title={tr("Landscape card", "横版卡片")}
                disabled={busy !== null}
                onClick={() => pickLayout("landscape")}
              >
                <RectangleHorizontal size={15} aria-hidden="true" />
              </button>
            </span>
            <span className="share-seg-rule" aria-hidden="true" />
            {/* Stock picker. The swatches are the labels — each button is a
                sample of the paper it selects. */}
            <span className="share-seg-group" role="group" aria-label={tr("Card background", "卡片底色")} data-tone={tone}>
              <span className="share-seg-thumb" aria-hidden="true" />
              <button
                type="button"
                className={tone === "paper" ? "is-active" : ""}
                aria-pressed={tone === "paper"}
                aria-label={tr("Cream paper", "米白底")}
                title={tr("Cream paper", "米白底")}
                disabled={busy !== null}
                onClick={() => pickTone("paper")}
              >
                <span className="share-swatch is-paper" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={tone === "gray" ? "is-active" : ""}
                aria-pressed={tone === "gray"}
                aria-label={tr("Cool gray", "冷灰底")}
                title={tr("Cool gray", "冷灰底")}
                disabled={busy !== null}
                onClick={() => pickTone("gray")}
              >
                <span className="share-swatch is-gray" aria-hidden="true" />
              </button>
            </span>
            <span className="share-seg-rule" aria-hidden="true" />
            {/* Three switches, not choices, so each gets one cell and a thumb
                that presses on rather than sliding across: how the entry is
                set, then the two pieces of furniture the page can go
                without, in the order they sit on it. The chips are the thing
                itself at chip size — a scrap of the stock with the sample
                written on it in the very face the sheet would use, and the
                mark as it would be stamped — inked when it's on the sheet,
                an empty outline when it isn't. */}
            <span className={`share-seg-group is-solo${hand ? " is-on" : ""}`}>
              <span className="share-seg-thumb" aria-hidden="true" />
              <button
                type="button"
                className={hand ? "is-active" : ""}
                aria-pressed={hand}
                aria-label={tr("Handwriting", "手写体")}
                title={tr("Handwriting", "手写体")}
                disabled={busy !== null}
                onClick={toggleHand}
              >
                <span className="share-hand-chip" aria-hidden="true">
                  {tr("Aa", "字")}
                </span>
              </button>
            </span>
            <span className="share-seg-rule" aria-hidden="true" />
            {/* The dateline is the one piece of furniture with no legible
                miniature at this size — a date set in 3px is a smudge — so
                it takes the one glyph everybody already reads as a date. */}
            <span className={`share-seg-group is-solo${dated ? " is-on" : ""}`}>
              <span className="share-seg-thumb" aria-hidden="true" />
              <button
                type="button"
                className={dated ? "is-active" : ""}
                aria-pressed={dated}
                aria-label={tr("Dateline", "日期")}
                title={tr("Dateline", "日期")}
                disabled={busy !== null}
                onClick={toggleDate}
              >
                <Calendar size={15} aria-hidden="true" />
              </button>
            </span>
            <span className="share-seg-rule" aria-hidden="true" />
            <span className={`share-seg-group is-solo${sealed ? " is-on" : ""}`}>
              <span className="share-seg-thumb" aria-hidden="true" />
              <button
                type="button"
                className={sealed ? "is-active" : ""}
                aria-pressed={sealed}
                aria-label={tr("Seal", "印章")}
                title={tr("Seal", "印章")}
                disabled={busy !== null}
                onClick={toggleSeal}
              >
                <span className="share-seal-chip" aria-hidden="true">
                  <NotebookPen size={10} strokeWidth={2.6} />
                </span>
              </button>
            </span>
          </span>

          {/* Privacy is the one option that isn't about the artifact's form
              but about what goes on it, and the only one no miniature can
              stand for — so it keeps the track's material and takes the word
              the others don't need. Same line while there's room; its own
              line on a phone. */}
          <span className="share-seg share-mode">
            <span className={`share-seg-group is-solo${privacy ? " is-on" : ""}`}>
              <span className="share-seg-thumb" aria-hidden="true" />
              <button
                type="button"
                className={privacy ? "is-active" : ""}
                aria-pressed={privacy}
                title={tr(
                  "Privacy mode — leave the wordmark and any tags off the sheet",
                  "隐私模式 — 落款与标签不印上纸面"
                )}
                disabled={busy !== null}
                onClick={togglePrivacy}
              >
                <EyeOff size={14} aria-hidden="true" />
                {tr("Privacy", "隐私")}
              </button>
            </span>
          </span>
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
