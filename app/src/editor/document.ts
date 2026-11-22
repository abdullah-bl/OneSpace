// Opening and saving a Markdown document in the visual editor (plans/19). Three promises:
//   1. what wasn't edited is saved byte for byte as it was;
//   2. what the editor can't show faithfully is shown locked, and saved as it was, never dropped;
//   3. whatever is saved was read back first and says what the editor showed, or it isn't saved.

import type { JSONContent } from "@tiptap/core";
import { blocksFrom, clean, docJson, toSpans, toChars, type Block, type Span } from "./model";
import { chunksOf, plainMarked, readBlock, readBlocks, readerView, seen, seenWith, type Links } from "./read";
import { listFamily, writeBlock, type Style } from "./write";

type Family = "ul" | "ol" | null;
type Part = { id: string; raw: string; start: number; end: number; block: Block; key: string; family: Family; sign: string | null };

export type OpenDocument = {
  /** Exactly what was opened. */
  source: string;
  /** With "\n" line endings. */
  text: string;
  /** Offset in `text` → offset in `source` (they differ only where a line ended in "\r\n" or "\r"). */
  at: number[] | null;
  parts: Part[];
  json: JSONContent;
  /** The source of each locked part, by its id. */
  kept: Map<string, string>;
  /** The link definitions of the whole document, which locked parts may use. */
  links: Links;
};

export class SaveError extends Error {}

const key = (b: Block) => JSON.stringify(b);

/** The block this Markdown reads as, if it is exactly one. */
function readsAs(md: string): Block | null {
  try {
    const got = clean(readBlocks(plainMarked.lexer(md)));
    return got.length === 1 ? got[0]! : null;
  } catch {
    return null;
  }
}

/** Link definitions inside a list or quote: marked reads them and then shows nothing for them. */
function hidesDefinitions(raw: string, type: string): boolean {
  if (type !== "list" && type !== "blockquote") return false;
  const lexer = new plainMarked.Lexer();
  lexer.lex(raw);
  return Object.keys(lexer.tokens.links).length > 0;
}

/** A list's family and the sign it uses («-», «*», «.», «)»), so a list written next to it stays apart. */
function listSign(token: { type: string; ordered?: boolean; raw: string } | null): { family: Family; sign: string | null } {
  if (token?.type !== "list") return { family: null, sign: null };
  const sign = token.ordered ? /^[ \t]*\d+([.)])/.exec(token.raw)?.[1] : /^[ \t]*([-*+])/.exec(token.raw)?.[1];
  return { family: token.ordered ? "ol" : "ul", sign: sign ?? null };
}

let opened = 0;

export function openDocument(source: string): OpenDocument {
  const text = source.replace(/\r\n?/g, "\n");
  let at: number[] | null = null;
  if (text.length !== source.length || source.includes("\r")) {
    at = new Array<number>(text.length + 1);
    let j = 0;
    for (let i = 0; i < text.length; i++) {
      at[i] = j;
      j += source[j] === "\r" && source[j + 1] === "\n" ? 2 : 1;
    }
    at[text.length] = source.length;
  }
  const doc = `${Date.now().toString(36)}-${++opened}`;
  const kept = new Map<string, string>();
  const { chunks, links } = chunksOf(text);
  const parts = chunks.map(({ start, end, token }, i): Part => {
    const id = `${doc}-${i}`;
    const raw = text.slice(start, end);
    const sign = listSign(token as any);
    if (token && !hidesDefinitions(raw, token.type)) {
      try {
        const got = clean([readBlock(token)]);
        if (got.length === 1) {
          const block = got[0]!;
          const w = writeChecked(block as Exclude<Block, { t: "keep" }>, false);
          // Editable only if writing it again says the same, to the reader too.
          if (!w.lossy && seen(readerView.parser([token])) === seen(readerView.parse(w.md) as string)) return { id, raw, start, end, block, key: key(block), ...sign };
        }
      } catch {
        // something the editor has no way to show: locked below
      }
    }
    kept.set(id, raw);
    const block: Block = { t: "keep", id };
    return { id, raw, start, end, block, key: key(block), ...sign };
  });
  return { source, text, at, parts, kept, links, json: docJson(parts.map((p) => p.block)) };
}

