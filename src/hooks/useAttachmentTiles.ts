import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { ImageSlotLedger } from "../lib/imageSlots";
import { compressImage } from "../lib/images";
import { useI18n } from "../lib/i18n";
import { announce } from "../lib/liveAnnouncer";
import { EASE_OUT, EXIT_MS, T_BASE, T_SLOW } from "../lib/motion";
import type { MemoImage, NewImagePayload } from "../lib/types";

export const MAX_IMAGES = 9;
/** Removed attachments held for their toast's Undo — as many as the toast
 * stack shows at once (TOAST_LIMIT in App); an older one's Undo is gone. */
const UNDO_HOLD = 3;
/** A tile that could not be made stays this long, marked, before it fades. */
const FAILED_TILE_MS = 2_000;
/** A finger lifts a tile to reorder after holding still this long (a mouse
 * lifts it as soon as it moves), so a swipe across the row still scrolls. */
const TOUCH_LIFT_MS = 300;
/** The other tiles' glide into place once a reordered one is let go. */
const REORDER_MS = T_SLOW;

/** One attachment tile: an image on the memo, one ready to upload, or one
 * still being compressed (shown from the original file meanwhile). */
export type AttachmentTile =
  | { kind: "stored"; key: string; image: MemoImage }
  | { kind: "pending"; key: string; image: NewImagePayload }
  | ({ kind: "preparing" } & PreparingImage);

/** An image being compressed: its tile's key and a preview of the original.
 * One that failed keeps its tile a moment, marked, then fades (`leaving`). */
export interface PreparingImage {
  key: string;
  url: string | null;
  failed?: boolean;
  leaving?: boolean;
}

/** A pending tile being dragged to a new place in the row. */
interface TileDrag {
  id: string;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  lifted: boolean;
  holdTimer: number;
  tile: HTMLElement;
  handle: HTMLElement;
  /** The movable tiles' boxes when it lifted, relative to the row. */
  slots: Array<{ id: string; left: number; top: number; right: number; bottom: number }>;
  /** Where letting go would put it: before this image, at the end (null),
   * or nowhere new (undefined). */
  before: string | null | undefined;
  /** Stops listening for a release the tile itself never hears. */
  unlisten: () => void;
}

export type NoteCause = "link" | "limit" | "other";

/** The editor's note line, as the tiles speak through it. */
export interface AttachmentNotes {
  /** Show (and speak) a complaint; `cause` lets it leave with what raised it. */
  fail: (text: string, cause?: NoteCause) => void;
  /** Put away a complaint raised by `cause`, if one is showing. */
  clear: (cause: NoteCause) => void;
  /** Put away whatever complaint is showing: a new batch is on its way. */
  reset: () => void;
}

export interface AttachmentTilesOptions {
  /** Edit mode: attachments already on the memo. */
  existingImages: MemoImage[];
  /** A reopened draft's attachments (pending ones and the memo's removed ones). */
  initialDraft: { newImages: NewImagePayload[]; removedIds: string[] } | null;
  /** Whether the attachments are held right now (read live inside event handlers). */
  isLocked: () => boolean;
  notes: AttachmentNotes;
  /** The editor's root, field and Add image button: where focus goes from a removed tile. */
  rootRef: RefObject<HTMLElement>;
  areaRef: RefObject<HTMLTextAreaElement>;
  addImageRef: RefObject<HTMLButtonElement>;
  mountedRef: { readonly current: boolean };
  /** Raises the "Removed the image" toast with its Undo (see EditorProps.onNotice). */
  onNotice?: (text: string, action?: { label: string; run: () => void }) => void;
  /** Files are on their way in (the composer's ⌘Z-for-a-send window closes). */
  onAdd?: () => void;
  /** An image could not be added: a send held for it must not go without it. */
  onImageRejected?: () => void;
}

/** A preview URL for a file still compressing (null where none can be made). */
function previewOf(file: File): string | null {
  try {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

/** A light knock as a held tile lifts under a finger (same 8ms pulse as a landing send). */
function buzzLift() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // Not every engine lets a page buzz.
  }
}

