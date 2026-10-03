// Rich-text paste for the composer: a small, allow-list HTML → Markdown
// converter. Only the subset the card renderer understands survives
// (links, bold/italic/strike/highlight, inline code, fenced code, headings,
// lists and tasks, quotes, tables, rules, line breaks); everything else
// degrades to its text. Nothing from the clipboard is ever rendered as HTML —
// the document is parsed inert by DOMParser and only read.

// BUTTON is not skipped: MEMO's own cards render #tags as <button
// class="memo-tag">, and a copied card line must keep them (plain-text
// paste keeps button text too).
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "META", "LINK", "TITLE", "HEAD", "IMG", "SVG", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "SELECT", "TEXTAREA"]);
const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION",
  "DL", "DT", "DD", "ADDRESS", "CENTER", "DETAILS", "SUMMARY", "BODY", "FORM", "FIELDSET", "TR", "TBODY", "THEAD", "TFOOT"
]);

/** A block edge. Runs of them (and the line breaks around them) settle into
 * one newline in `settle`, so neighbouring blocks never stack blank lines;
 * only explicit <br>s add a blank line. */
const EDGE = "\x01";
/** Starts a code-fence line written by <pre>, so `tidy` never mistakes a
 * backtick line inside the code (or in prose) for the fence itself. */
const FENCE = "\x02";

interface Ctx {
  /** Set once anything beyond plain paragraphs was produced. */
  rich: boolean;
}

/** Link targets must survive the renderer's `\((https?://[^\s)]+)\)`. */
function safeUrl(href: string | null): string | null {
  const url = href?.trim() ?? "";
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Keep edge spaces outside the markers — "** bold **" would not parse. */
function wrap(inner: string, marker: string, ctx: Ctx): string {
  const core = inner.trim();
  if (!core || /[\n\x01]/.test(core)) return inner;
  ctx.rich = true;
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner)![0];
  return `${lead}${marker}${core}${marker}${trail}`;
}

function oneLine(text: string): string {
  return text.replace(/[\s\x01]*[\n\x01][\s\x01]*/g, " ").trim();
}

/** Resolve block edges: one newline, or a blank line where <br>s asked. */
function settle(text: string): string {
  return text.replace(/[\s\x01]*\x01[\s\x01]*/g, (run) => (run.split("\n").length > 2 ? "\n\n" : "\n"));
}

function styleMarkers(el: HTMLElement): string[] {
  const style = el.style;
  const markers: string[] = [];
  const weight = style?.fontWeight ?? "";
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) markers.push("**");
  if (style?.fontStyle === "italic") markers.push("*");
  if ((style?.textDecoration ?? "").includes("line-through") || (style?.textDecorationLine ?? "").includes("line-through")) markers.push("~~");
  return markers;
}

/** "font-weight: normal" on a <b> (Google Docs wraps whole pastes in one). */
function weightCancelled(el: HTMLElement): boolean {
  const weight = el.style?.fontWeight ?? "";
  return weight === "normal" || (weight !== "" && Number(weight) < 600);
}

function children(node: Node, ctx: Ctx, pre: boolean): string {
  let out = "";
  node.childNodes.forEach((child) => {
    out += walk(child, ctx, pre);
  });
  return out;
}

function list(el: Element, ctx: Ctx, depth: number): string {
  ctx.rich = true;
  const ordered = el.tagName === "OL";
  let ordinal = Number(el.getAttribute("start")) || 1;
  const lines: string[] = [];
  for (const item of Array.from(el.children)) {
    if (item.tagName === "UL" || item.tagName === "OL") {
      lines.push(list(item, ctx, depth + 1).slice(1, -1));
      continue;
    }
    if (item.tagName !== "LI") continue;
    // Google Docs keeps nested items flat and says the depth in aria-level.
    const level = Number(item.getAttribute("aria-level"));
    const itemDepth = level > 1 ? level - 1 : depth;
    const box = Array.from(item.querySelectorAll("input")).find((input) => input.type === "checkbox" && input.closest("li") === item);
    const nested: Element[] = [];
    let inline = "";
    item.childNodes.forEach((child) => {
      if (child instanceof Element && (child.tagName === "UL" || child.tagName === "OL")) nested.push(child);
      else inline += walk(child, ctx, false);
    });
    const marker = box ? `- [${box.checked || box.hasAttribute("checked") ? "x" : " "}] ` : ordered ? `${ordinal}. ` : "- ";
    ordinal += 1;
    lines.push(`${"  ".repeat(Math.min(itemDepth, 3))}${marker}${oneLine(inline)}`);
    for (const sub of nested) lines.push(list(sub, ctx, itemDepth + 1).slice(1, -1));
  }
  return `${EDGE}${lines.join("\n")}${EDGE}`;
}

function table(el: HTMLTableElement, ctx: Ctx): string | null {
  const rows = Array.from(el.rows);
  const width = rows[0]?.cells.length ?? 0;
  // Layout tables (one column, ragged rows, tables inside tables) are not
  // data; their cells fall through as plain blocks.
  if (rows.length < 2 || width < 2 || rows.some((row) => row.cells.length !== width) || el.querySelector("table")) return null;
  ctx.rich = true;
  const line = (row: HTMLTableRowElement) =>
    `| ${Array.from(row.cells)
      .map((cell) => oneLine(children(cell, ctx, false)).replace(/\|/g, "\\|"))
      .join(" | ")} |`;
  const [head, ...body] = rows;
  return `${EDGE}${[line(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n")}${EDGE}`;
}