function mapSpans(b: Block, f: (spans: Span[]) => Span[]): Block {
  switch (b.t) {
    case "p":
    case "h":
      return { ...b, spans: f(b.spans) };
    case "ul":
    case "tl":
    case "ol":
      return { ...b, items: b.items.map((it) => ({ ...it, blocks: it.blocks.map((x) => mapSpans(x, f)) })) };
    case "quote":
      return { ...b, blocks: b.blocks.map((x) => mapSpans(x, f)) };
    case "table":
      return { ...b, rows: b.rows.map((r) => r.map(f)) };
  }
  return b;
}

const without = (b: Block, marks: ("b" | "i" | "x" | "code" | "href" | "title")[]): Block =>
  mapSpans(b, (spans) =>
    toSpans(
      toChars(spans).map((ch) => {
        const c = { ...ch };
        for (const m of marks) delete c[m];
        return c;
      }),
    ),
  );

/** Empty bullets and numbers dropped: the last resort before giving up on a list. */
function withoutEmptyItems(b: Block): Block {
  if (b.t === "ul" || b.t === "ol" || b.t === "tl") return { ...b, items: b.items.filter((it) => it.blocks.length).map((it) => ({ ...it, blocks: it.blocks.map(withoutEmptyItems) })) };
  if (b.t === "quote") return { ...b, blocks: b.blocks.map(withoutEmptyItems) };
  return b;
}

// Three or more «*» with something on both sides: marked and Word's parser read it differently (the
// rule of three). Escaped signs count as ordinary characters.
const RISKY_EMPHASIS = /(?<=\S)\*{3,}(?=\S)|\*~~\*|__|_\*|\*_/;

type Written = { md: string; block: Block; lossy: boolean };
const STYLES: Style[] = [{}, { literal: true }, { underscore: true }, { underscore: true, literal: true }];

/**
 * Writes one block so it reads back the same: plainly, else with every sign escaped, else with less
 * formatting. Never less text.
 */
function writeChecked(block: Exclude<Block, { t: "keep" }>, alt: boolean): Written {
  const tries: Block[] = [block, withoutEmptyItems(block), without(block, ["i"]), without(block, ["b", "i", "x"]), withoutEmptyItems(without(block, ["b", "i", "x", "code", "href", "title"]))];
  for (const [n, candidate] of tries.entries()) {
    const want = clean([candidate]);
    if (want.length !== 1) continue;
    for (const style of STYLES) {
      const md = writeBlock(want[0] as Exclude<Block, { t: "keep" }>, alt, style);
      if (RISKY_EMPHASIS.test(md.replace(/\\./g, "x"))) continue;
      const back = readsAs(md);
      // An empty bullet given up costs no words: not asked about.
      if (back && key(back) === key(want[0]!)) return { md, block: want[0]!, lossy: n > 1 };
    }
  }
  throw new SaveError(STUCK);
}

const STUCK = "تعذّر حفظ المستند من المحرر بشكل سليم، ولم يُحفظ شيء. افتح «نص Markdown» من قائمة «المزيد» لترى النص وتصلحه.";

/** Whether the editor still holds exactly what was opened (formatting it would have to drop counts as a change). */
export function unchanged(open: OpenDocument, json: JSONContent): boolean {
  const blocks = clean(blocksFrom(json.content), { trim: false });
  return blocks.length === open.parts.length && blocks.every((b, i) => key(b) === open.parts[i]!.key);
}

/** The longest run of `a` kept in order in `b` (indexes into b, or -1), for a stretch small enough to compare all of. */
function lcs(a: string[], b: string[], aFrom: number, aTo: number, bFrom: number, bTo: number, found: number[]) {
  const n = aTo - aFrom;
  const m = bTo - bFrom;
  if (!n || !m || n * m > 4_000_000) return;
  const w = m + 1;
  const best = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      best[i * w + j] = a[aFrom + i] === b[bFrom + j] ? best[(i + 1) * w + j + 1]! + 1 : Math.max(best[(i + 1) * w + j]!, best[i * w + j + 1]!);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[aFrom + i] === b[bFrom + j]) {
      found[aFrom + i] = bFrom + j;
      i++;
      j++;
    } else if (best[(i + 1) * w + j]! >= best[i * w + j + 1]!) i++;
    else j++;
  }
}

/**
 * For each edited block, the original part it still is, or -1. Blocks that appear once on both
 * sides anchor the match (so a long document edited in several places still matches), and the
 * stretches between anchors are compared fully.
 */
