import type { FocusEvent, PointerEvent } from "react";
import { useTip, type TipBinding, type TipContent } from "./Tip";

type TipApi = ReturnType<typeof useTip>;

/**
 * The shared tip, or null where none is provided — chrome pieces such as a
 * filter chip or the tag tree also render on their own (tests, a future
 * standalone use), and a missing bubble must not take them down.
 */
export function useOptionalTip(): TipApi | null {
  try {
    return useTip();
  } catch {
    return null;
  }
}

/** True while `element` is cut short by its own overflow (an ellipsis). */
export function isTruncated(element: Element | null | undefined): boolean {
  return element instanceof HTMLElement && element.scrollWidth > element.clientWidth;
}

/**
 * tip.bind whose content can read the anchor it is about to show for —
 * whether a label inside it is ellipsized right now, say. The check runs at
 * show time, so a sidebar resize or a renamed tag is always measured fresh.
 */
export function bindAnchored(tip: TipApi | null, content: (anchor: HTMLElement) => TipContent | null): Partial<TipBinding> {
  if (!tip) return {};
  let anchor: HTMLElement | null = null;
  const binding = tip.bind(() => (anchor ? content(anchor) : null));
  return {
    ...binding,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      anchor = event.currentTarget;
      binding.onPointerEnter(event);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      anchor = event.currentTarget;
      binding.onFocus(event);
    }
  };
}

/**
 * A name that ellipsizes reveals itself in full: the bubble shows `full`
 * only while the name (`selector` inside the anchor, or the anchor itself)
 * is actually cut off — a name that fits says nothing it doesn't already.
 */
export function bindTruncationTip(tip: TipApi | null, full: string, selector?: string): Partial<TipBinding> {
  return bindAnchored(tip, (anchor) => (isTruncated(selector ? anchor.querySelector(selector) : anchor) ? { text: full } : null));
}
