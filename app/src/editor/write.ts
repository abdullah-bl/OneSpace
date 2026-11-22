// The editor's blocks → Markdown (plans/19). Only blocks that were edited are written again;
// document.ts reads back whatever this writes before it is saved.

import { linkRuns, outerMark, toChars, type Block, type Ch, type Item, type Mark, type Span } from "./model";

const DELIM: Record<Mark, string> = { b: "**", i: "*", x: "~~" };
// What marked reads as a bare address: it runs to the next space, backslashes and all.
// (An address's local part is bounded: unbounded, a long word made this take seconds.)
const ADDRESS = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<\u0000]*|(?<![\w.+-])[\w.+-]{1,64}@[\w-]+(?:\.[\w-]+)+/gi;

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((x) => x.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(text) || (/^ [\s\S]* $/.test(text) && /\S/.test(text)) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Backslashes for the characters Markdown would read as syntax, one entry per character. */
function escaped(chars: Ch[], opts: InlineOptions): string[] {
  const plain = chars.map((ch) => (ch.code ? "\u0000" : ch.c));
  const inWord = (i: number) => /[\p{L}\p{N}]/u.test(plain[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(plain[i + 1] ?? "");
  const entity = (i: number) => /^&(#\w+|[a-zA-Z][a-zA-Z0-9]*);/.test(plain.slice(i, i + 36).join(""));
  const out = chars.map(({ c, code }, i) => {
    if (code) return c;
    if (c === "\n") return opts.cell ? "<br>" : "\\\n";
    if (opts.literal && /^[!-/:-@[-`{-~]$/.test(c)) return `\\${c}`;
    if ("\\`*[]<~|".includes(c)) return `\\${c}`;
    if (c === "#" && opts.heading) return "\\#";
    if (c === "_") return inWord(i) ? c : "\\_";
    if (c === "&") return entity(i) ? "\\&" : c;
    if (c === "!" && (i + 1 === chars.length || plain[i + 1] === "[" || chars[i + 1]!.href)) return "\\!";
    return c;
  });
  if (opts.literal) return out;
  if (!opts.cell) {
    // What only means something at the start of a line.
    for (let i = 0; i < chars.length; i++) {
      if (i && plain[i - 1] !== "\n") continue;
      let end = plain.indexOf("\n", i);
      if (end < 0) end = plain.length;
      const line = plain.slice(i, end).join("");
      const num = /^(\d{1,9})[.)](?=\s|$)/.exec(line);
      if (num) out[i + num[1]!.length] = `\\${plain[i + num[1]!.length]}`;
      else if (/^(#{1,6}(\s|$)|>|[-+](\s|$)|--|=+\s*$|-[-\s:]*$)/.test(line)) out[i] = `\\${plain[i]}`;
    }
  }

  // Underscores in a bare address stay bare; marked would read a backslash as part of it. An
  // address it still misreads is written again with `literal`.
  const at: number[] = []; // string offset → character (beyond the BMP a character takes two)
  plain.forEach((c, i) => {
    for (let k = 0; k < c.length; k++) at.push(i);
  });
  for (const m of plain.join("").matchAll(ADDRESS))
    for (let k = 0; k < m[0].length; k++) if (m[0][k] === "_") out[at[m.index! + k]!] = "_";
  return out;
}

/**
 * How to write a block when the plain way doesn't read back right. `literal`: a backslash before every
 * ASCII sign (ugly, and nothing in it can be read as syntax). `underscore`: italic as «_…_», so it
 * doesn't run into the «**» of bold beside it.
 */
export type Style = { literal?: boolean; underscore?: boolean };
type InlineOptions = { cell?: boolean; heading?: boolean } & Style;

export function writeInline(spans: Span[], opts: InlineOptions = {}): string {
  const chars = toChars(spans);
  const esc = escaped(chars, opts);
  const write = (from: number, to: number, open: Set<Mark>): string => {
    let s = "";
    for (let i = from; i < to; ) {
      const o = outerMark(chars, i, to, open);
      if (o) {
        const delim = o.m === "i" && opts.underscore ? "_" : DELIM[o.m];
        s += delim + write(i, o.end, new Set([...open, o.m])) + delim;
        i = o.end;
      } else if (chars[i]!.code) {
        let j = i;
        let text = "";
        while (j < to && chars[j]!.code && !outerMark(chars, j, to, open)) text += chars[j++]!.c;
        const span = codeSpan(text);
        s += opts.cell ? span.replace(/\|/g, "\\|") : span;
        i = j;
      } else s += esc[i++];
    }
    return s;
  };
  return linkRuns(chars)
    .map(([a, b]) => {
      const { href, title } = chars[a]!;
      const body = write(a, b, new Set());
      if (!href) return body;
      const target = opts.cell ? href.replace(/\|/g, "%7C") : href;
      return `[${body}](${target}${title ? ` "${title.replace(/["\\]/g, "\\$&")}"` : ""})`;
    })
    .join("");
}

const indent = (text: string, pad: string) => text.split("\n").map((l, i) => (i && l ? pad + l : l)).join("\n");

/** `alt`: the other bullet (or number sign), so two lists in a row stay two lists. */
export function writeBlock(b: Exclude<Block, { t: "keep" }>, alt = false, style: Style = {}): string {
  switch (b.t) {
    case "p":
      return writeInline(b.spans, style);
    case "h":
      return `${"#".repeat(b.level)} ${writeInline(b.spans, { heading: true, ...style })}`;
    case "hr":
      return "---";
    case "code": {
      const longest = Math.max(2, ...(b.text.match(/`{3,}/g) ?? []).map((x) => x.length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${b.lang}\n${b.text}${b.text ? "\n" : ""}${fence}`;
    }
    case "quote":
      return writeBlocks(b.blocks, false, style).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    case "table": {
      const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const rows = b.rows.map((r) => row(r.map((spans) => writeInline(spans, { cell: true, ...style }))));
      const rule = row(b.align.map((a) => (a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---")));
      return [rows[0], rule, ...rows.slice(1)].join("\n");
    }
    case "ul":
    case "ol":
    case "tl": {
      const loose = b.items.some((it) => it.blocks.filter((x) => x.t === "p").length > 1);
      return b.items
        .map((it: Item, i) => {
          const marker = b.t === "ol" ? `${b.start + i}${alt ? ")" : "."} ` : alt ? "* " : "- ";
          const box = b.t === "tl" ? `[${it.checked ? "x" : " "}] ` : "";
          return marker + box + indent(writeBlocks(it.blocks, true, style), " ".repeat(marker.length));
        })
        .join(loose ? "\n\n" : "\n");
    }
  }
}

export const listFamily = (b: Block | undefined) => (!b ? null : b.t === "ol" ? "ol" : b.t === "ul" || b.t === "tl" ? "ul" : null);

function writeBlocks(blocks: Block[], inItem: boolean, style: Style): string {
  let out = "";
  let alt = false;
  blocks.forEach((b, i) => {
    if (b.t === "keep") throw new Error("a kept part is only ever a top-level block");
    const prev = blocks[i - 1];
    const family = listFamily(b);
    alt = !!family && family === listFamily(prev) ? !alt : false;
    // A nested list right under its item's line. One numbered from other than 1 needs the blank line.
    const tight = inItem && prev?.t === "p" && (b.t === "ul" || b.t === "tl" || (b.t === "ol" && b.start === 1));
    // «- ---» would be a line, not an item.
    const md = !i && inItem && b.t === "hr" ? "***" : writeBlock(b, alt, style);
    out += (i ? (tight ? "\n" : "\n\n") : "") + md;
  });
  return out;
}
