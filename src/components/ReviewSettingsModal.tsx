import { Minus, Plus, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import {
  REVIEW_COUNT_MAX,
  REVIEW_COUNT_MIN,
  eligibleReviewMemos,
  type ReviewRange,
  type ReviewScope,
  type ReviewSettings
} from "../lib/review";
import type { Memo } from "../lib/types";
import { RollingText } from "./RollingText";

interface ReviewSettingsModalProps {
  settings: ReviewSettings;
  /** Active memos — they power the live "matching memos" figure. */
  memos: Memo[];
  knownTags: string[];
  onSave: (settings: ReviewSettings) => void;
  onClose: () => void;
}

const SCOPE_OPTIONS: { scope: ReviewScope; en: string; zh: string }[] = [
  { scope: "all", en: "All memos", zh: "全部笔记" },
  { scope: "include", en: "With chosen tags", zh: "包含指定标签" },
  { scope: "exclude", en: "Without chosen tags", zh: "排除指定标签" },
  { scope: "untagged", en: "Untagged only", zh: "仅无标签笔记" }
];

const RANGE_OPTIONS: { range: ReviewRange; en: string; zh: string }[] = [
  { range: "all", en: "All time", zh: "全部时间" },
  { range: "1m", en: "Past month", zh: "1 个月内" },
  { range: "3m", en: "Past 3 months", zh: "3 个月内" },
  { range: "6m", en: "Past 6 months", zh: "6 个月内" },
  { range: "1y", en: "Past year", zh: "1 年内" }
];

/** Arrow-key roving for a radio row: returns the index to move to, or null. */
function rovingTarget(key: string, index: number, length: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % length;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

/**
 * Daily review settings — scope, tag picks, time window and batch size. All
 * choices preview live (the matching-memos figure rolls as they change) and
 * nothing applies until 保存. The dialog follows the app's modal language:
 * blurred backdrop, damped swell in, staggered section rise, reverse morph
 * out — including on save, before the feed regenerates.
 */
export function ReviewSettingsModal({ settings, memos, knownTags, onSave, onClose }: ReviewSettingsModalProps) {
  const { language, locale, tr } = useI18n();
  const reducedMotion = useReducedMotion();

  const [scope, setScope] = useState<ReviewScope>(settings.scope);
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(() => new Set(settings.tags));
  const [range, setRange] = useState<ReviewRange>(settings.range);
  const [countValue, setCountValue] = useState(settings.count);
  const [closing, setClosing] = useState(false);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dismissTimer = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  // One evaluation instant for the whole dialog: the eligibility preview must
  // not drift across midnight while the dialog sits open.
  const now = useMemo(() => new Date(), []);

  const draft = useMemo<ReviewSettings>(
    () => ({ scope, tags: [...selectedTags].sort(), range, count: countValue }),
    [scope, selectedTags, range, countValue]
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const eligibleCount = useMemo(() => eligibleReviewMemos(memos, draft, now).length, [memos, draft, now]);
  const needsTags = scope === "include" || scope === "exclude";
  const tagsMissing = needsTags && selectedTags.size === 0;

  // Selected-but-vanished tags (their last memo was deleted) stay listed so
  // the choice remains visible and revocable.
  const allTags = useMemo(() => {
    const set = new Set(knownTags);
    for (const tag of settings.tags) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, locale));
  }, [knownTags, settings.tags, locale]);

  const requestDismiss = useCallback(
    (action: () => void) => {
      if (closing) return;
      if (reducedMotion) {
        action();
        return;
      }
      setClosing(true);
      dismissTimer.current = window.setTimeout(action, 170);
    },
    [closing, reducedMotion]
  );

  const requestClose = useCallback(() => requestDismiss(() => closeRef.current()), [requestDismiss]);

  function requestSave() {
    if (tagsMissing) return;
    requestDismiss(() => saveRef.current(draftRef.current));
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, initialFocusRef: closeButtonRef });

  useEffect(() => {
    return () => window.clearTimeout(dismissTimer.current);
  }, []);

  function toggleTag(tag: string) {
    setSelectedTags((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function onRadioKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number, length: number, apply: (target: number) => void) {
    const target = rovingTarget(event.key, index, length);
    if (target === null) return;
    event.preventDefault();
    apply(target);
    const radios = event.currentTarget.closest("[role='radiogroup']")?.querySelectorAll<HTMLButtonElement>("[role='radio']");
    radios?.[target]?.focus({ preventScroll: true });
  }

  // Stepper hold-to-repeat: press steps once, holding ~0.4s repeats. Window
  // listeners end the hold even when the pointer leaves or the button hits a
  // bound and gets disabled under the finger.
  const stepCount = useCallback((delta: number) => {
    setCountValue((value) => Math.min(REVIEW_COUNT_MAX, Math.max(REVIEW_COUNT_MIN, value + delta)));
  }, []);
  const holdRef = useRef<{ timeout: number; interval: number } | null>(null);
  const pointerHeldRef = useRef(false);
  const stopHold = useCallback(() => {
    const hold = holdRef.current;
    if (!hold) return;
    window.clearTimeout(hold.timeout);
    window.clearInterval(hold.interval);
    holdRef.current = null;
    window.removeEventListener("pointerup", stopHold);
    window.removeEventListener("pointercancel", stopHold);
  }, []);
  useEffect(() => stopHold, [stopHold]);

  function pressStep(event: ReactPointerEvent<HTMLButtonElement>, delta: number) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Keep focus where it is (and text unselected) during a press-and-hold;
    // the click that follows is swallowed via pointerHeldRef.
    event.preventDefault();
    pointerHeldRef.current = true;
    stopHold();
    stepCount(delta);
    const timeout = window.setTimeout(() => {
      const interval = window.setInterval(() => stepCount(delta), 70);
      holdRef.current = { timeout, interval };
    }, 400);
    holdRef.current = { timeout, interval: 0 };
    window.addEventListener("pointerup", stopHold);
    window.addEventListener("pointercancel", stopHold);
  }

  function clickStep(delta: number) {
    // Pointer presses already stepped in pressStep; this path serves keyboard
    // activation (Enter/Space), which never fires pointerdown.
    if (pointerHeldRef.current) {
      pointerHeldRef.current = false;
      return;
    }
    stepCount(delta);
  }

  return (
    <div
      ref={overlayRef}
      className={`overlay review-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Daily Review Settings", "每日回顾设置")}
      tabIndex={-1}
      onClick={requestClose}
    >
      <div className="review-modal" onClick={(event) => event.stopPropagation()}>
        <header className="review-head">
          <span className="review-head-logo" aria-hidden="true">
            <Sparkles size={15} />
          </span>
          <h2>{tr("Daily review", "每日回顾")}</h2>
          <button ref={closeButtonRef} type="button" className="icon-button review-close" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="review-body">
          <section className="review-section">
            <h3 className="review-section-title" id="review-scope-title">
              {tr("Review scope", "回顾范围")}
            </h3>
            <div className="review-scope" role="radiogroup" aria-labelledby="review-scope-title">
              {SCOPE_OPTIONS.map((option, index) => (
                <button
                  key={option.scope}
                  type="button"
                  role="radio"
                  aria-checked={scope === option.scope}
                  tabIndex={scope === option.scope ? 0 : -1}
                  className={`review-option${scope === option.scope ? " is-active" : ""}`}
                  onClick={() => setScope(option.scope)}
                  onKeyDown={(event) => onRadioKeyDown(event, index, SCOPE_OPTIONS.length, (target) => setScope(SCOPE_OPTIONS[target].scope))}
                >
                  <span className="review-radio" aria-hidden="true" />
                  {tr(option.en, option.zh)}
                </button>
              ))}
            </div>
            {/* Kept mounted: the 0fr→1fr track unfolds/refolds the picker as
                the scope flips; disabled chips keep the collapsed box out of
                the tab order. */}
            <div className={`review-tagbox${needsTags ? " is-open" : ""}`} aria-hidden={!needsTags}>
              <div>
                {allTags.length === 0 ? (
                  <p className="review-tags-empty">{tr("No tags yet — write #tags in a memo first.", "还没有标签，先在笔记里写下 #标签 吧")}</p>
                ) : (
                  <div className="review-tags" role="group" aria-label={tr("Choose tags", "选择标签")}>
                    {allTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className={`review-chip${selectedTags.has(tag) ? " is-active" : ""}`}
                        aria-pressed={selectedTags.has(tag)}
                        disabled={!needsTags}
                        onClick={() => toggleTag(tag)}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="review-section" style={{ animationDelay: "0.03s" }}>
            <h3 className="review-section-title" id="review-range-title">
              {tr("Time range", "时间范围")}
            </h3>
            <div className="review-chips" role="radiogroup" aria-labelledby="review-range-title">
              {RANGE_OPTIONS.map((option, index) => (
                <button
                  key={option.range}
                  type="button"
                  role="radio"
                  aria-checked={range === option.range}
                  tabIndex={range === option.range ? 0 : -1}
                  className={`review-chip${range === option.range ? " is-active" : ""}`}
                  onClick={() => setRange(option.range)}
                  onKeyDown={(event) => onRadioKeyDown(event, index, RANGE_OPTIONS.length, (target) => setRange(RANGE_OPTIONS[target].range))}
                >
                  {tr(option.en, option.zh)}
                </button>
              ))}
            </div>
          </section>

          <section className="review-section" style={{ animationDelay: "0.06s" }}>
            <h3 className="review-section-title">{tr("Memos per day", "每日条数")}</h3>
            <div className="review-count-row">
              <div className="review-stepper" role="group" aria-label={tr("Memos per day", "每日条数")}>
                <button
                  type="button"
                  className="review-step"
                  disabled={countValue <= REVIEW_COUNT_MIN}
                  aria-label={tr("Fewer memos per day", "减少每日条数")}
                  onPointerDown={(event) => pressStep(event, -1)}
                  onClick={() => clickStep(-1)}
                >
                  <Minus size={15} aria-hidden="true" />
                </button>
                <span className="review-count-value">
                  <RollingText value={countValue} />
                </span>
                <button
                  type="button"
                  className="review-step"
                  disabled={countValue >= REVIEW_COUNT_MAX}
                  aria-label={tr("More memos per day", "增加每日条数")}
                  onPointerDown={(event) => pressStep(event, 1)}
                  onClick={() => clickStep(1)}
                >
                  <Plus size={15} aria-hidden="true" />
                </button>
              </div>
              <span className="review-count-unit">
                <RollingText key={language} value={countValue} text={tr(countValue === 1 ? "memo each day" : "memos each day", "条 / 每天")} align="left" />
              </span>
            </div>
          </section>
        </div>

        <footer className="review-foot">
          <div className={`review-note${tagsMissing || eligibleCount === 0 ? " is-warn" : ""}`} aria-live="polite">
            {tagsMissing ? (
              tr("Choose at least one tag", "请至少选择一个标签")
            ) : (
              <>
                <RollingText value={eligibleCount} />{" "}
                <RollingText
                  key={language}
                  value={eligibleCount}
                  text={tr(eligibleCount === 1 ? "matching memo" : "matching memos", "条笔记符合条件")}
                  align="left"
                />
              </>
            )}
          </div>
          <div className="review-foot-actions">
            <button type="button" className="ghost-button" onClick={requestClose}>
              {tr("Cancel", "取消")}
            </button>
            <button type="button" className="accent-button" disabled={tagsMissing} onClick={requestSave}>
              {tr("Save", "保存")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
