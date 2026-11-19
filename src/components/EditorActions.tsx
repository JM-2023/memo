import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../lib/i18n";
import { MAX_CONTENT_CHARS } from "../lib/memoRules";
import { EXIT_MS } from "../lib/motion";
import { SwapText } from "./SwapText";
import { useTip } from "./Tip";

/**
 * Holds a boolean-gated element mounted for EXIT_MS while its `.is-leaving`
 * exit animation plays (dissolving under reduced motion), so nothing hard-cuts.
 */
function usePresence(present: boolean): { mounted: boolean; leaving: boolean; onExited: () => void } {
  const [leaving, setLeaving] = useState(false);
  const [prev, setPrev] = useState(present);
  if (present !== prev) {
    setPrev(present);
    setLeaving(!present);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return { mounted: present || leaving, leaving: !present && leaving, onExited: () => setLeaving(false) };
}

/**
 * The Send/Save glyph: a solid paper dart, level with the label so the two
 * read as one direction. Drawn here rather than taken from lucide — the
 * outline plane sat at 45° in the accent green and read as a second, lighter
 * object beside the 600-weight label. The stroke only rounds the corners.
 */
function SendGlyph({ flying = false, onFlown }: { flying?: boolean; onFlown?: () => void }) {
  // `flying`: the composer just cleared after a send, and the dart flies
  // off and comes back round (app.css, .send-glyph.is-flying).
  return (
    <svg className={`send-glyph${flying ? " is-flying" : ""}`} width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" onAnimationEnd={onFlown}>
      <path fill="currentColor" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M3.6 3.7 20.9 12 3.6 20.3 6.7 13.25 13.4 12 6.7 10.75Z" />
    </svg>
  );
}

/** Button press does not blur the textarea (keeps iOS keyboard up). */
function keepFieldFocus(event: ReactMouseEvent) {
  event.preventDefault();
}

/** Send keeps the caret for a mouse too, so a failed send (or the next memo)
 * goes on in the field. A tap still lets the keyboard go on a phone. */
function keepSendFocus(event: ReactMouseEvent) {
  if (window.matchMedia?.("(pointer: fine)").matches) event.preventDefault();
}

export interface EditorActionsProps {
  mode: "create" | "edit";
  preparing: boolean;
  sending: boolean;
  locked: boolean;
  showStopButton: boolean;
  spinnerShown: boolean;
  canSubmit: boolean;
  canQueue: boolean;
  uploadPercent: number | null;
  showCounter: boolean;
  overLimit: boolean;
  effectiveContentLength: number;
  countId: string;
  clears: number;
  hasCancel: boolean;
  onCancel: () => void;
  onStop: () => void;
  onSubmit: () => void;
}

/**
 * The right side of the editor toolbar: preparing status, character counter,
 * Cancel/Stop button (all calling the single `stop()`), and the Send/Save
 * button with smooth enter/exit transitions for every transient state.
 */
export function EditorActions({
  mode,
  preparing,
  sending,
  locked,
  showStopButton,
  spinnerShown,
  canSubmit,
  canQueue,
  uploadPercent,
  showCounter,
  overLimit,
  effectiveContentLength,
  countId,
  clears,
  hasCancel,
  onCancel,
  onStop,
  onSubmit
}: EditorActionsProps) {
  const { formatNumber, tr } = useI18n();
  const tip = useTip();
  // Sends whose cleared composer the glyph has already flown for.
  const [flown, setFlown] = useState(0);
  const counterText = overLimit
    ? tr(`${formatNumber(effectiveContentLength - MAX_CONTENT_CHARS)} over`, `超出 ${formatNumber(effectiveContentLength - MAX_CONTENT_CHARS)} 字`)
    : `${formatNumber(effectiveContentLength)} / ${formatNumber(MAX_CONTENT_CHARS)}`;
  const lastCounterRef = useRef({ text: "", over: false });
  if (showCounter) lastCounterRef.current = { text: counterText, over: overLimit };
  const lastUploadRef = useRef(0);
  if (uploadPercent !== null) lastUploadRef.current = uploadPercent;

  const statusPresence = usePresence(preparing);
  const counterPresence = usePresence(showCounter);
  const stopPresence = usePresence(mode === "create" && showStopButton);
  const spinnerActive = sending && spinnerShown;
  const spinnerPresence = usePresence(spinnerActive);
  const progressPresence = usePresence(uploadPercent !== null);

  return (
    <div className="editor-actions">
      {statusPresence.mounted ? (
        <span
          className={`editor-status${statusPresence.leaving ? " is-leaving" : ""}`}
          aria-hidden={statusPresence.leaving || undefined}
          onAnimationEnd={(event) => {
            if (statusPresence.leaving && event.target === event.currentTarget) statusPresence.onExited();
          }}
        >
          {tr("Preparing image…", "正在处理图片…")}
        </span>
      ) : null}
      {counterPresence.mounted ? (
        showCounter ? (
          overLimit ? (
            // Over the cap the count says so in words; the bubble names the cap.
            <span
              id={countId}
              className="editor-count is-over"
              {...tip.bind({ text: tr(`A memo holds up to ${formatNumber(MAX_CONTENT_CHARS)} characters`, `单条笔记最多 ${formatNumber(MAX_CONTENT_CHARS)} 字`) })}
            >
              {counterText}
              <span className="sr-only">
                {tr(` — a memo holds up to ${formatNumber(MAX_CONTENT_CHARS)} characters`, `，单条笔记最多 ${formatNumber(MAX_CONTENT_CHARS)} 字`)}
              </span>
            </span>
          ) : (
            <span className="editor-count">{counterText}</span>
          )
        ) : (
          <span
            className={`editor-count${lastCounterRef.current.over ? " is-over" : ""} is-leaving`}
            aria-hidden="true"
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) counterPresence.onExited();
            }}
          >
            {lastCounterRef.current.text}
          </span>
        )
      ) : null}
      {mode === "edit" && hasCancel ? (
        <button
          type="button"
          className="ghost-button"
          onMouseDown={showStopButton ? keepFieldFocus : undefined}
          onClick={() => {
            if (showStopButton) onStop();
            else onCancel();
          }}
          disabled={!showStopButton && locked}
        >
          <SwapText id={showStopButton ? "stop" : "cancel"}>{showStopButton ? tr("Stop", "停止") : tr("Cancel", "取消")}</SwapText>
        </button>
      ) : stopPresence.mounted ? (
        <button
          type="button"
          className={`ghost-button editor-stop${stopPresence.leaving ? " is-leaving" : ""}`}
          tabIndex={stopPresence.leaving ? -1 : undefined}
          aria-hidden={stopPresence.leaving || undefined}
          onMouseDown={keepFieldFocus}
          onClick={() => {
            if (!stopPresence.leaving) onStop();
          }}
          onAnimationEnd={(event) => {
            if (stopPresence.leaving && event.target === event.currentTarget) stopPresence.onExited();
          }}
        >
          {tr("Stop", "停止")}
        </button>
      ) : null}
      <button
        type="button"
        className={`send-button${uploadPercent !== null ? " is-uploading" : ""}${sending ? " is-sending" : ""}`}
        onMouseDown={keepSendFocus}
        onClick={onSubmit}
        disabled={!canSubmit && !canQueue}
        aria-label={mode === "create" ? tr("Send", "发送") : tr("Save", "保存")}
        aria-keyshortcuts="Meta+Enter Control+Enter"
      >
        {progressPresence.mounted ? (
          // Images can take a while on a slow uplink: the fill and the figure
          // track the bytes actually sent. Decoration only: a button's children
          // are presentational, so the progressbar screen readers can reach
          // sits beside the button.
          <span
            className={`send-progress${progressPresence.leaving ? " is-leaving" : ""}`}
            aria-hidden="true"
            style={{ transform: `scaleX(${(uploadPercent ?? lastUploadRef.current) / 100})` }}
            onAnimationEnd={(event) => {
              if (progressPresence.leaving && event.target === event.currentTarget) progressPresence.onExited();
            }}
          />
        ) : null}
        {/* Glyph and spinner share one grid cell so the spinner crossfades
            smoothly back into the send icon instead of hard-cutting. */}
        <span className={`send-icon-slot${spinnerActive ? " is-spinning" : ""}`} aria-hidden="true">
          {/* Keyed by the clears, so each emptied composer replays the flight. */}
          <SendGlyph key={clears} flying={clears > flown} onFlown={() => setFlown(clears)} />
          {spinnerActive ? (
            <span className="send-spinner">
              <Loader2 size={17} className="spin" aria-hidden="true" />
            </span>
          ) : spinnerPresence.leaving ? (
            <span
              className="send-spinner-leaving"
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) spinnerPresence.onExited();
              }}
            >
              <Loader2 size={17} className="spin" aria-hidden="true" />
            </span>
          ) : null}
        </span>
        {/* Label and percentage share one grid cell with hidden sizers for
            both, so the chip is the same width idle, at 0% and at 99%
            (tabular digits) and crossfades smoothly between label and %. */}
        <span className={`send-percent${uploadPercent !== null ? " is-uploading" : ""}`} aria-hidden="true">
          <span className={`send-percent-label${uploadPercent !== null ? " send-percent-sizer" : ""}`}>
            {mode === "create" ? tr("Send", "发送") : tr("Save", "保存")}
          </span>
          <span className="send-percent-sizer">{formatNumber(99)}%</span>
          {progressPresence.mounted ? (
            <span className={`send-percent-value${progressPresence.leaving ? " is-leaving" : ""}`}>
              {formatNumber(uploadPercent ?? lastUploadRef.current)}%
            </span>
          ) : null}
        </span>
      </button>
      {uploadPercent !== null ? (
        <span
          className="send-progress-sr"
          role="progressbar"
          aria-label={tr("Uploading images", "正在上传图片")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={uploadPercent}
        />
      ) : null}
    </div>
  );
}
