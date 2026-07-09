import { Delete } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "delete"] as const;
type PadKey = (typeof keys)[number];

export const PIN_LENGTH = 4;

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
}

/**
 * The 4-digit pad shared by login, first-run setup, and change-passcode. It
 * owns only the digit buffer; the owner drives titles, error shakes, and when
 * the entry resets. Callbacks are read through refs so the window keydown
 * listener never acts through a stale step closure.
 */
export function PasscodePad({ icon, title, subtitle, error, busy, entryKey = 0, onInput, onComplete }: PasscodePadProps) {
  const { tr } = useI18n();
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  const busyRef = useRef(Boolean(busy));
  const onInputRef = useRef(onInput);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    busyRef.current = Boolean(busy);
    onInputRef.current = onInput;
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    valueRef.current = "";
    setValue("");
  }, [entryKey]);

  function update(next: string) {
    valueRef.current = next;
    setValue(next);
  }

  function press(key: PadKey) {
    if (busyRef.current) return;
    onInputRef.current?.();
    if (key === "clear") {
      update("");
      return;
    }
    if (key === "delete") {
      update(valueRef.current.slice(0, -1));
      return;
    }
    if (valueRef.current.length >= PIN_LENGTH) return;
    const next = `${valueRef.current}${key}`;
    update(next);
    if (next.length === PIN_LENGTH) {
      onCompleteRef.current(next);
    }
  }

  const pressRef = useRef(press);
  pressRef.current = press;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key >= "0" && event.key <= "9") {
        pressRef.current(event.key as PadKey);
      } else if (event.key === "Backspace") {
        pressRef.current("delete");
      } else if (event.key === "Escape") {
        pressRef.current("clear");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <section className={`pin-pad${error ? " shake" : ""}`} aria-label={title}>
      <div className="pin-brand">
        <div className="pin-logo">{icon}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>

      <div className={`pin-dots${error ? " error" : ""}`} aria-hidden="true">
        {Array.from({ length: PIN_LENGTH }).map((_, index) => (
          <span key={index} className={index < value.length ? "filled" : ""} />
        ))}
      </div>

      <div className="keypad">
        {keys.map((key) => {
          if (key === "clear") {
            return (
              <button
                key={key}
                type="button"
                className="keypad-action"
                onClick={() => press(key)}
                disabled={busy || !value}
                aria-label={tr("Clear", "清空")}
              >
                C
              </button>
            );
          }
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