function matchParts(blocks: string[], parts: string[]): number[] {
  const found = new Array<number>(blocks.length).fill(-1);
  const count = (xs: string[]) => xs.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const inBlocks = count(blocks);
  const inParts = count(parts);
  const where = new Map<string, number>();
  parts.forEach((k, j) => inParts.get(k) === 1 && where.set(k, j));
  // Unique on both sides, in order: the longest increasing run of their places (patience sorting).
  const pairs = blocks.flatMap((k, i) => (inBlocks.get(k) === 1 && where.has(k) ? [[i, where.get(k)!] as const] : []));
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length).fill(-1);
  pairs.forEach(([, j], p) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo) prev[p] = tails[lo - 1]!;
    tails[lo] = p;
  });
  const anchors: (readonly [number, number])[] = [];
  for (let p = tails.at(-1) ?? -1; p >= 0; p = prev[p]!) anchors.unshift(pairs[p]!);
  let a = 0;
  let b = 0;
  for (const [i, j] of [...anchors, [blocks.length, parts.length] as const]) {
    // Equal neighbours at the stretch's edges first, then the rest.
    let s = a;
    let t = b;
    while (s < i && t < j && blocks[s] === parts[t]) found[s++] = t++;
    let e = i;
    let f = j;
    while (e > s && f > t && blocks[e - 1] === parts[f - 1]) found[--e] = --f;
    lcs(blocks, parts, s, e, t, f, found);
    if (i < blocks.length) found[i] = j;
    a = i + 1;
    b = j + 1;
  }
  return found;
}

type Piece = { md: string; source: string; block: Block; at: number; family: Family; sign: string | null };

/** The pieces as one text: the original spacing where neighbours were neighbours, else a blank line. */
function assemble(open: OpenDocument, pieces: Piece[], eol: string): { text: string; source: string } {
  const { parts, text, source, at } = open;
  const fromSource = (a: number, b: number) => (at ? source.slice(at[a], at[b]) : source.slice(a, b));
  let out = "";
  let original = "";
  const gap = (s: string, src: string) => {
    out += s;
    original += src;
  };
  pieces.forEach((p, i) => {
    const prev = pieces[i - 1];
    if (!prev) {
      if (p.at === 0) gap(text.slice(0, parts[0]!.start), fromSource(0, parts[0]!.start));
    } else if (prev.at >= 0 && p.at === prev.at + 1) gap(text.slice(parts[prev.at]!.end, parts[p.at]!.start), fromSource(parts[prev.at]!.end, parts[p.at]!.start));
    else gap("\n\n", eol + eol);
    gap(p.md, p.source);
  });
  if (pieces.length) {
    if (parts.length) gap(text.slice(parts.at(-1)!.end), fromSource(parts.at(-1)!.end, text.length));
    else gap("\n", eol);
  }
  return { text: out, source: original };
}

/** The line ending the document mostly uses, for what is written new. */
function lineEnding(source: string): string {
  const crlf = source.match(/\r\n/g)?.length ?? 0;
  const cr = source.match(/\r(?!\n)/g)?.length ?? 0;
  const lf = source.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > lf && crlf >= cr ? "\r\n" : cr > lf ? "\r" : "\n";
}

function planPieces(open: OpenDocument, blocks: Block[], match: number[], spacing: boolean, mayReuse: (b: Block) => boolean, write: (b: Exclude<Block, { t: "keep" }>, alt: boolean) => Written, eol: string) {
  const { parts, kept } = open;
  const place = placesOf(match, parts.length);
  const fromSource = (p: Part) => (open.at ? open.source.slice(open.at[p.start], open.at[p.end]) : p.raw);
  const pieces: Piece[] = [];
  let lossy = false;
  blocks.forEach((b, i) => {
    const part = match[i]! >= 0 ? parts[match[i]!]! : null;
    if (b.t === "keep") {
      const own = parts.find((p) => p.id === b.id)!;
      pieces.push({ md: kept.get(b.id)!, source: fromSource(own), block: b, at: match[i]!, family: own.family, sign: own.sign });
      return;
    }
    if (part && mayReuse(b)) {
      pieces.push({ md: part.raw, source: fromSource(part), block: b, at: match[i]!, family: part.family, sign: part.sign });
      return;
    }
    let alt = false;
    const family = listFamily(b);
    if (family) {
      // Next to a list of its kind it takes the other sign, or the two would read as one.
      const prev = pieces.at(-1);
      const nextBlock = blocks[i + 1];
      const nextPart = nextBlock && match[i + 1]! >= 0 && (nextBlock.t === "keep" || mayReuse(nextBlock)) ? parts[match[i + 1]!]! : null;
      const usual = family === "ul" ? "-" : ".";
      const near = prev?.family === family ? prev.sign : nextPart?.family === family ? nextPart.sign : null;
      alt = near === usual;
    }
    const w = write(b, alt);
    lossy ||= w.lossy;
    const md = w.md;
    pieces.push({ md, source: md.replace(/\n/g, eol), block: w.block, at: spacing ? place[i]! : -1, family, sign: family ? (family === "ul" ? (alt ? "*" : "-") : alt ? ")" : ".") : null });
  });
  return { pieces, lossy };
}

