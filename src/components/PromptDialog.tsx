import { useEffect, useRef, useState } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import type { ConfirmOutcome } from "./ConfirmDialog";

/** A hint that changes what confirming does. */
export interface PromptNotice {
  text: string;
  /** An irreversible consequence: set in ink and weight, not grey small print. */
  strong?: boolean;
  /** Names the action the confirm button now performs. */
  confirmLabel?: string;
  busyLabel?: string;
  /** The widest busy label this action can show (its progress at 100%). */
  busyReserve?: string;
}

interface PromptDialogProps {
  title: string;
  body?: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel: string;
  busyLabel?: string;
  /** The widest busy label (its progress at 100%), reserved so the button never grows mid-run. */
  busyReserve?: string;
  busy?: boolean;
  /** Returns an error message for an unacceptable value, or null. */
  validate: (value: string) => string | null;
  /** Optional non-blocking notice (e.g. "同名标签将合并"). */
  hint?: (value: string) => string | PromptNotice | null;
  onCancel: () => void;
  /** Answer `true` (or a promise of it) once done: the dialog exits, then calls onDone. */
  onConfirm: (value: string) => ConfirmOutcome;
  /** After the exit that follows a confirm answered `true`; defaults to onCancel. */
  onDone?: () => void;
}

/** How long typing must pause before a new error or hint is said. */
const NOTE_SETTLE_MS = 400;

interface Verdict {
  error: string | null;
  notice: PromptNotice | null;
}

/** ConfirmDialog's sibling with a single text input; Enter confirms. */
export function PromptDialog({
  title,
  body,
  initialValue,
  placeholder,
  confirmLabel,
  busyLabel,
  busyReserve,
  busy,
  validate,
  hint,
  onCancel,
  onConfirm,
  onDone
}: PromptDialogProps) {
  const { tr } = useI18n();
  const [value, setValue] = useState(initialValue);
  // The value whose error or hint is on show: it trails typing by a pause,
  // so a half-typed `work/` doesn't flash a format error (or flip the button
  // between Rename and Merge) on every keystroke.
  const [settledValue, setSettledValue] = useState(initialValue);
  const [closing, setClosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [settled, setSettled] = useState(false);
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef(0);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const initial = initialValue.trim();
  function verdict(candidate: string): Verdict {
    // The untouched value says nothing: a rename that opens on the old name
    // simply can't be confirmed yet ("unchanged" only disables the button).
    if (!candidate || candidate === initial) return { error: null, notice: null };
    const error = validate(candidate);
    if (error) return { error, notice: null };
    const raw = hint?.(candidate) ?? null;
    return { error: null, notice: typeof raw === "string" ? { text: raw } : raw };
  }

  const trimmed = value.trim();
  const current = verdict(trimmed);
  const shown = settledValue === value ? current : verdict(settledValue.trim());
  // While typing, a note that no longer holds clears at once; a new one waits for the pause.
  const shownStillTrue =
    settledValue === value ||
    (shown.error ? shown.error === current.error : shown.notice ? shown.notice.text === current.notice?.text : true);
  const liveNote = shownStillTrue ? shown : { error: null, notice: null };
  const held = pending || settled;
  const busyLook = Boolean(busy) || held;
  const canConfirm = trimmed.length > 0 && !validate(trimmed) && !busyLook && !closing;

  // From the confirm on, the note and the action it named stay as they were:
  // the work itself changes what validate/hint would say (a renamed tag now
  // exists, which reads as a merge) and the exit must not flash that.
  const liveIdleLabel = liveNote.notice?.confirmLabel ?? confirmLabel;
  const frozenRef = useRef({ note: liveNote, idleLabel: liveIdleLabel });
  if (!busyLook) frozenRef.current = { note: liveNote, idleLabel: liveIdleLabel };
  const note = busyLook ? frozenRef.current.note : liveNote;
  const notice = note.notice;
  const idleLabel = busyLook ? frozenRef.current.idleLabel : liveIdleLabel;
  // The same action's live busy label carries the progress figure.
  const noticeBusyLabel =
    notice?.busyLabel && current.notice?.busyLabel && current.notice.confirmLabel === notice.confirmLabel ? current.notice.busyLabel : notice?.busyLabel;
  const busyText = noticeBusyLabel ?? busyLabel ?? tr("Processing…", "处理中…");
  const lastBusyTextRef = useRef<string | null>(null);
  if (busy) lastBusyTextRef.current = busyText;
  const shownBusyText = !busy && held && lastBusyTextRef.current ? lastBusyTextRef.current : busyText;
  const reserve = notice?.busyReserve ?? (notice?.busyLabel ? undefined : busyReserve);

  useEffect(() => {
    if (settledValue === value) return;
    const timer = window.setTimeout(() => setSettledValue(value), NOTE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [value, settledValue]);

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

  /**
   * Submitting says what the pause would have: a pending error or hint shows
   * now. True when one names an irreversible consequence (a merge) the
   * reader hasn't seen yet — that press stops, so the next one is informed.
   */
  function flushNote(): boolean {
    if (settledValue === value) return false;
    setSettledValue(value);
    return Boolean(current.notice?.strong && note.notice?.text !== current.notice.text);
  }

  function submit() {
    if (flushNote() || !canConfirm) return;
    const outcome = onConfirm(trimmed);
    if (outcome === true) finish();
    else if (outcome && typeof outcome === "object") {
      setPending(true);
      const release = () => {
        if (mountedRef.current) setPending(false);
      };
      void outcome.then((result) => {
        if (result === true) finish();
        else release();
      }, release);
    }
  }

  const overlayRef = useModalA11y<HTMLDivElement>({
    onEscape: requestClose,
    escapeDisabled: busyLook,
    initialFocusRef: inputRef
  });
  useKeyboardInset(overlayRef);
  const backdrop = useBackdropDismiss(requestClose);

  useEffect(() => {
    mountedRef.current = true;
    inputRef.current?.select();
    return () => {
      mountedRef.current = false;
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  const noteKey = note.error ? `error:${note.error}` : notice ? `notice:${notice.text}` : "empty";

  return (
    <div
      ref={overlayRef}
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      aria-busy={busyLook || undefined}
      tabIndex={-1}
      {...backdrop}
    >
      <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        {body ? <p>{body}</p> : null}
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            className="prompt-input"
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            disabled={busyLook}
            aria-invalid={note.error ? true : undefined}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // Enter's implicit submission skips a disabled button, so the
              // pending note is flushed here rather than in submit().
              if (event.key === "Enter" && !event.nativeEvent.isComposing && flushNote()) event.preventDefault();
            }}
          />
          {/* The row is always there, so a note arriving or leaving never
              changes the card's (or the sheet's) height. */}
          <p className={`prompt-note${note.error ? " is-error" : notice?.strong ? " is-strong" : ""}`}>
            {note.error ? (
              <span key={noteKey} role="alert">
                {note.error}
              </span>
            ) : notice ? (
              <span key={noteKey}>{notice.text}</span>
            ) : null}
          </p>
          <div className="confirm-actions">
            <button type="button" className="ghost-button" onClick={requestClose} disabled={busyLook}>
              {tr("Cancel", "取消")}
            </button>
            <button type="submit" className="accent-button" disabled={!canConfirm}>
              <span className="busy-swap">
                <span aria-hidden={busyLook || undefined}>{idleLabel}</span>
                {busyLabel !== undefined || notice?.busyLabel !== undefined || busyLook ? (
                  <span aria-hidden={!busyLook || undefined}>{shownBusyText}</span>
                ) : null}
                {reserve ? <span aria-hidden="true">{reserve}</span> : null}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
