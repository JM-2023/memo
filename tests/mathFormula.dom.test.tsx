// @vitest-environment jsdom

// A formula seen as pending source fades into its typeset form; one that
// mounts after KaTeX arrived (a replay clone, a later page) draws at once.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MathFormula } from "../src/components/MathFormula";
import { loadKatex } from "../src/lib/katexLoader";

afterEach(cleanup);

describe("MathFormula arrival", () => {
  it("mutes the pending source, fades in what replaces it, and draws later copies instantly", async () => {
    const pending = render(<MathFormula text="x^2" />);
    const source = pending.container.querySelector("code");
    expect(source?.classList.contains("md-math-pending")).toBe(true);
    expect(source?.hasAttribute("data-math-pending")).toBe(true);

    await act(async () => {
      await loadKatex();
    });
    const typeset = pending.container.querySelector(".md-math");
    expect(typeset?.classList.contains("is-arriving")).toBe(true);

    const clone = render(<MathFormula text="x^2" />);
    const instant = clone.container.querySelector(".md-math");
    expect(instant).not.toBeNull();
    expect(instant?.classList.contains("is-arriving")).toBe(false);
  });
});
