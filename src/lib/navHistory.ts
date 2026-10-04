// Feed lenses in the browser's session history. Every discrete lens change
// (a tag, a day, a facet, Trash, Daily review…) becomes a history entry, so
// Back — the desktop key, a mouse side button, iOS Safari's edge swipe —
// steps to the previous lens instead of leaving the app, and a reload in the
// same tab comes back to the lens it left.
//
// The URL never changes and history.state carries only an opaque entry id.
// Tag paths and search words are memo content: in the address bar or in
// history.state they would outlive a logout in the browser's global history
// and autocomplete. The lens itself (plus the reading place) lives here,
// mirrored to sessionStorage under the memo: prefix, so an ordinary logout's
// clearLocalDeviceData wipes it with the rest of the workspace furniture.

import type { FeedFilters } from "./search";
import { filtersEqual, hasActiveFilters } from "./search";
import type { StatsDrilldown } from "./statsDrilldown";

export type NavView = "memos" | "trash" | "review";

export interface NavLens {
  view: NavView;
  tag: string | null;
  day: string | null;
  drilldown: StatsDrilldown | null;
  filters: FeedFilters;
  query: string;
}

/**
 * Where the reader was in a lens: the card at the top of the viewport and
 * its offset, so a return lands on the same card even after the feed above
 * it changed. scrollY is the fallback when that card is gone; cap is how many
 * rows have to render for the anchor to exist again.
 */
export interface NavPlace {
  anchorId: string | null;
  offset: number;
  scrollY: number;
  cap: number;
}

interface NavEntry {
  lens: NavLens;
  place: NavPlace | null;
}

const STORAGE_KEY = "memo:nav";
/** Older entries fall back to All memos; a session rarely walks back further. */
const MAX_ENTRIES = 60;
const PERSIST_DELAY = 300;
const DAY_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const ROOT_LENS: NavLens = Object.freeze({
  view: "memos",
  tag: null,
  day: null,
  drilldown: null,
  filters: Object.freeze({ noTags: false, hasImage: false, hasLink: false, hasOpenTask: false, dateFrom: null, dateTo: null }),
  query: ""
}) as NavLens;

export function lensesEqual(a: NavLens, b: NavLens): boolean {
  return (
    a.view === b.view &&
    a.tag === b.tag &&
    a.day === b.day &&
    a.query === b.query &&
    filtersEqual(a.filters, b.filters) &&
    JSON.stringify(a.drilldown) === JSON.stringify(b.drilldown)
  );
}

/** All memos, unfiltered — the lens the ⌂ pill returns to. */
export function isRootLens(lens: NavLens): boolean {
  return lens.view === "memos" && !lens.tag && !lens.day && !lens.drilldown && lens.query.trim() === "" && !hasActiveFilters(lens.filters);
}

function dayOrNull(value: unknown): string | null {
  return typeof value === "string" && DAY_KEY_PATTERN.test(value) ? value : null;
}

function int(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parseDrilldown(value: unknown): StatsDrilldown | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case "year":
      return int(raw.year) ? { kind: "year", year: raw.year } : null;
    case "month":
      return int(raw.year) && int(raw.month) ? { kind: "month", year: raw.year, month: raw.month } : null;
    case "day": {
      const day = dayOrNull(raw.day);
      return day ? { kind: "day", day } : null;
    }
    case "weekday":
      return int(raw.year) && int(raw.weekday) ? { kind: "weekday", year: raw.year, weekday: raw.weekday } : null;
    case "hour":
      return int(raw.year) && int(raw.hour) ? { kind: "hour", year: raw.year, hour: raw.hour } : null;
    case "tag":
      return int(raw.year) && typeof raw.tag === "string" && raw.tag ? { kind: "tag", year: raw.year, tag: raw.tag } : null;
    default:
      return null;
  }
}

