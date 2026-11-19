import { htmlCarriesText } from "./htmlToMarkdown";

/**
 * What a file drag carries, read from its item types (dragenter cannot read
 * the files themselves). A browser that keeps the types back until the drop
 * counts as images: the veil must never refuse what it cannot see.
 */
export type FileDragKind = "images" | "other";

export function isFileDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

export function fileDragKind(data: DataTransfer | null): FileDragKind {
  const files = [...(data?.items ?? [])].filter((item) => item.kind === "file");
  return files.length > 0 && files.every((item) => item.type && !item.type.startsWith("image/")) ? "other" : "images";
}

/**
 * Whether a paste that carries image files adds them as attachments. Office
 * apps (Excel, PowerPoint, Word) put a rendered picture of the selection
 * beside its HTML and plain text: the words are what was copied, so they
 * win, and the HTML converter turns copied cells into a table. The picture
 * wins when the HTML is only that picture (a browser's "Copy image"), when
 * there is no text at all (a screenshot), or when the only text is the
 * files' own names (a file copied in Finder or Explorer).
 */
export function pasteTakesImages(data: DataTransfer, files: File[]): boolean {
  const html = data.getData("text/html");
  if (html.trim()) return !htmlCarriesText(html);
  const names = new Set(files.map((file) => file.name));
  return data
    .getData("text/plain")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .every((line) => !line || names.has(line.split(/[\\/]/).pop() ?? line));
}

/**
 * Window-level file-drop guard, shared by every mounted editor. A file let
 * go anywhere but on an editor — a few pixels off the composer, over a card
 * or the sidebar — would open in the tab and take the in-memory draft and
 * any open edit with it. So file drags are claimed window-wide and land in
 * the active editor: the open inline edit, else the visible composer, whose
 * veil lights for as long as the drag is over the window.
 */
export interface DropTarget {
  mode: "create" | "edit";
  root: () => HTMLElement | null;
  /** Whether a drop of this kind would add anything (room left, images). */
  accepts: (kind: FileDragKind) => boolean;
  /** Light the veil for a drag elsewhere in the window, or put it out. */
  light: (kind: FileDragKind | null) => void;
  take: (files: File[]) => void;
}

const dropTargets = new Set<DropTarget>();
let releaseDropGuard: (() => void) | null = null;

function activeDropTarget(): DropTarget | null {
  let composer: DropTarget | null = null;
  for (const target of dropTargets) {
    const root = target.root();
    if (!root || root.closest("[hidden]")) continue;
    if (target.mode === "edit") return target;
    composer ??= target;
  }
  return composer;
}

function installDropGuard(): () => void {
  // Counter, not boolean: dragenter/leave fire per element crossed.
  let depth = 0;
  let lit: DropTarget | null = null;
  let idle = 0;
  const reset = () => {
    depth = 0;
    window.clearTimeout(idle);
    lit?.light(null);
    lit = null;
  };
  const onEnter = (event: globalThis.DragEvent) => {
    if (!isFileDrag(event)) return;
    depth += 1;
    if (lit) return;
    lit = activeDropTarget();
    lit?.light(fileDragKind(event.dataTransfer));
  };
  const onLeave = (event: globalThis.DragEvent) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) reset();
  };
  const onOver = (event: globalThis.DragEvent) => {
    if (!isFileDrag(event)) return;
    // Some browsers skip the last dragleave when a drag leaves the window;
    // dragover repeats while it is still here, so its silence puts the
    // veil out.
    window.clearTimeout(idle);
    idle = window.setTimeout(reset, 1000);
    // An editor under the pointer has already answered for itself.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const target = activeDropTarget();
    if (event.dataTransfer) event.dataTransfer.dropEffect = target?.accepts(fileDragKind(event.dataTransfer)) ? "copy" : "none";
  };
  const onDrop = (event: globalThis.DragEvent) => {
    reset();
    if (!isFileDrag(event) || event.defaultPrevented) return;
    event.preventDefault();
    activeDropTarget()?.take([...(event.dataTransfer?.files ?? [])]);
  };
  window.addEventListener("dragenter", onEnter, true);
  window.addEventListener("dragleave", onLeave, true);
  window.addEventListener("dragover", onOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("dragend", reset, true);
  return () => {
    window.removeEventListener("dragenter", onEnter, true);
    window.removeEventListener("dragleave", onLeave, true);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("dragend", reset, true);
    reset();
  };
}

export function registerDropTarget(target: DropTarget): () => void {
  dropTargets.add(target);
  releaseDropGuard ??= installDropGuard();
  return () => {
    dropTargets.delete(target);
    if (dropTargets.size > 0) return;
    releaseDropGuard?.();
    releaseDropGuard = null;
  };
}
