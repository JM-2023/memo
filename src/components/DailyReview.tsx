import { Check, EyeOff, Leaf, Pencil, Pin, Sparkles } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { formatDayLabel, formatTime } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { reviewAge, type ReviewPick, type ReviewReason } from "../lib/review";
import { RollingText } from "./RollingText";

/*
 * Daily review's pieces around the cards: the line that says why a memo came
 * back, the seen check, the card's own actions, the day's masthead and the
 * quiet word once today's set is done. Progress is today's set and nothing
 * else — no streaks, no score, nothing to keep up with.
 */

type Translate = (en: string, zh: string) => string;

/** One relative-time formatter per locale and mode (cards share them). */
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormat(locale: string, numeric: "auto" | "always"): Intl.RelativeTimeFormat {
  const key = `${locale}|${numeric}`;
  let format = relativeFormats.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric });
    relativeFormats.set(key, format);
  }
  return format;
}

/**
 * "11 months ago" / "11 个月前": the memo's age in the UI locale, its figure
 * set off by spaces the way the app's Chinese copy sets numbers ("{n} 年前").
 * The day itself reads "today" / "今天".
 */
export function formatReviewAge(createdAt: string, locale: string, now = new Date()): string {
  const { value, unit } = reviewAge(createdAt, now);
  return relativeFormat(locale, value === 0 ? "auto" : "always")
    .formatToParts(value === 0 ? 0 : -value, unit)
    .map((part) => (part.type === "integer" ? ` ${part.value} ` : part.value))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Why the memo came back, in words. */
export function reviewContextText(pick: ReviewPick, createdAt: string, tr: Translate, locale: string, now = new Date()): string {
  switch (pick.reason) {
    case "onThisDay":
      return pick.years === 1 ? tr("1 year ago today", "去年今天") : tr(`${pick.years} years ago today`, `${pick.years} 年前的今天`);
    case "anniversary":
      return pick.span === "week"
        ? tr("A week ago", "一周前")
        : pick.span === "month"
          ? tr("A month ago", "一个月前")
          : pick.span === "halfYear"
            ? tr("Six months ago", "半年前")
            : tr("A year ago", "一年前");
    default: {
      const age = formatReviewAge(createdAt, locale, now);
      return tr(`Random · ${age}`, `随机 · ${age}`);
    }
  }
}

/** Rendered just before a review card's stamp, which stays as it is. */
export function ReviewContext({ pick, createdAt }: { pick: ReviewPick; createdAt: string }) {
  const { locale, tr } = useI18n();
  return (
    <span className={`review-context${pick.reason === "random" ? "" : " is-dated"}`}>
      {pick.reason === "onThisDay" ? <Sparkles size={11} aria-hidden="true" /> : null}
      <span className="review-context-text">{reviewContextText(pick, createdAt, tr, locale)}</span>
      <span className="review-context-sep" aria-hidden="true">
        ·
      </span>
    </span>
  );
}

/**
 * The seen check in the card's head. It dissolves in only when this card
 * sees itself become seen — not each time the card mounts (a return to the
 * review, the stage's twin header).
 */
export function ReviewSeenMark({ seen }: { seen: boolean }) {
  const { tr } = useI18n();
  const [shown, setShown] = useState(seen);
  const [fresh, setFresh] = useState(false);
  if (shown !== seen) {
    setShown(seen);
    setFresh(seen);
  }
  if (!seen) return null;
  return (
    <Check
      size={15}
      strokeWidth={2.4}
      role="img"
      className={`review-seen-mark${fresh ? " is-new" : ""}`}
      aria-label={tr("Revisited", "已回顾")}
      onAnimationEnd={() => setFresh(false)}
    />
  );
}

interface ReviewActionsProps {
  /** False in the card stage's inert twin: the same row, nothing to press. */
  live: boolean;
  createdAt: string;
  pinned: boolean;
  /** A pin for this memo is in flight. */
  busy: boolean;
  onHide: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
}

/**
 * A review card's own row: set it aside for good, pin it, edit it. Shown on
 * hover or focus, always on devices without hover (like the ⋯). Each control
 * names the card by its time, as the ⋯ does.
 */
export function ReviewActions({ live, createdAt, pinned, busy, onHide, onTogglePin, onEdit }: ReviewActionsProps) {
  const { locale, tr } = useI18n();
  if (!live) {
    return (
      <div className="review-actions">
        <span className="review-action review-hide">
          <EyeOff size={15} aria-hidden="true" />
          {tr("Not again", "不再出现")}
        </span>
        <span className="review-actions-end">
          <span className={`icon-button review-action${pinned ? " is-on" : ""}`}>
            <Pin size={15} aria-hidden="true" />
          </span>
          <span className="icon-button review-action">
            <Pencil size={15} aria-hidden="true" />
          </span>
        </span>
      </div>
    );
  }
  const stamp = formatTime(createdAt, locale);
  return (
    <div className="review-actions">
      <button type="button" className="review-action review-hide" aria-label={tr(`Not again: memo from ${stamp}`, `不再出现：${stamp} 的笔记`)} onClick={onHide}>
        <EyeOff size={15} aria-hidden="true" />
        {tr("Not again", "不再出现")}
      </button>
      <span className="review-actions-end">
        <button
          type="button"
          className={`icon-button review-action${pinned ? " is-on" : ""}`}
          aria-label={tr(`Pin memo from ${stamp}`, `置顶 ${stamp} 的笔记`)}
          aria-pressed={pinned}
          disabled={busy}
          onClick={onTogglePin}
        >
          <Pin size={15} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button review-action" aria-label={tr(`Edit memo from ${stamp}`, `编辑 ${stamp} 的笔记`)} onClick={onEdit}>
          <Pencil size={15} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

/** Split "{date} · {seen} of {n}" around its slots, keeping the sentence whole per language. */
function fill(template: string, values: Record<string, ReactNode>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((part, index) => (index % 2 === 1 ? <Fragment key={index}>{values[part]}</Fragment> : part));
}

function fillText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
}

interface ReviewBannerProps {
  /** The batch's local day key. */
  day: string;
  seen: number;
  total: number;
  breakdown: Record<ReviewReason, number>;
}

/**
 * The day's masthead: the date and how much of today's set has been
 * revisited, why the set came back (on the right, muted), and under it a
 * hairline that fills as cards are seen.
 */
export function ReviewBanner({ day, seen, total, breakdown }: ReviewBannerProps) {
  const { formatNumber, locale, tr } = useI18n();
  const shown = Math.min(seen, total);
  const template = tr("{date} · {seen} of {n} revisited", "{date} · 已回顾 {seen} / {n}");
  const date = formatDayLabel(day, locale);
  const n = formatNumber(total);
  const mix = [
    breakdown.onThisDay > 0 ? tr(`On this day ${formatNumber(breakdown.onThisDay)}`, `往年今天 ${formatNumber(breakdown.onThisDay)}`) : null,
    breakdown.anniversary > 0 ? tr(`Anniversaries ${formatNumber(breakdown.anniversary)}`, `周年 ${formatNumber(breakdown.anniversary)}`) : null,
    breakdown.random > 0 ? tr(`Random ${formatNumber(breakdown.random)}`, `随机 ${formatNumber(breakdown.random)}`) : null
  ].filter((part): part is string => part !== null);
  return (
    <div className="review-banner">
      <div className="review-banner-row">
        <Sparkles size={14} aria-hidden="true" />
        <span className="review-banner-title">
          {/* The figure rolls; the sentence is read from a plain copy. */}
          <span className="sr-only">{fillText(template, { date, seen: formatNumber(shown), n })}</span>
          <span aria-hidden="true">{fill(template, { date, seen: <RollingText value={shown} />, n })}</span>
        </span>
        {mix.length > 0 ? <span className="review-banner-mix">{mix.join(" · ")}</span> : null}
      </div>
      <div
        className="review-progress"
        role="progressbar"
        aria-label={tr("Revisited today", "今天已回顾")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={shown}
        aria-valuetext={tr(`${formatNumber(shown)} of ${n}`, `${formatNumber(shown)} / ${n}`)}
      >
        <span className="review-progress-fill" style={{ width: `${total > 0 ? (shown / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

const EN_COUNTS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ZH_COUNTS = ["", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十"];

/** "All ten revisited for today" — the actual count, spelled out up to ten. */
export function reviewFinishTitle(count: number, tr: Translate, formatNumber: (value: number) => string = String): string {
  if (count === 1) return tr("Today’s one memo is revisited", "今天的这一条回顾过了");
  if (count === 2) return tr("Both revisited for today", "今天的两条都回顾过了");
  if (count > 2 && count <= 10) return tr(`All ${EN_COUNTS[count]} revisited for today`, `今天的${ZH_COUNTS[count]}条都回顾过了`);
  return tr(`All ${formatNumber(count)} revisited for today`, `今天的 ${formatNumber(count)} 条都回顾过了`);
}

/** After the last card once all of today's set is seen: a leaf and two quiet lines. */
export function ReviewFinish({ count }: { count: number }) {
  const { formatNumber, tr } = useI18n();
  return (
    <div className="review-finish">
      <Leaf size={22} className="review-finish-leaf" aria-hidden="true" />
      <p className="review-finish-title">{reviewFinishTitle(count, tr, formatNumber)}</p>
      <p className="review-finish-note">{tr("A new set tomorrow", "明天再抽新的一组")}</p>
    </div>
  );
}