/**
 * The editor's attachment tiles: the memo's own images, the ones added to
 * the draft, and the ones still compressing — adding them (compressed
 * client-side, a slot reserved per image), removing them with an exit and
 * an Undo, and reordering the draft's own by drag or Alt+←/→. The editor
 * keeps the text and the send; this keeps the pictures and their preview
 * URLs, which leak unless revoked.
 */
export function useAttachmentTiles({
  existingImages,
  initialDraft,
  isLocked,
  notes,
  rootRef,
  areaRef,
  addImageRef,
  mountedRef,
  onNotice,
  onAdd,
  onImageRejected
}: AttachmentTilesOptions) {
  const { errorMessage, tr } = useI18n();
  const [newImages, setNewImages] = useState<NewImagePayload[]>(() => initialDraft?.newImages ?? []);
  const [removedIds, setRemovedIds] = useState<string[]>(() => initialDraft?.removedIds ?? []);
  // Images still compressing, in the order they were added. Each already
  // has the tile it keeps once it lands (tileKeysRef carries the key over).
  const [preparing, setPreparing] = useState<PreparingImage[]>([]);
  const compressing = preparing.filter((item) => !item.failed).length;
  const tileKeysRef = useRef(new Map<string, string>());
  const preparingUrlsRef = useRef(new Set<string>());
  // Tiles the editor opened with (the memo's images, a reopened draft's):
  // they are already on screen in the card, so they do not pop in again.
  const [settledTiles] = useState(
    () => new Set([...existingImages.map((image) => image.id), ...(initialDraft?.newImages ?? []).map((image) => image.id)])
  );
  // Attachments play their exit animation before the state actually drops
  // them — keyed by image id, stored or pending.
  const [removingKeys, setRemovingKeys] = useState<ReadonlySet<string>>(new Set());
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  // Pending images removed with an Undo on offer: their previews stay alive
  // until the Undo is spent or out of reach (UNDO_HOLD), the draft is sent,
  // or the editor closes. A send bumps the epoch, so an Undo raised before
  // it cannot put an image into the next memo.
  const heldRemovalsRef = useRef<NewImagePayload[]>([]);
  const undoEpochRef = useRef(0);
  // A pending tile pressed on touch (waiting for the long-press lift), and
  // one lifted to reorder plus the insertion bar's spot in the row.
  const [pressingId, setPressingId] = useState<string | null>(null);
  const [reorder, setReorder] = useState<{ id: string; bar: { left: number; top: number; height: number } | null } | null>(null);
  const tileDragRef = useRef<TileDrag | null>(null);
  // The click that trails a drag's release is not a tap to open the tile.
  const tileClickFloorRef = useRef(0);
  // Tile centres taken just before the order changes; the layout effect
  // after it glides each tile from there (FLIP). `flips` asks for that pass.
  const flipFromRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const refocusTileRef = useRef<string | null>(null);
  const [flips, setFlips] = useState(0);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  const [imageSlots] = useState(() => new ImageSlotLedger(MAX_IMAGES, existingImages.length));

  const keptExisting = useMemo(() => existingImages.filter((image) => !removedIds.includes(image.id)), [existingImages, removedIds]);
  const totalImages = keptExisting.length + newImages.length;
  // Attachments mid-exit-animation count as removed already.
  const keptNewImages = newImages.filter((image) => !removingKeys.has(image.id));
  const removedImageIds = [...removedIds, ...existingImages.filter((image) => removingKeys.has(image.id)).map((image) => image.id)];

  // What the latest render holds, for calls that outlive their render (a
  // send's landing clears the composer from inside the owner's update).
  const latestRef = useRef({ newImages, removingKeys });
  latestRef.current = { newImages, removingKeys };

  /**
   * Start an attachment's exit. Focus on its × would fall to <body> once the
   * tile unmounts, so it moves on first: to the next tile's ×, else the one
   * before, else Add image (or, for a keyboard reader, the field).
   */
  function beginRemove(id: string, button: HTMLButtonElement) {
    if (isLocked()) return;
    if (document.activeElement === button) {
      const others = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>(".attachment:not(.is-removing) .attachment-remove") ?? [])];
      const at = others.indexOf(button);
      let keyboard = false;
      try {
        keyboard = button.matches(":focus-visible");
      } catch {
        keyboard = false;
      }
      const add = addImageRef.current;
      const target = others[at + 1] ?? others[at - 1] ?? (add && !add.disabled ? add : keyboard ? areaRef.current : null);
      target?.focus({ preventScroll: true });
    }
    // A tile coming back through Undo pops in like any new one.
    settledTiles.delete(id);
    setRemovingKeys((value) => new Set(value).add(id));
  }
  function settleRemove(key: string, drop: () => void) {
    setRemovingKeys((value) => {
      if (!value.has(key)) return value;
      const next = new Set(value);
      next.delete(key);
      return next;
    });
    drop();
    notes.clear("limit");
  }
  /** Raise the "Removed the image" toast; its Undo runs `restore` if it still can. */
  function offerUndo(restore: () => void) {
    const notice = onNoticeRef.current;
    if (!notice) return;
    const epoch = undoEpochRef.current;
    notice(tr("Removed the image", "已移除图片"), {
      label: tr("Undo", "撤销"),
      run: () => {
        if (!mountedRef.current || epoch !== undoEpochRef.current || isLocked()) return;
        restore();
      }
    });
  }
  /** Claim a slot for an image coming back; false (and says so) when full. */
  function reclaimSlot(): boolean {
    if (imageSlots.reserve(1) < 1) {
      notes.fail(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`), "limit");
      return false;
    }
    imageSlots.settle(true);
    return true;
  }
  /** Hold a removed pending image for its Undo; the oldest beyond UNDO_HOLD is released. */
  function holdRemoval(image: NewImagePayload) {
    const held = [...heldRemovalsRef.current, image];
    for (const stale of held.splice(0, Math.max(0, held.length - UNDO_HOLD))) URL.revokeObjectURL(stale.previewUrl);
    heldRemovalsRef.current = held;
  }
  function releaseHeldRemovals() {
    for (const image of heldRemovalsRef.current) URL.revokeObjectURL(image.previewUrl);
    heldRemovalsRef.current = [];
  }

  /** A tile's exit (or its reduced-motion dissolve) has played: drop it, with an Undo. */
  function settleTile(tile: Exclude<AttachmentTile, { kind: "preparing" }>) {
    if (tile.kind === "stored") {
      const image = tile.image;
      settleRemove(image.id, () => {
        imageSlots.releaseCommitted();
        setRemovedIds((value) => [...value, image.id]);
        offerUndo(() => {
          if (reclaimSlot()) setRemovedIds((value) => value.filter((id) => id !== image.id));
        });
      });
      return;
    }
    // Undo puts a pending image back in the slot it left.
    const pending = tile.image;
    const slot = newImages.findIndex((item) => item.id === pending.id);
    settleRemove(pending.id, () => {
      imageSlots.releaseCommitted();
      setNewImages((value) => value.filter((item) => item.id !== pending.id));
      if (!onNoticeRef.current) {
        URL.revokeObjectURL(pending.previewUrl);
        return;
      }
      holdRemoval(pending);
      offerUndo(() => {
        if (!heldRemovalsRef.current.includes(pending) || !reclaimSlot()) return;
        heldRemovalsRef.current = heldRemovalsRef.current.filter((item) => item !== pending);
        setNewImages((value) => (value.some((item) => item.id === pending.id) ? value : [...value.slice(0, slot), pending, ...value.slice(slot)]));
      });
    });
  }

  useLayoutEffect(() => {
    imageSlots.syncCommitted(totalImages);
  }, [imageSlots, totalImages]);

  // A reorder just landed: each tile glides from where it was to its new
  // place (under reduced motion a tile that moved fades in there instead),
  // and a tile moved from the keyboard keeps focus through its DOM move.
  useLayoutEffect(() => {
    const from = flipFromRef.current;
    flipFromRef.current = null;
    if (from) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      const to = tileCentres();
      for (const tile of attachmentsRef.current?.querySelectorAll<HTMLElement>(".attachment[data-image-id]") ?? []) {
        const was = from.get(tile.dataset.imageId ?? "");
        const now = to.get(tile.dataset.imageId ?? "");
        if (!was || !now || typeof tile.animate !== "function") continue;
        const dx = was.x - now.x;
        const dy = was.y - now.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        tile.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: reduced ? T_BASE : REORDER_MS,
          easing: EASE_OUT
        });
      }
    }
    const refocus = refocusTileRef.current;
    refocusTileRef.current = null;
    if (refocus) {
      const row = [...(attachmentsRef.current?.querySelectorAll<HTMLElement>(".attachment[data-image-id]") ?? [])];
      row.find((tile) => tile.dataset.imageId === refocus)?.querySelector<HTMLElement>(".attachment-open")?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flips]);

  // A finger that lifted a tile drags it, not the page. Registered up front
  // (and not passive): a browser decides whether a touch may scroll as it
  // starts, so a listener added mid-drag would come too late.
  const hasTiles = keptExisting.length + newImages.length + preparing.length > 0;
  useEffect(() => {
    const row = attachmentsRef.current;
    if (!row) return;
    const hold = (event: TouchEvent) => {
      if (tileDragRef.current?.lifted) event.preventDefault();
    };
    row.addEventListener("touchmove", hold, { passive: false });
    return () => row.removeEventListener("touchmove", hold);
  }, [hasTiles]);

  // If an update committed but its response was lost, the conflict payload
  // will contain our stable image ids. Retire the matching local payloads so
  // accepting the new base does not try to insert the same attachments again.
  useEffect(() => {
    if (newImages.length === 0 || existingImages.length === 0) return;
    const storedIds = new Set(existingImages.map((image) => image.id));
    const committed = newImages.filter((image) => storedIds.has(image.id));
    if (committed.length === 0) return;
    for (const image of committed) URL.revokeObjectURL(image.previewUrl);
    setNewImages((current) => current.filter((image) => !storedIds.has(image.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingImages]);

  // Object URLs for pending attachments leak unless revoked; only revoke on
  // unmount (successful submit unmounts or clears the list). Previews of
  // images still compressing and of removals held for Undo go too.
  const previewUrls = useRef<string[]>([]);
  useEffect(() => {
    previewUrls.current = newImages.map((image) => image.previewUrl);
  }, [newImages]);
  useEffect(() => {
    const preparingUrls = preparingUrlsRef.current;
    return () => {
      const drag = tileDragRef.current;
      if (drag) {
        window.clearTimeout(drag.holdTimer);
        drag.unlisten();
        tileDragRef.current = null;
      }
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      for (const url of preparingUrls) URL.revokeObjectURL(url);
      releaseHeldRemovals();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Reorder ---- */

  /** Each tile's centre on screen, by image id. */
  function tileCentres(): Map<string, { x: number; y: number }> {
    const centres = new Map<string, { x: number; y: number }>();
    for (const tile of attachmentsRef.current?.querySelectorAll<HTMLElement>(".attachment[data-image-id]") ?? []) {
      const box = tile.getBoundingClientRect();
      centres.set(tile.dataset.imageId ?? "", { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    }
    return centres;
  }

  /** Change the tile order with every tile gliding on from where it is now. */
  function glideTiles(change: () => void) {
    flipFromRef.current = tileCentres();
    change();
    setFlips((value) => value + 1);
  }

  /** Put a pending image before `before` (null: at the end). The order is the one sent. */
  function moveImage(id: string, before: string | null) {
    setNewImages((value) => {
      const moving = value.find((image) => image.id === id);
      if (!moving) return value;
      const rest = value.filter((image) => image !== moving);
      const at = before === null ? rest.length : rest.findIndex((image) => image.id === before);
      return at < 0 ? value : [...rest.slice(0, at), moving, ...rest.slice(at)];
    });
  }

  /** The pending images in the row's order, those leaving left out. */
  function movableIds(): string[] {
    return newImages.filter((image) => !removingKeys.has(image.id)).map((image) => image.id);
  }

  /** Alt+←/→ moves the focused tile one place and says where it now is. */
  function onTileKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Alt+← is Back in some browsers: never leave the page from here.
    event.preventDefault();
    if (isLocked()) return;
    const order = movableIds();
    const at = order.indexOf(id);
    if (at < 0) return;
    const to = Math.min(order.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1)));
    if (to !== at) {
      refocusTileRef.current = id;
      glideTiles(() => moveImage(id, event.key === "ArrowRight" ? (order[to + 1] ?? null) : order[to]));
    }
    // The memo's own images stay first; the moved one is counted after them.
    const position = removable.length - order.length + to + 1;
    announce(tr(`Image ${position} of ${removable.length}`, `第 ${position} 张，共 ${removable.length} 张`));
  }

  function attachRelease(drag: TileDrag) {
    drag.unlisten();
    // Without capture a release off the tile goes elsewhere: the window
    // still hears it (after the tile's own handlers, which end it first).
    const release = (event: PointerEvent) => {
      if (event.pointerId === drag.pointerId) endTileDrag(drag, event.type === "pointerup", event.timeStamp);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    drag.unlisten = () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }

  function onTilePointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    // A fresh press is a new gesture: only the click trailing a drag is held back.
    tileClickFloorRef.current = 0;
    if (!event.isPrimary || event.button !== 0 || isLocked() || tileDragRef.current) return;
    const tile = event.currentTarget.closest<HTMLElement>(".attachment");
    if (!tile) return;
    const drag: TileDrag = {
      id,
      pointerId: event.pointerId,
      touch: event.pointerType !== "mouse",
      x0: event.clientX,
      y0: event.clientY,
      lifted: false,
      holdTimer: 0,
      tile,
      handle: event.currentTarget,
      slots: [],
      before: undefined,
      unlisten: () => undefined
    };
    tileDragRef.current = drag;
    if (drag.touch) {
      // Visual press feedback while the hold builds toward the lift; window
      // listeners clear it even if the finger leaves the tile before lifting.
      setPressingId(id);
      attachRelease(drag);
      drag.holdTimer = window.setTimeout(() => liftTile(drag), TOUCH_LIFT_MS);
    }
  }

  /** Lift the pressed tile: it follows the pointer from here, and the row's
   * movable tiles are measured once as the slots it can land between. */
  function liftTile(drag: TileDrag) {
    const row = attachmentsRef.current;
    if (tileDragRef.current !== drag || drag.lifted || !row) return;
    drag.lifted = true;
    setPressingId((current) => (current === drag.id ? null : current));
    if (drag.touch) buzzLift();
    try {
      drag.handle.setPointerCapture?.(drag.pointerId);
    } catch {
      // Capture is a nicety; the drag still tracks without it.
    }
    attachRelease(drag);
    const origin = row.getBoundingClientRect();
    drag.slots = [...row.querySelectorAll<HTMLElement>(".attachment[data-movable]")].map((tile) => {
      const box = tile.getBoundingClientRect();
      return { id: tile.dataset.imageId ?? "", left: box.left - origin.left, top: box.top - origin.top, right: box.right - origin.left, bottom: box.bottom - origin.top };
    });
    setReorder({ id: drag.id, bar: null });
  }

  function onTilePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = tileDragRef.current;
    const row = attachmentsRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !row) return;
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;
    if (!drag.lifted) {
      // A finger that moves before its hold is up is scrolling the page.
      if (drag.touch) {
        if (Math.hypot(dx, dy) > 8) endTileDrag(drag, false);
        return;
      }
      if (Math.hypot(dx, dy) < 4) return;
      liftTile(drag);
      if (!drag.lifted) return;
    }
    // Written straight to the tile: a render per pointer move would be waste.
    drag.tile.style.translate = `${dx}px ${dy}px`;
    const origin = row.getBoundingClientRect();
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    let nearest = -1;
    let distance = Infinity;
    drag.slots.forEach((slot, index) => {
      const away = Math.hypot(x - (slot.left + slot.right) / 2, y - (slot.top + slot.bottom) / 2);
      if (away < distance) {
        distance = away;
        nearest = index;
      }
    });
    if (nearest < 0) return;
    const target = drag.slots[nearest];
    const index = nearest + (x > (target.left + target.right) / 2 ? 1 : 0);
    const from = drag.slots.findIndex((slot) => slot.id === drag.id);
    // Either side of the tile's own place is where it already is.
    const before = index === from || index === from + 1 ? undefined : index < drag.slots.length ? drag.slots[index].id : null;
    if (before === drag.before) return;
    drag.before = before;
    const anchor = before === undefined ? null : before === null ? drag.slots[drag.slots.length - 1] : drag.slots[index];
    // The bar stands in the 8px gap: before its tile, or after the last.
    const bar = anchor ? { left: before === null ? anchor.right + 3 : anchor.left - 5, top: anchor.top, height: anchor.bottom - anchor.top } : null;
    setReorder({ id: drag.id, bar });
  }

  /** Let the tile go — into its new place when `drop` (and one was found), else home. */
  function endTileDrag(drag: TileDrag, drop: boolean, timeStamp = 0) {
    window.clearTimeout(drag.holdTimer);
    drag.unlisten();
    if (tileDragRef.current !== drag) return;
    tileDragRef.current = null;
    setPressingId((current) => (current === drag.id ? null : current));
    if (!drag.lifted) return;
    tileClickFloorRef.current = timeStamp + 400;
    glideTiles(() => {
      drag.tile.style.translate = "";
      setReorder(null);
      if (drop && drag.before !== undefined && !isLocked()) moveImage(drag.id, drag.before);
    });
  }

  /** The pointer on a tile's picture let go (`drop`) or was taken away. */
  function onTilePointerEnd(event: ReactPointerEvent<HTMLButtonElement>, drop: boolean) {
    const drag = tileDragRef.current;
    if (drag && drag.pointerId === event.pointerId) endTileDrag(drag, drop, event.timeStamp);
  }

  /* ---- Adding ---- */

  /** What a file that could not be added says, by name. */
  function failureText(file: File, cause: unknown): string {
    const name = file.name;
    if (/^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(name)) {
      return tr(`${name}: this browser can’t read HEIC — export it as JPG first`, `${name}：这个浏览器读不出 HEIC，可以先导出成 JPG 再拖进来`);
    }
    const reason = errorMessage(cause, "Couldn’t process the image", "图片处理失败");
    return name ? tr(`${name}: ${reason}`, `${name}：${reason}`) : reason;
  }

  async function addFiles(files: File[]) {
    if (isLocked()) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    const nonImageCount = files.length - images.length;
    if (images.length === 0) {
      if (files.length > 0) notes.fail(tr("Only images can be added", "只能添加图片"));
      return;
    }
    onAdd?.();
    const acceptedCount = imageSlots.reserve(images.length);
    if (acceptedCount <= 0) {
      if (nonImageCount > 0) {
        notes.fail(
          tr(
            `You can add up to ${MAX_IMAGES} images — ${nonImageCount} non-image ${nonImageCount === 1 ? "file was" : "files were"} also skipped`,
            `最多 ${MAX_IMAGES} 张图片，另有 ${nonImageCount} 个非图片文件已跳过`
          ),
          "limit"
        );
      } else {
        notes.fail(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`), "limit");
      }
      return;
    }
    const overflowCount = images.length - acceptedCount;
    if (overflowCount > 0 && nonImageCount > 0) {
      notes.fail(
        tr(
          `Up to ${MAX_IMAGES} images only — skipped ${overflowCount} extra ${overflowCount === 1 ? "image" : "images"} and ${nonImageCount} non-image ${
            nonImageCount === 1 ? "file" : "files"
          }`,
          `最多 ${MAX_IMAGES} 张图片且仅支持图片，已跳过 ${overflowCount} 张多余图片和 ${nonImageCount} 个非图片文件`
        ),
        "other"
      );
    } else if (overflowCount > 0) {
      notes.fail(
        tr(
          overflowCount === 1
            ? `You can add up to ${MAX_IMAGES} images — 1 extra image was skipped`
            : `You can add up to ${MAX_IMAGES} images — ${overflowCount} extra images were skipped`,
          `最多 ${MAX_IMAGES} 张图片，已跳过多余的 ${overflowCount} 张`
        ),
        "limit"
      );
    } else if (nonImageCount > 0) {
      notes.fail(
        tr(
          nonImageCount === 1 ? "Only images can be added — 1 non-image file was skipped" : `Only images can be added — ${nonImageCount} non-image files were skipped`,
          `只能添加图片，已跳过 ${nonImageCount} 个非图片文件`
        ),
        "other"
      );
    } else {
      notes.reset();
    }
    // Each image gets its tile at once, showing the file itself while it
    // compresses; the compressed image then takes over that same tile
    // (tileKeysRef), so it pops in once and never trades places with a
    // spinner.
    const batch = images.slice(0, acceptedCount).map((file) => ({ file, key: crypto.randomUUID(), url: previewOf(file) }));
    for (const { url } of batch) if (url) preparingUrlsRef.current.add(url);
    setPreparing((value) => [...value, ...batch.map(({ key, url }) => ({ key, url }))]);
    let added = 0;
    for (const { file, key, url } of batch) {
      let reservationOpen = true;
      let failed = false;
      try {
        if (!mountedRef.current) continue;
        const payload = await compressImage(file);
        if (!mountedRef.current) {
          URL.revokeObjectURL(payload.previewUrl);
          continue;
        }
        const accepted = imageSlots.settle(true);
        reservationOpen = false;
        if (!accepted) {
          URL.revokeObjectURL(payload.previewUrl);
          notes.fail(tr(`You can add up to ${MAX_IMAGES} images`, `最多 ${MAX_IMAGES} 张图片`), "limit");
          // The draft is not what Send was pressed on any more: hold it back.
          onImageRejected?.();
          continue;
        }
        tileKeysRef.current.set(payload.id, key);
        setNewImages((value) => [...value, payload]);
        added += 1;
      } catch (cause) {
        if (mountedRef.current) {
          failed = true;
          notes.fail(failureText(file, cause));
          // A queued send would go out without the image it was waiting for.
          onImageRejected?.();
        }
      } finally {
        if (reservationOpen) imageSlots.settle(false);
        if (url) {
          URL.revokeObjectURL(url);
          preparingUrlsRef.current.delete(url);
        }
        if (mountedRef.current && failed) {
          // The tile it would have been stays a moment, marked, so the
          // reader sees which one it was; then it fades out. Timers, not
          // animationend: an edit scrolled off screen runs no animations.
          setPreparing((value) => value.map((item) => (item.key === key ? { ...item, url: null, failed: true } : item)));
          window.setTimeout(() => {
            if (!mountedRef.current) return;
            setPreparing((value) => value.map((item) => (item.key === key ? { ...item, leaving: true } : item)));
            window.setTimeout(() => {
              if (mountedRef.current) setPreparing((value) => value.filter((item) => item.key !== key));
            }, EXIT_MS);
          }, FAILED_TILE_MS);
        } else if (mountedRef.current) setPreparing((value) => value.filter((item) => item.key !== key));
      }
    }
    // The tiles are silent to a screen reader until they land: say so then,
    // naming anything skipped so the announcement never misleads.
    if (added > 0 && mountedRef.current) {
      if (overflowCount > 0 && nonImageCount > 0) {
        announce(
          tr(
            `Added ${added} ${added === 1 ? "image" : "images"}; skipped ${overflowCount} extra and ${nonImageCount} non-image`,
            `已添加 ${added} 张图片，已跳过 ${overflowCount} 张多余图片和 ${nonImageCount} 个非图片文件`
          )
        );
      } else if (overflowCount > 0) {
        announce(
          tr(
            `Added ${added} ${added === 1 ? "image" : "images"}; ${overflowCount} skipped (limit ${MAX_IMAGES})`,
            `已添加 ${added} 张图片，另有 ${overflowCount} 张因超出上限未添加`
          )
        );
      } else if (nonImageCount > 0) {
        announce(
          tr(
            `Added ${added} ${added === 1 ? "image" : "images"}; ${nonImageCount} non-image ${nonImageCount === 1 ? "file" : "files"} skipped`,
            `已添加 ${added} 张图片，已跳过 ${nonImageCount} 个非图片文件`
          )
        );
      } else {
        announce(added === 1 ? tr("Added the image", "已添加图片") : tr(`Added ${added} images`, `已添加 ${added} 张图片`));
      }
    }
  }

  /* ---- The draft leaving or coming back ---- */

  /**
   * A send has landed and the composer clears: the sent images and their
   * previews went with the memo (the owner releases them, or hands them back
   * if the memo is taken back). Only a tile still playing its exit stays
   * behind, and an Undo still on a toast belongs to the memo just sent.
   */
  function clearSent() {
    const latest = latestRef.current;
    imageSlots.syncCommitted(existingImages.length);
    for (const image of latest.newImages) if (latest.removingKeys.has(image.id)) URL.revokeObjectURL(image.previewUrl);
    undoEpochRef.current += 1;
    releaseHeldRemovals();
    tileKeysRef.current.clear();
    setNewImages([]);
    setRemovingKeys(new Set());
    previewUrls.current = [];
  }

  /** An edit closing as a draft: its pending images go with it, previews alive. */
  function handOff(): { newImages: NewImagePayload[]; removedIds: string[] } {
    const handedOff = new Set(keptNewImages.map((image) => image.previewUrl));
    previewUrls.current = previewUrls.current.filter((url) => !handedOff.has(url));
    return { newImages: keptNewImages, removedIds: removedImageIds };
  }

  // One flat list of tiles, so a compressing image keeps its tile (same
  // key, same element) when its compressed self lands in newImages.
  const tiles: AttachmentTile[] = [
    ...keptExisting.map((image): AttachmentTile => ({ kind: "stored", key: image.id, image })),
    ...newImages.map((image): AttachmentTile => ({ kind: "pending", key: tileKeysRef.current.get(image.id) ?? image.id, image })),
    ...preparing.map((item): AttachmentTile => ({ kind: "preparing", ...item }))
  ];
  // What stays, numbered like the card's own "View image 2 of 3".
  const removable = tiles.flatMap((tile) => (tile.kind !== "preparing" && !removingKeys.has(tile.image.id) ? [tile.image.id] : []));

  return {
    newImages,
    /** Puts a sent memo's images back (the composer taking it back). */
    setNewImages,
    compressing,
    totalImages,
    keptNewImages,
    removedImageIds,
    removingKeys,
    settledTiles,
    tiles,
    removable,
    // The row folds shut while its last tile leaves, and unmounts after.
    open: removable.length > 0 || preparing.length > 0,
    // Only images not yet sent can be reordered: the server keeps a memo's own
    // images in their order, so an edit's new ones line up after them.
    movableCount: newImages.filter((image) => !removingKeys.has(image.id)).length,
    pressingId,
    reorder,
    attachmentsRef,
    tileClickFloorRef,
    tileDragRef,
    addFiles,
    beginRemove,
    settleTile,
    onTileKeyDown,
    onTilePointerDown,
    onTilePointerMove,
    onTilePointerEnd,
    clearSent,
    handOff
  };
}

export type AttachmentTilesApi = ReturnType<typeof useAttachmentTiles>;
