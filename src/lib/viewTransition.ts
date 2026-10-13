/** How the cards that leave the feed in a transition go (app.css `data-vt-exit`). */
export type TransitionExit = "sink" | "lift" | "fade";

interface TransitionOptions {
  /**
   * The verb's exit for departing cards. Sink (the removal recede) is the
   * default; a restore leaving Trash lifts out, a permanent delete fades.
   */
  exit?: TransitionExit;
}

/** Where the running transition paints one feed card, against its DOM box. */
export interface PaintedOffset {
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
let updating = false;
const updateHooks = new Set<() => void>();

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Runs a feed/state change inside a same-document view transition so the
 * outgoing DOM morphs/cross-fades into the incoming one (choreographed by
 * the ::view-transition rules in app.css). The callback must leave the DOM
 * in its final state before it returns — React callers wrap their setState
 * in flushSync themselves. The callback receives whether a snapshot transition
 * is being attempted, so local entrances can hand motion to their snapshots.
 * Falls back to calling the update directly when the API is unavailable.
 *
 * Reduced motion still gets a transition, only a different one: the cards
 * carry no names (so nothing glides), and app.css's reduce block turns every
 * pair into a short dissolve — a cross-fade in place instead of a hard cut.
 *
 * A transition started while another is still on screen continues from the
 * frame the reader is looking at. The browser captures the outgoing state
 * from the real DOM, and the DOM already holds the cut transition's END state
 * — each gliding card would restart from where it was going rather than from
 * where it was, a jump of up to the whole glide. So the cards are first posed
 * where the cut transition is painting them (translate + opacity, which the
 * capture includes), and the poses come off inside the update.
 */
export function withViewTransition(update: (animated: boolean) => void, options: TransitionOptions = {}): ViewTransition | null {
  if (!document.startViewTransition) {
    update(false);
    return null;
  }
  const reduced = reducedMotion();
  const root = document.documentElement;
  const poses = reduced ? [] : poseAtPaintedFrame();
  tuneFeedTransitionNames(window.scrollY, reduced);
  if (options.exit && options.exit !== "sink") root.dataset.vtExit = options.exit;
  else delete root.dataset.vtExit;
  const transition = document.startViewTransition(() => {
    updating = true;
    try {
      for (const slot of poses) {
        slot.style.translate = "";
        slot.style.opacity = "";
      }
      // Motion that the capture just froze (feed FLIPs, exit ghosts) would
      // otherwise keep playing under the snapshot's own.
      for (const hook of updateHooks) hook();
      update(true);
      tuneFeedTransitionNames(window.scrollY, reduced);
    } finally {
      updating = false;
    }
  });
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
    if (active !== entry) return;
    active = null;
    delete root.dataset.vtExit;
  };
  Promise.resolve(transition.finished).then(done, done);
  return transition;
}

/** True while a transition's update callback runs: the snapshot owns that commit's motion. */
export function transitionUpdating(): boolean {
  return updating;
}

/** Called inside every transition's update, before the DOM changes. */
export function onTransitionUpdate(hook: () => void): () => void {
  updateHooks.add(hook);
  return () => updateHooks.delete(hook);
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

const PSEUDO = /^::view-transition-(group|old|new)\((memo-[^)]*)\)$/;

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
 * Where the running transition is painting each feed card it carries, as an
 * offset from the card's box in the live DOM (which already sits at the
 * transition's end). Keyed by view-transition-name; empty when no transition
 * is on screen.
 *
 * A card shared by both states is painted by its group, which glides from the
 * old box to the new one: the offset is the group's transform now minus its
 * transform at the end of the glide (read by seeking the group's animation to
 * its end and back within this task — nothing paints in between, and both
 * readings share the snapshot's coordinate space). A card arriving in the
 * new state only has a static group; its image is what moves and fades.
 * Cards leaving (old image only) are not in the DOM and are skipped.
 */
export function paintedTransitionOffsets(): Map<string, PaintedOffset> {
  const offsets = new Map<string, PaintedOffset>();
  if (!active?.live || typeof document.getAnimations !== "function") return offsets;
  const groups = new Map<string, Animation>();
  const arriving = new Set<string>();
  const leaving = new Set<string>();
  for (const animation of document.getAnimations()) {
    const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement ?? "";
    const match = PSEUDO.exec(pseudo);
    if (!match) continue;
    const [, part, name] = match;
    if (part === "group") groups.set(name, animation);
    else if (part === "new") arriving.add(name);
    else leaving.add(name);
  }
  const root = document.documentElement;
  for (const name of arriving) {
    const group = groups.get(name);
    if (group && leaving.has(name)) {
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

/**
 * Pose every card the transition on screen is carrying where it is painted,
 * so the next capture starts from the reader's frame. Returns the posed slots.
 */
function poseAtPaintedFrame(): HTMLElement[] {
  const offsets = paintedTransitionOffsets();
  if (offsets.size === 0) return [];
  const posed: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(".memo-slot").forEach((slot) => {
    const offset = offsets.get(slot.style.viewTransitionName);
    if (!offset) return;
    if (Math.abs(offset.dx) >= 0.5 || Math.abs(offset.dy) >= 0.5) slot.style.translate = `${offset.dx}px ${offset.dy}px`;
    if (offset.opacity < 0.99) slot.style.opacity = String(offset.opacity);
    posed.push(slot);
  });
  return posed;
}

/**
 * Decide, slot by slot, which feed cards take part in the next capture. A card
 * only morphs when it sits near the viewport its snapshot belongs to, so a
 * shared card whose other endpoint is pages away enters or departs like its
 * neighbours instead of streaking across the screen.
 *
 * `viewportTop` is the document offset that capture's viewport starts at — the
 * live scroll for a swap that stays put, 0 for one that rewinds to the top
 * (the scroll reset has not landed yet when the outgoing pass runs).
 *
 * Both directions matter. Stripping alone would be a one-way ratchet: a slot
 * dropped from a past capture keeps the empty inline name forever, because
 * React bails out of re-rendering unchanged slots and so never rewrites the
 * style it believes is already correct. Scroll down to a card that an earlier
 * swap had left far from the top, filter from there, and the card being looked
 * at would be missing from the outgoing capture — arriving in the new one as a
 * first-time entrance instead of a glide. data-vt holds the untouched name, so
 * restoring is always exact.
 *
 * `dissolve` (reduced motion) names no card at all: the feed then cross-fades
 * inside the page's own snapshot, every card in place, rather than as groups
 * that would have to jump to their new boxes.
 */
export function tuneFeedTransitionNames(viewportTop: number, dissolve = false): void {
  const height = window.innerHeight;
  const margin = height / 2;
  let remaining = 32;
  document.querySelectorAll<HTMLElement>(".memo-slot").forEach((slot) => {
    if (dissolve) {
      slot.style.viewTransitionName = "";
      return;
    }
    const rect = slot.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const near = top + rect.height >= viewportTop - margin && top <= viewportTop + height + margin;
    const name = near && remaining > 0 ? slot.dataset.vt ?? "" : "";
    slot.style.viewTransitionName = name;
    if (name) remaining -= 1;
  });
}
