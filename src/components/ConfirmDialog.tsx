import { useEffect, useId, useRef, useState } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";

/**
 * What a confirm handler may answer. `true` (or a promise of it) means the
 * action went through: the dialog plays its exit, still in its busy look,
 * and then calls `onDone`. Anything else leaves closing to the parent.
 */
export type ConfirmOutcome = void | boolean | Promise<boolean | void>;

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel?: string;
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
  confirmLabel,
  busyLabel,
  busy,
  tone = "danger",
  progress,
  onStop,
  stopping,
  onCancel,
  onConfirm,
  onDone
}: ConfirmDialogProps) {
  const { tr } = useI18n();
  const [closing, setClosing] = useState(false);
  // Waiting on the confirm's answer, then leaving after it went through:
  // the busy look holds from the click through the exit, so the label,
  // progress and Stop never flash back to the idle form in between.
  const [pending, setPending] = useState(false);
  const [settled, setSettled] = useState(false);
  const reducedMotion = useReducedMotion();
  const closeTimer = useRef(0);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const titleId = useId();
  const bodyId = useId();

  const liveBusy: BusyView = { label: busyLabel ?? tr("Processing…", "处理中…"), progress, stop: Boolean(onStop || stopping), stopping };
  const lastBusyRef = useRef<BusyView | null>(null);
  if (busy) lastBusyRef.current = liveBusy;
  const held = pending || settled;
  const busyLook = Boolean(busy) || held;
  const view = !busy && held && lastBusyRef.current ? lastBusyRef.current : liveBusy;
  const shownProgress = busy || held ? view.progress : progress;

  function leave(callback: () => void) {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reducedMotion) {
      callback();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(callback, 170);
  }

  function requestClose() {
    if (busyLook || closingRef.current) return;
    leave(() => cancelRef.current());
  }

  function finish() {
    if (!mountedRef.current || closingRef.current) return;
    setSettled(true);
    leave(() => (doneRef.current ?? cancelRef.current)());
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
        if (value === true) finish();
        else release();
      }, release);
    }
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, escapeDisabled: busyLook });
  const backdrop = useBackdropDismiss(requestClose);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={busyLook || undefined}
      tabIndex={-1}
      {...backdrop}
    >
      <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        {shownProgress ? (
          <div className="confirm-progress">
            <span className="confirm-progress-text">{shownProgress.text}</span>
            <div
              className="model-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={shownProgress.max}
              aria-valuenow={Math.min(shownProgress.value, shownProgress.max)}
              aria-valuetext={shownProgress.text}
              aria-label={title}
            >
              <span
                className="model-progress-fill"
                style={{ width: `${shownProgress.max > 0 ? Math.min(100, (shownProgress.value / shownProgress.max) * 100).toFixed(2) : 0}%` }}
              />
            </div>
          </div>
        ) : null}
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
          <button type="button" className={tone === "accent" ? "accent-button" : "danger-button"} onClick={confirm} disabled={busyLook}>
            {/* Both labels share one cell, so turning busy never changes the
                button's width and slides Cancel along. */}
            <span className="busy-swap">
              <span aria-hidden={busyLook || undefined}>{confirmLabel}</span>
              {busyLabel !== undefined || busyLook ? <span aria-hidden={!busyLook || undefined}>{view.label}</span> : null}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
