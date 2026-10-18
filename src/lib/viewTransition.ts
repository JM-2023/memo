/** Where a running transition paints one snapshot, against its element's box. */
interface PaintedOffset {
  dx: number;
  dy: number;
  opacity: number;
}

interface ActiveTransition {
  transition: ViewTransition;
  /** Pseudo-elements exist (ready resolved) and nothing has skipped it yet. */
  live: boolean;
}

let active: ActiveTransition | null = null;

/**
 * Runs a change inside a same-document view transition, for the few morphs
 * that need snapshots: the sent text becoming its card (App, landCreated),
 * a feed tile growing into the viewer's photo (Lightbox), and the splash's
 * brand mark landing on the gate. Only the parts a morph names take part;
 * the rest of the page stays live under it (app.css, view-transition
 * section) — the feed's own motion is lib/feedMotion.ts. The callback must
 * leave the DOM in its final state before it returns — React callers wrap
 * their setState in flushSync themselves — and receives whether a snapshot
 * transition is being attempted. Falls back to calling the update directly
 * when the API is unavailable.
 */
export function withViewTransition(update: (animated: boolean) => void): ViewTransition | null {
  if (!document.startViewTransition) {
    update(false);
    return null;
  }
  installPressRelay();
  const transition = document.startViewTransition(() => update(true));
  const entry: ActiveTransition = { transition, live: false };
  active = entry;
  // A transition can be skipped — another one starting on top of it, the tab
  // going non-visible mid-capture — and a skip rejects `ready`. The DOM update
  // still lands (that is all `update` does), so the only thing left to do with
  // the rejection is keep it from surfacing as an unhandled one.
  Promise.resolve(transition.ready).then(
    () => {
      if (active === entry) entry.live = true;
    },
    () => undefined
  );
  const done = () => {
    if (active === entry) active = null;
  };
  Promise.resolve(transition.finished).then(done, done);
  return transition;
}

/** Is a transition's pseudo-element tree on screen right now? */
export function transitionLive(): boolean {
  return active?.live === true;
}

/** End the transition on screen at once; the DOM already holds its end state. */
export function skipLiveTransition(): void {
  if (!active?.live) return;
  active.live = false;
  active.transition.skipTransition();
}

/**
 * A press made while a transition is on screen. The browser does not
 * hit-test an element its snapshot is drawing, so a press on a card, the top
 * bar or the composer lands on the nearest element that isn't captured: the
 * feed, <main>, or <html> while reduced motion captures the page. Its click
 * was lost. The reader is pressing what they see, so the transition ends
 * there (the DOM already holds its end state) and the press goes on to the
 * element drawn under the pointer: pointer capture brings that element the
 * pointerup and the click, and the down events are replayed to it. A press
 * beside every snapshot (the sidebar) already reached its element and leaves
 * the transition running, so a second pick still carries on from the
 * painted frame.
 */
let relayInstalled = false;
/** The press being carried over, until its mousedown has been handed on. */
let relayed: { landedOn: Element; target: Element } | null = null;
/** Set while a relayed down event is dispatched: that one is the relay's own. */
let replaying = false;

function replay(target: Element, event: Event): boolean {
  replaying = true;
  try {
    return target.dispatchEvent(event);
  } finally {
    replaying = false;
  }
}

function installPressRelay(): void {
  if (relayInstalled || typeof document.addEventListener !== "function") return;
  relayInstalled = true;
  document.addEventListener("pointerdown", relayPress, true);
  document.addEventListener("mousedown", relayMouseDown, true);
  const settle = () => {
    relayed = null;
  };
  document.addEventListener("pointerup", settle, true);
  document.addEventListener("pointercancel", settle, true);
}

function relayPress(event: PointerEvent): void {
  if (replaying) return;
  relayed = null;
  if (!event.isPrimary || event.button !== 0 || !active?.live) return;
  const landedOn = event.target;
  if (!(landedOn instanceof Element)) return;
  const point = pressedPoint(landedOn, event.clientX, event.clientY);
  if (!point) return;
  skipLiveTransition();
  const target = document.elementFromPoint(point.x, point.y);
  if (!target || target === landedOn || !landedOn.contains(target)) return;
  event.stopImmediatePropagation();
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    // The pointer is already gone; the down events still reach the target.
  }
  relayed = { landedOn, target };
  replay(target, new PointerEvent("pointerdown", event));
}

function relayMouseDown(event: MouseEvent): void {
  if (replaying) return;
  const press = relayed;
  relayed = null;
  if (!press || event.target !== press.landedOn) return;
  event.stopImmediatePropagation();
  // Its default would move focus by the element it landed on.
  event.preventDefault();
  if (replay(press.target, new MouseEvent("mousedown", event))) focusPressed(press.target);
}

