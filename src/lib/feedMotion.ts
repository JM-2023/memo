import { skipLiveTransition, transitionLive } from "./viewTransition";
import { captureChrome, chromeMotions, type ChromeCapture, type ChromeStage } from "./chromeMotion";
import { layoutRect, motionOffset, type Box } from "./feedBoxes";
import { EASE, EASE_OUT, T_BASE, T_ENTER, T_EXIT } from "./motion";
import { SCROLL_JUMP_EVENT } from "./navHistory";

/**
 * Why the feed is about to change. Every change plays here, as FLIP: the
 * cards are measured where they are painted, the change commits, and each
 * card is moved back to where the reader saw it and released.
 *
 *  - A lens (tag, day, sort, filter, search, Trash, Daily review) is a new
 *    list: the cards it keeps glide to their new places, the ones it drops
 *    sink where they stood, and the ones it brings rise in. The scroll reset
 *    (or the restored reading place) is part of the change, so every
 *    position is the reader's: where they saw a card, where they will.
 *  - Everything else happens in place, inside the list the reader is already
 *    looking at — pins, edits, ticks, deletes and restores, tags added or
 *    taken off, and the deltas another tab or device sends — and keeps the
 *    reader's place.
 *  - A send lands its memo at the head of the list. The text travelling
 *    from the composer into its card is a view transition's morph
 *    (lib/viewTransition.ts) whose update runs the send through here, so
 *    the cards below glide live under it.
 *
 * Cards that simply mount — the first page, the next one, a typed search's
 * results — get the feed's entrance here as well (`observe`). And the chrome
 * around the feed moves in the same run as the cards (lib/chromeMotion.ts):
 * `select` is a change of the chrome alone — select mode, a pill arming.
 */
export type FeedIntent = "create" | "lens" | "pin" | "unpin" | "trash" | "restore" | "purge" | "edit-save" | "task" | "retag" | "remote" | "select";
export type InPlaceIntent = Exclude<FeedIntent, "create" | "lens">;

export interface RunOptions {
  /**
   * "none" commits without motion: a change the browser has animated already
   * (a Back swipe's own slide), or one made behind the closing drawer. What
   * is in flight lands first.
   */
  motion?: "auto" | "none";
  /** A send: the memo whose arrival a view transition's morph plays instead. */
  morphed?: string;
}

/** Where a named card went, for the caller's focus and words. */
export type Departure = "removed" | "up" | "down";

export interface FeedMotionResult {
  /** Named cards that were on screen before the change and are not after it, by memo id. */
  departed: Map<string, Departure>;
}

export interface FeedMotion {
  /**
   * One change to the feed. `commit` must leave the DOM in its new state —
   * scroll included — before it returns (React callers wrap their setState in
   * flushSync). `ids` are the memos the action is about — the cards that may
   * leave their place.
   */
  run(intent: FeedIntent, ids: Iterable<string>, commit: () => void, options?: RunOptions): FeedMotionResult;
  /** Stop everything in flight: running glides land, exit ghosts go (logout, unmount). */
  settle(): void;
  /**
   * Watch a feed for cards mounted outside any run — the first page, the next
   * page, a typed search's results — and play their entrance: a rise, ≤48ms
   * apart, for the ones on screen. The cards it already holds arrive with it.
   */
  observe(feed: HTMLElement | null): void;
  /**
   * The cards mounted since the last look have arrived already: a commit
   * whose motion is owned elsewhere must not replay their entrance.
   */
  claim(): void;
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
  /** Where the reader sees it: the box plus a glide still running. */
  at: { left: number; top: number };
  opacity: number;
  /** A copy taken before the change, for a named card that may move far away. */
  copy: HTMLElement | null;
}

