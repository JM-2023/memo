/**
 * Ink the paper can take back.
 *
 * The share card's two removable marks — the wordmark and the tags — don't
 * blink out when privacy mode hides them and don't blink back when it lets
 * them return. They are absorbed and re-written, using the Riddle diary's
 * own two gestures: the page drinks the ink (every glyph sinking on its own
 * beat, dealt from the diary's per-pixel hash so the absorption reads as
 * granular rather than as a wipe), and the pen lays it down again stroke by
 * stroke, left to right.
 *
 * Split into glyphs only while something is actually moving: a settled card
 * is plain text, so the export never serializes a pile of per-character
 * spans, and the line breaks exactly where it would have anyway.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

/** Which way the ink is going, or null once it has settled. */
export type InkPhase = "drink" | "write" | null;

/** The diary's per-pixel hash (ink.rs px_hash, via riddle-ink.js), reused
    per glyph to deal each one a dissolve stage. */
function pxHash(x: number, y: number): number {
  let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/* The diary absorbs in 14 passes of 70ms; a control that answers a finger
   can't take a second and a half, so the same pattern is dealt over a
   shorter clock. The soak and stroke lengths themselves live in app.css
   (ink-drink / ink-write) — these mirror them to time the unmount. */
const DRINK_STAGES = 12;
const DRINK_STAGE_MS = 32;
const DRINK_SOAK_MS = 380;
const WRITE_STEP_MS = 28;
const WRITE_STROKE_MS = 160;

/** How long the paper takes to drink a mark, whatever its length: every
    glyph is dealt one of the stages, so the last one starts at the same
    moment no matter how many there are. */
export const INK_DRINK_MS = (DRINK_STAGES - 1) * DRINK_STAGE_MS + DRINK_SOAK_MS;

/** How long the pen takes to write the marks back — set by the longest one,
    since they all start together, plus any wait before the pen is put down. */
export function inkWriteMs(longestMark: number, lead = 0): number {
  return lead + Math.max(0, longestMark - 1) * WRITE_STEP_MS + WRITE_STROKE_MS;
}

function delayOf(phase: Exclude<InkPhase, null>, index: number, total: number, lead: number): number {
  if (phase === "write") return lead + index * WRITE_STEP_MS;
  return (pxHash(index, total) % DRINK_STAGES) * DRINK_STAGE_MS;
}

interface InkTextProps {
  text: string;
  phase: InkPhase;
  className?: string;
  /** A beat before the pen touches down, for a mark whose room on the page
      has to open up first. Ignored on the way out — the page can drink from
      a line it is already closing. */
  lead?: number;
}

export function InkText({ text, phase, className, lead = 0 }: InkTextProps) {
  if (!phase) return <span className={className}>{text}</span>;
  // Code points, not code units: an emoji tag must sink as one mark.
  const glyphs = [...text];
  return (
    <span className={`${className ? `${className} ` : ""}${phase === "drink" ? "is-drinking" : "is-writing"}`}>
      {glyphs.map((glyph, index) => (
        // Keyed by phase so a reversal mid-flight replaces the nodes and
        // restarts cleanly, instead of retargeting a half-faded glyph.
        <span
          key={`${phase}-${index}`}
          className="sc-glyph"
          style={{ "--ink-delay": `${delayOf(phase, index, glyphs.length, lead)}ms` } as CSSProperties}
        >
          {glyph}
        </span>
      ))}
    </span>
  );
}

/**
 * The clock for one mark's leaving and returning. Holds the gesture's phase
 * for exactly as long as app.css needs to run it, then lets the mark go —
 * or, under reduced motion, never starts one at all.
 *
 * One of these per mark that can leave the page, so a dateline and a
 * wordmark can be travelling in opposite directions at once.
 */
export function useInkPhase(reducedMotion: boolean) {
  const [phase, setPhase] = useState<InkPhase>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    phase,
    /** Send the mark away, or bring it back over `writeMs`. */
    run(leaving: boolean, writeMs: number) {
      window.clearTimeout(timer.current);
      if (reducedMotion) {
        setPhase(null);
        return;
      }
      setPhase(leaving ? "drink" : "write");
      timer.current = window.setTimeout(() => setPhase(null), leaving ? INK_DRINK_MS : writeMs);
    },
    /** Cut a gesture short and land on its result — what an export does, so
        the PNG never catches a mark halfway. */
    settle() {
      window.clearTimeout(timer.current);
      setPhase(null);
    }
  };
}
