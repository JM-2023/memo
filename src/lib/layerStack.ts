// The one stack of things that are "up" over the page: a menu, the search
// list, the filter panel, the drawer, Statistics, the lightbox, a dialog.
// Each registers while it is open (useLayer) and leaves when it closes, so
// the app has a single answer to "is a layer up, and which is on top":
//
// - Back (App's popstate) closes exactly the topmost layer through its own
//   exit, and keeps the layer's history entry while more stay up;
// - the app's keyboard shortcuts stand down while anything is up;
// - on phones, a bottom-sheet layer tells the toast stack to take the top edge.
//
// The order is the order layers opened in: a menu opened inside a dialog
// sits above it, a dialog opened from a menu takes the menu's place.

export interface LayerOptions {
  /**
   * A layer that may decline Back (a dialog with a draft or with work in
   * flight). Its history entry is kept until it really goes, so a declined
   * Back still has a step to close it with later.
   */
  mayRefuse?: boolean;
  /**
   * Still on screen but already on its way out (the drawer sliding shut).
   * It holds the history entry through its exit, so a layer it hands over
   * to keeps it, but Back and a pick made inside it no longer count it.
   */
  leaving?: boolean;
  /**
   * Rises from the bottom edge on phones (dialogs, Statistics, passcode),
   * so the phone toast stack takes the top edge while it is up.
   */
  coversBottom?: boolean;
}

export interface Layer {
  readonly id: number;
  /** Close the way the layer's own Cancel or Esc would (a busy dialog may decline). */
  close(): void;
  mayRefuse(): boolean;
  leaving(): boolean;
  coversBottom(): boolean;
}

const layers: Layer[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function notify() {
  for (const listener of [...listeners]) listener();
}

/**
 * Put a layer on the stack; returns its removal. Callbacks are read when
 * they are needed, so a component can hand in refs that track its render.
 */
export function addLayer(close: () => void, options: () => LayerOptions = () => ({})): () => void {
  const layer: Layer = {
    id: nextId++,
    close,
    mayRefuse: () => Boolean(options().mayRefuse),
    leaving: () => Boolean(options().leaving),
    coversBottom: () => Boolean(options().coversBottom)
  };
  layers.push(layer);
  notify();
  return () => {
    const index = layers.indexOf(layer);
    if (index < 0) return;
    layers.splice(index, 1);
    notify();
  };
}

/** Every layer, bottom first, the leaving ones included. */
export function allLayers(): readonly Layer[] {
  return layers.slice();
}

/** Layers that hold a history entry: every one on screen, leaving or not. */
export function layerCount(): number {
  return layers.length;
}

/** The layers Back can still close, bottom first. */
export function standingLayers(): Layer[] {
  return layers.filter((layer) => !layer.leaving());
}

/** True while any standing layer covers a phone's bottom edge. */
export function hasBottomSheetLayer(): boolean {
  return layers.some((layer) => !layer.leaving() && layer.coversBottom());
}

/** The topmost layer Back would close, if any. */
export function topLayer(): Layer | null {
  for (let index = layers.length - 1; index >= 0; index -= 1) if (!layers[index].leaving()) return layers[index];
  return null;
}

/** For useSyncExternalStore: called whenever a layer comes or goes. */
export function subscribeLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
