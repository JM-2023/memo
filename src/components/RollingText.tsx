import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../lib/i18n";

interface RollingTextProps {
  /** Numeric value behind the text; its change decides the roll direction. */
  value: number;
  /** Rendered text; defaults to the locale-grouped number. */
  text?: string;
  /**
   * Which edge keeps column identity when the length changes: numbers keep
   * their odometer columns from the right, words (memo → memos) from the left.
   */
  align?: "right" | "left";
  className?: string;
}

interface RollState {
  value: number;
  text: string;
  prev: string | null;
  up: boolean;
  serial: number;
}

/**
 * Split-flap value: when the text changes, only the characters that differ
 * roll over on a 3D drum — the old one tips up and away over the top, the new
 * one rolls in from below (mirrored when the value decreases), rippling
 * outward from the units column. Unchanged characters hold perfectly still.
 * Column count changes grow/collapse through an animated 0fr track, so the
 * width morphs instead of jumping. Screen readers only see the plain text.
 */
export function RollingText({ value, text, align = "right", className }: RollingTextProps) {
  const { formatNumber } = useI18n();
  const display = text ?? formatNumber(value);
  const [st, setSt] = useState<RollState>({ value, text: display, prev: null, up: true, serial: 0 });
  if (st.text !== display) {
    // Derive-during-render: keep the outgoing text one update as `prev`.
    setSt({ value, text: display, prev: st.text, up: value >= st.value, serial: st.serial + 1 });
  }

  // Sweep the rolled-out ghosts once every column has settled — invisible,
  // but they'd otherwise keep propping the slot open at the wider of the two
  // characters (visible whenever widths differ, e.g. across scripts).
  useEffect(() => {
    if (st.prev === null) return;
    const timer = window.setTimeout(() => {
      setSt((value) => (value.serial === st.serial ? { ...value, prev: null } : value));
    }, 750);
    return () => window.clearTimeout(timer);
  }, [st.serial, st.prev]);

  const curr = st.text;
  const prev = st.prev;
  const length = Math.max(curr.length, prev?.length ?? 0);
  const currPad = align === "right" ? length - curr.length : 0;
  const prevPad = align === "right" ? length - (prev?.length ?? 0) : 0;

  const slots = Array.from({ length }, (_, index) => {
    const currIndex = index - currPad;
    const prevIndex = index - prevPad;
    return {
      char: currIndex >= 0 && currIndex < curr.length ? curr[currIndex] : null,
      old: prev !== null && prevIndex >= 0 && prevIndex < prev.length ? prev[prevIndex] : null,
      // Column id measured from the anchored edge — also the stagger index.
      key: align === "right" ? length - 1 - index : index
    };
  });

  return (
    <span className={`roll${className ? ` ${className}` : ""}`} role="text" aria-label={curr}>
      <span className={`roll-inner ${st.up ? "roll-up" : "roll-down"}`} aria-hidden="true">
        {slots.map((slot) => {
          const changed = prev !== null && slot.char !== slot.old;
          if (slot.char === null && !changed) return null;
          const slotClass =
            changed && slot.old === null ? " is-grow" : changed && slot.char === null ? " is-collapse" : "";
          return (
            <span
              key={slot.key}
              className={`roll-slot${slotClass}`}
              style={{ "--ri": Math.min(slot.key, 6) } as CSSProperties}
            >
              <span className="roll-pane">
                {changed && slot.old !== null ? (
                  <span key={`out-${st.serial}`} className="roll-char roll-char-out">
                    {slot.old}
                  </span>
                ) : null}
                {slot.char !== null ? (
                  changed ? (
                    <span key={`in-${st.serial}`} className="roll-char roll-char-in">
                      {slot.char}
                    </span>
                  ) : (
                    <span key="still" className="roll-char">
                      {slot.char}
                    </span>
                  )
                ) : null}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
