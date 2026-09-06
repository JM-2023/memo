import { compactNumber } from "../lib/compactNumber";
import { useI18n } from "../lib/i18n";
import { RollingText } from "./RollingText";

/** Independent drums keep the numeric columns anchored when a unit appears. */
export function CompactNumber({ value }: { value: number }) {
  const { locale, formatNumber } = useI18n();
  const display = compactNumber(value, locale);
  return (
    <span className="compact-number" role="text" aria-label={formatNumber(value)}>
      <span aria-hidden="true">
        <RollingText value={value} text={display.number} />
        <RollingText value={value} text={display.unit} align="left" />
      </span>
    </span>
  );
}
