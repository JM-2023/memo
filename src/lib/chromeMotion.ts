import { motionOffset, type Box } from "./feedBoxes";
import { T_BASE, T_ENTER, T_EXIT, T_FAST, T_SLOW } from "./motion";

/**
 * The chrome around the feed — the location pill and its trail, the filter
 * chips, the selection toolbar — moved in the same run as the cards
 * (lib/feedMotion.ts), on live DOM: what the reader sees is always what
 * takes the press.
 *
 * Each part answers to a key. A key found on both sides of a change glides
 * from where it was drawn; one whose look changed (a pill relabelled, armed,
 * or a different element taking the slot) cross-fades as it glides — a copy
 * taken before the change fades out while the live element fades in, both at
 * their natural size. A key the change takes away leaves a stand-in that
 * plays its exit; a key it brings plays its own CSS entrance, or a short
 * fade-in when it has none. Under reduced motion nothing travels: the same
 * decisions play as opacity alone.
 */

type ChromeExit = "crumb" | "fade" | "sink";

interface ChromeKey {
  selector: string;
  /** The key the element answers to. */
  name: string | ((el: Element) => string | undefined);
  /** How it leaves when a change takes it away. */
  exit: ChromeExit;
  /**
   * Holds parts that move by themselves (crumbs cascading in, pills with
   * their own entrance, nested keys): it glides as a whole when it moves, and
   * never cross-fades for what changed inside it.
   */
  container?: boolean;
}

const KEYS: ChromeKey[] = [
  // One slot, four elements that never render together: the location pill,
  // the selection counter, Empty Trash and Review settings morph into each
  // other.
  { selector: ".loc-trigger, .select-count, .trash-empty-button, .review-config-button", name: "topbar-action", exit: "fade" },
  { selector: ".crumbs:not(.view-trail)", name: "trail", exit: "crumb", container: true },
  { selector: ".view-trail", name: "view-trail", exit: "crumb" },
  { selector: ".loc-sep", name: "loc-sep", exit: "crumb" },
  { selector: ".trash-select-button", name: "trash-select", exit: "crumb" },
  { selector: ".select-bar", name: "select-bar", exit: "crumb", container: true },
  { selector: ".select-delete", name: "select-delete", exit: "crumb" },
  // The toolbar's other pills: they make room when the delete pill arms.
  { selector: ".select-lens", name: "select-lens", exit: "crumb" },
  { selector: ".select-all", name: "select-all", exit: "crumb" },
  { selector: ".select-tag", name: "select-tag", exit: "crumb" },
  { selector: ".select-exit", name: "select-exit", exit: "crumb" },
  { selector: ".searchbox", name: "searchbox", exit: "fade" },
  // Filter chips name themselves.
  { selector: "[data-motion]", name: (el) => (el as HTMLElement).dataset.motion, exit: "crumb" }
];
const ANY_KEY = KEYS.map((key) => key.selector).join(", ");
/** Stand-ins carry this; they are never parts themselves. */
const GHOST = "data-motion-ghost";
/** Text that animates its own changes (the selected count's split-flap, a swapped label). */
const SELF_TEXT = ".roll, .swap";
/** A key with no entrance of its own fades in a beat late, behind what leaves. */
const ARRIVAL_LAG_MS = 30;

const EXITS: Record<ChromeExit, { duration: number; frames: (opacity: number) => Keyframe[] }> = {
  // crumb-out: the trail folding back.
  crumb: {
    duration: T_BASE,
    frames: (opacity) => [
      { opacity, transform: "none", filter: "blur(0)" },
      { opacity: 0, transform: "translateX(-10px)", filter: "blur(3px)" }
    ]
  },
  fade: { duration: T_FAST, frames: (opacity) => [{ opacity }, { opacity: 0 }] },
  // card-depart: what sinks with the cards.
  sink: { duration: T_EXIT, frames: (opacity) => [{ opacity, transform: "none" }, { opacity: 0, transform: "scale(0.965)" }] }
};

