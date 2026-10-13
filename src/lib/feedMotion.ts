import { onTransitionUpdate, paintedTransitionOffsets, skipLiveTransition, transitionUpdating, type PaintedOffset } from "./viewTransition";

/**
 * Why the feed is about to change. Two kinds of change exist, and they move
 * differently:
 *
 *  - Whole-scene swaps — a lens (tag, day, sort, filter, search) or a send —
 *    ride a view transition (lib/viewTransition.ts): the chrome around the
 *    feed changes with it, and the snapshot masks the scroll reset.
 *  - Everything else happens in place, inside the list the reader is already
 *    looking at — pins, edits, ticks, deletes and restores, and the deltas
 *    another tab or device sends. Those play here, as FLIP: the cards are
 *    measured before the change, the change commits, and each card is moved
 *    back to where it was painted and released.
 */
export type FeedIntent = "create" | "lens" | "pin" | "unpin" | "trash" | "restore" | "purge" | "edit-save" | "task" | "remote";
export type InPlaceIntent = Exclude<FeedIntent, "create" | "lens">;

/** Where a named card went, for the caller's focus and words. */
export type Departure = "removed" | "up" | "down";

export interface FeedMotionResult {
  /** Named cards that were on screen before the change and are not after it, by memo id. */
  departed: Map<string, Departure>;
}

export interface FeedMotion {
  /**
   * One in-place change. `commit` must leave the DOM in its new state before
   * it returns (React callers wrap their setState in flushSync). `ids` are the
   * memos the action is about — the cards that may leave their place.
   */
  run(intent: InPlaceIntent, ids: Iterable<string>, commit: () => void): FeedMotionResult;
  /** Stop everything in flight: running glides land, exit ghosts go. */
  settle(): void;
  /**
   * Start settling whenever a view transition's update runs (the capture has
   * just frozen the frame; motion left running would play under it). The
   * returned detach settles and stops listening — an effect's cleanup.
   */
  attach(): () => void;
}

