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

/**
 * Load a stored attachment through the in-memory / sealed cache. The first
 * render already shows a cached copy (MemoStage's ghost layers depend on
 * that); in "lazy" mode any request waits until the tile nears the viewport.
 */
export function useStoredImage(image: MemoImage, sizing: ImageSizing, ref: RefObject<HTMLElement | null>, mode: LoadMode = "lazy") {
  const { id } = image;
  const [state, setState] = useState<{ src: string | null; status: Status }>(() => {
    const cached = cachedVariant(id, sizing);
    if (cached) return { src: cached.url, status: "ready" };
    return { src: null, status: mode === "ghost" && imageFailed(id) ? "error" : "idle" };
  });
  const [attempt, setAttempt] = useState(0);
  const heldRef = useRef<Held | null>(null);

  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    const live = mode !== "ghost";
    const hold = (next: Held) => {
      const previous = heldRef.current;
      heldRef.current = next;
      if (previous) releaseImage(id, previous.variant, previous.url);
      if (live) noteImageFailed(id, false);
      setState({ src: next.url, status: "ready" });
    };
    const fail = () => {
      // A preview already on screen stays there when its original fails.
      if (cancelled || heldRef.current) return;
      if (live) noteImageFailed(id, true);
      setState({ src: null, status: "error" });
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
      if (!heldRef.current) setState((current) => (current.status === "loading" ? current : { src: null, status: "loading" }));
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
      setState({ src: null, status: "error" });
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
    setState({ src: null, status: "error" });
  }, [id, mode]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { src: state.src, status: state.status, retry, onDecodeError };
}

function FailedLabel() {
  const { tr } = useI18n();
  return (
    <span className="memo-image-failed" aria-hidden="true">
      <RotateCw size={16} />
      <span>{tr("Couldn’t load image", "图片加载失败")}</span>
    </span>
  );
}

function tileClass(status: Status): string {
  return `memo-image${status === "ready" ? "" : " is-loading"}${status === "error" ? " is-failed" : ""}`;
}

interface StoredImageButtonProps {
  image: MemoImage;
  sizing: ImageSizing;
  label: string;
  tabIndex?: number;
  onOpen: () => void;
}

/** A feed tile: opens the lightbox, or retries in place after a failed load. */
export function StoredImageButton({ image, sizing, label, tabIndex, onOpen }: StoredImageButtonProps) {
  const { tr } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const { src, status, retry, onDecodeError } = useStoredImage(image, sizing, ref);
  const failed = status === "error";
  return (
    <button
      ref={ref}
      type="button"
      className={tileClass(status)}
      tabIndex={tabIndex}
      onClick={failed ? retry : onOpen}
      aria-label={failed ? tr("Couldn’t load image. Retry", "图片加载失败，点按重试") : label}
      aria-busy={status === "loading" || undefined}
    >
      {src ? (
        <img src={src} alt="" decoding="async" width={image.width || undefined} height={image.height || undefined} onError={onDecodeError} />
      ) : null}
      {failed ? <FailedLabel /> : null}
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
