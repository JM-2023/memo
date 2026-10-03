import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MathFormula } from "../src/components/MathFormula";
import { loadedKatex, loadKatex, subscribeKatex } from "../src/lib/katexLoader";

describe("on-demand KaTeX", () => {
  it("prints a formula as pending source until KaTeX arrives, then typesets it", async () => {
    expect(loadedKatex()).toBeNull();
    expect(renderToStaticMarkup(<MathFormula text="x^2" />)).toBe("<code data-math-pending=\"\">x^2</code>");
    let notified = 0;
    const unsubscribe = subscribeKatex(() => (notified += 1));
    await Promise.all([loadKatex(), loadKatex()]);
    unsubscribe();
    expect(notified).toBe(1);
    const html = renderToStaticMarkup(<MathFormula text="x^2" />);
    expect(html).toContain('class="md-math"');
    expect(html).not.toContain("data-math-pending");
    expect(renderToStaticMarkup(<MathFormula text={String.raw`\badcommand`} />)).toBe("<code>\\badcommand</code>");
  });
});