/** What a mousedown focuses, Chromium's way: buttons included. */
const PRESS_FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, iframe, [contenteditable]:not([contenteditable='false']), [tabindex]";

/** The focus move a mousedown on `target` makes when nothing prevents it. */
function focusPressed(target: Element): void {
  const focusable = target.closest<HTMLElement>(PRESS_FOCUSABLE);
  if (focusable && !focusable.matches(":disabled")) {
    focusable.focus({ preventScroll: true });
    return;
  }
  const current = document.activeElement;
  if (current instanceof HTMLElement && current !== document.body) current.blur();
}

/**
 * Where, in the live DOM, a press at (x, y) was aimed, if a snapshot is
 * drawn there; null when the press reached an element of its own. Each
 * captured element is found where its snapshot paints it (a card mid-glide,
 * the composer growing a context row), and the point is carried into the
 * element's settled box. The top bar, the composer and the rest paint above
 * the cards, and an inner snapshot (the searchbox) above the one around it.
 * Something on its way out, or not yet faded in, takes no press.
 */
function pressedPoint(landedOn: Element, x: number, y: number): { x: number; y: number } | null {
  const inside = (box: DOMRect, px: number, py: number) => px >= box.left && px <= box.right && py >= box.top && py <= box.bottom;
  // A card's own contents carry no names (the lightbox tile's is only ever
  // on during its own morph), so its subtree needn't be read.
  const candidates = [landedOn, ...landedOn.querySelectorAll(":not(.memo-slot *)")];
  const offsets = readPaintedOffsets(() => true);
  let part: { x: number; y: number } | null = null;
  let card: { x: number; y: number } | null = null;
  for (const element of candidates) {
    const name = getComputedStyle(element).viewTransitionName;
    if (!name || name === "none") continue;
    // No animation of its own: drawn where it stands.
    const offset = offsets.get(name) ?? { dx: 0, dy: 0, opacity: 1 };
    if (offset.opacity < 0.5) continue;
    const point = { x: x - offset.dx, y: y - offset.dy };
    if (!inside(element.getBoundingClientRect(), point.x, point.y)) continue;
    if (!element.classList.contains("memo-slot")) part = point;
    else card ??= point;
  }
  return part ?? card;
}

const PSEUDO = /^::view-transition-(group|old|new)\(([^)]*)\)$/;

function translationOf(transform: string): { x: number; y: number } {
  if (!transform || transform === "none" || typeof DOMMatrixReadOnly !== "function") return { x: 0, y: 0 };
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/**
 * Where the running transition paints each snapshot the `wanted` names pick,
 * as an offset from its element's box in the live DOM (which already sits at
 * the transition's end), by view-transition-name. A pair whose group moves is
 * painted by the group: its transform now minus its transform at the end
 * (read by seeking the group's animation to its end and back within this
 * task — nothing paints in between). A pair whose group doesn't move (the
 * reduced-motion dissolve) paints in place; a snapshot arriving alone, where
 * its image is. Ones leaving (old image only) are not in the DOM.
 */
function readPaintedOffsets(wanted: (name: string) => boolean): Map<string, PaintedOffset> {
  const offsets = new Map<string, PaintedOffset>();
  if (!active?.live || typeof document.getAnimations !== "function") return offsets;
  const groups = new Map<string, Animation>();
  const arriving = new Set<string>();
  const leaving = new Set<string>();
  for (const animation of document.getAnimations()) {
    const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement ?? "";
    const match = PSEUDO.exec(pseudo);
    if (!match || !wanted(match[2])) continue;
    const [, part, name] = match;
    if (part === "group") groups.set(name, animation);
    else if (part === "new") arriving.add(name);
    else leaving.add(name);
  }
  const root = document.documentElement;
  for (const name of arriving) {
    const group = groups.get(name);
    if (!group && leaving.has(name)) {
      offsets.set(name, { dx: 0, dy: 0, opacity: 1 });
    } else if (group && leaving.has(name)) {
      const pseudo = `::view-transition-group(${name})`;
      const now = translationOf(getComputedStyle(root, pseudo).transform);
      const time = group.currentTime;
      const end = group.effect?.getComputedTiming().endTime;
      if (time === null || typeof end !== "number") continue;
      group.currentTime = end;
      const last = translationOf(getComputedStyle(root, pseudo).transform);
      group.currentTime = time;
      offsets.set(name, { dx: now.x - last.x, dy: now.y - last.y, opacity: 1 });
    } else {
      const image = getComputedStyle(root, `::view-transition-new(${name})`);
      const moved = translationOf(image.transform);
      const opacity = Number.parseFloat(image.opacity);
      offsets.set(name, { dx: moved.x, dy: moved.y, opacity: Number.isFinite(opacity) ? opacity : 1 });
    }
  }
  return offsets;
}
