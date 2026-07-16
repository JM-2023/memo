import { useEffect, useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Small centred glass dialog with animated backdrop; Escape cancels. */
export function ConfirmDialog({ title, body, confirmLabel, busyLabel, busy, onCancel, onConfirm }: ConfirmDialogProps) {
  const { tr } = useI18n();
  const [closing, setClosing] = useState(false);
  const reducedMotion = useReducedMotion();
  const closeTimer = useRef(0);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

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
      aria-label={title}
      aria-busy={busy || undefined}
      tabIndex={-1}
      onClick={requestClose}
    >
      <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="confirm-actions">
          <button type="button" className="ghost-button" onClick={requestClose} disabled={busy}>
            {tr("Cancel", "取消")}
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
            {busy ? busyLabel ?? tr("Processing…", "处理中…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