/** An inline white-space style that keeps line breaks (Google Docs spans,
 * chat apps): the nearest declaring ancestor decides. */
function keepsBreaks(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const value = el.style?.whiteSpace ?? "";
    if (value) return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(value);
  }
  return false;
}

function walk(node: Node, ctx: Ctx, pre: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\xa0/g, " ");
    if (pre) return text;
    if (keepsBreaks(node)) return text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ");
    return text.replace(/\s+/g, " ");
  }
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toUpperCase();
  if (SKIP.has(tag)) return "";
  const el = node as HTMLElement;

  switch (tag) {
    case "BR":
      return "\n";
    case "HR":
      ctx.rich = true;
      return `${EDGE}---${EDGE}`;
    case "PRE": {
      ctx.rich = true;
      const code = (el.textContent ?? "").replace(/\xa0/g, " ").replace(/\n+$/, "");
      // One backtick longer than any run in the code, so a ``` inside it
      // cannot close the fence early.
      const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `${EDGE}${FENCE}${fence}\n${code}\n${FENCE}${fence}${EDGE}`;
    }
    case "CODE": {
      if (pre) return el.textContent ?? "";
      const code = oneLine((el.textContent ?? "").replace(/\xa0/g, " "));
      if (!code || code.includes("`")) return code;
      ctx.rich = true;
      return `\`${code}\``;
    }
    case "A": {
      const inner = children(el, ctx, pre);
      const url = safeUrl(el.getAttribute("href"));
      const label = oneLine(inner).replace(/[[\]]/g, "");
      if (!url) return inner;
      ctx.rich = true;
      if (!label || label === url || label === el.getAttribute("href")) return url;
      return `[${label}](${url})`;
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = oneLine(children(el, ctx, false));
      if (!text) return EDGE;
      ctx.rich = true;
      return `${EDGE}${"#".repeat(Math.min(Number(tag[1]), 3))} ${text}${EDGE}`;
    }
    case "UL":
    case "OL":
      return list(el, ctx, 0);
    case "LI":
      return `${EDGE}- ${oneLine(children(el, ctx, false))}${EDGE}`;
    case "BLOCKQUOTE": {
      const inner = settle(children(el, ctx, false)).trim();
      if (!inner) return "";
      ctx.rich = true;
      return `${EDGE}${inner
        .split("\n")
        .map((line) => (line.trim() ? `> ${line.trim()}` : ">"))
        .join("\n")}${EDGE}`;
    }
    case "TABLE": {
      const converted = table(el as HTMLTableElement, ctx);
      if (converted !== null) return converted;
      return `${EDGE}${children(el, ctx, false)}${EDGE}`;
    }
    case "TD":
    case "TH":
      return `${EDGE}${children(el, ctx, pre)}${EDGE}`;
    case "STRONG":
      return wrap(children(el, ctx, pre), "**", ctx);
    case "B":
      return weightCancelled(el) ? children(el, ctx, pre) : wrap(children(el, ctx, pre), "**", ctx);
    case "EM":
    case "I":
      return wrap(children(el, ctx, pre), "*", ctx);
    case "DEL":
    case "S":
    case "STRIKE":
      return wrap(children(el, ctx, pre), "~~", ctx);
    case "MARK":
      return wrap(children(el, ctx, pre), "==", ctx);
    default: {
      let inner = children(el, ctx, pre);
      if (!pre) for (const marker of styleMarkers(el)) inner = wrap(inner, marker, ctx);
      return BLOCK.has(tag) ? `${EDGE}${inner}${EDGE}` : inner;
    }
  }
}

/** Trim the whitespace HTML layout leaves behind, outside code fences. */
function tidy(text: string): string {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of settle(text).split("\n")) {
    if (raw.trimStart().startsWith(FENCE)) {
      fenced = !fenced;
      lines.push(raw.trim().slice(FENCE.length));
      continue;
    }
    if (fenced) {
      lines.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    // Our own nested list indent is the only leading space that means anything.
    lines.push(/^\s+(?:[-*+]|\d{1,3}[.)])\s/.test(line) ? line : line.trimStart());
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Markdown for a clipboard text/html payload, or null when plain-text paste
 * should go ahead untouched: nothing richer than paragraphs was found, or
 * the HTML is a code editor's styled copy (white-space: pre spans), whose
 * indentation lives only in the plain text.
 */
export function htmlToMarkdown(html: string): string | null {
  if (!html.trim() || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return null;
  // Decide from the effective declaration: Google Docs spans say
  // "white-space:pre;white-space:pre-wrap", where pre-wrap wins.
  const codeCopy = Array.from(body.querySelectorAll<HTMLElement>("[style*='white-space']")).some((el) => el.style.whiteSpace === "pre");
  if (!body.querySelector("pre") && !body.querySelector("[id^='docs-internal-guid']") && codeCopy) return null;
  const ctx: Ctx = { rich: false };
  const markdown = tidy(walk(body, ctx, false));
  return ctx.rich && markdown ? markdown : null;
}
