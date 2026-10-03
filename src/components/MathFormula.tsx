import { useEffect, useMemo, useSyncExternalStore } from "react";
import { loadedKatex, loadKatex, subscribeKatex } from "../lib/katexLoader";

/** Native MathML keeps formulas accessible and self-contained in image
 * exports and replay clones, without downloading external math fonts. */
export function MathFormula({ text, display = false }: { text: string; display?: boolean }) {
  const katex = useSyncExternalStore(subscribeKatex, loadedKatex, loadedKatex);
  useEffect(() => {
    if (!katex) void loadKatex().catch(() => undefined);
  }, [katex]);
  const html = useMemo(() => {
    if (!katex) return null;
    try {
      return katex.renderToString(text, {
        output: "mathml", displayMode: display, throwOnError: true,
        trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20
      });
    } catch { return null; }
  }, [katex, text, display]);
  // data-math-pending marks a formula still waiting on KaTeX, so an export
  // knows to wait for it rather than print the source.
  if (html === null) return <code data-math-pending={katex ? undefined : ""}>{text}</code>;
  return <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} />;
}
