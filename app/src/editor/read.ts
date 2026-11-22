// Markdown → the editor's blocks (plans/19), each with the exact source it came from. Uses the same
// parser as the preview (marked). What can't be shown faithfully is never guessed: see document.ts.

import { Lexer, Marked, type Token, type Tokens } from "marked";
import { safeHref, type Block, type Span } from "./model";

export class Unsupported extends Error {}

export const plainMarked = new Marked({ gfm: true, breaks: false, async: false });

/**
 * The preview without the links marked makes of bare addresses by itself: Word and PDF don't have
 * them, and where one ends depends on the backslashes around it.
 */
export const readerView = new Marked({ gfm: true, breaks: false, async: false });
readerView.use({ renderer: { link: (token) => (token.raw.startsWith("[") || token.raw.startsWith("<") ? false : token.raw.replace(/&/g, "&amp;").replace(/</g, "&lt;")) } });

export type Chunk = { start: number; end: number; token: Token | null };
export type Links = Record<string, { href: string; title: string }>;

/**
 * The document's top-level blocks and where each is in the source. marked's `raw` can't be used for
 * that (it drops link definitions and joins some blocks), so the lexer's position is recorded
 * before each block it reads. A chunk without a token is a link definition.
 */
export function chunksOf(src: string): { chunks: Chunk[]; links: Links } {
  const marks: { pos: number; count: number }[] = [];
  const m = new Marked({ gfm: true, breaks: false, async: false });
  m.use({
    extensions: [
      {
        name: "position",
        level: "block",
        tokenizer(rest, tokens) {
          if (tokens === (this.lexer.tokens as unknown)) marks.push({ pos: src.length - rest.length, count: tokens.length });
          return undefined;
        },
        renderer: () => false,
      },
    ],
  });
  const tokens = m.lexer(src);
  marks.push({ pos: src.length, count: tokens.length });
  const out: Chunk[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const { pos, count } = marks[i]!;
    const next = marks[i + 1]!;
    const text = src.slice(pos, next.pos);
    // A line of only a non-breaking space is a paragraph to marked: kept, not dropped as spacing.
    if (!/[^ \t\n]/.test(text)) continue;
    const lead = /^(?:[ \t]*\n)*/.exec(text)![0].length;
    let end = next.pos;
    while (end > pos && " \t\n".includes(src[end - 1]!)) end--;
    const start = pos + lead;
    if (next.count > count) {
      const token = tokens[count]!;
      if (token.type !== "space") out.push({ start, end, token });
    } else {
      const last = tokens[count - 1];
      const prev = out.at(-1);
      // Read into the paragraph before it (a lazy line); else a link definition.
      if (prev?.token && prev.token === last && (last.type === "paragraph" || last.type === "text")) prev.end = end;
      else out.push({ start, end, token: null });
    }
  }
  return { chunks: out, links: { ...(tokens.links as Links) } };
}

/** What one part shows when the document's link definitions are `links`. */
export function seenWith(raw: string, links: Links): string {
  const lexer = new Lexer({ gfm: true, breaks: false, async: false });
  Object.assign(lexer.tokens.links, links);
  return seen(readerView.parser(lexer.lex(raw)));
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lrm: "\u200e", rlm: "\u200f", zwj: "\u200d", zwnj: "\u200c", laquo: "«", raquo: "»", times: "×", deg: "°",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, name: string) => {
    if (name[0] !== "#") {
      if (!Object.hasOwn(NAMED, name)) throw new Unsupported(whole);
      return NAMED[name]!;
    }
    const n = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) || (n < 32 && n !== 9)) throw new Unsupported(whole);
    return String.fromCodePoint(n);
  });
}

const BR = /^<br\s*\/?>$/i;

/** Lines of a paragraph joined with one space (no regex: a long run of spaces made one take seconds). */
function joinLines(s: string): string {
  if (!s.includes("\n")) return s;
  const lines = s.split("\n");
  return lines.map((l, i) => {
    let a = 0;
    let b = l.length;
    if (i) while (a < b && (l[a] === " " || l[a] === "\t")) a++;
    if (i < lines.length - 1) while (b > a && (l[b - 1] === " " || l[b - 1] === "\t")) b--;
    return l.slice(a, b);
  }).join(" ");
}

