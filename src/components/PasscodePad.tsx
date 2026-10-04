import { Check, Delete } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "delete", "0", "submit"] as const;
type PadKey = (typeof keys)[number] | "clear";

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 18;

/** A refused entry's dots stay up, red, through the shake before they go. */
const ERROR_HOLD_MS = 320;
const ERROR_FADE_MS = 120;
/** A hardware key's echo on its on-screen twin. */
const KEY_ECHO_MS = 120;

interface PasscodePadProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  error?: boolean;
  busy?: boolean;
  /** Bump to clear the current entry (step change or failed attempt). */
  entryKey?: number;
  /** Ordinal of a multi-step flow (current → new → confirm); a change slides the title in. */
  step?: number;
  /** Fires on every accepted key press, so the owner can clear its error state. */
  onInput?: () => void;
  onComplete: (pin: string) => void;
  /** What a password manager should offer: the saved passcode, or to save a new one. */
  autoComplete?: "current-password" | "new-password";
  /** The pad's root, for a modal owner that wants initial focus on it. */
  rootRef?: Ref<HTMLElement>;
}

function hasFinePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
}

function isOtherEditable(target: EventTarget | null, own: HTMLInputElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === own) return false;
  return target.isContentEditable || target.matches("input, textarea, select");
}

/**
 * The digit pad shared by login, first-run setup, and change-passcode. It
 * accepts 4–18 digits and submits through ✓/Enter, so the entry never reveals
 * the expected length; the dots row only mirrors how much was typed. The pad
 * owns only the digit buffer; the owner drives titles, error shakes, and when
 * the entry resets. Callbacks are read through refs so the window keydown
 * listener never acts through a stale step closure.
 *
 * A transparent password field over the dots row mirrors the buffer, so
 * password managers and the iOS keychain can fill (and offer to save) the
 * passcode, and pasting digits works anywhere on the pad. It takes focus by
 * itself only with a fine pointer; on touch screens it waits for a tap on
 * the dots row, so the system keyboard never covers the keypad uninvited.
 */
