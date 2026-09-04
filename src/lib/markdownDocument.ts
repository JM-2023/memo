import { inlineCodeSpanEnd } from "./content";
import { mathAt, parseBlock, parseTableCells, isTableRule } from "./markdown";

export interface MarkdownRow { raw: string; key: number }
const reference = /^ {0,3}\[([^\]\n]+)\]:\s*(https?:\/\/[^\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const labelKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/** Resolve references only in prose, never in code or TeX. The result is
 * display-only; original memo content and source indices are preserved. */
function resolveReferences(text: string, refs: Map<string, string>): string {
  let result = "";
  for (let i = 0; i < text.length;) {
    const codeEnd = inlineCodeSpanEnd(text, i);
    const math = mathAt(text, i);
    if (codeEnd !== -1 || math) {
      const end = codeEnd !== -1 ? codeEnd : i + math!.raw.length;
      result += text.slice(i, end);
      i = end;
      continue;
    }
    const match = text[i] === "[" && /^\[([^\]\n]+)\]\[([^\]\n]*)\]/.exec(text.slice(i));
    const url = match && refs.get(labelKey(match[2] || match[1]));
    if (match && url && text[i - 1] !== "\\" && text[i - 1] !== "!") {
      result += `[${match[1]}](${url})`;
      i += match[0].length;
    } else result += text[i++];
  }
  return result;
}

/** Group cross-line syntax once. Each resulting row is self-contained for
 * the animation's independent clones, and retains its original line key. */
export function markdownRows(content: string): MarkdownRow[] {
  const source = content.replace(/\r\n?/g, "\n").split("\n");
  const rows: MarkdownRow[] = [];
  const refs = new Map<string, string>();
  for (let key = 0; key < source.length; key++) {
    const raw = source[key];
    const fence = /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(raw);
    if (fence) {
      const closer = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      let end = key + 1;
      while (end < source.length && !closer.test(source[end])) end++;
      rows.push({ raw: source.slice(key, Math.min(end + 1, source.length)).join("\n") + (end === key + 1 && end === source.length ? "\n" : ""), key });
      key = Math.min(end, source.length - 1);
      continue;
    }
    const opener = raw.trim().startsWith("$$") ? "$$" : raw.trim().startsWith("\\[") ? "\\[" : null;
    if (opener && parseBlock(raw).kind !== "math") {
      const closer = opener === "$$" ? "$$" : "\\]";
      let end = key + 1;
      while (end < source.length && !source[end].trimEnd().endsWith(closer)) end++;
      if (end < source.length) {
        rows.push({ raw: source.slice(key, end + 1).join("\n"), key });
        key = end;
        continue;
      }
    }
    const ref = reference.exec(raw);
    if (ref) {
      const id = labelKey(ref[1]);
      if (!refs.has(id)) refs.set(id, ref[2]);
      continue;
    }
    rows.push({ raw, key });
  }
  // Unbordered tables require a delimiter row; isolated prose pipes stay prose.
  for (let i = 0; i < rows.length; i++) {
    if (parseBlock(rows[i].raw).kind === "codeblock" || parseBlock(rows[i].raw).kind === "math") continue;
    const cells = parseTableCells(rows[i].raw.trimStart().startsWith("|") ? rows[i].raw : `| ${rows[i].raw}`);
    if (!cells || cells.length < 2 || !isTableRule(cells) || i === 0) continue;
    const header = parseTableCells(rows[i - 1].raw.trimStart().startsWith("|") ? rows[i - 1].raw : `| ${rows[i - 1].raw}`);
    if (!header || header.length !== cells.length) continue;
    for (let j = i - 1; j < rows.length; j++) {
      const row = rows[j];
      if (!row.raw.includes("|") || row.raw.includes("\n")) break;
      if (!row.raw.trimStart().startsWith("|")) row.raw = `| ${row.raw}`;
    }
  }
  return rows.map(row => {
    const kind = parseBlock(row.raw).kind;
    return kind === "codeblock" || kind === "math" ? row : { ...row, raw: resolveReferences(row.raw, refs) };
  });
}
