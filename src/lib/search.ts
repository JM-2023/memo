// Feed search and structured filters. The search language is deliberately
// tiny: whitespace separates keywords that must ALL appear (AND), and double
// quotes — straight or curly, since IMEs swap between them — group an exact
// contiguous phrase. No OR/NOT operators, nothing to escape. Structured
// filters (no tags / has image / has link / has open task / date range) are
// derived per memo and cached on the immutable memo snapshot, so toggling
// them stays O(memos) like every other feed predicate.

import { MD_IMAGE_PATTERN, URL_PATTERN, isImageUrl, splitTrailingPunct } from "./content";
import { dayKeyOf } from "./stats";
import { tagsOf } from "./tags";
import type { Memo } from "./types";

export interface ParsedQuery {
  /** Lowercased keywords; every one must appear somewhere in the memo. */
  terms: string[];
  /** Lowercased quoted runs; each must appear as a contiguous substring. */
  phrases: string[];
}

// " and its curly siblings all delimit phrases: a phrase typed as “……” must
// not silently degrade into independent keywords.
const QUOTE_CHARS = new Set(['"', "“", "”"]);

export function parseSearchQuery(raw: string): ParsedQuery {
  const text = raw.toLowerCase();
  const terms: string[] = [];
  const phrases: string[] = [];
  let buffer = "";
  const flushTerms = () => {
    for (const term of buffer.split(/\s+/u)) if (term) terms.push(term);
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (QUOTE_CHARS.has(ch)) {
      flushTerms();
      let end = i + 1;
      while (end < text.length && !QUOTE_CHARS.has(text[end])) end += 1;
      // An unterminated quote reads as a phrase-in-progress — the natural
      // live-typing state between opening and closing the quote.
      const phrase = text.slice(i + 1, end).trim();
      if (phrase) phrases.push(phrase);
      i = end + 1;
    } else {
      buffer += ch;
      i += 1;
    }
  }
  flushTerms();
  return { terms, phrases };
}

export function queryIsEmpty(query: ParsedQuery): boolean {
  return query.terms.length === 0 && query.phrases.length === 0;
}

// Memo objects are immutable snapshots — every edit or sync delivers a fresh
// object — so WeakMaps keyed on the object are leak-free derivation caches.
const searchTextCache = new WeakMap<Memo, string>();

function searchableText(memo: Memo): string {
  let value = searchTextCache.get(memo);
  if (value === undefined) {
    value = memo.content.toLowerCase();
    searchTextCache.set(memo, value);
  }
  return value;
}

export function memoMatchesQuery(memo: Memo, query: ParsedQuery): boolean {
  const text = searchableText(memo);
  for (const phrase of query.phrases) if (!text.includes(phrase)) return false;
  for (const term of query.terms) if (!text.includes(term)) return false;
  return true;
}

/**
 * Merge the two retrieval signals without letting semantic search hide an
 * exact keyword/phrase hit. Unit-normalized cosine scores cannot exceed 1,
 * so a fixed boost of 2 keeps every keyword hit ahead of semantic-only
 * matches while still letting meaning rank ties inside the keyword tier.
 * `null` means neither retrieval path matched.
 */
export function hybridSearchScore(keywordMatch: boolean, semanticScore: number | undefined): number | null {
  if (keywordMatch) return 2 + (semanticScore ?? 0);
  return semanticScore ?? null;
}

export type FacetKey = "noTags" | "hasImage" | "hasLink" | "hasOpenTask";

export interface FeedFilters {
  noTags: boolean;
  hasImage: boolean;
  hasLink: boolean;
  hasOpenTask: boolean;
  /** Inclusive local-day keys (dates.ts format); either end may be open. */
  dateFrom: string | null;
  dateTo: string | null;
}

export const EMPTY_FILTERS: FeedFilters = Object.freeze({
  noTags: false,
  hasImage: false,
  hasLink: false,
  hasOpenTask: false,
  dateFrom: null,
  dateTo: null
});

export function hasActiveFilters(filters: FeedFilters): boolean {
  return filters.noTags || filters.hasImage || filters.hasLink || filters.hasOpenTask || filters.dateFrom !== null || filters.dateTo !== null;
}

export function filtersEqual(a: FeedFilters, b: FeedFilters): boolean {
  return (
    a.noTags === b.noTags &&
    a.hasImage === b.hasImage &&
    a.hasLink === b.hasLink &&
    a.hasOpenTask === b.hasOpenTask &&
    a.dateFrom === b.dateFrom &&
    a.dateTo === b.dateTo
  );
}

export interface MemoFacets {
  hasImage: boolean;
  hasLink: boolean;
  hasOpenTask: boolean;
}

// An unchecked box exactly as markdown.ts's TASK_PATTERN sees one: list
// marker, whitespace, then "[ ]" ending the line or followed by whitespace
// ("- [ ]x" stays a bullet there and stays undetected here).
const OPEN_TASK_PATTERN = /^[^\S\n]*[-*+][^\S\n]+\[ \](?=\s|$)/m;

const facetsCache = new WeakMap<Memo, MemoFacets>();

export function facetsOf(memo: Memo): MemoFacets {
  let facets = facetsCache.get(memo);
  if (!facets) {
    let hasImage = memo.images.length > 0;
    let hasLink = false;
    // Mirror the card renderer's filing: ![alt](url) is always an image,
    // never a link; a bare URL is whichever its extension says it is.
    const withoutMdImages = memo.content.replace(MD_IMAGE_PATTERN, () => {
      hasImage = true;
      return " ";
    });
    for (const match of withoutMdImages.matchAll(URL_PATTERN)) {
      if (isImageUrl(splitTrailingPunct(match[0]).url)) hasImage = true;
      else hasLink = true;
      if (hasImage && hasLink) break;
    }
    facets = { hasImage, hasLink, hasOpenTask: OPEN_TASK_PATTERN.test(memo.content) };
    facetsCache.set(memo, facets);
  }
  return facets;
}

export function memoMatchesFilters(memo: Memo, filters: FeedFilters): boolean {
  if (filters.noTags && tagsOf(memo).length > 0) return false;
  if (filters.hasImage || filters.hasLink || filters.hasOpenTask) {
    const facets = facetsOf(memo);
    if (filters.hasImage && !facets.hasImage) return false;
    if (filters.hasLink && !facets.hasLink) return false;
    if (filters.hasOpenTask && !facets.hasOpenTask) return false;
  }
  if (filters.dateFrom !== null || filters.dateTo !== null) {
    // Day keys share one format, so string order is date order; a reversed
    // pair still reads as the range between the two days.
    let lo = filters.dateFrom;
    let hi = filters.dateTo;
    if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
    const day = dayKeyOf(memo);
    if (lo !== null && day < lo) return false;
    if (hi !== null && day > hi) return false;
  }
  return true;
}
