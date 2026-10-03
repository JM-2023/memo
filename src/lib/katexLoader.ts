import type katexType from "katex";

type Katex = typeof katexType;

/* KaTeX is a third of the app's script and only memos with math need it, so
   it loads on first use instead of with the main bundle. Formulas render as
   their source in <code> until it arrives, then re-render in place. */
let katex: Katex | null = null;
let pending: Promise<Katex> | null = null;
const listeners = new Set<() => void>();

export function loadedKatex(): Katex | null {
  return katex;
}

export function loadKatex(): Promise<Katex> {
  if (katex) return Promise.resolve(katex);
  pending ??= import("katex").then(
    (module) => {
      katex = module.default;
      for (const listener of listeners) listener();
      return katex;
    },
    (error: unknown) => {
      // A failed fetch (offline, a deploy swapped the chunk) may succeed on
      // the next formula, so do not remember it.
      pending = null;
      throw error;
    }
  );
  return pending;
}

export function subscribeKatex(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