function readInline(tokens: Token[] = [], f: Omit<Span, "s"> = {}): Span[] {
  return tokens.flatMap((token): Span[] => {
    const t = token as any;
    switch (t.type) {
      case "text":
        return t.tokens ? readInline(t.tokens, f) : [{ ...f, s: decodeEntities(joinLines(t.text)) }];
      case "escape":
        return [{ ...f, s: t.text }];
      case "strong":
        return readInline(t.tokens, { ...f, b: true });
      case "em":
        return readInline(t.tokens, { ...f, i: true });
      case "del":
        // A single «~» is strikethrough for marked only; Word and PDF print it as it is.
        return t.raw.startsWith("~~") ? readInline(t.tokens, { ...f, x: true }) : [{ ...f, s: "~" }, ...readInline(t.tokens, f), { ...f, s: "~" }];
      case "codespan":
        return [{ ...f, code: true, s: t.text }];
      case "br":
        return [{ s: "\n" }];
      case "html":
        if (BR.test(t.raw.trim())) return [{ s: "\n" }];
        break;
      case "link": {
        // A bare address is text (the exporters don't link it); the preview links it by itself.
        if (!t.raw.startsWith("[") && !t.raw.startsWith("<")) return [{ ...f, s: t.raw }];
        if (!safeHref(t.href) || f.href) break;
        const inner = readInline(t.tokens, { ...f, href: t.href, ...(t.title ? { title: decodeEntities(t.title) } : {}) });
        if (!inner.some((x) => x.code || x.s.trim())) break;
        return inner;
      }
    }
    throw new Unsupported(t.type);
  });
}

export function readBlock(token: Token): Block {
  const t = token as any;
  switch (t.type) {
    case "paragraph":
    case "text":
      return { t: "p", spans: t.tokens ? readInline(t.tokens) : [{ s: decodeEntities(t.text) }] };
    case "heading":
      return { t: "h", level: t.depth, spans: readInline(t.tokens) };
    case "hr":
      return { t: "hr" };
    case "code":
      return { t: "code", lang: t.lang ?? "", text: t.text };
    case "blockquote":
      return { t: "quote", blocks: readBlocks(t.tokens) };
    case "list": {
      const list = t as Tokens.List;
      const tasks = list.items.filter((it) => it.task).length;
      if (tasks && (tasks !== list.items.length || list.ordered)) break;
      const items = list.items.map((it) => ({ ...(tasks ? { checked: !!it.checked } : {}), blocks: readBlocks(it.tokens) }));
      return list.ordered ? { t: "ol", start: Number(list.start), items } : { t: tasks ? "tl" : "ul", items };
    }
    case "table": {
      const table = t as Tokens.Table;
      return { t: "table", align: table.align.map((a) => a ?? null), rows: [table.header, ...table.rows].map((r) => r.map((cell) => readInline(cell.tokens))) };
    }
  }
  throw new Unsupported(t.type);
}

export function readBlocks(tokens: Token[]): Block[] {
  return tokens.filter((t) => t.type !== "space" && t.type !== "checkbox").map(readBlock);
}

/**
 * What a reader sees, for checking that a block survives the editor: the structure, and every
 * character with its formatting. Runs of spaces count as one.
 */
export function seen(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let space = false;
  let text = false;
  let href = "";
  for (const part of html.split(/(<[^>]*>)/)) {
    if (!part) continue;
    const tag = /^<(\/)?([a-zA-Z][\w-]*)([^>]*)>$/.exec(part);
    if (tag) {
      const [, close, rawName, attrs] = tag;
      const name = rawName!.toLowerCase();
      if (["strong", "em", "del", "a"].includes(name) || (name === "code" && !open.includes("pre"))) {
        if (close) open.splice(open.lastIndexOf(name), 1);
        else open.push(name);
        if (name === "a") href = close ? "" : attrs!;
        continue;
      }
      if (name === "pre") {
        if (close) open.splice(open.lastIndexOf(name), 1);
        else open.push(name);
      }
      space = false;
      text = false;
      if (name === "p" || name === "thead" || name === "tbody") continue;
      out.push(`<${close ?? ""}${name}${close ? "" : attrs!.replace(/\s+/g, " ").trim()}>`);
      continue;
    }
    const pre = open.includes("pre");
    const format = `${["strong", "em", "del", "code"].filter((x) => open.includes(x)).join()}${href}`;
    let decoded: string;
    try {
      decoded = decodeEntities(part);
    } catch {
      decoded = part;
    }
    if (pre) {
      out.push(`pre:${decoded.replace(/\n+$/, "")}`);
      continue;
    }
    for (const c of decoded) {
      if (/[ \t\n]/.test(c)) {
        space = text;
        continue;
      }
      if (space) out.push(" ");
      space = false;
      text = true;
      out.push(`${c}${format}`);
    }
  }
  return out.join("\u0001");
}
