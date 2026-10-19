import { useSheet, type BackdropDismissProps, type SheetOptions } from "./useSheet";

export { boopCard, type BackdropDismissProps, type SheetOptions } from "./useSheet";

/**
 * The overlay's dismissal props: a backdrop click that began on the backdrop
 * closes the dialog, and on a phone the sheet can be pulled down. The sheet
 * controller itself (drag sources, springs, resisting a stray dismissal)
 * lives in useSheet.
 */
export function useBackdropDismiss(onDismiss: () => void, options?: SheetOptions): BackdropDismissProps {
  return useSheet(onDismiss, options);
}
