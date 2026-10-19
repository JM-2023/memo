import { Check, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { boopCard, useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { useModalA11y } from "../hooks/useModalA11y";
import { nudgeRefusal, useCloseSignal, useOverlayExit } from "../hooks/useOverlayExit";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import { DONE_HOLD_MS } from "../lib/motion";
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
  /** What the button says once this action went through. */
  doneLabel?: string;
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
  /** Said once a confirm that was under way went through; defaults to "Done". */
  doneLabel?: string;
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
  /** Bumped by Back: leave as Cancel would (a busy dialog holds). */
  closeSignal?: number;
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
  doneLabel,
  busy,
  validate,
  hint,
  onCancel,
  onConfirm,
  onDone,
  closeSignal
}: PromptDialogProps) {
  const { tr } = useI18n();
  const [value, setValue] = useState(initialValue);
  // The value whose error or hint is on show: it trails typing by a pause,
  // so a half-typed `work/` doesn't flash a format error (or flip the button
  // between Rename and Merge) on every keystroke.
  const [settledValue, setSettledValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [settled, setSettled] = useState(false);
  // A confirm that went through after a wait says so before the exit.
  const [done, setDone] = useState(false);
  const doneTimerRef = useRef(0);
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const noteId = useId();
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
  // An edited draft isn't thrown away by a stray tap on the backdrop, a
  // sheet pulled down or Back; Esc, Cancel and the explicit close still go.
  const dirtyRef = useRef(false);
  dirtyRef.current = value !== initialValue;

  const overlayRef = useModalA11y<HTMLDivElement>({
    onEscape: requestClose,
    escapeDisabled: busyLook,
    initialFocusRef: inputRef
  });
  const { closing, closingRef, leave } = useOverlayExit(overlayRef);
  useKeyboardInset(overlayRef);
  const backdrop = useBackdropDismiss(requestClose, { resist: () => dirtyRef.current });
  useCloseSignal(closeSignal, requestBack);

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

  function requestClose() {
    if (busyLook || closingRef.current) return;
    leave(() => cancelRef.current());
  }

  /** Back is a stray dismissal too: a draft (or busy work) stays, and the card says so. */
  function requestBack() {
    if (closingRef.current) return;
    if (dirtyRef.current || busyLook) boopCard(overlayRef.current);
    else requestClose();
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
    if (flushNote()) return;
    if (!canConfirm) {
      refuse();
      return;
    }
    const outcome = onConfirm(trimmed);
    if (outcome === true) finish();
    else if (outcome && typeof outcome === "object") {
      setPending(true);
      const release = () => {
        if (mountedRef.current) setPending(false);
      };
      void outcome.then((result) => {
        if (result === true) finish(true);
        else release();
      }, release);
    }
  }

  /**
   * A press that can't go through (an empty field, an unchanged name, an
   * error already on show) used to do nothing at all. It answers the way a
   * refused passcode does, at a smaller size: the field nudges. Not while
   * busy or leaving — that press was heard.
   */
  function refuse() {
    if (busyLook || closingRef.current) return;
    nudgeRefusal(inputRef.current, reducedMotion);
  }

  useEffect(() => {
    mountedRef.current = true;
    inputRef.current?.select();
    return () => {
      mountedRef.current = false;
      window.clearTimeout(doneTimerRef.current);
    };
  }, []);

  const noteKey = note.error ? `error:${note.error}` : notice ? `notice:${notice.text}` : "empty";

  return (
    <div
      ref={overlayRef}
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      aria-busy={busyLook || undefined}
      tabIndex={-1}
      {...backdrop}
    >
      <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        {body ? <p id={bodyId}>{body}</p> : null}
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
            aria-describedby={body ? `${bodyId} ${noteId}` : noteId}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // Enter's implicit submission skips a disabled button, so the
              // pending note is flushed — and a refusal answered — here
              // rather than in submit().
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              if (flushNote()) event.preventDefault();
              else if (!canConfirm) refuse();
            }}
          />
          {/* The row is always there, so a note arriving or leaving never
              changes the card's (or the sheet's) height — and, standing from
              the start, it is a live region a screen reader hears a hint
              arrive in. An error, or a strong notice (one that stops the
              first press, see flushNote), is an alert: the press it answers
              must not go by in silence, or the next one merges for good. */}
          <p id={noteId} className={`prompt-note${note.error ? " is-error" : notice?.strong ? " is-strong" : ""}`} aria-live="polite">
            {note.error ? (
              <span key={noteKey} role="alert">
                {note.error}
              </span>
            ) : notice ? (
              <span key={noteKey} role={notice.strong ? "alert" : undefined}>
                {notice.text}
              </span>
            ) : null}
          </p>
          <div className="confirm-actions">
            <button type="button" className="ghost-button" onClick={requestClose} disabled={busyLook}>
              {tr("Cancel", "取消")}
            </button>
            <button type="submit" className={`accent-button${busyLook ? " is-busy" : ""}`} disabled={!canConfirm}>
              {/* The busy label wears the spinner every busy action does, the
                  done one its check; the reserve carries one too, so the
                  widest figure fits. */}
              <span className="busy-swap" data-done={done || undefined}>
                <span aria-hidden={busyLook || undefined}>{idleLabel}</span>
                {busyLabel !== undefined || notice?.busyLabel !== undefined || busyLook ? (
                  <>
                    <span aria-hidden={!busyLook || done || undefined}>
                      <Loader2 size={14} className="spin busy-spinner" aria-hidden="true" />
                      {shownBusyText}
                    </span>
                    <span aria-hidden={!done || undefined}>
                      <Check size={14} className="busy-spinner" aria-hidden="true" />
                      {notice?.doneLabel ?? doneLabel ?? tr("Done", "已完成")}
                    </span>
                  </>
                ) : null}
                {reserve ? (
                  <span aria-hidden="true">
                    <Loader2 size={14} className="busy-spinner" aria-hidden="true" />
                    {reserve}
                  </span>
                ) : null}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