interface FeedMotionOptions {
  /** The feed container; its direct `.memo-slot` children are the cards. */
  feed: () => HTMLElement | null;
  /** An empty, absolutely positioned layer inside the feed for exit ghosts. */
  ghosts: () => HTMLElement | null;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Shot {
  el: HTMLElement;
  /** The card's layout box, in viewport coordinates. */
  box: Box;
  /** Where the reader sees it: the box plus a glide still running, or the pose a view transition is painting. */
  at: { left: number; top: number };
  opacity: number;
  /** A copy taken before the change, for a named card that may move far away. */
  copy: HTMLElement | null;
}

interface Capture {
  intent: InPlaceIntent;
  /** Slot keys (`memo-<id>`) of the memos the action names. */
  targets: Set<string>;
  /** Every slot key in the feed before the change. */
  known: Set<string>;
  shots: Map<string, Shot>;
  /** The last untouched card starting above the viewport top: what keeps the reader's place. */
  anchor: { el: HTMLElement; top: number } | null;
  /** A view transition was on screen; positions came from its pseudo-elements. */
  overTransition: boolean;
}

type Exit = "sink" | "lift" | "settle" | "fade";
type Arrival = "rise" | "drop" | "fade";

/* Durations and shapes follow app.css: glides match ::view-transition-group
   (0.24s, --ease-out), exits card-depart (0.16s, --ease) — exits run faster
   than entrances — and every keyframe set below is a named keyframe there or
   its mirror. */
const GLIDE_MS = 240;
const EXIT_MS = 160;
const ARRIVE_MS = 240;
/** How long the reader's place is held after a change: past the glides, and
    past the 220ms height tween a card plays when it leaves its editor. */
const HOLD_MS = 400;
const FALLBACK_EASE: Record<string, string> = {
  "--ease": "cubic-bezier(0.22, 0.61, 0.36, 1)",
  "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)"
};

const EXITS: Record<Exit, (opacity: number) => Keyframe[]> = {
  // card-depart: the trash recede.
  sink: (opacity) => [{ opacity, transform: "none" }, { opacity: 0, transform: "scale(0.965)" }],
  // rise-in played upward: pinned toward the top, restored out of Trash.
  lift: (opacity) => [{ opacity, transform: "none" }, { opacity: 0, transform: "translateY(-18px) scale(0.995)" }],
  // drop-in's travel, continuing down: unpinned to a place far below.
  settle: (opacity) => [{ opacity, transform: "none" }, { opacity: 0, transform: "translateY(8px)" }],
  // fade-out: gone for good, or gone elsewhere.
  fade: (opacity) => [{ opacity }, { opacity: 0 }]
};

const ARRIVALS: Record<Arrival, Keyframe[]> = {
  rise: [
    { opacity: 0, transform: "translateY(18px) scale(0.995)" },
    { opacity: 1, transform: "none" }
  ],
  drop: [
    { opacity: 0, transform: "translateY(-8px)" },
    { opacity: 1, transform: "none" }
  ],
  fade: [{ opacity: 0 }, { opacity: 1 }]
};

/** Intents whose named cards can change place rather than leave the list. */
const RELOCATING: ReadonlySet<InPlaceIntent> = new Set(["pin", "unpin", "edit-save", "task", "remote"]);

/** How a card leaves the list under each verb. */
function exitOf(intent: InPlaceIntent): Exit {
  switch (intent) {
    case "restore":
      return "lift";
    case "purge":
    case "remote":
      return "fade";
    default:
      // Trash, and an edit or a tick that takes the memo out of the lens:
      // the feed's removal recede.
      return "sink";
  }
}

/** How a named card goes when its new place is far off-screen. */
function departureOf(intent: InPlaceIntent, up: boolean): Exit {
  if (intent === "remote") return "fade";
  return up ? "lift" : "settle";
}

/** How a named card comes in when its old place was far off-screen. */
function arrivalOf(intent: InPlaceIntent, up: boolean): Arrival {
  if (intent === "remote") return "fade";
  return up ? "rise" : "drop";
}

const EMPTY: FeedMotionResult = { departed: new Map() };

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function canAnimate(): boolean {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function" && !reducedMotion();
}

function ease(token: "--ease" | "--ease-out"): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || FALLBACK_EASE[token];
}

