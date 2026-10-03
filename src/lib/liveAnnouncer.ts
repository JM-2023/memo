/**
 * The app's screen-reader voice: two visually hidden live regions (polite
 * and assertive) that sit in the document from startup, so a message written
 * into them is announced. A live region inserted together with its text —
 * a toast, a notice that mounts already filled — is often skipped by
 * Chrome/Safari with VoiceOver or NVDA.
 *
 * The container hangs off <body> and carries LIVE_REGION_ATTR, which modal
 * isolation leaves alone, so a toast raised from inside a dialog still
 * speaks.
 */
export const LIVE_REGION_ATTR = "data-live-region";

interface Regions {
  root: HTMLElement;
  polite: HTMLElement;
  assertive: HTMLElement;
}

let regions: Regions | null = null;
let mounts = 0;
let clearTimer = 0;
/** Long enough to be read out; then the regions empty, so a later browse
    through the page does not meet a stale "Moved to Trash" at its end. */
const CLEAR_AFTER_MS = 10_000;

function createRegion(role: "status" | "alert"): HTMLElement {
  const region = document.createElement("div");
  region.setAttribute("role", role);
  region.setAttribute("aria-live", role === "alert" ? "assertive" : "polite");
  region.setAttribute("aria-atomic", "true");
  return region;
}

/** Mounts the regions (ref-counted); returns the matching unmount. */
export function mountLiveRegions(): () => void {
  mounts += 1;
  if (!regions) {
    const root = document.createElement("div");
    root.setAttribute(LIVE_REGION_ATTR, "");
    root.className = "sr-only";
    const polite = createRegion("status");
    const assertive = createRegion("alert");
    root.appendChild(polite);
    root.appendChild(assertive);
    document.body.appendChild(root);
    regions = { root, polite, assertive };
  }
  return () => {
    mounts = Math.max(0, mounts - 1);
    if (mounts > 0 || !regions) return;
    window.clearTimeout(clearTimer);
    regions.root.remove();
    regions = null;
  };
}

/**
 * Speaks `text`. Each message replaces the region's child node, so the same
 * sentence twice in a row ("Copied to clipboard") is still an addition and
 * still announced.
 */
export function announce(text: string, tone: "polite" | "assertive" = "polite"): void {
  if (!regions || !text) return;
  const line = document.createElement("div");
  line.textContent = text;
  (tone === "assertive" ? regions.assertive : regions.polite).replaceChildren(line);
  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    regions?.polite.replaceChildren();
    regions?.assertive.replaceChildren();
  }, CLEAR_AFTER_MS);
}
