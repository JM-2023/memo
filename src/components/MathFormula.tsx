import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { loadedKatex, loadKatex, subscribeKatex } from "../lib/katexLoader";

/** Native MathML keeps formulas accessible and self-contained in image
 * exports and replay clones, without downloading external math fonts. */
export function MathFormula({ text, display = false }: { text: string; display?: boolean }) {
  const katex = useSyncExternalStore(subscribeKatex, loadedKatex, loadedKatex);
  // Only a formula this reader saw as pending source fades into its typeset
  // form; one mounted after KaTeX arrived (a replay clone, a later page)
  // draws at once, so clones stay pixel-identical to the card.
  const arrivedRef = useRef(katex === null);
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
  // knows to wait for it rather than print the source. Pending source is
  // muted so it reads as a placeholder; a formula KaTeX can't parse shows
  // its source at full strength.
  if (html === null) {
    return katex ? <code>{text}</code> : <code className="md-math-pending" data-math-pending="">{text}</code>;
  }
  return <span className={`md-math${arrivedRef.current ? " is-arriving" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
