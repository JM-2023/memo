import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Loader2, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import { acquireImage, discardImage, peekImage, releaseImage, retainImage, type ImageVariant } from "../lib/imageCache";
import type { LightboxItem } from "../lib/types";
import { withViewTransition } from "../lib/viewTransition";
import { EXIT_MS } from "../lib/motion";

interface LightboxProps {
  items: LightboxItem[];
  index: number;
  onClose: () => void;
  /** Bumped by the owner to close the viewer the way its own ✕ does (Back). */
  closeSignal?: number;
}

/** Travel before a touch commits to an axis; under it a touch is still a tap. */
const AXIS_LOCK_PX = 10;
/** A flick this fast (px/ms) commits even when the travel is short. */
const FLICK_SPEED = 0.45;

interface Drag {
  id: number;
  x0: number;
  y0: number;
  axis: "x" | "y" | null;
  dx: number;
  dy: number;
  /** Recent samples, for the release velocity. */
  samples: Array<{ x: number; y: number; t: number }>;
}

type Dir = "fwd" | "back";

interface Held {
  url: string;
  variant: ImageVariant;
}

/** The image a page change took off screen, held until its successor can be seen. */
interface Leaving {
  /** The React key it was drawn under, so the very same <img> stays put. */
  key: string;
  src: string;
  external: boolean;
  dir: Dir;
  /** Where a swipe let go of it (0 for a key or button): it leaves from
      there, carrying on the way it was thrown, not from the centre. */
  dx: number;
}

/* ---- Shared-element morph between a feed tile and the viewer ----
   Opening, the tile's picture and the viewer's image carry one
   view-transition-name across the swap (app.css, lightbox section), so the
   photo grows out of its tile; closing, it shrinks back into the tile of the
   picture shown last. Only one element may hold the name in each captured
   state: the viewer's current image wears it through CSS for as long as it is
   mounted, and a tile gets it inline just for the capture it is in. */
const PHOTO_NAME = "lightbox-photo";

/** The tile a viewer is being opened from — handed to that one mount. */
let arrival: { tile: HTMLElement; morph: boolean } | null = null;
/** A tile still named for a close morph that may not have finished. */
let namedTile: HTMLImageElement | null = null;

function releaseNamedTile() {
  if (namedTile) namedTile.style.viewTransitionName = "";
  namedTile = null;
}

function morphsAllowed(): boolean {
  if (typeof document.startViewTransition !== "function") return false;
  return typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A tile's picture, when it can stand in for one end of the morph: painted
 * and on screen. A tile scrolled away, tucked under the sticky topbar or
 * gone from the feed would send the photo somewhere nobody can follow it —
 * the viewer then leaves the plain way.
 */
function morphablePicture(tile: HTMLElement | null): HTMLImageElement | null {
  const picture = tile?.isConnected ? tile.querySelector("img") : null;
  if (!picture || !picture.complete || picture.naturalWidth === 0) return null;
  const rect = picture.getBoundingClientRect();
  const topbar = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
  const visible = rect.width > 0 && rect.bottom > Math.max(0, topbar) + 8 && rect.top < window.innerHeight - 8 && rect.right > 0 && rect.left < window.innerWidth;
  return visible ? picture : null;
}

/**
 * Opens the viewer from a feed tile: the tile's picture grows into the
 * viewer's image when it is painted and motion is welcome, else the viewer
 * opens with its own zoom. `open` must mount the Lightbox (the owner's
 * setState); it runs inside flushSync so the mount can read which tile it
 * came from. A tile that is not given (or not found) still opens plainly.
 */
export function openLightboxFrom(tile: HTMLElement | null, open: () => void): void {
  const mount = (morph: boolean) => {
    arrival = tile ? { tile, morph } : null;
    try {
      flushSync(open);
    } finally {
      arrival = null;
    }
  };
  const picture = morphsAllowed() ? morphablePicture(tile) : null;
  if (!picture) {
    mount(false);
    return;
  }
  releaseNamedTile();
  picture.style.viewTransitionName = PHOTO_NAME;
  withViewTransition((animated) => {
    // The viewer's image takes the name over in the new state.
    picture.style.viewTransitionName = "";
    mount(animated);
  });
}

/** One identity per picture, whichever copy of it is on screen. */
function itemKey(item: LightboxItem): string {
  return item.imageId ? `id:${item.imageId}` : item.src;
}

/** The best copy memory holds of a stored image: the original, else the feed's preview. */
function peekCached(id: string): Held | null {
  for (const variant of ["full", "thumb"] as const) {
    const url = peekImage(id, variant);
    if (url) return { url, variant };
  }
  return null;
}

/**
 * What to draw for one item. A stored attachment is served no-store (the
 * client cache is sealed on purpose — see lib/imageCache), so it goes through
 * that cache: whatever memory already holds paints at once — the original if
 * it was seen, else the preview the feed tile drew — while the original is
 * acquired and swapped in when it lands. An external link is drawn as is.
 */
function useLightboxSource(item: LightboxItem, attempt: number) {
  const id = item.imageId;
  const key = `${itemKey(item)}#${attempt}`;
  const [state, setState] = useState(() => ({ key, held: id ? peekCached(id) : null, failed: false }));
  let current = state;
  if (state.key !== key) {
    // A new item (or a retry): its cached copy is known before paint.
    current = { key, held: id ? peekCached(id) : null, failed: false };
    setState(current);
  }
  const heldRef = useRef<Held | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const hold = (next: Held) => {
      const previous = heldRef.current;
      heldRef.current = next;
      if (previous) releaseImage(id, previous.variant, previous.url);
      setState((value) => (value.key === key ? { key, held: next, failed: false } : value));
    };
    for (const variant of ["full", "thumb"] as const) {
      const url = retainImage(id, variant);
      if (url) {
        hold({ url, variant });
        break;
      }
    }
    if (heldRef.current?.variant !== "full") {
      acquireImage(id, "full").then(
        (url) => {
          if (cancelled) releaseImage(id, "full", url);
          else hold({ url, variant: "full" });
        },
        () => {
          // A preview on screen stays there when its original fails.
          if (!cancelled && !heldRef.current) setState((value) => (value.key === key ? { ...value, failed: true } : value));
        }
      );
    }
    return () => {
      cancelled = true;
      const held = heldRef.current;
      heldRef.current = null;
      if (held) releaseImage(id, held.variant, held.url);
    };
  }, [id, key]);

  /** The bytes arrived but do not decode: forget them so a retry refetches. */
  const onDecodeError = () => {
    const held = heldRef.current;
    if (id && held) discardImage(id, held.variant);
  };

  if (!id) return { src: item.src as string | null, failed: false, onDecodeError };
  return { src: current.held?.url ?? null, failed: current.failed, onDecodeError };
}

