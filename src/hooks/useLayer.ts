import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { addLayer, hasBottomSheetLayer, layerCount, subscribeLayers, type LayerOptions } from "../lib/layerStack";

/**
 * Holds a place on the layer stack (lib/layerStack) while `open`: Back
 * closes the topmost layer through `onBack` — the layer's own Cancel or
 * Esc, never a bare unmount — and the app's shortcuts wait until it goes.
 * Registered before paint, so a layer handing over to the next in one
 * commit (a menu item opening a dialog) never leaves the stack empty.
 */
export function useLayer(open: boolean, onBack: () => void, options: LayerOptions = {}): void {
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useLayoutEffect(() => {
    if (!open) return;
    return addLayer(
      () => backRef.current(),
      () => optionsRef.current
    );
  }, [open]);
}

function anyLayer(): boolean {
  return layerCount() > 0;
}

function noLayer(): boolean {
  return false;
}

/** True while any layer is on the stack. */
export function useLayersUp(): boolean {
  return useSyncExternalStore(subscribeLayers, anyLayer, noLayer);
}

/** True while any standing layer covers a phone's bottom edge. */
export function useBottomSheetUp(): boolean {
  return useSyncExternalStore(subscribeLayers, hasBottomSheetLayer, noLayer);
}
