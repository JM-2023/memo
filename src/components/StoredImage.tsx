import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../lib/i18n";
import {
  acquireImage,
  discardImage,
  imageFailed,
  noteImageFailed,
  peekImage,
  releaseImage,
  retainImage,
  type ImageVariant
} from "../lib/imageCache";
import { previewCovers } from "../lib/imageLayout";
import type { MemoImage } from "../lib/types";

/** "auto" picks the preview unless the tile is drawn larger than it covers. */
export type ImageSizing = ImageVariant | "auto";

/**
 * - "lazy": requests wait until the tile nears the viewport.
 * - "eager": requests start at once.
 * - "ghost": MemoStage's inert copies; eager, but an image whose live tile
 *   failed shows the same failed state instead of requesting again.
 */
export type LoadMode = "lazy" | "eager" | "ghost";

type Status = "idle" | "loading" | "ready" | "error";

interface Held {
  variant: ImageVariant;
  url: string;
}

/** Cached variants in the order they serve this sizing: an original serves any size. */
function cacheOrder(sizing: ImageSizing): readonly ImageVariant[] {
  return sizing === "thumb" ? (["thumb", "full"] as const) : (["full", "thumb"] as const);
}

function cachedVariant(id: string, sizing: ImageSizing): Held | null {
  for (const variant of cacheOrder(sizing)) {
    const url = peekImage(id, variant);
    if (url) return { variant, url };
  }
  return null;
}

function wantedVariant(image: MemoImage, sizing: ImageSizing, element: HTMLElement | null): ImageVariant {
  if (sizing !== "auto") return sizing;
  if (!element) return "thumb";
  const rect = element.getBoundingClientRect();
  return previewCovers(image, rect.width, rect.height, window.devicePixelRatio || 1) ? "thumb" : "full";
}

/** A retry shows its "Retrying…" at least this long, so a failure that comes
    straight back still reads as an answer to the tap rather than as nothing. */
const RETRY_HOLD_MS = 400;

interface TileState {
  src: string | null;
  status: Status;
  /** The picture had to be waited for (the tile was blank first), so it
      fades in; one already in memory at mount draws at once. */
  arriving: boolean;
}

/**
 * Load a stored attachment through the in-memory / sealed cache. The first
 * render already shows a cached copy (MemoStage's ghost layers depend on
 * that); in "lazy" mode any request waits until the tile nears the viewport.
 */
export function useStoredImage(image: MemoImage, sizing: ImageSizing, ref: RefObject<HTMLElement | null>, mode: LoadMode = "lazy") {
  const { id } = image;
  const [state, setState] = useState<TileState>(() => {
    const cached = cachedVariant(id, sizing);
    if (cached) return { src: cached.url, status: "ready", arriving: false };
    return { src: null, status: mode === "ghost" && imageFailed(id) ? "error" : "idle", arriving: false };
  });
  const [attempt, setAttempt] = useState(0);
  // While a retry runs the tile keeps its failed chrome and says so.
  const [retrying, setRetrying] = useState(false);
  const retryAtRef = useRef(0);
  const heldRef = useRef<Held | null>(null);

  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let settleTimer = 0;
    const live = mode !== "ghost";
    // An outcome lands at once, unless a retry began less than
    // RETRY_HOLD_MS ago: then it waits out the rest of the hold.
    const settle = (apply: () => void) => {
      const wait = retryAtRef.current ? retryAtRef.current + RETRY_HOLD_MS - performance.now() : 0;
      const run = () => {
        if (cancelled) return;
        retryAtRef.current = 0;
        setRetrying(false);
        apply();
      };
      if (wait > 0) settleTimer = window.setTimeout(run, wait);
      else run();
    };
    const hold = (next: Held) => {
      const previous = heldRef.current;
      heldRef.current = next;
      if (previous) releaseImage(id, previous.variant, previous.url);
      if (live) noteImageFailed(id, false);
      settle(() => setState((current) => ({ src: next.url, status: "ready", arriving: current.arriving || current.src === null })));
    };
    const fail = () => {
      // A preview already on screen stays there when its original fails.
      if (cancelled || heldRef.current) return;
      if (live) noteImageFailed(id, true);
      settle(() => setState({ src: null, status: "error", arriving: false }));
    };
    const covered = (wanted: ImageVariant) => {
      const held = heldRef.current;
      return held !== null && (held.variant === wanted || held.variant === "full");
    };

    // Whatever memory holds paints now; only the network waits for the viewport.
    for (const variant of cacheOrder(sizing)) {
      const url = retainImage(id, variant);
      if (url) {
        hold({ variant, url });
        break;
      }
    }

    const load = () => {
      const wanted = wantedVariant(image, sizing, ref.current);
      if (covered(wanted)) return;
      // (A retry keeps the failed tile up, spinning its icon, instead.)
      if (!heldRef.current && !retryAtRef.current) {
        setState((current) => (current.status === "loading" ? current : { src: null, status: "loading", arriving: current.arriving }));
      }
      const loadWanted = () => {
        if (cancelled) return;
        acquireImage(id, wanted).then((url) => {
          if (cancelled) releaseImage(id, wanted, url);
          else hold({ variant: wanted, url });
        }, fail);
      };
      if (wanted === "full" && !heldRef.current) {
        // The preview (sealed on this device, or a few KB away) paints first,
        // so a lone image is not a blank box while its original downloads.
        acquireImage(id, "thumb")
          .then(
            (url) => {
              if (cancelled || heldRef.current) releaseImage(id, "thumb", url);
              else hold({ variant: "thumb", url });
            },
            () => undefined
          )
          .then(loadWanted);
      } else {
        loadWanted();
      }
    };

    const element = ref.current;
    if (!live && !heldRef.current && imageFailed(id)) {
      setState({ src: null, status: "error", arriving: false });
    } else if (covered(wantedVariant(image, sizing, element))) {
      // Memory already holds what this tile needs.
    } else if (mode === "lazy" && element && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          observer = null;
          load();
        },
        { rootMargin: "600px 0px" }
      );
      observer.observe(element);
    } else {
      load();
    }

    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      observer?.disconnect();
      const held = heldRef.current;
      heldRef.current = null;
      if (held) releaseImage(id, held.variant, held.url);
    };
    // width/height feed the size choice; the object identity does not matter.
  }, [id, image.width, image.height, sizing, mode, attempt]);

  /** The bytes arrived but do not decode: drop them so a retry refetches. */
  const onDecodeError = useCallback(() => {
    const held = heldRef.current;
    heldRef.current = null;
    if (held) {
      releaseImage(id, held.variant, held.url);
      discardImage(id, held.variant);
    }
    if (mode !== "ghost") noteImageFailed(id, true);
    setState({ src: null, status: "error", arriving: false });
  }, [id, mode]);

  const retry = useCallback(() => {
    if (retryAtRef.current) return;
    retryAtRef.current = performance.now();
    setRetrying(true);
    setAttempt((value) => value + 1);
  }, []);

  return { src: state.src, status: state.status, arriving: state.arriving, retrying, retry, onDecodeError };
}