export function PasscodePad({
  icon,
  title,
  subtitle,
  error,
  busy,
  entryKey = 0,
  step = 0,
  onInput,
  onComplete,
  autoComplete = "current-password",
  rootRef
}: PasscodePadProps) {
  const { tr } = useI18n();
  const reducedMotion = useReducedMotion();
  const [value, setValue] = useState("");
  // A refused entry's dots: "hold" while the card shakes, then "fade".
  const [dotsExit, setDotsExit] = useState<"hold" | "fade" | null>(null);
  const [echoKey, setEchoKey] = useState<string | null>(null);
  const [shownStep, setShownStep] = useState(step);
  const [stepDir, setStepDir] = useState(0);
  if (shownStep !== step) {
    setShownStep(step);
    setStepDir(step > shownStep ? 1 : -1);
  }
  const fieldRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const busyRef = useRef(Boolean(busy));
  const completingRef = useRef(false);
  const onInputRef = useRef(onInput);
  const onCompleteRef = useRef(onComplete);
  const exitTimerRef = useRef(0);
  const echoTimerRef = useRef(0);
  const firstEntryRef = useRef(true);

  useEffect(() => {
    busyRef.current = Boolean(busy);
    onInputRef.current = onInput;
    onCompleteRef.current = onComplete;
  });

  /** Drops the held (refused) entry at once — the next key starts afresh. */
  function dropHeldEntry() {
    if (!exitTimerRef.current) return;
    window.clearTimeout(exitTimerRef.current);
    exitTimerRef.current = 0;
    valueRef.current = "";
    setValue("");
    setDotsExit(null);
  }

  useEffect(() => {
    window.clearTimeout(exitTimerRef.current);
    exitTimerRef.current = 0;
    completingRef.current = false;
    const refused = Boolean(error) && !firstEntryRef.current;
    firstEntryRef.current = false;
    if (refused) {
      try {
        navigator.vibrate?.([12, 40, 12]);
      } catch {
        // Haptics are a courtesy.
      }
    }
    const clear = () => {
      exitTimerRef.current = 0;
      valueRef.current = "";
      setValue("");
      setDotsExit(null);
    };
    // A refused entry stays on screen in red while the card shakes, so the
    // reader sees what was rejected; a step change simply starts afresh.
    if (!refused || reducedMotion || !valueRef.current) {
      clear();
      return;
    }
    setDotsExit("hold");
    exitTimerRef.current = window.setTimeout(() => {
      setDotsExit("fade");
      exitTimerRef.current = window.setTimeout(clear, ERROR_FADE_MS);
    }, ERROR_HOLD_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per entry
  }, [entryKey]);

  useEffect(
    () => () => {
      window.clearTimeout(exitTimerRef.current);
      window.clearTimeout(echoTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!busy) completingRef.current = false;
  }, [busy]);

  function update(next: string) {
    valueRef.current = next;
    setValue(next);
  }

  /** Flash the on-screen key a hardware key stands for. */
  function echo(key: PadKey) {
    if (busyRef.current) return;
    window.clearTimeout(echoTimerRef.current);
    setEchoKey(key);
    echoTimerRef.current = window.setTimeout(() => setEchoKey(null), KEY_ECHO_MS);
  }

  function press(key: PadKey) {
    if (busyRef.current) return;
    dropHeldEntry();
    if (key === "submit") {
      if (valueRef.current.length < MIN_PIN_LENGTH || completingRef.current) return;
      completingRef.current = true;
      onInputRef.current?.();
      onCompleteRef.current(valueRef.current);
      return;
    }
    completingRef.current = false;
    onInputRef.current?.();
    if (key === "clear") {
      update("");
      return;
    }
    if (key === "delete") {
      update(valueRef.current.slice(0, -1));
      return;
    }
    if (valueRef.current.length >= MAX_PIN_LENGTH) return;
    update(`${valueRef.current}${key}`);
  }

  /** Autofill, paste or typing into the field: its digits become the entry. */
  function fill(text: string) {
    if (busyRef.current) return;
    let next = text.replace(/\D/g, "");
    if (exitTimerRef.current) {
      // The field still mirrors the refused entry: a key typed after it
      // starts a new one, a deletion just clears it, and anything else
      // (autofill, paste) replaces it whole.
      const held = valueRef.current;
      dropHeldEntry();
      if (next.startsWith(held)) next = next.slice(held.length);
      else if (held.startsWith(next)) next = "";
    }
    completingRef.current = false;
    onInputRef.current?.();
    update(next.slice(0, MAX_PIN_LENGTH));
  }

  const pressRef = useRef(press);
  pressRef.current = press;
  const fillRef = useRef(fill);
  fillRef.current = fill;

  useEffect(() => {
    if (hasFinePointer()) fieldRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      // The field handles its own paste through onChange; other text fields
      // (a dialog behind a modal pad never has focus, but be safe) keep theirs.
      if (event.defaultPrevented || event.target === fieldRef.current || isOtherEditable(event.target, fieldRef.current)) return;
      const digits = (event.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
      if (!digits) return;
      event.preventDefault();
      fillRef.current(digits);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      // Typing into the focused field edits its value natively; onChange
      // mirrors that into the entry, so the shortcut must not add it twice.
      const inField = event.target === fieldRef.current;
      const digit = event.key.length === 1 && event.key >= "0" && event.key <= "9";
      if (digit) echo(event.key as PadKey);
      else if (event.key === "Backspace") echo("delete");
      if (inField && (digit || event.key === "Backspace")) return;
      if (event.key >= "0" && event.key <= "9") {
        pressRef.current(event.key as PadKey);
      } else if (event.key === "Backspace") {
        pressRef.current("delete");
      } else if (event.key === "Enter") {
        // A focused button receives its own native Enter-generated click. Let
        // that one activation own the key instead of also submitting through
        // this window shortcut (which would otherwise invoke onComplete twice).
        const active = event.target instanceof Element ? event.target : document.activeElement;
        if (active instanceof Element && active.closest("button")) return;
        // The field's form would otherwise submit implicitly as well.
        if (inField) event.preventDefault();
        pressRef.current("submit");
      } else if (event.key === "Escape") {
        pressRef.current("clear");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keyed by step: a step change slides its words in (forward or back); an
  // error or busy line swaps in place.
  const stepClass = stepDir > 0 ? "pin-step dir-fwd" : stepDir < 0 ? "pin-step dir-back" : "pin-step";

  return (
    <section ref={rootRef} className={`pin-pad${error ? " shake" : ""}`} aria-label={title} aria-busy={busy || undefined} tabIndex={-1}>
      <div className="pin-brand">
        <div className="pin-logo">{icon}</div>
        <h1>
          <span key={step} className={stepClass}>
            {title}
          </span>
        </h1>
        <p role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">
          <span key={step} className={stepClass}>
            {subtitle}
          </span>
        </p>
      </div>

      {/* A password manager submitting the form counts as ✓. */}
      <form
        className="pin-entry"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          press("submit");
        }}
      >
        {/* Password-only forms save more reliably with a fixed account name. */}
        <input type="text" name="username" autoComplete="username" value="MEMO" readOnly hidden />
        <input
          ref={fieldRef}
          className="pin-field"
          type="password"
          name="passcode"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={MAX_PIN_LENGTH}
          autoComplete={autoComplete}
          aria-label={tr("Passcode", "密码")}
          value={value}
          readOnly={busy}
          onChange={(event) => fill(event.target.value)}
        />
        <div className={`pin-dots${error ? " error" : ""}${dotsExit === "fade" ? " is-clearing" : ""}`} aria-hidden="true">
          {Array.from({ length: value.length }).map((_, index) => (
            <span key={index} />
          ))}
        </div>
      </form>

      <div className="keypad">
        {keys.map((key) => {
          if (key === "delete") {
            return (
              <button
                key={key}
                type="button"
                className={`keypad-action${echoKey === key ? " is-pressed" : ""}`}
                onClick={() => press(key)}
                disabled={busy || !value}
                aria-label={tr("Delete", "删除")}
              >
                <Delete size={22} aria-hidden="true" />
              </button>
            );
          }
          if (key === "submit") {
            return (
              <button
                key={key}
                type="button"
                className="keypad-action confirm"
                onClick={() => press(key)}
                disabled={busy || value.length < MIN_PIN_LENGTH}
                aria-label={tr("Confirm", "确认")}
              >
                <Check size={24} aria-hidden="true" />
              </button>
            );
          }
          return (
            <button key={key} type="button" className={echoKey === key ? "is-pressed" : undefined} onClick={() => press(key)} disabled={busy} aria-label={key}>
              {key}
            </button>
          );
        })}
      </div>
    </section>
  );
}
