import { Check, Delete } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useI18n } from "../lib/i18n";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "delete", "0", "submit"] as const;
type PadKey = (typeof keys)[number] | "clear";

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 18;

interface PasscodePadProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  error?: boolean;
  busy?: boolean;
  /** Bump to clear the current entry (step change or failed attempt). */
  entryKey?: number;
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
  onInput,
  onComplete,
  autoComplete = "current-password",
  rootRef
}: PasscodePadProps) {
  const { tr } = useI18n();
  const [value, setValue] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const busyRef = useRef(Boolean(busy));
  const completingRef = useRef(false);
  const onInputRef = useRef(onInput);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    busyRef.current = Boolean(busy);
    onInputRef.current = onInput;
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    valueRef.current = "";
    completingRef.current = false;
    setValue("");
  }, [entryKey]);

  useEffect(() => {
    if (!busy) completingRef.current = false;
  }, [busy]);

  function update(next: string) {
    valueRef.current = next;
    setValue(next);
  }

  function press(key: PadKey) {
    if (busyRef.current) return;
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
    completingRef.current = false;
    onInputRef.current?.();
    update(text.replace(/\D/g, "").slice(0, MAX_PIN_LENGTH));
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
      if (inField && ((event.key >= "0" && event.key <= "9") || event.key === "Backspace")) return;
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

  return (
    <section ref={rootRef} className={`pin-pad${error ? " shake" : ""}`} aria-label={title} aria-busy={busy || undefined} tabIndex={-1}>
      <div className="pin-brand">
        <div className="pin-logo">{icon}</div>
        <h1>{title}</h1>
        <p role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">
          {subtitle}
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
        <div className={`pin-dots${error ? " error" : ""}`} aria-hidden="true">
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
                className="keypad-action"
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
            <button key={key} type="button" onClick={() => press(key)} disabled={busy} aria-label={key}>
              {key}
            </button>
          );
        })}
      </div>
    </section>
  );
}
