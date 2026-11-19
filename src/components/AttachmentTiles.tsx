import { ImageOff, Loader2, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AttachmentTile, AttachmentTilesApi } from "../hooks/useAttachmentTiles";
import { useI18n } from "../lib/i18n";
import type { LightboxItem } from "../lib/types";
import { openLightboxFrom } from "./Lightbox";
import { StoredImg } from "./StoredImage";

/** Tile buttons never take focus from the field: on iOS a blurred textarea
 * drops the keyboard (see Editor, keepFieldFocus). */
function keepFieldFocus(event: ReactMouseEvent) {
  event.preventDefault();
}

/**
 * The editor's attachment row (useAttachmentTiles holds its state): one
 * tile per image — the memo's own, the draft's, and those still being
 * prepared — folding open and shut under the field.
 */
export function AttachmentTiles({
  tiles: api,
  locked,
  onOpenImage
}: {
  tiles: AttachmentTilesApi;
  locked: boolean;
  onOpenImage?: (items: LightboxItem[], index: number) => void;
}) {
  const { tr } = useI18n();
  const { tiles, removable, removingKeys, settledTiles, reorder, movableCount } = api;

  /** The photo viewer, on the tiles that stay (a preview for an image not yet sent). */
  function openTile(event: ReactMouseEvent<HTMLButtonElement>, id: string) {
    if (!onOpenImage || event.timeStamp < api.tileClickFloorRef.current) return;
    const shown = tiles.filter(
      (tile): tile is Exclude<AttachmentTile, { kind: "preparing" }> => tile.kind !== "preparing" && !removingKeys.has(tile.image.id)
    );
    const items: LightboxItem[] = shown.map((tile) =>
      tile.kind === "stored" ? { src: `/api/images/${tile.image.id}`, imageId: tile.image.id } : { src: tile.image.previewUrl }
    );
    const index = Math.max(0, shown.findIndex((tile) => tile.image.id === id));
    openLightboxFrom(event.currentTarget.closest<HTMLElement>(".attachment"), () => onOpenImage(items, index));
  }

  return (
    <div className={`editor-attach${api.open ? " is-open" : ""}${reorder ? " is-reordering" : ""}`}>
      <div className="editor-attach-clip">
        {tiles.length > 0 ? (
          <div ref={api.attachmentsRef} className="editor-attachments">
            {tiles.map((tile) => {
              if (tile.kind === "preparing" && tile.failed) {
                // A file that could not be made into an image keeps its
                // tile a moment, marked; the error line names it.
                return (
                  <div key={tile.key} className={`attachment is-failed${tile.leaving ? " is-leaving" : ""}`} aria-hidden="true">
                    <ImageOff size={18} aria-hidden="true" />
                  </div>
                );
              }
              if (tile.kind === "preparing") {
                // The file itself stands in while it prepares; the ready image
                // takes over this same tile.
                return (
                  <div key={tile.key} className="attachment is-busy" role="img" aria-label={tr("Preparing image", "正在处理图片")}>
                    {tile.url ? <img src={tile.url} alt="" decoding="async" /> : null}
                    <span className="attachment-spinner">
                      <Loader2 size={16} className="spin" aria-hidden="true" />
                    </span>
                  </div>
                );
              }
              const image = tile.image;
              const removing = removingKeys.has(image.id);
              const position = removable.indexOf(image.id);
              const movable = tile.kind === "pending" && !removing && !locked && movableCount > 1;
              return (
                <div
                  key={tile.key}
                  className={`attachment${removing ? " is-removing" : ""}${settledTiles.has(image.id) ? " is-settled" : ""}${
                    api.pressingId === image.id ? " is-holding" : ""
                  }${reorder?.id === image.id ? " is-lifted" : ""}`}
                  // A send names the tile after this id, so the picture
                  // rides into the new card (App, landCreated).
                  data-image-id={image.id}
                  data-movable={movable ? "" : undefined}
                  aria-hidden={removing || undefined}
                  onAnimationEnd={(event) => {
                    // The exit, or its reduced-motion dissolve (app.css).
                    if (event.animationName !== "attach-out" && event.animationName !== "attach-dissolve") return;
                    api.settleTile(tile);
                  }}
                >
                  {/* The picture is a button: a click (or Enter) opens it in
                      the viewer; a drag — or Alt+←/→ — moves an image not
                      yet sent to another place in the row. */}
                  <button
                    type="button"
                    className="attachment-open"
                    aria-label={
                      removable.length > 1 && position >= 0
                        ? onOpenImage
                          ? tr(`View image ${position + 1} of ${removable.length}`, `查看图片 ${position + 1}/${removable.length}`)
                          : tr(`Image ${position + 1} of ${removable.length}`, `第 ${position + 1} 张，共 ${removable.length} 张`)
                        : onOpenImage
                          ? tr("View image", "查看图片")
                          : tr("Image", "图片")
                    }
                    aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
                    tabIndex={removing ? -1 : undefined}
                    onMouseDown={keepFieldFocus}
                    onClick={(event) => openTile(event, image.id)}
                    onKeyDown={movable ? (event) => api.onTileKeyDown(event, image.id) : undefined}
                    onPointerDown={movable ? (event) => api.onTilePointerDown(event, image.id) : undefined}
                    onPointerMove={api.onTilePointerMove}
                    onPointerUp={(event) => api.onTilePointerEnd(event, true)}
                    onPointerCancel={(event) => api.onTilePointerEnd(event, false)}
                    // A long press lifts the tile; no image menu over it.
                    onContextMenu={(event) => {
                      if (api.tileDragRef.current) event.preventDefault();
                    }}
                  >
                    {tile.kind === "stored" ? (
                      <StoredImg image={tile.image} />
                    ) : (
                      <img src={tile.image.previewUrl} alt="" decoding="async" draggable={false} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="attachment-remove"
                    aria-label={
                      removable.length > 1 && position >= 0
                        ? tr(`Remove image ${position + 1} of ${removable.length}`, `移除图片 ${position + 1}/${removable.length}`)
                        : tr("Remove image", "移除图片")
                    }
                    tabIndex={removing ? -1 : undefined}
                    onMouseDown={keepFieldFocus}
                    onClick={(event) => api.beginRemove(image.id, event.currentTarget)}
                    disabled={locked}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            {reorder?.bar ? (
              <span className="attachment-slot" style={{ left: reorder.bar.left, top: reorder.bar.top, height: reorder.bar.height }} aria-hidden="true" />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