/** Rebuild a stored lens field by field, dropping anything malformed. */
export function parseNavLens(value: unknown): NavLens | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.view !== "memos" && raw.view !== "trash" && raw.view !== "review") return null;
  const filters = (typeof raw.filters === "object" && raw.filters !== null ? raw.filters : {}) as Record<string, unknown>;
  return {
    view: raw.view,
    tag: typeof raw.tag === "string" && raw.tag ? raw.tag : null,
    day: dayOrNull(raw.day),
    drilldown: parseDrilldown(raw.drilldown),
    filters: {
      noTags: filters.noTags === true,
      hasImage: filters.hasImage === true,
      hasLink: filters.hasLink === true,
      hasOpenTask: filters.hasOpenTask === true,
      dateFrom: dayOrNull(filters.dateFrom),
      dateTo: dayOrNull(filters.dateTo)
    },
    query: typeof raw.query === "string" ? raw.query : ""
  };
}

function parsePlace(value: unknown): NavPlace | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!finite(raw.offset) || !finite(raw.scrollY) || !int(raw.cap)) return null;
  return {
    anchorId: typeof raw.anchorId === "string" && raw.anchorId ? raw.anchorId : null,
    offset: raw.offset as number,
    scrollY: Math.max(0, raw.scrollY as number),
    cap: Math.max(1, raw.cap as number)
  };
}

/** The entry id this app stamped on a history state, if any. */
export function navIdOf(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const id = (state as Record<string, unknown>).memoNav;
  return typeof id === "string" && id ? id : null;
}

/**
 * A layer's entry: pushed over the lens entry while the drawer, Stats or the
 * lightbox is up. It carries the same lens id, so Back closes that layer and
 * lands on the lens it covered instead of changing the feed behind it.
 */
export function isLayerState(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>).memoLayer === true;
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function historyState(id: string): Record<string, unknown> {
  const current = window.history.state;
  const rest: Record<string, unknown> = { ...(typeof current === "object" && current !== null ? current : {}) };
  // A lens taking over a layer's entry (a pick made inside the drawer) makes
  // it an ordinary lens entry again.
  delete rest.memoLayer;
  return { ...rest, memoNav: id };
}

export interface NavStore {
  get(id: string): { lens: NavLens; place: NavPlace | null } | null;
  /** Point the current history entry at `lens` (no new entry). */
  replace(id: string | null, lens: NavLens): string;
  /** Add a history entry for `lens` on top of the current one. */
  push(lens: NavLens): string;
  /** Add a layer's entry over the lens entry `id` (see isLayerState). */
  pushLayer(id: string): void;
  setPlace(id: string, place: NavPlace | null): void;
  /** Write pending changes now (pagehide). */
  flush(): void;
  /** Forget every entry, in memory and in sessionStorage (logout). */
  clear(): void;
}

function readStorage(): Map<string, NavEntry> {
  const entries = new Map<string, NavEntry>();
  let data: unknown;
  try {
    data = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return entries;
  }
  if (!Array.isArray(data)) return entries;
  for (const item of data.slice(-MAX_ENTRIES)) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const raw = item[1] as Record<string, unknown> | null;
    const lens = parseNavLens(raw?.lens);
    if (lens) entries.set(item[0], { lens, place: parsePlace(raw?.place) });
  }
  return entries;
}