/**
 * The document as edited, as Markdown. `lossy`: some formatting couldn't be written (the caller
 * asks before saving). Throws SaveError rather than returning Markdown that says something else.
 */
export function saveDocument(open: OpenDocument, json: JSONContent): { markdown: string; lossy: boolean } {
  const { parts, kept } = open;
  const asTyped = clean(blocksFrom(json.content), { trim: false });
  const blocks = clean(asTyped);
  for (const b of blocks) if (b.t === "keep" && !kept.has(b.id)) throw new SaveError("جزء محفوظ من مستند آخر لا يمكن لصقه هنا");
  // Formatting Markdown can't open where it was put (bold glued to a sign) gives way: asked first.
  const trimmed = asTyped.length !== blocks.length || asTyped.some((b, i) => key(b) !== key(blocks[i]!));
  const keys = blocks.map(key);
  const match = matchParts(keys, parts.map((p) => p.key));
  if (match.length === parts.length && match.every((p, i) => p === i)) return { markdown: open.source, lossy: trimmed };

  const eol = lineEnding(open.source);
  // First with all that's unchanged as it was, spacing too; then, if neighbours change each other's
  // meaning (two lists meeting, a deleted link definition), with more of it written again.
  const attempts = [
    { spacing: true, mayReuse: () => true },
    { spacing: false, mayReuse: () => true },
    { spacing: false, mayReuse: (b: Block) => !listFamily(b) },
    { spacing: false, mayReuse: () => false },
  ];
  for (const { spacing, mayReuse } of attempts) {
    const { pieces, lossy } = planPieces(open, blocks, match, spacing, mayReuse, writeChecked, eol);
    const out = assemble(open, pieces, eol);
    if (saysTheSame(open, out.text, pieces.map((p) => p.block))) return { markdown: out.source, lossy: lossy || trimmed };
  }
  throw new SaveError(STUCK);
}

/**
 * The document as edited, written without the checks: only to show someone its source when the
 * editor can't save it, so they can fix it by hand. Never saved as it is.
 */
export function draftSource(open: OpenDocument, json: JSONContent): string {
  const blocks = clean(blocksFrom(json.content)).filter((b) => b.t !== "keep" || open.kept.has(b.id));
  const match = matchParts(blocks.map(key), open.parts.map((p) => p.key));
  const eol = lineEnding(open.source);
  const { pieces } = planPieces(open, blocks, match, true, () => true, (b, alt) => ({ md: writeBlock(b, alt), block: b, lossy: false }), eol);
  return assemble(open, pieces, eol).source;
}

/** Where each block sits among the original parts: as many edited in a gap as were there take their places (and spacing). */
function placesOf(match: number[], count: number): number[] {
  const place = [...match];
  for (let i = 0; i < match.length; ) {
    if (match[i]! >= 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < match.length && match[j]! < 0) j++;
    const from = i ? match[i - 1]! + 1 : 0;
    const to = j < match.length ? match[j]! : count;
    if (to - from === j - i) for (let k = i; k < j; k++) place[k] = from + k - i;
    i = j;
  }
  return place;
}

function saysTheSame(open: OpenDocument, md: string, want: Block[]): boolean {
  const got = openDocument(md);
  if (got.parts.length !== want.length) return false;
  return got.parts.every((p, i) => {
    const w = want[i]!;
    if (w.t !== "keep") return p.key === key(w);
    const raw = open.kept.get(w.id)!;
    // Same bytes, and the same to a reader: a link definition it used may have been deleted.
    return p.raw.trim() === raw.trim() && seenWith(raw, open.links) === seenWith(raw, got.links);
  });
}