/**
 * Full-screen image viewer: backdrop fade, the photo growing out of its feed
 * tile on open (or a zoom-in when it can't — see openLightboxFrom), then a
 * directional slide per page; closing shrinks the photo back into the tile
 * of the picture shown last. Paging by ←/→ (Home/End for the ends), the
 * arrow buttons, or a horizontal swipe; a downward swipe dismisses. Only
 * single-finger touch is claimed (`touch-action: pinch-zoom`), so the
 * platform's own pinch zoom keeps working, and once the page is zoomed the
 * swipes stand down so a finger pans the zoomed view instead.
 *
 * A page change never cuts to black: the outgoing picture stays on its own
 * aria-hidden layer until the incoming one can be seen, then the two swap.
 */
export function Lightbox({ items, index, onClose, closeSignal = 0 }: LightboxProps) {
  const { tr } = useI18n();
  // Read once, during the mount openLightboxFrom wrapped.
  const [origin] = useState(() => arrival);
  // The first picture arrives by the morph from its tile, so its own zoom
  // stands down — unless it has no pixels yet to morph into (see below).
  const [morphIn, setMorphIn] = useState(() => origin?.morph === true);
  // `dir` picks the entrance: null is the first open (zoom, or the morph
  // from the tile), then the direction of travel for each page change.
  const [view, setView] = useState<{ current: number; dir: Dir | null }>({ current: index, dir: null });
  const [closing, setClosing] = useState(false);
  // Set by every close path, including the morph, which never sets
  // `closing`: its exit is the transition's, not the stylesheet's.
  const closingRef = useRef(false);
  // A swipe that dismissed leaves the image where the finger let go.
  const [flung, setFlung] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // Pictures that have been on screen once — by item, not by URL, so a page
  // seen a moment ago (or a preview being upgraded to its original) is
  // drawn at once instead of fading in again.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const reducedMotion = useReducedMotion();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeTimer = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dragRef = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  // The tile that opened the viewer: the one openLightboxFrom handed over (a
  // click does not focus a button in Safari), else whatever had focus — read
  // before the modal hook moves focus.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    openerRef.current = origin?.tile ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, []);

  const current = Math.min(view.current, items.length - 1);
  const item = items[current];
  const key = itemKey(item);
  const imageKey = `${key}#${attempt}`;
  const source = useLightboxSource(item, attempt);
  const status: "loading" | "ready" | "failed" =
    failed.has(key) || (source.failed && !source.src) ? "failed" : loaded.has(key) && source.src ? "ready" : "loading";

  /** The stylesheet's exit: the scrim fades (under reduced motion that is
      all that happens), the picture recedes with it or, flung, stays where
      the finger let it go. */
  function leavePlainly(swiped: boolean) {
    setClosing(true);
    setFlung(swiped);
    closeTimer.current = window.setTimeout(() => closeRef.current(), EXIT_MS);
  }

  function requestClose(swiped = false) {
    if (closingRef.current) return;
    closingRef.current = true;
    if (!morphHome(swiped)) leavePlainly(swiped);
  }

  /**
   * Close by shrinking the photo back into the tile of the picture on screen
   * — from wherever it is painted, so a swipe-down hands the photo straight
   * from the finger to its tile. False when that can't be seen through (no
   * tile in view, a pinch-zoomed page, a picture still loading, reduced
   * motion): the caller leaves plainly instead.
   */
  function morphHome(swiped: boolean): boolean {
    if (reducedMotion || zoomed || status !== "ready" || !imageRef.current || !morphsAllowed()) return false;
    const target = morphablePicture(currentTile());
    if (!target) return false;
    releaseNamedTile();
    const root = document.documentElement;
    root.dataset.vtLightbox = "close";
    const transition = withViewTransition((animated) => {
      if (!animated) {
        // No snapshots after all: the viewer is still up, so it leaves the
        // way it always has.
        delete root.dataset.vtLightbox;
        flushSync(() => leavePlainly(swiped));
        return;
      }
      flushSync(() => closeRef.current());
      target.style.viewTransitionName = PHOTO_NAME;
      namedTile = target;
    });
    // The tile gives the name back once the snapshots have let go of it.
    const release = () => {
      if (namedTile === target) releaseNamedTile();
      if (root.dataset.vtLightbox === "close") delete root.dataset.vtLightbox;
    };
    if (transition) void Promise.resolve(transition.finished).then(release, release);
    return true;
  }

  // Back closes the viewer with its own exit, not an unmount. Only a change
  // after mount counts: the value it opened with is the owner's old count.
  const closeSignalRef = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal === closeSignalRef.current) return;
    closeSignalRef.current = closeSignal;
    requestClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeSignal]);

  function goTo(next: number, dir: Dir, dx = 0) {
    if (next === current) return;
    // Whatever is on screen now stays there, on its own layer, until the
    // next picture can take its place.
    setLeaving((previous) => {
      const outgoing =
        status === "ready" && source.src ? { key: imageKey, src: source.src, external: Boolean(item.external), dir, dx } : previous && { ...previous, dir };
      return outgoing && !outgoing.key.startsWith(`${itemKey(items[next])}#`) ? outgoing : null;
    });
    setAttempt(0);
    setView({ current: next, dir });
  }

  function page(step: 1 | -1, dx = 0) {
    goTo((current + items.length + step) % items.length, step > 0 ? "fwd" : "back", dx);
  }

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: () => requestClose(), initialFocusRef: closeButtonRef });

  // The feed tile of the picture on screen, if it is still in the feed.
  const currentRef = useRef(current);
  currentRef.current = current;
  function currentTile(): HTMLElement | null {
    const grid = openerRef.current?.closest(".memo-images");
    return grid?.querySelector<HTMLElement>(`[data-lightbox-index="${currentRef.current}"]`) ?? null;
  }

  // Runs after the modal hook's own restore (cleanups run in order): the
  // reader may have paged away from the tile that opened the viewer, so
  // focus lands on the tile of the picture they were looking at.
  useLayoutEffect(
    () => () => {
      const tile = currentTile();
      if (tile?.isConnected && tile !== document.activeElement) tile.focus({ preventScroll: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ←/→ page, Home/End jump to the ends. A lone image has nowhere to go; a
  // held modifier means a browser shortcut (Cmd+← and Alt+← are Back); a
  // closing viewer is already done.
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (event) => {
    if (closingRef.current || items.length < 2 || event.defaultPrevented || event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft") page(-1);
    else if (event.key === "ArrowRight") page(1);
    else if (event.key === "Home") goTo(0, "back");
    else if (event.key === "End") goTo(items.length - 1, "fwd");
    else return;
    event.preventDefault();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  // A pinch-zoomed page hands single-finger pans back to the browser.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setZoomed(viewport.scale > 1.01);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);

  function markLoaded(target: string) {
    setLoaded((value) => (value.has(target) ? value : new Set(value).add(target)));
  }

  // A picture the browser already holds decoded (a cached blob, a page seen
  // a moment ago) is ready before paint; waiting for onLoad would flash it
  // in from nothing.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image && source.src && image.complete && image.naturalWidth > 0) markLoaded(key);
  }, [key, source.src, attempt]);

  // The new state is captured right after this mount: a picture with no
  // pixels yet leaves the morph nothing to land on, so its zoom plays once
  // it arrives instead of it popping in.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (morphIn && !(image && image.complete && image.naturalWidth > 0)) setMorphIn(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the current picture is up, fetch its neighbours' originals through
  // the cache so the next page is already there. Raw URLs are left alone.
  const ready = status === "ready";
  useEffect(() => {
    if (!ready || items.length < 2) return;
    let cancelled = false;
    const held: Array<{ id: string; url: string }> = [];
    const ids = new Set<string>();
    for (const offset of [1, -1]) {
      const id = items[(current + offset + items.length) % items.length].imageId;
      if (id && id !== item.imageId) ids.add(id);
    }
    for (const id of ids) {
      acquireImage(id, "full").then(
        (url) => {
          if (cancelled) releaseImage(id, "full", url);
          else held.push({ id, url });
        },
        () => undefined
      );
    }
    return () => {
      cancelled = true;
      for (const { id, url } of held) releaseImage(id, "full", url);
    };
  }, [ready, current, items, item.imageId]);

  function retry() {
    setFailed((value) => {
      const next = new Set(value);
      next.delete(key);
      return next;
    });
    setAttempt((value) => value + 1);
    setMorphIn(false);
    // The Retry button leaves with the failed state; keep focus in the viewer.
    overlayRef.current?.focus({ preventScroll: true });
  }

  function setDragStyle(dx: number, dy: number, fade: number) {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.style.setProperty("--lb-dx", `${dx}px`);
    overlay.style.setProperty("--lb-dy", `${dy}px`);
    overlay.style.setProperty("--lb-fade", String(fade));
  }

  function endDrag() {
    dragRef.current = null;
    setDragging(false);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) {
      // A second finger means pinch: let it go to the browser untouched.
      if (dragRef.current) {
        setDragStyle(0, 0, 0);
        endDrag();
      }
      return;
    }
    // A fresh touch is a new gesture: only the click that trails a swipe's
    // own release is swallowed, never a deliberate tap that follows it.
    suppressClickUntil.current = 0;
    if (event.pointerType === "mouse" || zoomed || closingRef.current) return;
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    dragRef.current = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      axis: null,
      dx: 0,
      dy: 0,
      samples: [{ x: event.clientX, y: event.clientY, t: event.timeStamp }]
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    drag.dx = event.clientX - drag.x0;
    drag.dy = event.clientY - drag.y0;
    drag.samples.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });
    if (drag.samples.length > 6) drag.samples.shift();
    if (!drag.axis) {
      if (Math.hypot(drag.dx, drag.dy) < AXIS_LOCK_PX) return;
      drag.axis = Math.abs(drag.dx) > Math.abs(drag.dy) ? "x" : "y";
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture is a nicety; the gesture still tracks without it.
      }
      setDragging(true);
    }
    if (drag.axis === "x") {
      // A lone image has nowhere to page to: resist instead.
      setDragStyle(items.length > 1 ? drag.dx : drag.dx * 0.25, 0, 0);
    } else {
      const dy = drag.dy > 0 ? drag.dy : drag.dy * 0.25;
      setDragStyle(0, dy, Math.min(1, Math.max(0, dy) / (window.innerHeight * 0.5)));
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    endDrag();
    if (!drag.axis) return;
    suppressClickUntil.current = event.timeStamp + 400;
    const first = drag.samples.find((sample) => event.timeStamp - sample.t <= 100) ?? drag.samples[0];
    const elapsed = Math.max(1, event.timeStamp - first.t);
    const vx = (event.clientX - first.x) / elapsed;
    const vy = (event.clientY - first.y) / elapsed;
    if (drag.axis === "x") {
      const far = Math.abs(drag.dx) > window.innerWidth * 0.25;
      const flick = Math.abs(vx) > FLICK_SPEED && Math.abs(drag.dx) > 30 && Math.sign(vx) === Math.sign(drag.dx);
      setDragStyle(0, 0, 0);
      // A committed swipe hands its offset to the leaving layer, which stays
      // where the finger let go instead of springing back to the centre.
      if (items.length > 1 && (far || flick)) page(drag.dx < 0 ? 1 : -1, drag.dx);
      return;
    }
    const far = drag.dy > window.innerHeight * 0.18;
    const flick = vy > FLICK_SPEED && drag.dy > 40;
    if (far || flick) {
      // Leave the image where the finger let go; the overlay fades it out.
      requestClose(true);
      return;
    }
    setDragStyle(0, 0, 0);
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current || dragRef.current.id !== event.pointerId) return;
    setDragStyle(0, 0, 0);
    endDrag();
  }

  const classes = ["overlay", "lightbox"];
  if (items.length > 1) classes.push("has-nav");
  if (dragging) classes.push("is-dragging");
  if (zoomed) classes.push("is-zoomed");
  if (closing) classes.push("is-closing");
  if (flung) classes.push("is-flung");

  // The outgoing layer leaves (on the existing swap-out keyframes) the moment
  // its successor is ready or has failed — never before, so there is no gap.
  const outgoing = leaving && leaving.key !== imageKey ? leaving : null;
  const settled = status !== "loading";

  return (
    <div
      ref={overlayRef}
      className={classes.join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label={tr("View image", "查看图片")}
      tabIndex={-1}
      onClickCapture={(event) => {
        // The tail of a swipe is not a tap on the backdrop.
        if (event.timeStamp < suppressClickUntil.current) {
          event.stopPropagation();
          event.preventDefault();
        }
      }}
      onClick={() => requestClose()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="lightbox-close"
        onClick={(event) => {
          event.stopPropagation();
          requestClose();
        }}
        aria-label={tr("Close", "关闭")}
      >
        <X size={20} aria-hidden="true" />
      </button>
      {items.length > 1 ? (
        <>
          <button
            type="button"
            className="lightbox-nav prev"
            aria-label={tr("Previous image", "上一张")}
            onClick={(event) => {
              event.stopPropagation();
              page(-1);
            }}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="lightbox-nav next"
            aria-label={tr("Next image", "下一张")}
            onClick={(event) => {
              event.stopPropagation();
              page(1);
            }}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
        </>
      ) : null}
      {/* Keyed like the current image was, so the outgoing <img> is the same
          element, still painted, rather than a fresh one loading again. */}
      {outgoing ? (
        <img
          key={outgoing.key}
          className={`lightbox-image is-leaving${settled ? ` out-${outgoing.dir}` : ""}`}
          src={outgoing.src}
          style={outgoing.dx ? ({ "--lb-leave-dx": `${outgoing.dx}px` } as CSSProperties) : undefined}
          alt=""
          aria-hidden="true"
          referrerPolicy={outgoing.external ? "no-referrer" : undefined}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setLeaving(null);
          }}
        />
      ) : null}
      {source.src ? (
        <img
          key={imageKey}
          ref={imageRef}
          className={`lightbox-image${status === "ready" ? "" : " is-pending"}${view.dir ? ` dir-${view.dir}` : morphIn ? " is-morphed" : ""}`}
          src={source.src}
          alt={tr(`Image ${current + 1} of ${items.length}`, `第 ${current + 1} 张图片，共 ${items.length} 张`)}
          referrerPolicy={item.external ? "no-referrer" : undefined}
          aria-busy={status === "loading" || undefined}
          onLoad={() => {
            markLoaded(key);
            setFailed((value) => {
              if (!value.has(key)) return value;
              const next = new Set(value);
              next.delete(key);
              return next;
            });
          }}
          onError={() => {
            source.onDecodeError();
            setFailed((value) => (value.has(key) ? value : new Set(value).add(key)));
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {/* The spinner is for a picture with nothing to show yet; a cached copy
          of a stored one is only waiting to decode. */}
      {status === "loading" && !(item.imageId && source.src) ? (
        <span className="lightbox-status is-loading" aria-hidden="true">
          <Loader2 size={26} className="spin" />
        </span>
      ) : null}
      {status === "failed" ? (
        <div className="lightbox-status is-failed">
          <p role="alert">
            <ImageOff size={20} aria-hidden="true" />
            {tr("Couldn't load this image", "这张图片加载失败")}
          </p>
          <button
            type="button"
            className="lightbox-retry"
            onClick={(event) => {
              event.stopPropagation();
              retry();
            }}
          >
            <RotateCw size={14} aria-hidden="true" />
            {tr("Retry", "重试")}
          </button>
        </div>
      ) : null}
      {item.external ? (
        <a
          className="lightbox-source"
          href={item.src}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLink size={13} aria-hidden="true" />
          {tr("Open original", "打开原图")}
        </a>
      ) : null}
      {items.length > 1 ? (
        <div className="lightbox-count" role="status" aria-live="polite" aria-atomic="true">
          {current + 1} / {items.length}
        </div>
      ) : null}
    </div>
  );
}
