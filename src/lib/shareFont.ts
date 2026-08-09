/**
 * The script face, packed for the export.
 *
 * An SVG rendered through an <img> is its own document with no network: the
 * @font-face in app.css is invisible to it, and a url() pointing back at the
 * origin would simply not resolve. So the export carries the font with it,
 * inlined as a data URI in a rule appended to the stylesheet it embeds.
 *
 * The bytes are fetched once and the promise is kept, so the second export
 * costs nothing. A failure resolves to an empty rule rather than rejecting:
 * a card that falls back to the reader's own written face is a far better
 * outcome than an export that refuses to happen.
 */

import handFontUrl from "../assets/fonts/DancingScript.ttf?url";

/** Matches the @font-face in app.css and the family named by --sc-face in
    shareCard.css; all three have to agree or the export silently falls back. */
const HAND_FAMILY = "Dancing Script";

function toBase64(bytes: Uint8Array): string {
  // Chunked: one apply() over ~130k arguments overflows the call stack.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

let packed: Promise<string> | null = null;

/**
 * The @font-face rule to append to the exported stylesheet — empty string if
 * the font can't be read. Safe to call eagerly: it's the same promise every
 * time, so warming it when the reader picks the hand makes the export itself
 * instant.
 */
export function handFontCss(): Promise<string> {
  packed ??= fetch(handFontUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`Font request failed: ${response.status}`);
      return response.arrayBuffer();
    })
    .then(
      (buffer) =>
        `@font-face{font-family:"${HAND_FAMILY}";` +
        `src:url(data:font/ttf;base64,${toBase64(new Uint8Array(buffer))}) format("truetype");` +
        `font-weight:400 700;font-style:normal;}`
    )
    .catch(() => "");
  return packed;
}
