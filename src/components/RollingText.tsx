import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties } from "react";
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

interface SlotGhost {
  char: string;
  serial: number;
  up: boolean;
}

interface Slot {
  /** Column id measured from the anchored edge — also the stagger index. */
  key: number;
  /** Current character, with roll metadata while its entrance plays. */
  char: string | null;
  /** Set while the entrance animation runs; cleared on animationend. */
  roll: { serial: number; up: boolean } | null;
  /** Outgoing characters still tipping off the drum, newest last. */
  ghosts: SlotGhost[];
  /** Born after mount, so its track grows in from 0fr. */
  grew: boolean;
}

interface RollState {
  value: number;
  text: string;
  slots: Slot[];
  serial: number;
}

function slotsFor(text: string, align: "right" | "left"): Slot[] {
  return Array.from({ length: text.length }, (_, index) => ({
    key: align === "right" ? text.length - 1 - index : index,
    char: text[index],
    roll: null,
    ghosts: [],
    grew: false
  }));
}

/**
 * Split-flap value: when the text changes, each changed character rolls over
 * on a 3D drum — the old one tips away over the top while the new one rides
 * in from below on the same wheel (mirrored when the value decreases),
 * rippling outward from the units column. Unchanged characters hold still,
 * and a change that lands mid-roll stacks another ghost on the drum instead
 * of snapping, so fast paging reads as the wheel spinning through. Column
 * count changes grow/collapse through an animated 0fr track, so the width
 * morphs instead of jumping. Screen readers only see the plain text.
 */
export function RollingText({ value, text, align = "right", className }: RollingTextProps) {
  const { formatNumber } = useI18n();
  const display = text ?? formatNumber(value);
  const [st, setSt] = useState<RollState>(() => ({ value, text: display, slots: slotsFor(display, align), serial: 0 }));

  if (st.text !== display) {
    // Derive-during-render: fold the new text into the column model before
    // anything paints. Columns whose character survives keep their slot (and
    // any in-flight animation) untouched.
    const up = value >= st.value;
    const serial = st.serial + 1;
    const oldByKey = new Map(st.slots.map((slot) => [slot.key, slot]));
    const keys = new Set<number>();
    for (let index = 0; index < display.length; index += 1) keys.add(align === "right" ? display.length - 1 - index : index);
    for (const slot of st.slots) if (slot.ghosts.length > 0 || slot.char !== null) keys.add(slot.key);

    const slots: Slot[] = [...keys]
      .sort((a, b) => (align === "right" ? b - a : a - b))
      .map((key) => {
        const index = align === "right" ? display.length - 1 - key : key;
        const char = index >= 0 && index < display.length ? display[index] : null;
        const old = oldByKey.get(key);
        if (old && old.char === char) return old;
        const ghosts = old ? [...old.ghosts, ...(old.char !== null ? [{ char: old.char, serial, up }] : [])] : [];
        return {
          key,
          char,
          roll: char !== null ? { serial, up } : null,
          ghosts,
          grew: old === undefined
        };
      });
    setSt({ value, text: display, slots, serial });
  }

  // Ghosts and roll flags normally clear themselves on animationend; this
  // sweep is the safety net for events that never fire (tab hidden mid-roll,
  // animations cancelled), so stray ghosts can't prop columns open forever.
  const serialRef = useRef(st.serial);
  serialRef.current = st.serial;
  useEffect(() => {
    if (st.serial === 0) return;
    const timer = window.setTimeout(() => {
      if (serialRef.current !== st.serial) return;
      setSt((state) =>
        state.serial === st.serial
          ? {
              ...state,
              slots: state.slots
                .map((slot) => (slot.ghosts.length > 0 || slot.roll ? { ...slot, ghosts: [], roll: null } : slot))
                .filter((slot) => slot.char !== null)
            }
          : state
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [st.serial]);

  function onAnimationEnd(event: AnimationEvent<HTMLSpanElement>) {
    const name = event.animationName;
    const isOut = name.startsWith("roll-char-out");
    const isIn = name.startsWith("roll-char-in");
    if (!isOut && !isIn) return;
    const target = event.target as HTMLElement;
    const key = Number(target.dataset.rollKey);
    const serial = Number(target.dataset.rollSerial);
    if (Number.isNaN(key) || Number.isNaN(serial)) return;
    setSt((state) => {
      const slots = state.slots
        .map((slot) => {
          if (slot.key !== key) return slot;
          if (isOut) return { ...slot, ghosts: slot.ghosts.filter((ghost) => ghost.serial !== serial) };
          return slot.roll?.serial === serial ? { ...slot, roll: null } : slot;
        })
        .filter((slot) => slot.char !== null || slot.ghosts.length > 0);
      return { ...state, slots };
    });
  }

  return (
    <span className={`roll${className ? ` ${className}` : ""}`} role="text" aria-label={st.text}>
      <span className="roll-inner" aria-hidden="true" onAnimationEnd={onAnimationEnd}>
        {st.slots.map((slot) => (
          <span
            key={slot.key}
            className={`roll-slot${slot.char === null ? " is-collapse" : ""}${slot.grew ? " is-grow" : ""}`}
            style={{ "--ri": Math.min(slot.key, 6) } as CSSProperties}
          >
            <span className="roll-pane">
              {slot.ghosts.map((ghost) => (
                <span
                  key={`g${ghost.serial}`}
                  className={`roll-char roll-char-out ${ghost.up ? "is-up" : "is-down"}`}
                  data-roll-key={slot.key}
                  data-roll-serial={ghost.serial}
                >
                  {ghost.char}
                </span>
              ))}
              {slot.char !== null ? (
                slot.roll ? (
                  <span
                    key={`c${slot.roll.serial}`}
                    className={`roll-char roll-char-in ${slot.roll.up ? "is-up" : "is-down"}`}
                    data-roll-key={slot.key}
                    data-roll-serial={slot.roll.serial}
                  >
                    {slot.char}
                  </span>
                ) : (
                  <span key="c" className="roll-char">
                    {slot.char}
                  </span>
                )
              ) : null}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
