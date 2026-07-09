import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

interface PromptDialogProps {
  title: string;
  body?: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  /** Returns an error message for an unacceptable value, or null. */
  validate: (value: string) => string | null;
  /** Optional non-blocking notice (e.g. "同名标签将合并"). */
  hint?: (value: string) => string | null;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

/** ConfirmDialog's sibling with a single text input; Enter confirms. */
export function PromptDialog({
  title,
  body,
  initialValue,
  placeholder,
  confirmLabel,
  busyLabel,
  busy,
  validate,
  hint,
  onCancel,
  onConfirm
}: PromptDialogProps) {
  const { tr } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  const trimmed = value.trim();
  const error = trimmed ? validate(trimmed) : null;
  const notice = trimmed && !error ? hint?.(trimmed) ?? null : null;
  const canConfirm = trimmed.length > 0 && !error && !busy;

  function requestClose() {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => cancelRef.current(), 240);
  }

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
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
        {body ? <p>{body}</p> : null}
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canConfirm) onConfirm(trimmed);
          }}
        >
          <input
            ref={inputRef}
            className="prompt-input"
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
          {error ? (
            <p className="prompt-note is-error" role="alert">
              {error}
            </p>
          ) : notice ? (
            <p className="prompt-note">{notice}</p>
          ) : null}
          <div className="confirm-actions">
            <button type="button" className="ghost-button" onClick={requestClose} disabled={busy}>
              {tr("Cancel", "取消")}
            </button>
            <button type="submit" className="accent-button" disabled={!canConfirm}>
              {busy ? busyLabel ?? tr("Processing…", "处理中…") : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
