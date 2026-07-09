// Memo text parsing shared by the card renderer, tag extraction and word
// counting. Two things count as an external image (previewed, never stored):
//   1. ![alt](https://…)  — the editor's "图片链接" button inserts this form,
//      so any URL can be forced to render as an image;
//   2. a bare URL whose path ends in a common image extension.

export const MD_IMAGE_PATTERN = /!\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)/gu;
export const URL_PATTERN = /https?:\/\/[^\s]+/gu;

const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
// Punctuation that reads as sentence-trailing rather than part of the URL.
const TRAILING_PUNCT_PATTERN = /[)）\]】》»"'.,;:!?、。，；：！？…]+$/;

export function splitTrailingPunct(raw: string): { url: string; trailing: string } {
  const match = raw.match(TRAILING_PUNCT_PATTERN);
  if (!match) return { url: raw, trailing: "" };
  return { url: raw.slice(0, raw.length - match[0].length), trailing: match[0] };
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

const TOKEN_PATTERN = /(!\[[^\]\n]*\]\((?:https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s]+)|(#[\p{L}\p{N}_\-/·]+)/gu;

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
  for (const line of content.split("\n")) {
    for (const token of tokenizeLine(line)) {
      if (token.kind === "image" && !seen.has(token.url)) {
        seen.add(token.url);
        urls.push(token.url);
      }
    }
  }
  return urls;
}