function translationOf(transform: string): { x: number; y: number } {
  if (!transform || transform === "none" || typeof DOMMatrixReadOnly !== "function") return { x: 0, y: 0 };
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** The computed `translate` property ("12px 30px", "12px", "none"). */
function translateOf(value: string): { x: number; y: number } {
  if (!value || value === "none") return { x: 0, y: 0 };
  const [x = "0", y = "0"] = value.trim().split(/\s+/);
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

/**
 * A card's layout box and where it is painted. The box leaves out every
 * transform (the slot's own entrance, a glide still running); `at` keeps the
 * glide — ours to continue — but not the entrance, which keeps playing by
 * itself on the CSS animation and would otherwise be counted twice.
 */
function measure(el: HTMLElement, offsets: Map<string, PaintedOffset>): Omit<Shot, "el" | "copy"> {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const glide = translateOf(style.translate);
  const own = translationOf(style.transform);
  const box = { left: rect.left - glide.x - own.x, top: rect.top - glide.y - own.y, width: rect.width, height: rect.height };
  const painted = el.style.viewTransitionName ? offsets.get(el.style.viewTransitionName) : undefined;
  if (painted) return { box, at: { left: box.left + painted.dx, top: box.top + painted.dy }, opacity: painted.opacity };
  return { box, at: { left: box.left + glide.x, top: box.top + glide.y }, opacity: 1 };
}

function boxOf(el: HTMLElement): Box {
  return measure(el, new Map()).box;
}

function slotsOf(feed: HTMLElement): HTMLElement[] {
  return Array.from(feed.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("memo-slot"));
}

/** First slot whose bottom reaches `edge` (slots run down the page in order). */
function firstFrom(slots: HTMLElement[], edge: number): number {
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (slots[mid].getBoundingClientRect().bottom < edge) low = mid + 1;
    else high = mid;
  }
  return low;
}

const idOf = (key: string) => key.slice("memo-".length);

/**
 * The feed's motion layer for in-place changes. One instance per feed; App
 * routes every in-place change through `run` with the verb that caused it.
 */
export function createFeedMotion(options: FeedMotionOptions): FeedMotion {
  const glides = new Map<HTMLElement, Animation>();
  const lifted = new Set<HTMLElement>();
  const ghosts = new Set<HTMLElement>();

  function stopGlides(): void {
    for (const animation of glides.values()) animation.cancel();
    glides.clear();
    for (const el of lifted) el.style.zIndex = "";
    lifted.clear();
  }

  // The hold now running; a later one (or a settle) ends it.
  let holding = 0;

  /**
   * Keep the reader's place while what lies above it settles — a card that
   * left the editor eases to its reading height after the commit, wherever
   * it moved to. Each frame, before paint, whatever the anchor has moved in
   * the document is scrolled away; the reader's own scrolling is left alone.
   */
  function hold(el: HTMLElement): void {
    const generation = ++holding;
    const until = performance.now() + HOLD_MS;
    let last = boxOf(el).top + window.scrollY;
    const step = (now: number) => {
      if (generation !== holding || !el.isConnected) return;
      const at = boxOf(el).top + window.scrollY;
      if (Math.abs(at - last) >= 0.5) {
        window.scrollTo({ top: window.scrollY + at - last, behavior: "instant" });
        last = at;
      }
      if (now < until) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function settle(): void {
    holding += 1;
    stopGlides();
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }

  function capture(intent: InPlaceIntent, ids: Iterable<string>): Capture | null {
    const feed = options.feed();
    if (!feed) return null;
    const offsets = paintedTransitionOffsets();
    const slots = slotsOf(feed);
    const targets = new Set(Array.from(ids, (id) => `memo-${id}`));
    const known = new Set<string>();
    for (const slot of slots) if (slot.dataset.vt) known.add(slot.dataset.vt);
    const height = window.innerHeight;
    const shots = new Map<string, Shot>();
    let anchor: Capture["anchor"] = null;
    // The band: a viewport above the screen to a viewport below it. Cards
    // inside it can be seen moving; beyond it, they are inferred.
    for (let index = firstFrom(slots, -height); index < slots.length; index += 1) {
      const slot = slots[index];
      const key = slot.dataset.vt;
      if (!key) continue;
      const shot = { el: slot, copy: null, ...measure(slot, offsets) };
      shots.set(key, shot);
      if (shot.box.top > 2 * height) break;
      if (shot.box.top < 0 && !targets.has(key)) anchor = { el: slot, top: shot.box.top };
    }
    for (const key of targets) {
      if (shots.has(key)) continue;
      const slot = slots.find((candidate) => candidate.dataset.vt === key);
      if (slot) shots.set(key, { el: slot, copy: null, ...measure(slot, offsets) });
    }
    // A named card that may move far away leaves a copy of itself behind,
    // taken now: after the change its node is somewhere else, already
    // showing the new state.
    if (RELOCATING.has(intent)) {
      for (const key of targets) {
        const shot = shots.get(key);
        if (shot && onScreen(shot.at.top, shot.box.height)) shot.copy = shot.el.cloneNode(true) as HTMLElement;
      }
    }
    return { intent, targets, known, shots, anchor, overTransition: offsets.size > 0 };
  }

  function onScreen(top: number, height: number): boolean {
    return top < window.innerHeight && top + height > 0;
  }

  /** Near enough to the screen that a glide between two such places reads as one move. */
  function nearScreen(top: number, height: number): boolean {
    const margin = window.innerHeight / 2;
    return top < window.innerHeight + margin && top + height > -margin;
  }

  /** `layer` raises the card for the glide: 2 for a named card, which
   *  crosses its neighbours over them, not under; 1 for a neighbour closing
   *  over an exit ghost (the ghost layer comes after every slot). */
  function glide(el: HTMLElement, dx: number, dy: number, opacity: number, layer: number): void {
    const from: Keyframe = { translate: `${dx}px ${dy}px` };
    const to: Keyframe = { translate: "0px 0px" };
    if (opacity < 0.99) {
      from.opacity = opacity;
      to.opacity = 1;
    }
    if (layer > 0) {
      el.style.zIndex = String(layer);
      lifted.add(el);
    }
    const animation = el.animate([from, to], { duration: GLIDE_MS, easing: ease("--ease-out") });
    glides.set(el, animation);
    const release = () => {
      if (glides.get(el) !== animation) return;
      glides.delete(el);
      if (lifted.delete(el)) el.style.zIndex = "";
    };
    void Promise.resolve(animation.finished).then(release, () => undefined);
  }

  function arrive(el: HTMLElement, arrival: Arrival): void {
    const animation = el.animate(ARRIVALS[arrival], { duration: arrival === "fade" ? 200 : ARRIVE_MS, easing: ease("--ease-out") });
    glides.set(el, animation);
    void Promise.resolve(animation.finished).then(
      () => {
        if (glides.get(el) === animation) glides.delete(el);
      },
      () => undefined
    );
  }

  /**
   * Play an exit on a stand-in for a card that has left its place: the
   * card's own detached node (React is done with it) or the copy taken before
   * the change. It lives in the ghost layer, outside React's tree, at the
   * spot the reader last saw the card.
   */
  function ghost(node: HTMLElement, shot: Shot, exit: Exit): void {
    const layer = options.ghosts();
    if (!layer) return;
    layer.inert = true;
    node.className = node.className.replace(/\bmemo-slot\b/, "feed-ghost");
    node.removeAttribute("data-vt");
    node.removeAttribute("style");
    for (const element of Array.from(node.querySelectorAll("[id]"))) element.removeAttribute("id");
    // The menu that ran the action was closing with it; the card leaves
    // alone rather than carrying a frozen popover away.
    for (const element of Array.from(node.querySelectorAll(".action-menu, .tag-suggest"))) element.remove();
    const base = layer.getBoundingClientRect();
    node.style.top = `${shot.at.top - base.top}px`;
    node.style.left = `${shot.at.left - base.left}px`;
    node.style.width = `${shot.box.width}px`;
    node.style.height = `${shot.box.height}px`;
    layer.appendChild(node);
    ghosts.add(node);
    const animation = node.animate(EXITS[exit](shot.opacity), { duration: EXIT_MS, easing: ease("--ease"), fill: "forwards" });
    const remove = () => {
      node.remove();
      ghosts.delete(node);
    };
    void Promise.resolve(animation.finished).then(remove, remove);
  }

  function play(capture: Capture): FeedMotionResult {
    const result: FeedMotionResult = { departed: new Map() };
    const feed = options.feed();
    if (!feed) return result;

    // The reader's place. A change wholly above the screen — a memo arriving
    // from another device, a card pinned out of the middle of the page —
    // must not slide what they are reading. Chromium's scroll anchoring
    // often has done this already by the time the box is read (then the
    // anchor has not drifted and this is a no-op); Safari has none, and no
    // engine anchors to a node React has just moved.
    const { anchor } = capture;
    if (anchor && anchor.el.parentElement === feed) {
      // A card new to the feed has no remembered size: off-screen, its slot
      // stands at the feed's height estimate and only takes its own a frame
      // later, under the reader. Render the new ones above the anchor now,
      // so the drift is measured against real heights; their size is
      // remembered (contain-intrinsic-size: auto) by the time they go back
      // to rendering lazily.
      const fresh: HTMLElement[] = [];
      for (const slot of slotsOf(feed)) {
        if (slot === anchor.el) break;
        const key = slot.dataset.vt;
        if (key && !capture.known.has(key)) {
          slot.style.contentVisibility = "visible";
          fresh.push(slot);
        }
      }
      if (fresh.length) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const slot of fresh) slot.style.contentVisibility = "";
          })
        );
      }
      const drift = boxOf(anchor.el).top - anchor.top;
      if (Math.abs(drift) >= 0.5) window.scrollTo({ top: window.scrollY + drift, behavior: "instant" });
      hold(anchor.el);
    }

    const height = window.innerHeight;
    const motions: Array<() => void> = [];
    let changed = false;
    // Whether an exit ghost plays: the glides (queued first, run after both
    // passes) then close over it.
    let ghosted = false;
    const slots = slotsOf(feed);
    // How far the last measured card moved, for its unmeasured followers.
    let shift = 0;
    for (let index = firstFrom(slots, -height); index < slots.length; index += 1) {
      const slot = slots[index];
      const key = slot.dataset.vt;
      if (!key) continue;
      const box = boxOf(slot);
      if (box.top > 2 * height) break;
      const shot = capture.shots.get(key);
      if (!shot) {
        if (!capture.known.has(key)) {
          // A new card: its slot plays the feed's own entrance on mount.
          changed = true;
        } else if (Math.abs(shift) >= 0.5) {
          // It was in the feed, past the measured band: it moves with the
          // card above it.
          changed = true;
          motions.push(() => glide(slot, 0, shift, 1, ghosted ? 1 : 0));
        }
        continue;
      }
      const target = capture.targets.has(key);
      const dx = shot.at.left - box.left;
      const dy = shot.at.top - box.top;
      if (Math.abs(box.top - shot.box.top) >= 0.5 || Math.abs(box.left - shot.box.left) >= 0.5) changed = true;
      if (!target) shift = shot.box.top - box.top;
      if (target && !(nearScreen(shot.at.top, shot.box.height) && nearScreen(box.top, box.height))) {
        // A named card from far away: the long glide would streak across
        // the page, so it enters in its verb's direction instead — only if
        // it lands where it can be seen.
        if (onScreen(box.top, box.height) && Math.abs(dy) >= 0.5) motions.push(() => arrive(slot, arrivalOf(capture.intent, dy > 0)));
        continue;
      }
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || shot.opacity < 0.99) {
        motions.push(() => glide(slot, dx, dy, shot.opacity, target ? 2 : ghosted ? 1 : 0));
      }
    }

    for (const [key, shot] of capture.shots) {
      const target = capture.targets.has(key);
      if (shot.el.parentElement !== feed) {
        // (A fresh node under the same key is the same card, remounted.)
        if (slots.some((slot) => slot.dataset.vt === key)) continue;
        changed = true;
        const seen = onScreen(shot.at.top, shot.box.height);
        if (target && seen) result.departed.set(idOf(key), "removed");
        if (seen) {
          ghosted = true;
          motions.push(() => ghost(shot.el, shot, exitOf(capture.intent)));
        }
        continue;
      }
      if (!target || !onScreen(shot.at.top, shot.box.height)) continue;
      const box = boxOf(shot.el);
      if (onScreen(box.top, box.height)) continue;
      const up = box.top < shot.box.top;
      result.departed.set(idOf(key), up ? "up" : "down");
      const copy = shot.copy;
      if (copy && !(nearScreen(shot.at.top, shot.box.height) && nearScreen(box.top, box.height))) {
        ghosted = true;
        motions.push(() => ghost(copy, shot, departureOf(capture.intent, up)));
      }
    }

    // Nothing moved: whatever is in flight keeps flying.
    if (!changed) return result;
    // Something moved under a view transition still on screen: end it here
    // (the DOM holds its end state) and carry on from the frame it painted.
    if (capture.overTransition) skipLiveTransition();
    // Glides still running were captured where they were painted, and the
    // new ones start from there.
    stopGlides();
    if (canAnimate()) for (const motion of motions) motion();
    return result;
  }

  return {
    run(intent, ids, commit) {
      // Inside a view transition's update the snapshot owns the motion; and
      // with no Web Animations there is nothing to play.
      if (transitionUpdating() || typeof Element.prototype.animate !== "function") {
        commit();
        return EMPTY;
      }
      let taken: Capture | null = null;
      try {
        taken = capture(intent, ids);
      } catch {
        taken = null;
      }
      commit();
      if (!taken) return EMPTY;
      try {
        return play(taken);
      } catch {
        // Motion is decoration: a failure here must never fail the action.
        settle();
        return EMPTY;
      }
    },
    settle,
    attach() {
      const unsubscribe = onTransitionUpdate(settle);
      return () => {
        unsubscribe();
        settle();
      };
    }
  };
}