type Part = HTMLElement | SVGElement;

/** What the engine lends the chrome pass: its easing, and its books. */
export interface ChromeStage {
  ease(token: "--ease" | "--ease-out"): string;
  /** Play on a live part; the engine cancels it when the next change starts. */
  animate(el: Part, keyframes: Keyframe[], timing: KeyframeAnimationOptions): Animation;
  /** Whether a live part is carried by one of those animations now. */
  owns(el: Part): boolean;
  /** Keep a stand-in until `animation` is done; the engine clears it on settle. */
  keep(ghost: Part, animation: Animation): void;
}

interface Shot {
  key: string;
  spec: ChromeKey;
  el: Part;
  /** The bar it rides in, if any: positions are kept against it, so the bar's own tuck isn't counted. */
  band: Element | null;
  /** Layout box and painted spot, against the band (or the viewport). */
  box: Box;
  at: { left: number; top: number };
  opacity: number;
  className: string;
  text: string;
  /** The element as it looked, for a stand-in. */
  copy: Part;
  /** Where a stand-in can live: the element's ancestors, nearest first. */
  hosts: Element[];
  /** The key of the nearest keyed ancestor. */
  parent: string | null;
}

interface Found {
  spec: ChromeKey;
  key: string;
  el: Part;
  parent: string | null;
}

export interface ChromeCapture {
  root: HTMLElement;
  shots: Map<string, Shot>;
}

function specOf(el: Element): ChromeKey | undefined {
  return KEYS.find((spec) => el.matches(spec.selector));
}

function keyOf(el: Element, spec = specOf(el)): string | undefined {
  if (!spec) return undefined;
  return typeof spec.name === "string" ? spec.name : spec.name(el);
}

/** Every keyed part on screen under `root`, by key, with its keyed parent. */
function find(root: HTMLElement): Map<string, Found> {
  const found = new Map<string, Found>();
  const keyed = new Map<Element, string>();
  for (const el of Array.from(root.querySelectorAll<Part>(ANY_KEY))) {
    if (el.closest(`[${GHOST}], [hidden], .feed-ghosts`)) continue;
    const spec = specOf(el);
    const key = keyOf(el, spec);
    if (!spec || !key || found.has(key)) continue;
    keyed.set(el, key);
    let parent: string | null = null;
    for (let up = el.parentElement; up && up !== root; up = up.parentElement) {
      const name = keyed.get(up);
      if (name) {
        parent = name;
        break;
      }
    }
    found.set(key, { spec, key, el, parent });
  }
  return found;
}

function bandOf(el: Element): Element | null {
  return el.closest(".topbar");
}

/** Layout box and painted spot, against the band. */
function measure(el: Part, band: Element | null): { box: Box; at: { left: number; top: number } } {
  const rect = el.getBoundingClientRect();
  const { glide, own } = motionOffset(el);
  const origin = band ? band.getBoundingClientRect() : { left: 0, top: 0 };
  const left = rect.left - origin.left - glide.x - own.x;
  const top = rect.top - origin.top - glide.y - own.y;
  return { box: { left, top, width: rect.width, height: rect.height }, at: { left: left + glide.x, top: top + glide.y } };
}

function ancestors(el: Element, root: HTMLElement): Element[] {
  const chain: Element[] = [];
  for (let up = el.parentElement; up; up = up.parentElement) {
    chain.push(up);
    if (up === root) break;
  }
  return chain;
}

/** The chrome as the reader sees it, before a change commits. */
export function captureChrome(root: HTMLElement, stage: Pick<ChromeStage, "owns">): ChromeCapture {
  const shots = new Map<string, Shot>();
  for (const { spec, key, el, parent } of find(root).values()) {
    const band = bandOf(el);
    const { box, at } = measure(el, band);
    const opacity = stage.owns(el) ? Number.parseFloat(getComputedStyle(el).opacity) : 1;
    shots.set(key, {
      key,
      spec,
      el,
      band,
      box,
      at,
      opacity: Number.isFinite(opacity) ? opacity : 1,
      className: el.getAttribute("class") ?? "",
      text: el.textContent ?? "",
      copy: el.cloneNode(true) as Part,
      hosts: ancestors(el, root),
      parent
    });
  }
  return { root, shots };
}

