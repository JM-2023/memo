import { X, type LucideIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

interface FilterChipProps {
  /** Lens-type glyph — the same icon as the filter's source row (heatmap day,
      panel facet), so the chip reads as that row's compact echo in the trail. */
  icon: LucideIcon;
  label: string;
  /** Accessible name for removing this lens. */
  clearLabel: string;
  /** Unique view-transition-name. It makes the chip glide when the breadcrumb
      before it changes width, morph in place when its label changes (repicking
      a heatmap day), and fold back on removal (see the chip rules in the
      view-transition section of app.css). */
  transitionName: string;
  /** Entrance stagger when several chips mount in one commit (a saved preset
      restoring day + facets at once); a lone chip enters immediately. */
  delay?: string;
  onClear: () => void;
  /** Hands the reader back to the panel the lens came from. With it, the chip
      splits into two targets — label to edit, nub to remove; without it the
      whole chip is the remove button (a heatmap day has no panel to reopen). */
  onEdit?: () => void;
  /** Accessible name for the edit half; required with onEdit. */
  editLabel?: string;
}

/**
 * One active feed lens, riding behind the location pill: the breadcrumb says
 * WHERE, the chips say THROUGH WHAT. A chip whose lens lives in the filter
 * panel opens that panel from its label and removes the lens from its ×; a
 * chip with no panel behind it (a heatmap day) is one large remove button,
 * with the × glyph kept as the affordance cue.
 *
 * The entrance delay is frozen at mount, TrailCrumb-style: the stagger is
 * derived from which chips are new this commit, and re-deriving it on a later
 * render (once the previous chip list has moved on) would retime a finished
 * entrance. Only a real remount legitimately restarts it.
 */
export function FilterChip({ icon: Icon, label, clearLabel, transitionName, delay, onClear, onEdit, editLabel }: FilterChipProps) {
  const [entranceDelay] = useState(delay);
  const style: CSSProperties = { viewTransitionName: transitionName };
  if (entranceDelay) style.animationDelay = entranceDelay;
  if (!onEdit) {
    return (
      <button type="button" className="filter-chip" style={style} aria-label={clearLabel} onClick={onClear}>
        <Icon size={13} aria-hidden="true" />
        <span className="filter-chip-label">{label}</span>
        <X size={12} className="filter-chip-x" aria-hidden="true" />
      </button>
    );
  }
  return (
    <span className="filter-chip is-editable" style={style}>
      <button type="button" className="filter-chip-main" aria-label={editLabel} onClick={onEdit}>
        <Icon size={13} aria-hidden="true" />
        <span className="filter-chip-label">{label}</span>
      </button>
      <button type="button" className="filter-chip-x" aria-label={clearLabel} onClick={onClear}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}
