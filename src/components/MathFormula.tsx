import { useMemo } from "react";
import katex from "katex";

/** Native MathML keeps formulas accessible and self-contained in image
 * exports and replay clones, without downloading external math fonts. */
export function MathFormula({ text, display = false }: { text: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(text, {
        output: "mathml", displayMode: display, throwOnError: true,
        trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20
      });
    } catch { return null; }
  }, [text, display]);
  return html === null ? <code>{text}</code> : <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} />;
}
