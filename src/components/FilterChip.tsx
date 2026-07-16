import { X, type LucideIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

interface FilterChipProps {
  /** Lens-type glyph — the same icon as the filter's source row (heatmap day,
      panel facet), so the chip reads as that row's compact echo in the trail. */
  icon: LucideIcon;
  label: string;
  /** Accessible name for the chip's single action: removing this lens. */
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
}

/**
 * One active feed lens, riding behind the location pill: the breadcrumb says
 * WHERE, the chips say THROUGH WHAT. The whole chip is one button whose only
 * action is removing the lens — one large target instead of a 12px ×; the ×
 * glyph stays as the affordance cue.
 *
 * The entrance delay is frozen at mount, TrailCrumb-style: the stagger is
 * derived from which chips are new this commit, and re-deriving it on a later
 * render (once the previous chip list has moved on) would retime a finished
 * entrance. Only a real remount legitimately restarts it.
 */
export function FilterChip({ icon: Icon, label, clearLabel, transitionName, delay, onClear }: FilterChipProps) {
  const [entranceDelay] = useState(delay);
  const style: CSSProperties = { viewTransitionName: transitionName };
  if (entranceDelay) style.animationDelay = entranceDelay;
  return (
    <button type="button" className="filter-chip" style={style} aria-label={clearLabel} onClick={onClear}>
      <Icon size={13} aria-hidden="true" />
      <span className="filter-chip-label">{label}</span>
      <X size={12} className="filter-chip-x" aria-hidden="true" />
    </button>
  );
}
