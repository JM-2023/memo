import { useEffect, useRef, useState } from "react";
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
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  function requestClose() {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => cancelRef.current(), 160);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`overlay${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={requestClose}>
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
