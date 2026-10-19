import { Check, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useModalA11y } from "../hooks/useModalA11y";
import { useCloseSignal, useOverlayExit } from "../hooks/useOverlayExit";
import { useI18n } from "../lib/i18n";
import { DONE_HOLD_MS } from "../lib/motion";

/**
 * What a confirm handler may answer. `true` (or a promise of it) means the
 * action went through: the dialog plays its exit, still in its busy look,
 * and then calls `onDone`. Anything else leaves closing to the parent. A
 * promise that went through first says so on the button (a check and the
 * done label) for a beat before the exit.
 */
export type ConfirmOutcome = void | boolean | Promise<boolean | void>;

interface ConfirmDialogProps {
  title: string;
  body: string;
  /** A line after the body for what this time costs (unsent memos a logout drops). */
  note?: string;
  confirmLabel: string;
  busyLabel?: string;
  /** Said on the button for a beat once a confirm that was under way went
   * through. Without it the dialog leaves at once, as before. */
  doneLabel?: string;
  busy?: boolean;
  /** `danger` for irreversible actions; `accent` for ones that only add. */
  tone?: "danger" | "accent";
  /** A long-running confirm shows how far it has got. */
  progress?: { value: number; max: number; text: string };
  /** While busy, turns Cancel into Stop for work that can halt part-way. */
  onStop?: () => void;
  stopping?: boolean;
  onCancel: () => void;
  onConfirm: () => ConfirmOutcome;
  /** After the exit that follows a confirm answered `true`; defaults to onCancel. */
  onDone?: () => void;
  /** Bumped by Back: leave as Cancel would (a busy dialog holds). */
  closeSignal?: number;
}

interface BusyView {
  label: string;
  progress?: ConfirmDialogProps["progress"];
  stop: boolean;
  stopping?: boolean;
}

/** Small centred glass dialog with animated backdrop; Escape cancels. */
export function ConfirmDialog({
  title,
  body,
  note,
  confirmLabel,
  busyLabel,
  doneLabel,
  busy,
  tone = "danger",
  progress,
  onStop,
  stopping,
  onCancel,
  onConfirm,
  onDone,
  closeSignal
}: ConfirmDialogProps) {
  const { tr } = useI18n();
  // Waiting on the confirm's answer, then leaving after it went through:
  // the busy look holds from the click through the exit, so the label,
  // progress and Stop never flash back to the idle form in between.
  const [pending, setPending] = useState(false);
  const [settled, setSettled] = useState(false);
  // A confirm that went through after a wait says so before the exit.
  const [done, setDone] = useState(false);
  const doneTimerRef = useRef(0);
  const mountedRef = useRef(true);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const titleId = useId();
  const bodyId = useId();
  const noteId = useId();

  const liveBusy: BusyView = { label: busyLabel ?? tr("Processing…", "处理中…"), progress, stop: Boolean(onStop || stopping), stopping };
  const lastBusyRef = useRef<BusyView | null>(null);
  if (busy) lastBusyRef.current = liveBusy;
  const held = pending || settled;
  const busyLook = Boolean(busy) || held;
  const view = !busy && held && lastBusyRef.current ? lastBusyRef.current : liveBusy;
  const shownProgress = busy || held ? view.progress : progress;
  // The progress block folds open on the 0fr→1fr track rather than mounting
  // into the card (which grew the card at once, and on a phone threw the
  // sheet's top edge up); folding shut, it keeps its last figures.
  const lastProgressRef = useRef(shownProgress);
  if (shownProgress) lastProgressRef.current = shownProgress;
  const foldProgress = shownProgress ?? lastProgressRef.current;

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, escapeDisabled: busyLook });
  const { closing, closingRef, leave } = useOverlayExit(overlayRef);
  const backdrop = useBackdropDismiss(requestClose);
  useCloseSignal(closeSignal, requestClose);

  function requestClose() {
    if (busyLook || closingRef.current) return;
    leave(() => cancelRef.current());
  }

  /** `said`: the work took a while, so its success stands on the button for a beat first. */
  function finish(said = false) {
    if (!mountedRef.current || closingRef.current) return;
    setSettled(true);
    const go = () => leave(() => (doneRef.current ?? cancelRef.current)());
    if (!said) {
      go();
      return;
    }
    setDone(true);
    window.clearTimeout(doneTimerRef.current);
    doneTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) go();
    }, DONE_HOLD_MS);
  }

  function confirm() {
    const outcome = onConfirm();
    if (outcome === true) finish();
    else if (outcome && typeof outcome === "object") {
      setPending(true);
      const release = () => {
        if (mountedRef.current) setPending(false);
      };
      void outcome.then((value) => {
        // Only a confirm that names its done state holds on it: logging out
        // or an import already says what happened in the next screen or a toast.
        if (value === true) finish(doneLabel !== undefined);
        else release();
      }, release);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(doneTimerRef.current);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={note ? `${bodyId} ${noteId}` : bodyId}
      aria-busy={busyLook || undefined}
      tabIndex={-1}
      {...backdrop}
    >
      <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        {note ? (
          <p id={noteId} className="confirm-note">
            {note}
          </p>
        ) : null}
        {/* Always in the card, folded shut it costs nothing (not even the
            card's row gap), so the first figures open it rather than mount it. */}
        <div className={`confirm-progress-fold${shownProgress ? " is-open" : ""}`}>
          <div>
            {foldProgress ? (
              // Folded shut it says nothing: no stale bar for a screen reader.
              <div className="confirm-progress" aria-hidden={!shownProgress || undefined}>
                <span className="confirm-progress-text">{foldProgress.text}</span>
                <div
                  className="model-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={foldProgress.max}
                  aria-valuenow={Math.min(foldProgress.value, foldProgress.max)}
                  aria-valuetext={foldProgress.text}
                  aria-label={title}
                >
                  <span
                    className="model-progress-fill"
                    style={{ width: `${foldProgress.max > 0 ? Math.min(100, (foldProgress.value / foldProgress.max) * 100).toFixed(2) : 0}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="confirm-actions">
          {busyLook && view.stop ? (
            <button type="button" className="ghost-button" onClick={onStop} disabled={view.stopping || settled}>
              {view.stopping ? tr("Stopping…", "正在停止…") : tr("Stop", "停止")}
            </button>
          ) : (
            <button type="button" className="ghost-button" onClick={requestClose} disabled={busyLook}>
              {tr("Cancel", "取消")}
            </button>
          )}
          <button
            type="button"
            className={`${tone === "accent" ? "accent-button" : "danger-button"}${busyLook ? " is-busy" : ""}`}
            onClick={confirm}
            disabled={busyLook}
          >
            {/* The labels share one cell, so turning busy never changes the
                button's width and slides Cancel along. The busy one wears
                the spinner every busy action does, the done one its check
                (app.css, "busy-swap"). */}
            <span className="busy-swap" data-done={done || undefined}>
              <span aria-hidden={busyLook || undefined}>{confirmLabel}</span>
              {busyLabel !== undefined || busyLook ? (
                <>
                  <span aria-hidden={!busyLook || done || undefined}>
                    <Loader2 size={14} className="spin busy-spinner" aria-hidden="true" />
                    {view.label}
                  </span>
                  <span aria-hidden={!done || undefined}>
                    <Check size={14} className="busy-spinner" aria-hidden="true" />
                    {doneLabel ?? tr("Done", "已完成")}
                  </span>
                </>
              ) : null}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