function FailedLabel({ retrying = false }: { retrying?: boolean }) {
  const { tr } = useI18n();
  return (
    <span className="memo-image-failed" aria-hidden="true">
      <RotateCw size={16} className={retrying ? "spin" : undefined} />
      <span>{retrying ? tr("Retrying…", "正在重试…") : tr("Couldn’t load image", "图片加载失败")}</span>
    </span>
  );
}

function tileClass(status: Status, arriving = false): string {
  return `memo-image${status === "ready" ? "" : " is-loading"}${status === "error" ? " is-failed" : ""}${arriving && status === "ready" ? " is-arriving" : ""}`;
}

interface StoredImageButtonProps {
  image: MemoImage;
  sizing: ImageSizing;
  label: string;
  tabIndex?: number;
  /** This tile's place in the lightbox's items, so closing the viewer can
      return focus to the tile of the picture last shown. */
  lightboxIndex?: number;
  onOpen: () => void;
}

/** A feed tile: opens the lightbox, or retries in place after a failed load. */
export function StoredImageButton({ image, sizing, label, tabIndex, lightboxIndex, onOpen }: StoredImageButtonProps) {
  const { tr } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const { src, status, arriving, retrying, retry, onDecodeError } = useStoredImage(image, sizing, ref);
  const failed = status === "error";
  return (
    <button
      ref={ref}
      type="button"
      className={tileClass(status, arriving)}
      tabIndex={tabIndex}
      data-lightbox-index={lightboxIndex}
      onClick={failed ? retry : onOpen}
      aria-label={failed ? (retrying ? tr("Retrying image…", "正在重试加载图片…") : tr("Couldn’t load image. Retry", "图片加载失败，点按重试")) : label}
      aria-busy={status === "loading" || retrying || undefined}
    >
      {src ? (
        <img src={src} alt="" decoding="async" width={image.width || undefined} height={image.height || undefined} onError={onDecodeError} />
      ) : null}
      {failed ? <FailedLabel retrying={retrying} /> : null}
    </button>
  );
}

/** The inert twin of StoredImageButton for MemoStage's ghost layers, failed state included. */
export function StoredImageFrame({ image, sizing }: { image: MemoImage; sizing: ImageSizing }) {
  const ref = useRef<HTMLDivElement>(null);
  const { src, status } = useStoredImage(image, sizing, ref, "ghost");
  return (
    <div ref={ref} className={tileClass(status)} aria-hidden="true">
      {src ? <img src={src} alt="" decoding="async" width={image.width || undefined} height={image.height || undefined} /> : null}
      {status === "error" ? <FailedLabel /> : null}
    </div>
  );
}

/** Just the picture (editor attachment chips): no tile chrome of its own. */
export function StoredImg({ image }: { image: MemoImage }) {
  // Chips are a fixed 64px and load eagerly, so nothing needs measuring.
  const ref = useRef<HTMLElement>(null);
  const { src, onDecodeError } = useStoredImage(image, "thumb", ref, "eager");
  return src ? <img src={src} alt="" decoding="async" onError={onDecodeError} /> : null;
}