/** Does the element bring its own entrance (a CSS animation in its subtree)? */
function entersByItself(el: Part): boolean {
  if (typeof el.getAnimations !== "function" || typeof CSSAnimation === "undefined") return false;
  return el.getAnimations({ subtree: true }).some((animation) => animation instanceof CSSAnimation);
}

/** A clip that hides `from`px of the element's right side, then `to`px — its own corners kept. */
function trim(el: Part, from: number, to: number): Keyframe[] {
  const radius = getComputedStyle(el).borderRadius || "0px";
  return [{ clipPath: `inset(0px ${from}px 0px 0px round ${radius})` }, { clipPath: `inset(0px ${to}px 0px 0px round ${radius})` }];
}

/**
 * Put a copy where the reader last saw its part, in the nearest ancestor the
 * change left in place: absolutely positioned, inert, out of the
 * accessibility tree, its own CSS motion and names switched off.
 */
function stand(shot: Shot, band: Element | null, hidden: (el: Element) => boolean): Part | null {
  const host = shot.hosts.find((candidate) => candidate.isConnected);
  if (!host) return null;
  const ghost = shot.copy.cloneNode(true) as Part;
  ghost.setAttribute(GHOST, "");
  ghost.setAttribute("aria-hidden", "true");
  if (ghost instanceof HTMLElement) ghost.inert = true;
  for (const el of [ghost, ...Array.from(ghost.querySelectorAll<Part>("*"))]) {
    el.removeAttribute("id");
    el.style.setProperty("animation", "none", "important");
    el.style.setProperty("transition", "none", "important");
    el.style.setProperty("view-transition-name", "none", "important");
  }
  // Parts the change kept (the pill inside a leaving trail) move on their own.
  for (const el of Array.from(ghost.querySelectorAll<Part>(ANY_KEY))) if (hidden(el)) el.style.visibility = "hidden";
  const style = ghost.style;
  style.position = "absolute";
  style.left = "0px";
  style.top = "0px";
  style.margin = "0px";
  style.boxSizing = "border-box";
  style.width = `${shot.box.width}px`;
  style.height = `${shot.box.height}px`;
  style.pointerEvents = "none";
  style.zIndex = "1";
  host.appendChild(ghost);
  const origin = band ? band.getBoundingClientRect() : { left: 0, top: 0 };
  const placed = ghost.getBoundingClientRect();
  style.left = `${origin.left + shot.at.left - placed.left}px`;
  style.top = `${origin.top + shot.at.top - placed.top}px`;
  return ghost;
}

/**
 * The motions that take the chrome from `capture` to what the DOM holds now,
 * ready to play once the engine has stopped what was in flight. Empty when
 * nothing in the chrome changed.
 */
