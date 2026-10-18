import { onTransitionCommitted, onTransitionUpdate, paintedTransitionOffsets, skipLiveTransition, transitionUpdating, type PaintedOffset } from "./viewTransition";
import { layoutRect, motionOffset, type Box } from "./feedBoxes";
import { EASE, EASE_OUT, T_BASE, T_ENTER, T_EXIT } from "./motion";

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
 *
 * Cards that simply mount — the first page, the next one, a typed search's
 * results — get the feed's entrance here as well (`observe`).
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
   * Watch a feed for cards mounted outside any run — the first page, the next
   * page, a typed search's results — and play their entrance: a rise, ≤48ms
   * apart, for the ones on screen. The cards it already holds arrive with it.
   */
  observe(feed: HTMLElement | null): void;
  /**
   * The cards mounted since the last look have arrived already: a commit
   * whose motion is owned elsewhere (a view transition's snapshot, the
   * browser's own Back slide) must not replay their entrance.
   */
  claim(): void;
  /**
   * Start settling whenever a view transition's update runs (the capture has
   * just frozen the frame; motion left running would play under it), and
   * leave the cards its update mounts to the snapshot. The returned detach
   * settles and stops listening — an effect's cleanup.
   */
  attach(): () => void;
}

interface FeedMotionOptions {
  /** The feed container; its direct `.memo-slot` children are the cards. */
  feed: () => HTMLElement | null;
  /** An empty, absolutely positioned layer inside the feed for exit ghosts. */
  ghosts: () => HTMLElement | null;
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

/* Durations and shapes follow app.css: glides and arrivals take --t-enter on
   --ease-out, exits card-depart's --t-exit on --ease — exits run faster than
   entrances — and every keyframe set below is a named keyframe there or its
   mirror. Under reduced motion every one of them is a --t dissolve. */
const GLIDE_MS = T_ENTER;
const EXIT_MS = T_EXIT;
const ARRIVE_MS = T_ENTER;
const DISSOLVE_MS = T_BASE;
/** Cards arriving together enter this far apart, the seventh and later at once with the sixth. */
const STAGGER_MS = 8;
const STAGGER_CAP = 6;
/** How long the reader's place is held after a change: past the glides, and
    past the 220ms height tween a card plays when it leaves its editor. */
const HOLD_MS = 400;
const FALLBACK_EASE: Record<string, string> = {
  "--ease": EASE,
  "--ease-out": EASE_OUT
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

function ease(token: "--ease" | "--ease-out"): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || FALLBACK_EASE[token];
}

/**
 * A card's layout box and where it is painted. The box leaves out every
 * transform (an entrance, a glide still running). `at` and `opacity` are the
 * reader's frame when the motion carrying the card is ours (`ours`) — the
 * next change continues from it — and the plain box otherwise.
 */
function measure(el: HTMLElement, offsets: Map<string, PaintedOffset>, ours = false): Omit<Shot, "el" | "copy"> {
  const rect = el.getBoundingClientRect();
  const { glide, own } = motionOffset(el);
  const box = { left: rect.left - glide.x - own.x, top: rect.top - glide.y - own.y, width: rect.width, height: rect.height };
  const painted = el.style.viewTransitionName ? offsets.get(el.style.viewTransitionName) : undefined;
  if (painted) return { box, at: { left: box.left + painted.dx, top: box.top + painted.dy }, opacity: painted.opacity };
  if (!ours) return { box, at: { left: box.left, top: box.top }, opacity: 1 };
  const opacity = Number.parseFloat(getComputedStyle(el).opacity);
  return { box, at: { left: rect.left, top: rect.top }, opacity: Number.isFinite(opacity) ? opacity : 1 };
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

const hasAnimations = () => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

/** Below this a card is not seen yet — an arrival still waiting out its stagger. */
const UNSEEN = 0.05;

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
      const shot = { el: slot, copy: null, ...measure(slot, offsets, glides.has(slot)) };
      shots.set(key, shot);
      if (shot.box.top > 2 * height) break;
      if (shot.box.top < 0 && !targets.has(key)) anchor = { el: slot, top: shot.box.top };
    }
    for (const key of targets) {
      if (shots.has(key)) continue;
      const slot = slots.find((candidate) => candidate.dataset.vt === key);
      if (slot) shots.set(key, { el: slot, copy: null, ...measure(slot, offsets, glides.has(slot)) });
    }
    // A named card that may move far away leaves a copy of itself behind,
    // taken now: after the change its node is somewhere else, already
    // showing the new state.
    if (RELOCATING.has(intent)) {
      for (const key of targets) {
        const shot = shots.get(key);
        if (shot && seenAt(shot)) shot.copy = shot.el.cloneNode(true) as HTMLElement;
      }
    }
    return { intent, targets, known, shots, anchor, overTransition: offsets.size > 0 };
  }

  function onScreen(top: number, height: number): boolean {
    return top < window.innerHeight && top + height > 0;
  }

  /** The reader could see the card when it was measured: on screen, and not still waiting to arrive. */
  function seenAt(shot: Pick<Shot, "at" | "box" | "opacity">): boolean {
    return onScreen(shot.at.top, shot.box.height) && shot.opacity >= UNSEEN;
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

  /** `delay` holds the card at its first frame (unseen) until its turn in a cascade. */
  function arrive(el: HTMLElement, arrival: Arrival, duration = arrival === "fade" ? 200 : ARRIVE_MS, delay = 0, easing = ease("--ease-out")): Animation {
    const animation = el.animate(ARRIVALS[arrival], { duration, delay, easing, fill: "backwards" });
    glides.set(el, animation);
    void Promise.resolve(animation.finished).then(
      () => {
        if (glides.get(el) === animation) glides.delete(el);
      },
      () => undefined
    );
    return animation;
  }

  /**
   * Play an exit on a stand-in for a card that has left its place: the
   * card's own detached node (React is done with it) or the copy taken before
   * the change. It lives in the ghost layer, outside React's tree, at the
   * spot the reader last saw the card.
   */
  function ghost(node: HTMLElement, shot: Pick<Shot, "at" | "box" | "opacity">, exit: Exit, duration = EXIT_MS): void {
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
    const animation = node.animate(EXITS[exit](shot.opacity), { duration, easing: ease("--ease"), fill: "forwards" });
    const remove = () => {
      node.remove();
      ghosts.delete(node);
    };
    void Promise.resolve(animation.finished).then(remove, remove);
  }

  /**
   * Reduced motion's stand-in for a glide: nothing travels. The card's old
   * look stays where it was drawn and fades out while the card fades in at
   * its new place — the same dissolve the reduce block gives a lens swap.
   * Its node already shows the new state, but a card that only moved looks
   * the same in both, so a copy of it now is a copy of then.
   */
  function dissolve(el: HTMLElement, from: Pick<Shot, "at" | "box" | "opacity">): void {
    ghost(el.cloneNode(true) as HTMLElement, from, "fade", DISSOLVE_MS);
    arrive(el, "fade", DISSOLVE_MS);
  }

  // Cards that have had their entrance, or had it under someone else's
  // motion. React moving a kept card re-inserts its node; it does not
  // arrive again.
  const seen = new WeakSet<HTMLElement>();
  let watched: HTMLElement | null = null;
  let observer: MutationObserver | null = null;

  /** The slots among `nodes` that have not arrived yet, now marked as arrived. */
  function unseen(nodes: Iterable<Node>): HTMLElement[] {
    const fresh: HTMLElement[] = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !node.classList.contains("memo-slot") || seen.has(node)) continue;
      seen.add(node);
      fresh.push(node);
    }
    return fresh;
  }

  function added(records: MutationRecord[]): HTMLElement[] {
    return unseen(records.flatMap((record) => Array.from(record.addedNodes)));
  }

  /**
   * The feed's own entrance for cards mounted outside any change it plays:
   * each rises into place, the ones arriving together ≤48ms apart down the
   * page; reduced motion fades them in, all at once. It is for the cards the
   * reader sees arrive. Until the browser renders a new card it stands at
   * the feed's height estimate, so the entrance starts on everything within
   * a viewport and a half; a frame later the cards have their real heights,
   * and the ones that turned out below the fold — a page appended under the
   * reader — land at once rather than rise as they are scrolled into.
   */
  function enter(fresh: HTMLElement[]): void {
    const feed = watched;
    if (!feed || fresh.length === 0 || !hasAnimations()) return;
    const arriving = new Set(fresh);
    const reach = window.innerHeight * 1.5;
    const reduced = reducedMotion();
    const easing = ease("--ease-out");
    const started: Array<[HTMLElement, Animation]> = [];
    let order = 0;
    for (const slot of slotsOf(feed)) {
      if (!arriving.has(slot)) continue;
      const rect = slot.getBoundingClientRect();
      if (rect.top >= reach) break;
      if (rect.bottom <= 0) continue;
      const animation = reduced ? arrive(slot, "fade", DISSOLVE_MS) : arrive(slot, "rise", ARRIVE_MS, Math.min(order++, STAGGER_CAP) * STAGGER_MS, easing);
      started.push([slot, animation]);
    }
    if (started.length === 0) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const [slot, animation] of started) {
          if (glides.get(slot) !== animation || !slot.isConnected) continue;
          const { top, bottom } = layoutRect(slot);
          if (top >= window.innerHeight || bottom <= 0) animation.finish();
        }
      })
    );
  }

  /** Cards mounted since the last look that are still waiting for an entrance get it now. */
  function flush(): void {
    const records = observer?.takeRecords();
    if (records?.length) enter(added(records));
  }

  function claim(): void {
    const records = observer?.takeRecords();
    if (records?.length) added(records);
  }

  function observe(feed: HTMLElement | null): void {
    if (feed === watched) return;
    observer?.disconnect();
    observer = null;
    watched = feed;
    if (!feed || typeof MutationObserver !== "function") return;
    observer = new MutationObserver((records) => enter(added(records)));
    observer.observe(feed, { childList: true });
    const fresh = unseen(slotsOf(feed));
    // A feed mounted by a view transition's update is the snapshot's to show.
    if (!transitionUpdating()) enter(fresh);
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
    // Reduced motion keeps every decision below and changes only how each
    // one plays: a dissolve in place, never a cut and never a journey.
    const reduced = reducedMotion();
    const motions: Array<() => void> = [];
    let changed = false;
    // Whether an exit ghost plays: the glides (queued first, run after both
    // passes) then close over it.
    let ghosted = false;
    const slots = slotsOf(feed);
    // How far the last measured card moved, for its unmeasured followers.
    let shift = 0;
    // New cards entering so far, for their cascade.
    let arrivals = 0;
    for (let index = firstFrom(slots, -height); index < slots.length; index += 1) {
      const slot = slots[index];
      const key = slot.dataset.vt;
      if (!key) continue;
      const box = boxOf(slot);
      if (box.top > 2 * height) break;
      const shot = capture.shots.get(key);
      if (!shot) {
        if (!capture.known.has(key)) {
          // A new card — another device's, or one the change brought into
          // the lens: the feed's own entrance, where it can be seen.
          changed = true;
          if (onScreen(box.top, box.height)) {
            const delay = Math.min(arrivals++, STAGGER_CAP) * STAGGER_MS;
            motions.push(() => (reduced ? arrive(slot, "fade", DISSOLVE_MS) : arrive(slot, "rise", ARRIVE_MS, delay)));
          }
        } else if (Math.abs(shift) >= 0.5) {
          // It was in the feed, past the measured band: it moves with the
          // card above it.
          changed = true;
          const moved = shift;
          motions.push(() =>
            reduced ? dissolve(slot, { box, at: { left: box.left, top: box.top + moved }, opacity: 1 }) : glide(slot, 0, moved, 1, ghosted ? 1 : 0)
          );
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
        if (onScreen(box.top, box.height) && Math.abs(dy) >= 0.5) {
          motions.push(() => (reduced ? arrive(slot, "fade", DISSOLVE_MS) : arrive(slot, arrivalOf(capture.intent, dy > 0))));
        }
        continue;
      }
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || shot.opacity < 0.99) {
        motions.push(() => (reduced ? dissolve(slot, shot) : glide(slot, dx, dy, shot.opacity, target ? 2 : ghosted ? 1 : 0)));
      }
    }

    for (const [key, shot] of capture.shots) {
      const target = capture.targets.has(key);
      if (shot.el.parentElement !== feed) {
        // (A fresh node under the same key is the same card, remounted.)
        if (slots.some((slot) => slot.dataset.vt === key)) continue;
        changed = true;
        const seen = seenAt(shot);
        if (target && seen) result.departed.set(idOf(key), "removed");
        if (seen) {
          ghosted = true;
          motions.push(() => (reduced ? ghost(shot.el, shot, "fade", DISSOLVE_MS) : ghost(shot.el, shot, exitOf(capture.intent))));
        }
        continue;
      }
      if (!target || !seenAt(shot)) continue;
      const box = boxOf(shot.el);
      if (onScreen(box.top, box.height)) continue;
      const up = box.top < shot.box.top;
      result.departed.set(idOf(key), up ? "up" : "down");
      const copy = shot.copy;
      if (copy && !(nearScreen(shot.at.top, shot.box.height) && nearScreen(box.top, box.height))) {
        ghosted = true;
        motions.push(() => (reduced ? ghost(copy, shot, "fade", DISSOLVE_MS) : ghost(copy, shot, departureOf(capture.intent, up))));
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
    for (const motion of motions) motion();
    return result;
  }

  return {
    run(intent, ids, commit) {
      // Inside a view transition's update the snapshot owns the motion (and
      // the update's end claims the cards it mounted); with no Web
      // Animations there is nothing to play.
      if (transitionUpdating() || !hasAnimations()) {
        commit();
        claim();
        return EMPTY;
      }
      let taken: Capture | null = null;
      try {
        // Cards mounted just before this change enter first, so it starts
        // from the frame their entrance paints.
        flush();
        taken = capture(intent, ids);
      } catch {
        taken = null;
      }
      commit();
      // The change's own new cards are play's to move.
      claim();
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
    observe,
    claim,
    attach() {
      const unsubscribe = [onTransitionUpdate(settle), onTransitionCommitted(claim)];
      return () => {
        for (const stop of unsubscribe) stop();
        settle();
      };
    }
  };
}
