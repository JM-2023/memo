export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "memo:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
// The theme-color pair in index.html; public/theme-init.js mirrors these.
const META_LIGHT = "#f3f4f7";
const META_DARK = "#0c0e13";

export function loadTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
}

// [data-theme] is always the resolved theme, so the stylesheet keeps one dark
// token block. "system" resolves here (and in theme-init.js before first
// paint) and follows the OS while the page is open through this listener.
let systemQuery: MediaQueryList | null = null;
function setResolvedTheme(theme: "light" | "dark"): void {
  // Unchanged values are skipped: [data-theme] observers (the orb) re-read
  // tokens on every mutation record, even a same-value one.
  const root = document.documentElement;
  if (root.getAttribute("data-theme") !== theme) root.setAttribute("data-theme", theme);
}
function syncSystemTheme(): void {
  setResolvedTheme(systemQuery?.matches ? "dark" : "light");
}

export function applyTheme(choice: ThemeChoice): void {
  systemQuery?.removeEventListener("change", syncSystemTheme);
  systemQuery = null;
  if (choice === "system") {
    systemQuery = darkQuery();
    systemQuery?.addEventListener("change", syncSystemTheme);
    syncSystemTheme();
  } else {
    setResolvedTheme(choice);
  }
  try {
    if (choice === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    // private mode — theme just won't persist
  }
  // "system" hands the browser chrome back to the media-qualified pair, so the
  // status bar follows the OS even while the page sits in the background; an
  // explicit choice paints both with that theme's colour.
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const color =
      choice === "system"
        ? (meta.getAttribute("media") ?? "").includes("dark") ? META_DARK : META_LIGHT
        : choice === "dark" ? META_DARK : META_LIGHT;
    meta.setAttribute("content", color);
  });
}

export function nextTheme(current: ThemeChoice): ThemeChoice {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}