export function createNavStore(): NavStore {
  const entries = readStorage();
  let timer = 0;

  function persistNow() {
    window.clearTimeout(timer);
    timer = 0;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...entries]));
    } catch {
      // Best-effort: without storage, Back still works within this page load.
    }
  }

  function schedule() {
    if (!timer) timer = window.setTimeout(persistNow, PERSIST_DELAY);
  }

  function put(id: string, entry: NavEntry) {
    // Re-insert so Map order tracks recency and the trim drops the stalest.
    entries.delete(id);
    entries.set(id, entry);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    schedule();
  }

  return {
    get(id) {
      return entries.get(id) ?? null;
    },
    replace(id, lens) {
      const key = id ?? newId();
      // A lens edited in place (typing a search) is no longer the list the
      // stored place was measured in.
      put(key, { lens, place: null });
      if (navIdOf(window.history.state) !== key) {
        try {
          window.history.replaceState(historyState(key), "");
        } catch {
          // History can throw when rate-limited; the store still holds the lens.
        }
      }
      return key;
    },
    push(lens) {
      const key = newId();
      put(key, { lens, place: null });
      try {
        window.history.pushState({ memoNav: key }, "");
      } catch {
        // Rate-limited: the lens is applied, it just isn't a Back step.
      }
      return key;
    },
    pushLayer(id) {
      try {
        window.history.pushState({ memoNav: id, memoLayer: true }, "");
      } catch {
        // Rate-limited: Back has no layer step to close; it steps the lens.
      }
    },
    setPlace(id, place) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.place = place;
      schedule();
    },
    flush() {
      if (timer) persistNow();
    },
    clear() {
      window.clearTimeout(timer);
      timer = 0;
      entries.clear();
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // Restricted storage: nothing was written either.
      }
    }
  };
}

const FEED_SLOTS = ".memo-feed > .memo-slot";

/** The memo id a feed slot renders (MemoSlot's data-vt is `memo-<id>`). */
function slotMemoId(slot: HTMLElement): string | null {
  const name = slot.dataset.vt;
  return name && name.startsWith("memo-") ? name.slice(5) : null;
}

/**
 * Measure the reading place: the first card whose bottom clears the sticky
 * topbar. Slots are in visual order, so a binary search keeps this cheap on
 * a feed with hundreds of rendered rows.
 */
export function captureFeedPlace(pageSize: number): NavPlace {
  const scrollY = window.scrollY;
  if (scrollY <= 0) return { anchorId: null, offset: 0, scrollY: 0, cap: pageSize };
  const slots = document.querySelectorAll<HTMLElement>(FEED_SLOTS);
  const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
  let lo = 0;
  let hi = slots.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].getBoundingClientRect().bottom > top) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found < 0) return { anchorId: null, offset: 0, scrollY, cap: Math.max(pageSize, slots.length) };
  return {
    anchorId: slotMemoId(slots[found]),
    offset: slots[found].getBoundingClientRect().top,
    scrollY,
    // Render a little past the anchor so the screen under it is filled too.
    cap: Math.max(pageSize, found + Math.ceil(pageSize / 2))
  };
}

function findSlot(anchorId: string): HTMLElement | null {
  for (const slot of document.querySelectorAll<HTMLElement>(FEED_SLOTS)) if (slotMemoId(slot) === anchorId) return slot;
  return null;
}

/** Frames to keep re-aiming while cards near the anchor settle. */
const SETTLE_FRAMES = 6;
const READER_INPUT = ["wheel", "touchstart", "keydown", "mousedown"] as const;

/**
 * Scroll the anchor card back to its offset (or to the raw offset when the
 * card is gone). The cards just above it remount with content-visibility
 * estimates and only take their real height a frame or two later, which
 * pushed the anchor ~24px off (scroll anchoring doesn't run inside the swap),
 * so the next few frames re-aim — until the reader scrolls themselves.
 */
export function restoreFeedPlace(place: NavPlace): void {
  const slot = place.anchorId ? findSlot(place.anchorId) : null;
  if (!slot) {
    window.scrollTo(0, place.scrollY);
    return;
  }
  window.scrollTo(0, window.scrollY + slot.getBoundingClientRect().top - place.offset);
  let frames = 0;
  let readerTookOver = false;
  const stop = () => {
    readerTookOver = true;
  };
  for (const type of READER_INPUT) window.addEventListener(type, stop, { once: true, passive: true });
  const settle = () => {
    if (!readerTookOver && slot.isConnected) {
      const drift = slot.getBoundingClientRect().top - place.offset;
      if (Math.abs(drift) > 1) window.scrollTo(0, window.scrollY + drift);
      if (++frames < SETTLE_FRAMES) {
        window.requestAnimationFrame(settle);
        return;
      }
    }
    for (const type of READER_INPUT) window.removeEventListener(type, stop);
  };
  window.requestAnimationFrame(settle);
}
