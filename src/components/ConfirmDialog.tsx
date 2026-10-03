import { useEffect, useId, useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";

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
  onConfirm: () => void;
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
  onConfirm
}: ConfirmDialogProps) {
  const { tr } = useI18n();
  const [closing, setClosing] = useState(false);
  const reducedMotion = useReducedMotion();
  const closeTimer = useRef(0);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const titleId = useId();
  const bodyId = useId();

  function requestClose() {
    if (busy || closing) return;
    if (reducedMotion) {
      cancelRef.current();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => cancelRef.current(), 170);
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, escapeDisabled: Boolean(busy) });

  useEffect(() => {
    return () => window.clearTimeout(closeTimer.current);
  }, []);

  return (
    <div
      ref={overlayRef}
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={busy || undefined}
      tabIndex={-1}
      onClick={requestClose}
    >
      <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        {progress ? (
          <div className="confirm-progress">
            <span className="confirm-progress-text">{progress.text}</span>
            <div
              className="model-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.max}
              aria-valuenow={Math.min(progress.value, progress.max)}
              aria-valuetext={progress.text}
              aria-label={title}
            >
              <span
                className="model-progress-fill"
                style={{ width: `${progress.max > 0 ? Math.min(100, (progress.value / progress.max) * 100).toFixed(2) : 0}%` }}
              />
            </div>
          </div>
        ) : null}
        <div className="confirm-actions">
          {busy && (onStop || stopping) ? (
            <button type="button" className="ghost-button" onClick={onStop} disabled={stopping}>
              {stopping ? tr("Stopping…", "正在停止…") : tr("Stop", "停止")}
            </button>
          ) : (
            <button type="button" className="ghost-button" onClick={requestClose} disabled={busy}>
              {tr("Cancel", "取消")}
            </button>
          )}
          <button type="button" className={tone === "accent" ? "accent-button" : "danger-button"} onClick={onConfirm} disabled={busy}>
            {busy ? busyLabel ?? tr("Processing…", "处理中…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