interface Capture {
  intent: FeedIntent;
  /** Slot keys (`memo-<id>`) of the memos the action names. */
  targets: Set<string>;
  /** Every slot key in the feed before the change. */
  known: Set<string>;
  shots: Map<string, Shot>;
  /** The last untouched card starting above the viewport top: what keeps the reader's place. */
  anchor: { el: HTMLElement; top: number } | null;
  /** A send's memo whose arrival a morph plays. */
  morphed: string | undefined;
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
/** A new list's cards rise a beat after the old ones start to sink. */
const LENS_LAG_MS = 30;
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

/** Intents whose named cards can change place rather than leave the list
    (a retagged memo is an edited one: by edit time it can move). */
const RELOCATING: ReadonlySet<FeedIntent> = new Set(["pin", "unpin", "edit-save", "task", "retag", "remote"]);

/** How a card leaves the list under each verb. */
function exitOf(intent: FeedIntent): Exit {
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
function departureOf(intent: FeedIntent, up: boolean): Exit {
  if (intent === "remote") return "fade";
  return up ? "lift" : "settle";
}

/** How a named card comes in when its old place was far off-screen. */
function arrivalOf(intent: FeedIntent, up: boolean): Arrival {
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
function measure(el: HTMLElement, ours = false): Omit<Shot, "el" | "copy"> {
  const rect = el.getBoundingClientRect();
  const { glide, own } = motionOffset(el);
  const box = { left: rect.left - glide.x - own.x, top: rect.top - glide.y - own.y, width: rect.width, height: rect.height };
  if (!ours) return { box, at: { left: box.left, top: box.top }, opacity: 1 };
  const opacity = Number.parseFloat(getComputedStyle(el).opacity);
  return { box, at: { left: rect.left, top: rect.top }, opacity: Number.isFinite(opacity) ? opacity : 1 };
}

function boxOf(el: HTMLElement): Box {
  return measure(el).box;
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

/** The reader taking the page over: a held place is theirs from then on. */
const READER_INPUT = ["wheel", "touchstart", "keydown", "mousedown"] as const;

/** Below this a card is not seen yet — an arrival still waiting out its stagger. */
const UNSEEN = 0.05;

/**
 * The feed's motion layer for in-place changes. One instance per feed; App
 * routes every in-place change through `run` with the verb that caused it.
 */
export function createFeedMotion(options: FeedMotionOptions): FeedMotion {
  const glides = new Map<HTMLElement, Animation>();
  const lifted = new Set<HTMLElement>();
  const ghosts = new Set<Element>();
  // The chrome's live motions; its stand-ins join the cards' ghosts.
  const chromeLive = new Set<Animation>();

  function stopGlides(): void {
    for (const animation of glides.values()) animation.cancel();
    glides.clear();
    for (const el of lifted) el.style.zIndex = "";
    lifted.clear();
    for (const animation of chromeLive) animation.cancel();
    chromeLive.clear();
  }

  const stage: ChromeStage = {
    ease,
    animate(el, keyframes, timing) {
      const animation = el.animate(keyframes, timing);
      chromeLive.add(animation);
      const done = () => chromeLive.delete(animation);
      void Promise.resolve(animation.finished).then(done, done);
      return animation;
    },
    owns(el) {
      for (const animation of chromeLive) if ((animation.effect as KeyframeEffect | null)?.target === el) return true;
      return false;
    },
    keep(ghost, animation) {
      ghosts.add(ghost);
      const remove = () => {
        ghost.remove();
        ghosts.delete(ghost);
      };
      void Promise.resolve(animation.finished).then(remove, remove);
    }
  };

  /** Does this layer carry `el` right now — a glide or entrance on it or around it? */
  function carried(el: Element): boolean {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node instanceof HTMLElement && (glides.has(node) || stage.owns(node))) return true;
    }
    return false;
  }

  /**
   * A mouse press on something on the move: it can glide out from under the
   * pointer before the button comes up, and the click would then land on
   * whatever lies there instead. Capturing the pointer keeps the release, and
   * so the click, on what was pressed — as a touch's own capture already does.
   */
  function holdPress(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (glides.size === 0 && chromeLive.size === 0) return;
    const pressed = event.target;
    if (!(pressed instanceof Element) || !carried(pressed)) return;
    try {
      pressed.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone.
    }
  }
  let pressesHeld = false;

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
    keeping?.();
    stopGlides();
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }

  /**
   * Render the cards around the screen now, at their real heights, so the
   * change is measured against where they will rest. A card the browser has
   * never rendered stands at the feed's height estimate (content-visibility)
   * and takes its own size a frame later — under the reader, after its glide
   * has aimed at the estimate. Each one rendered moves the ones after it, so
   * this goes on until a viewport below the screen. They go back to rendering
   * lazily two frames later, their sizes remembered by then.
   *
   * The card the reader's place hangs on — the first one clear of the
   * sticky bar, where a restored place put it — stays where the change left
   * it: the cards above it taking their real heights must not push it off,
   * to be re-aimed a frame later under the reader.
   */
  function materialize(feed: HTMLElement): HTMLElement | undefined {
    const slots = slotsOf(feed);
    const edge = feed.closest("main")?.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const anchor = slots[firstFrom(slots, edge + 0.5)];
    if (feed.classList.contains("is-small")) return anchor;
    const height = window.innerHeight;
    const placed = anchor ? layoutRect(anchor).top : 0;
    const forced: HTMLElement[] = [];
    for (let index = firstFrom(slots, -height); index < slots.length; ) {
      const end = Math.min(slots.length, index + 8);
      for (; index < end; index += 1) {
        if (slots[index].style.contentVisibility) continue;
        slots[index].style.contentVisibility = "visible";
        forced.push(slots[index]);
      }
      if (slots[end - 1].getBoundingClientRect().top > 2 * height) break;
    }
    if (forced.length === 0) return anchor;
    const drift = anchor ? layoutRect(anchor).top - placed : 0;
    if (Math.abs(drift) >= 0.5) {
      window.dispatchEvent(new Event(SCROLL_JUMP_EVENT));
      window.scrollTo({ top: window.scrollY + drift, behavior: "instant" });
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const slot of forced) slot.style.contentVisibility = "";
      })
    );
    return anchor;
  }

  // Ends the place keeping in progress, if any.
  let keeping: (() => void) | null = null;

  /**
   * Hold the reader's place card where a new list put it while the browser
   * renders the cards above it. Those that stood at the height estimate take
   * their own heights in the frames after the change, during layout — after
   * any frame callback could re-aim, so the frame would paint the place
   * pushed off. A ResizeObserver runs after that layout and before the
   * paint, and scrolls back whatever the place card has moved on the screen
   * (nothing, where the browser's own scroll anchoring has already). The
   * reader's first scroll, press or key ends it: from then on the place is
   * theirs.
   */
  function keepPlace(feed: HTMLElement, anchor: HTMLElement): void {
    keeping?.();
    if (typeof ResizeObserver !== "function") return;
    const slots = slotsOf(feed);
    const end = slots.indexOf(anchor);
    if (end <= 0) return;
    const placed = layoutRect(anchor).top;
    const observer = new ResizeObserver(() => {
      if (!anchor.isConnected) {
        stop();
        return;
      }
      const drift = layoutRect(anchor).top - placed;
      if (Math.abs(drift) < 0.5) return;
      window.dispatchEvent(new Event(SCROLL_JUMP_EVENT));
      window.scrollTo({ top: window.scrollY + drift, behavior: "instant" });
    });
    // The browser renders well ahead of the screen; three viewports covers it.
    for (let index = firstFrom(slots, -3 * window.innerHeight); index < end; index += 1) observer.observe(slots[index]);
    const timer = window.setTimeout(() => stop(), HOLD_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const type of READER_INPUT) window.removeEventListener(type, stop);
      if (keeping === stop) keeping = null;
    };
    for (const type of READER_INPUT) window.addEventListener(type, stop, { passive: true });
    keeping = stop;
  }

  /** Where each exit in flight is drawn now — but those riding the sticky bar, which move with it. */
  function placeGhosts(): Map<HTMLElement, DOMRect> {
    const placed = new Map<HTMLElement, DOMRect>();
    for (const node of ghosts) {
      if (node instanceof HTMLElement && node.isConnected && !node.closest(".topbar")) placed.set(node, node.getBoundingClientRect());
    }
    return placed;
  }

  /**
   * An exit in flight finishes where the reader sees it: when the change
   * scrolled the page (a new list starts at the top) or moved its layer,
   * the stand-in is moved back by as much.
   */
  function rebase(placed: Map<HTMLElement, DOMRect>): void {
    for (const [node, was] of placed) {
      if (!node.isConnected) continue;
      const now = node.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      node.style.left = `${(Number.parseFloat(node.style.left) || 0) + dx}px`;
      node.style.top = `${(Number.parseFloat(node.style.top) || 0) + dy}px`;
    }
  }

  function capture(intent: FeedIntent, ids: Iterable<string>, morphed: string | undefined): Capture | null {
    const feed = options.feed();
    if (!feed) return null;
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
      const shot = { el: slot, copy: null, ...measure(slot, glides.has(slot)) };
      shots.set(key, shot);
      if (shot.box.top > 2 * height) break;
      if (shot.box.top < 0 && !targets.has(key)) anchor = { el: slot, top: shot.box.top };
    }
    // Named cards outside the band (a batch can name hundreds).
    if (Array.from(targets).some((key) => !shots.has(key))) {
      for (const slot of slots) {
        const key = slot.dataset.vt;
        if (key && targets.has(key) && !shots.has(key)) shots.set(key, { el: slot, copy: null, ...measure(slot, glides.has(slot)) });
      }
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
    return { intent, targets, known, shots, anchor, morphed: morphed === undefined ? undefined : `memo-${morphed}` };
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

  /** Keep a card at `layer` while `animation` carries it. */
  function raise(el: HTMLElement, layer: number, animation: Animation): void {
    if (layer <= 0) return;
    el.style.zIndex = String(layer);
    lifted.add(el);
    const release = () => {
      // Unless a later motion carries it now.
      const current = glides.get(el);
      if ((current === undefined || current === animation) && lifted.delete(el)) el.style.zIndex = "";
    };
    void Promise.resolve(animation.finished).then(release, () => undefined);
  }

  /** Keep a card that has no motion of its own over the exits for `ms`. */
  function liftFor(el: HTMLElement, ms: number): void {
    el.style.zIndex = "1";
    lifted.add(el);
    window.setTimeout(() => {
      if (!glides.has(el) && lifted.delete(el)) el.style.zIndex = "";
    }, ms);
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
    const animation = el.animate([from, to], { duration: GLIDE_MS, easing: ease("--ease-out") });
    glides.set(el, animation);
    raise(el, layer, animation);
    void Promise.resolve(animation.finished).then(
      () => {
        if (glides.get(el) === animation) glides.delete(el);
      },
      () => undefined
    );
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
    enter(unseen(slotsOf(feed)));
  }

  /** What the cards do: the reader's place kept now, the motions to play once whatever is in flight has stopped. */
  function plan(capture: Capture, reduced: boolean): { result: FeedMotionResult; changed: boolean; motions: Array<() => void> } {
    const result: FeedMotionResult = { departed: new Map() };
    const motions: Array<() => void> = [];
    const feed = options.feed();
    if (!feed) return { result, changed: false, motions };

    // The reader's place. A change wholly above the screen — a memo arriving
    // from another device, a card pinned out of the middle of the page —
    // must not slide what they are reading. Chromium's scroll anchoring
    // often has done this already by the time the box is read (then the
    // anchor has not drifted and this is a no-op); Safari has none, and no
    // engine anchors to a node React has just moved.
    // A send adds its memo at the head of the list, where the reader wrote it.
    const { anchor } = capture;
    if (anchor && anchor.el.parentElement === feed && capture.intent !== "create") {
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
          // the lens: the feed's own entrance, where it can be seen. A sent
          // memo drops in from the composer above, unless the morph carrying
          // its text plays its arrival.
          changed = true;
          if (key === capture.morphed) continue;
          if (onScreen(box.top, box.height)) {
            const delay = Math.min(arrivals++, STAGGER_CAP) * STAGGER_MS;
            const arrival: Arrival = capture.intent === "create" && capture.targets.has(key) ? "drop" : "rise";
            motions.push(() => (reduced ? arrive(slot, "fade", DISSOLVE_MS) : arrive(slot, arrival, ARRIVE_MS, delay)));
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

    return { result, changed, motions };
  }

  /**
   * A new list, measured where the reader sees it: before the change, and
   * after it with its scroll reset or place restored. A card in both that is
   * near the screen at both ends glides; one that comes from (or goes to)
   * far off would streak across the page, so it leaves and enters like its
   * neighbours. Cards the change drops sink where they stood; the ones it
   * brings rise a beat later, ≤48ms apart down the page. The change itself
   * chose where the reader lands — the top, or the card they left — and
   * keepPlace holds it there; nothing here moves the page.
   */
  function planLens(capture: Capture, reduced: boolean): { result: FeedMotionResult; changed: boolean; motions: Array<() => void> } {
    const result: FeedMotionResult = { departed: new Map() };
    const motions: Array<() => void> = [];
    const feed = options.feed();
    if (!feed) return { result, changed: false, motions };
    const height = window.innerHeight;
    const slots = slotsOf(feed);
    const leave = (node: HTMLElement, shot: Shot) => (reduced ? ghost(node, shot, "fade", DISSOLVE_MS) : ghost(node, shot, "sink"));
    let changed = false;
    let ghosted = false;
    let arrivals = 0;
    // The cards measured after the change.
    const placed = new Set<string>();
    // Kept cards that stay put on screen.
    const still: HTMLElement[] = [];
    for (let index = firstFrom(slots, -height); index < slots.length; index += 1) {
      const slot = slots[index];
      const key = slot.dataset.vt;
      if (!key) continue;
      const box = boxOf(slot);
      if (box.top > 2 * height) break;
      placed.add(key);
      const shot = capture.shots.get(key);
      // A card still waiting out its entrance was never seen: it arrives again.
      const seen = shot && shot.opacity >= UNSEEN ? shot : undefined;
      if (seen && nearScreen(seen.at.top, seen.box.height) && nearScreen(box.top, box.height)) {
        const dx = seen.at.left - box.left;
        const dy = seen.at.top - box.top;
        if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || seen.opacity < 0.99) {
          changed = true;
          motions.push(() => (reduced ? dissolve(slot, seen) : glide(slot, dx, dy, seen.opacity, ghosted ? 1 : 0)));
        } else if (onScreen(box.top, box.height)) still.push(slot);
        continue;
      }
      if (seen && seenAt(seen)) {
        // From where the reader saw it, to far off: its look (the same card)
        // leaves from there.
        changed = true;
        ghosted = true;
        motions.push(() => leave(slot.cloneNode(true) as HTMLElement, seen));
      }
      if (onScreen(box.top, box.height)) {
        changed = true;
        const delay = LENS_LAG_MS + Math.min(arrivals++, STAGGER_CAP) * STAGGER_MS;
        // The new list comes in over the old one leaving, not under it.
        motions.push(() => raise(slot, ghosted ? 1 : 0, reduced ? arrive(slot, "fade", DISSOLVE_MS) : arrive(slot, "rise", ARRIVE_MS, delay)));
      }
    }
    for (const [key, shot] of capture.shots) {
      if (placed.has(key) || !seenAt(shot)) continue;
      changed = true;
      ghosted = true;
      // Gone from the list: its own node, which React is done with. Still in
      // it but far off now: a copy of it, which looks the same.
      const node = shot.el.parentElement === feed ? (shot.el.cloneNode(true) as HTMLElement) : shot.el;
      motions.push(() => leave(node, shot));
    }
    // What stays put can still be moved by the page (the phone composer
    // unfolding above it): it too passes over the exits, not under them.
    if (ghosted) motions.push(() => still.forEach((slot) => liftFor(slot, EXIT_MS)));
    return { result, changed, motions };
  }

  function play(intent: FeedIntent, capture: Capture | null, chrome: ChromeCapture | null, inFlight: Map<HTMLElement, DOMRect>): FeedMotionResult {
    // Reduced motion keeps every decision and changes only how each one
    // plays: a dissolve in place, never a cut and never a journey.
    const reduced = reducedMotion();
    const cards = !capture
      ? { result: { departed: new Map<string, Departure>() }, changed: false, motions: [] }
      : capture.intent === "lens"
        ? planLens(capture, reduced)
        : plan(capture, reduced);
    // A send with no morph to close the composer (reduced motion, or no
    // view transitions): its typed look hands over to the emptied one. A
    // morph closes it itself; without one at full motion the field eases
    // down on its own height.
    const handover = intent === "create" && !capture?.morphed && reduced ? new Set(["composer"]) : undefined;
    const around = chrome ? chromeMotions(chrome, stage, reduced, handover) : [];
    rebase(inFlight);
    // Nothing moved: whatever is in flight keeps flying.
    if (!cards.changed && around.length === 0) return cards.result;
    // A morph still on screen (a send's, a photo's) holds parts the change
    // moves: end it here — the DOM holds its end state.
    if (transitionLive()) skipLiveTransition();
    // What is still running was captured where it was painted, and the new
    // motions start from there.
    stopGlides();
    for (const motion of cards.motions) motion();
    for (const motion of around) motion();
    if (!pressesHeld) {
      pressesHeld = true;
      document.addEventListener("pointerdown", holdPress, true);
    }
    return cards.result;
  }

  return {
    run(intent, ids, commit, { motion = "auto", morphed } = {}) {
      // With no Web Animations there is nothing to play. A change without
      // motion lands what is in flight with it.
      if (motion === "none" || !hasAnimations()) {
        if (motion === "none") settle();
        try {
          commit();
        } finally {
          claim();
        }
        return EMPTY;
      }
      let taken: Capture | null = null;
      let chrome: ChromeCapture | null = null;
      let inFlight = new Map<HTMLElement, DOMRect>();
      // This change decides the reader's place now.
      keeping?.();
      try {
        // Cards mounted just before this change enter first, so it starts
        // from the frame their entrance paints.
        flush();
        taken = capture(intent, ids, morphed);
        const root = options.feed()?.closest("main");
        chrome = root ? captureChrome(root, stage) : null;
        inFlight = placeGhosts();
      } catch {
        taken = null;
        chrome = null;
      }
      try {
        commit();
      } finally {
        // The change's own new cards are play's to move.
        claim();
      }
      if (!taken && !chrome) return EMPTY;
      try {
        const feed = options.feed();
        const anchor = feed ? materialize(feed) : undefined;
        // A new list keeps the place it lands on (a rewind's top, a return's card).
        if (feed && anchor && intent === "lens") keepPlace(feed, anchor);
        return play(intent, taken, chrome, inFlight);
      } catch {
        // Motion is decoration: a failure here must never fail the action.
        settle();
        return EMPTY;
      }
    },
    settle,
    observe,
    claim
  };
}
