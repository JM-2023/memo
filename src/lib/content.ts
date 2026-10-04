// Memo text parsing shared by the card renderer, tag extraction and word
// counting. Two things count as an external image (previewed, never stored):
//   1. ![alt](https://…)  — the editor's "图片链接" button inserts this form,
//      so any URL can be forced to render as an image;
//   2. a bare URL whose path ends in a common image extension.

export const MD_IMAGE_PATTERN = /!\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)/gu;

/**
 * What ends a bare URL besides whitespace: Han ideographs, kana, Hangul, CJK
 * punctuation (U+3000–303F), full-width forms (U+FF00–FFEF), and the curly
 * quotes, ellipsis and dash that CJK prose sets right against a link. None of
 * them appears unencoded in an address a browser copies, so in
 * "参考https://a.com/x，然后再看#读书" only the address links and #读书 stays a
 * tag. Every bare-URL pattern is built from this one source — the card, tag
 * extraction (client and server), word counts and search must agree on where
 * a link ends.
 */
const BARE_URL_STOP = "\\s\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff00-\\uffef\\u2014\\u2018-\\u201f\\u2026";
/** A bare http(s) URL, as regex source (needs the `u` flag). */
export const BARE_URL_SOURCE = `https?:\\/\\/[^${BARE_URL_STOP}]+`;
export const URL_PATTERN = new RegExp(BARE_URL_SOURCE, "gu");

const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
// Punctuation that reads as sentence-trailing rather than part of the URL.
const TRAILING_PUNCT_PATTERN = /[)）\]】》»"'.,;:!?、。，；：！？…]+$/;

/**
 * Return the exclusive end of the single-backtick code span opened at
 * `opener`, or -1 when it stays literal. Callers pass one visual line: memo
 * Markdown is deliberately line-stateless, so backticks never pair across a
 * newline. A non-empty body is required, matching parseInline exactly.
 */
export function inlineCodeSpanEnd(line: string, opener: number): number {
  if (line[opener] !== "`") return -1;
  const closer = line.indexOf("`", opener + 1);
  return closer > opener + 1 ? closer + 1 : -1;
}

export function splitTrailingPunct(raw: string): { url: string; trailing: string } {
  const match = raw.match(TRAILING_PUNCT_PATTERN);
  if (!match) return { url: raw, trailing: "" };
  return { url: raw.slice(0, raw.length - match[0].length), trailing: match[0] };
}

/** Longest a bare link's visible text runs, in Latin-letter widths (a CJK
    character counts two), before its middle gives way to "…". */
const URL_DISPLAY_MAX = 48;
const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uff60\uffe0-\uffe6]/u;

function charWidth(char: string): number {
  return WIDE_CHAR.test(char) ? 2 : 1;
}

/**
 * The visible text of a bare link; its href stays the exact URL. A link
 * copied from a browser arrives percent-encoded (…/wiki/%E7%AC%94…, three
 * lines of escapes for one word), so it is decoded where that is safe, and
 * the parts a reader never needs — the scheme, a leading "www.", a trailing
 * "/" — are dropped. A long remainder keeps its host and its last segment
 * with an ellipsis between.
 */
export function displayUrl(url: string): string {
  let text = url;
  try {
    const decoded = decodeURI(url);
    // Escapes that decode to whitespace, controls or bidi marks stay
    // escaped: decoded, they would hide or reorder the address.
    if (!/[\s\p{Cc}\p{Cf}]/u.test(decoded)) text = decoded;
  } catch {
    // A malformed escape: show the URL as written.
  }
  text = text.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (text.endsWith("/") && text.length > 1) text = text.slice(0, -1);
  const chars = Array.from(text);
  if (chars.reduce((sum, char) => sum + charWidth(char), 0) <= URL_DISPLAY_MAX) return text;
  // Three fifths of the room before the ellipsis (the host and the path's
  // start), the rest after it (the last segment, which names the page).
  const tailBudget = Math.floor((URL_DISPLAY_MAX - 1) * 0.4);
  let headBudget = URL_DISPLAY_MAX - 1 - tailBudget;
  let head = 0;
  while (head < chars.length && headBudget - charWidth(chars[head]) >= 0) headBudget -= charWidth(chars[head++]);
  let tail = chars.length;
  let tailLeft = tailBudget;
  while (tail > head && tailLeft - charWidth(chars[tail - 1]) >= 0) tailLeft -= charWidth(chars[--tail]);
  return `${chars.slice(0, head).join("")}…${chars.slice(tail).join("")}`;
}

export function isImageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return IMAGE_EXT_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Content with image markup and URLs blanked — the base for tag extraction and word counts. */
export function stripLinks(content: string): string {
  return content.replace(MD_IMAGE_PATTERN, " ").replace(URL_PATTERN, " ");
}

export type ContentToken =
  | { kind: "text"; text: string }
  | { kind: "tag"; raw: string; path: string }
  | { kind: "link"; url: string }
  /** Pulled out of the text flow; rendered in the media grid instead. */
  | { kind: "image"; url: string };

const TOKEN_PATTERN = new RegExp(`(!\\[[^\\]\\n]*\\]\\((?:https?:\\/\\/[^\\s)]+)\\))|(${BARE_URL_SOURCE})|(#[\\p{L}\\p{N}_\\-/·]+)`, "gu");

export function tokenizeLine(line: string): ContentToken[] {
  const tokens: ContentToken[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", text: line.slice(last, index) });
    last = index + match[0].length;

    if (match[1]) {
      const inner = /\((https?:\/\/[^\s)]+)\)/.exec(match[1]);
      if (inner) tokens.push({ kind: "image", url: inner[1] });
    } else if (match[2]) {
      const { url, trailing } = splitTrailingPunct(match[2]);
      if (isImageUrl(url)) {
        tokens.push({ kind: "image", url });
      } else {
        tokens.push({ kind: "link", url });
      }
      if (trailing) tokens.push({ kind: "text", text: trailing });
    } else if (match[3]) {
      const path = match[3].slice(1).replace(/^[/·]+|[/·]+$/g, "");
      if (path) {
        tokens.push({ kind: "tag", raw: match[3], path });
      } else {
        tokens.push({ kind: "text", text: match[3] });
      }
    }
  }
  if (last < line.length) tokens.push({ kind: "text", text: line.slice(last) });
  return tokens;
}

/** All external image URLs in a memo, deduped, in appearance order. */
export function externalImagesOf(content: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  let fence: { marker: string; size: number } | null = null;
  for (const line of content.split("\n")) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.size},}\\s*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], size: opening[1].length };
      continue;
    }
    for (const token of tokenizeLine(line)) {
      if (token.kind === "image" && !seen.has(token.url)) {
        seen.add(token.url);
        urls.push(token.url);
      }
    }
  }
  return urls;
}
