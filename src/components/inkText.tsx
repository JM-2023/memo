/**
 * Ink the paper can take back.
 *
 * The share card's removable marks — the dateline, the wordmark and the
 * tags — don't blink out when they are hidden and don't blink back when they
 * return. They are absorbed and re-written, using the Riddle diary's own two
 * gestures, painted on a canvas laid over the mark (src/lib/inkCanvas.ts):
 * the page drinks the ink pixel by pixel in the diary's hash order, and the
 * pen lays it down again stroke by stroke, left to right.
 *
 * The DOM text never moves: it only goes transparent while the canvas holds
 * the ink, so the line breaks exactly where it will when it settles, and a
 * settled card is plain text for the export to serialize.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { playInk } from "../lib/inkCanvas";

/** Which way the ink is going, or null once it has settled. */
export type InkPhase = "drink" | "write" | null;

/* The diary absorbs over about a second; a control that answers a finger
   can't take that long, so the same dissolve runs on a shorter clock. The
   pen's pace is set per glyph so a long tag takes longer than a short one,
   the way a hand would. */
const DRINK_MS = 720;
const WRITE_STEP_MS = 28;
const WRITE_STROKE_MS = 160;

/** How long the paper takes to drink a mark, whatever its length. */
export const INK_DRINK_MS = DRINK_MS;

/** How long the pen takes to write the marks back — set by the longest one,
    since they all start together, plus any wait before the pen is put down. */
export function inkWriteMs(longestMark: number, lead = 0): number {
  return lead + Math.max(0, longestMark - 1) * WRITE_STEP_MS + WRITE_STROKE_MS;
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
  const hostRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // A reversal mid-flight restarts cleanly from the other gesture's start.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!phase || !host || !canvas) return;
    return playInk(host, canvas, {
      gesture: phase,
      // Code points, matching the dialog's own clock for the longest mark.
      durationMs: phase === "drink" ? INK_DRINK_MS : inkWriteMs([...text].length, lead),
      leadMs: phase === "write" ? lead : 0
    });
  }, [phase, text, lead]);

  if (!phase) {
    return (
      <span ref={hostRef} className={className}>
        {text}
      </span>
    );
  }
  return (
    <span ref={hostRef} className={`${className ? `${className} ` : ""}${phase === "drink" ? "is-drinking" : "is-writing"}`}>
      {/* Zero-height, on the baseline: where the canvas sets its type. */}
      <span className="sc-ink-base" aria-hidden="true" />
      {text}
      <canvas ref={canvasRef} className="sc-ink" aria-hidden="true" />
    </span>
  );
}

/**
 * The clock for one mark's leaving and returning. Holds the gesture's phase
 * for exactly as long as the canvas needs to run it, then lets the mark go —
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