export function chromeMotions(capture: ChromeCapture, stage: ChromeStage, reduced: boolean): Array<() => void> {
  const motions: Array<() => void> = [];
  const after = find(capture.root);
  const before = capture.shots;
  const kept = (el: Element) => {
    const key = keyOf(el);
    return key !== undefined && after.has(key);
  };
  const easeOut = stage.ease("--ease-out");
  const easeIn = stage.ease("--ease");

  // A hand-over rides the glide's own front-loaded curve: the new look is
  // mostly in within the first third, so the two never sit half-and-half.
  const fadeOut = (shot: Shot, band: Element | null, travel?: { x: number; y: number }, narrowTo?: number) => {
    const ghost = stand(shot, band, kept);
    if (!ghost) return;
    if (travel) ghost.animate([{ translate: "0px 0px" }, { translate: `${travel.x}px ${travel.y}px` }], { duration: T_ENTER, easing: easeOut, fill: "forwards" });
    if (narrowTo !== undefined) ghost.animate(trim(ghost, 0, shot.box.width - narrowTo), { duration: T_ENTER, easing: easeOut, fill: "forwards" });
    stage.keep(ghost, ghost.animate([{ opacity: shot.opacity }, { opacity: 0 }], { duration: T_BASE, easing: easeOut, fill: "forwards" }));
  };
  const fadeIn = (el: Part, duration = T_BASE, delay = 0, easing = easeOut) =>
    stage.animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing, fill: "backwards" });
  const glide = (el: Part, dx: number, dy: number, opacity: number) => {
    const from: Keyframe = { translate: `${dx}px ${dy}px` };
    const to: Keyframe = { translate: "0px 0px" };
    if (opacity < 0.99) {
      from.opacity = opacity;
      to.opacity = 1;
    }
    stage.animate(el, [from, to], { duration: T_ENTER, easing: easeOut });
  };

  for (const [key, shot] of before) {
    const next = after.get(key);
    if (!next) {
      // Inside a container that leaves too: its stand-in carries this one.
      if (shot.parent && before.has(shot.parent) && !after.has(shot.parent)) continue;
      motions.push(() => {
        if (reduced) {
          fadeOut(shot, shot.band);
          return;
        }
        const ghost = stand(shot, shot.band, kept);
        if (!ghost) return;
        const exit = EXITS[shot.spec.exit];
        stage.keep(ghost, ghost.animate(exit.frames(shot.opacity), { duration: exit.duration, easing: easeIn, fill: "forwards" }));
      });
      continue;
    }
    const band = bandOf(next.el);
    const now = measure(next.el, band);
    const dx = shot.at.left - now.box.left;
    const dy = shot.at.top - now.box.top;
    const moved = Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5;
    const selfText = next.el.querySelector(SELF_TEXT) !== null;
    const changed =
      !shot.spec.container &&
      (next.el !== shot.el ||
        (next.el.getAttribute("class") ?? "") !== shot.className ||
        (!selfText && ((next.el.textContent ?? "") !== shot.text || Math.abs(now.box.width - shot.box.width) >= 0.5 || Math.abs(now.box.height - shot.box.height) >= 0.5)));
    if (changed) {
      // The old look hands over to the new one: both glide the same way, at
      // their own sizes, while the copy fades out and the live part in. A
      // pill that changes width where it stands (arming) grows or shrinks
      // from its old edge instead, in step with the neighbours making room.
      const grow = !reduced && !moved && next.el === shot.el ? now.box.width - shot.box.width : 0;
      motions.push(() => {
        fadeOut(shot, band, reduced || !moved ? undefined : { x: -dx, y: -dy }, grow <= -0.5 ? now.box.width : undefined);
        if (!reduced && moved) glide(next.el, dx, dy, 1);
        if (grow >= 0.5) stage.animate(next.el, trim(next.el, grow, 0), { duration: T_ENTER, easing: easeOut });
        fadeIn(next.el);
      });
    } else if (moved || shot.opacity < 0.99) {
      motions.push(() => {
        if (!reduced) {
          glide(next.el, dx, dy, shot.opacity);
          return;
        }
        // Nothing travels: the old spot fades out, the new one in.
        if (moved) fadeOut(shot, band);
        fadeIn(next.el);
      });
    }
  }

  for (const [key, next] of after) {
    if (before.has(key)) continue;
    // Inside a container that arrives too: its entrance carries this one.
    if (next.parent && after.has(next.parent) && !before.has(next.parent)) continue;
    // Its own entrance (crumbs, pills, chips cascade in by CSS — faded under
    // reduced motion), or a kept part inside it that is moving by itself.
    if (entersByItself(next.el)) continue;
    if (Array.from(next.el.querySelectorAll(ANY_KEY)).some((el) => before.has(keyOf(el) ?? ""))) continue;
    motions.push(() => (reduced ? fadeIn(next.el) : fadeIn(next.el, T_SLOW, ARRIVAL_LAG_MS, easeIn)));
  }
  return motions;
}
