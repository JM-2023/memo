// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme } from "../src/lib/theme";

const root = resolve(import.meta.dirname, "..");

// A controllable prefers-color-scheme: flipping it fires the change listeners
// the way the OS switching appearance would.
function installColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => (media === query.media ? query : { matches: false, media, addEventListener() {}, removeEventListener() {} })
  });
  return {
    listeners,
    set(next: boolean) {
      dark = next;
      listeners.forEach((listener) => listener());
    }
  };
}

function themeColors() {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content"));
}

beforeEach(() => {
  // The pair index.html ships with.
  document.head.innerHTML = `
    <meta name="theme-color" content="#f3f4f7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0c0e13" media="(prefers-color-scheme: dark)" />`;
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

afterEach(() => {
  applyTheme("light");
  localStorage.clear();
});

describe("applyTheme", () => {
  it("resolves system to the OS theme and follows it while the page is open", () => {
    const scheme = installColorScheme(false);
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    scheme.set(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    scheme.set(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("keeps the media-qualified theme-color pair intact in system mode", () => {
    installColorScheme(true);
    applyTheme("dark");
    expect(themeColors()).toEqual(["#0c0e13", "#0c0e13"]);

    // Back to system: each meta gets its own colour again, so the browser
    // chrome can follow the OS without the page being reloaded.
    applyTheme("system");
    expect(themeColors()).toEqual(["#f3f4f7", "#0c0e13"]);
  });

  it("stops following the OS once a theme is chosen explicitly", () => {
    const scheme = installColorScheme(false);
    applyTheme("system");
    expect(scheme.listeners.size).toBe(1);

    applyTheme("light");
    expect(scheme.listeners.size).toBe(0);
    scheme.set(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(themeColors()).toEqual(["#f3f4f7", "#f3f4f7"]);
    expect(localStorage.getItem("memo:theme")).toBe("light");
  });
});

describe("stylesheet theming", () => {
  it("themes only through [data-theme], never the OS media query", () => {
    // [data-theme] already carries the OS preference in system mode; a
    // prefers-color-scheme rule would also fire under an explicit light
    // choice on a dark OS.
    for (const sheet of ["src/styles/app.css", "src/styles/shareCard.css"]) {
      const css = readFileSync(resolve(root, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css).not.toMatch(/prefers-color-scheme/);
    }
  });

  it("keeps the share card's code and math rules out of reach of the feed's", () => {
    // The share preview loads app.css too, the exported PNG only shareCard.css.
    // Every code/math rule in shareCard.css is scoped to .share-card, so it
    // outranks app.css's unscoped feed rules and preview matches export.
    const css = readFileSync(resolve(root, "src/styles/shareCard.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)]
      .flatMap((match) => match[1].split(","))
      .map((selector) => selector.trim())
      .filter((selector) => /\.md-(codeblock|math)/.test(selector));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith(".share-card")).toBe(true);
  });
});

describe("theme-init.js", () => {
  const script = readFileSync(resolve(root, "public/theme-init.js"), "utf8");
  const runInit = () => new Function(script)();

  it("resolves an unset theme from the OS before first paint and leaves theme-color alone", () => {
    installColorScheme(true);
    runInit();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(themeColors()).toEqual(["#f3f4f7", "#0c0e13"]);
  });

  it("applies a stored explicit theme to the attribute and both theme-colors", () => {
    installColorScheme(true);
    localStorage.setItem("memo:theme", "light");
    runInit();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(themeColors()).toEqual(["#f3f4f7", "#f3f4f7"]);
  });
});
