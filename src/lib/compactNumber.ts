const formatters = new Map<string, Intl.NumberFormat>();

/** Keep four-digit counts exact. Compact only the sidebar, never stored data. */
export function compactNumber(value: number, locale: string): { number: string; unit: string } {
  if (Math.abs(value) < 10_000) return { number: String(value), unit: "" };
  // Bound even implausibly large counters without an indefinitely growing suffix.
  if (Math.abs(value) >= 1e15) return { number: value.toExponential(1).replace(/\.0e\+?/, "e").replace("e+", "e"), unit: "" };
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      notation: "compact", compactDisplay: "short", maximumSignificantDigits: 3, useGrouping: false
    });
    formatters.set(locale, formatter);
  }
  const parts = formatter.formatToParts(value);
  return {
    number: parts.filter((part) => part.type !== "compact" && part.type !== "literal").map((part) => part.value).join(""),
    unit: parts.filter((part) => part.type === "compact").map((part) => part.value).join("")
  };
}
