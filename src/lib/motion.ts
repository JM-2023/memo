/**
 * The app.css motion tokens, for the places CSS can't reach: Web Animations
 * and the timers that unmount a surface once its exit has played. app.css
 * (:root, "Motion") is the source; these are literal copies only because
 * WAAPI can't read a custom property — change the two together.
 */

/** --ease: the default settle. */
export const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
/** --ease-out: entrances and glides — a long damped settle. */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
/** --ease-pop: the micro overshoot small pops ride. */
export const EASE_POP = "cubic-bezier(0.3, 1.42, 0.52, 1)";

/** The duration steps, in ms: --t-fast, --t, --t-slow. */
export const T_FAST = 100;
export const T_BASE = 150;
export const T_SLOW = 220;
/** The surface roles, in ms: --t-enter for a thing arriving, --t-exit for it leaving. */
export const T_ENTER = 240;
export const T_EXIT = 160;
/** --t-morph: a control turning into something else (a busy label into its done state). */
export const T_MORPH = 300;
/**
 * How long a done state stands before its dialog leaves: the morph's pop,
 * then a beat to read the word.
 */
export const DONE_HOLD_MS = T_MORPH + 60;
/**
 * --t-hold: how long a busy look waits before it shows, so a fast round trip
 * never flashes a spinner or dims the controls.
 */
export const BUSY_HOLD_MS = 150;
/** A gesture that didn't commit (a drawer, sheet or toast let go short) springs home in this. */
export const SPRING_MS = 280;

/**
 * How long a script waits before unmounting a surface whose exit it can't
 * watch: the shared exit (--t-exit, 0.16s) plus a frame's slack.
 */
export const EXIT_MS = 170;
