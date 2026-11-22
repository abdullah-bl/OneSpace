// The visual editor's document, between Markdown and Tiptap (plans/19): only what Markdown can say
// and the exporters can print. `clean` is the one normal form both sides are compared in.

import type { JSONContent } from "@tiptap/core";

export type Span = { s: string; b?: true; i?: true; x?: true; code?: true; href?: string; title?: string };
export type Align = "left" | "center" | "right" | null;
export type Item = { checked?: boolean; blocks: Block[] };
export type Block =
  | { t: "p"; spans: Span[] }
  | { t: "h"; level: number; spans: Span[] }
  | { t: "ul" | "tl"; items: Item[] }
  | { t: "ol"; start: number; items: Item[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "code"; lang: string; text: string }
  | { t: "hr" }
  | { t: "table"; align: Align[]; rows: Span[][][] }
  | { t: "keep"; id: string };

export type Mark = "b" | "i" | "x";
export const MARKS: Mark[] = ["b", "i", "x"];
/** One character with its formatting. "\n" is a line break. */
export type Ch = Omit<Span, "s"> & { c: string };

/** Links that may be clicked: web, mail, phone, in-app and relative. */
export function safeHref(href: string): boolean {
  const h = href.replace(/[\u0000-\u0020]/g, "");
  return !!h && (/^(https?:|mailto:|tel:)/i.test(h) || !/^[^/?#]*:/.test(h));
}

const cleanHref = (href: string) => href.trim().replace(/[\s()<>\\]/g, (c) => ({ "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", "\\": "%5C" })[c] ?? "%20");

export const toChars = (spans: Span[]): Ch[] => spans.flatMap(({ s, ...f }) => Array.from(s, (c) => ({ c, ...f })));

const sameFormat = (a: Omit<Span, "s">, b: Omit<Span, "s">) => a.b === b.b && a.i === b.i && a.x === b.x && a.code === b.code && a.href === b.href && a.title === b.title;

export function toSpans(chars: Ch[]): Span[] {
  const out: Span[] = [];
  for (const { c, ...f } of chars) {
    const last = out.at(-1);
    if (last && sameFormat(last, f)) {
      last.s += c;
      continue;
    }
    // Always the same key order, so spans compare as JSON.
    out.push({ s: c, ...(f.b && { b: f.b }), ...(f.i && { i: f.i }), ...(f.x && { x: f.x }), ...(f.code && { code: f.code }), ...(f.href && { href: f.href }), ...(f.title && { title: f.title }) });
  }
  return out;
}

export const isWord = (c: string | undefined) => !!c && !/[\s\p{P}\p{S}]/u.test(c);

/** The end of the run starting at `i` that has mark `m`. */
export function runEnd(chars: Ch[], i: number, to: number, m: Mark) {
  let j = i;
  while (j < to && chars[j]![m]) j++;
  return j;
}

/** Which mark to open at `i`: the one that runs furthest (so the others nest inside it). */
export function outerMark(chars: Ch[], i: number, to: number, open: Set<Mark>): { m: Mark; end: number } | null {
  let best: { m: Mark; end: number } | null = null;
  // On a tie strikethrough goes outside: if one has to give way it's the inner one, and a struck-out
  // amount must stay struck out.
  for (const m of ["x", "i", "b"] as Mark[]) {
    if (open.has(m) || !chars[i]![m]) continue;
    const end = runEnd(chars, i, to, m);
    if (!best || end > best.end) best = { m, end };
  }
  return best;
}

// marked counts these as letters beside emphasis: «~», and half of an emoji.
const joins = (c: string | undefined) => c === "~" || (c?.length ?? 0) > 1;

/**
 * Markdown can't open emphasis before a space, or before punctuation that follows a letter
 * («**المجموع:**150» isn't bold). Those edge characters lose that mark; the text never changes.
 * Returns whether it changed anything.
 */
function trimMarks(chars: Ch[], from: number, to: number, open: Set<Mark>): boolean {
  for (let i = from; i < to; ) {
    const o = outerMark(chars, i, to, open);
    if (!o) {
      i++;
      continue;
    }
    const first = chars[i]!;
    const last = chars[o.end - 1]!;
    const punct = (ch: Ch) => ch.code || !isWord(ch.c);
    const before = i > from && !chars[i - 1]!.code ? chars[i - 1]!.c : undefined;
    const after = o.end < to && !chars[o.end]!.code ? chars[o.end]!.c : undefined;
    if ((!first.code && /\s/.test(first.c)) || (punct(first) && (isWord(before) || joins(before) || (i > from && chars[i - 1]!.x)))) {
      delete first[o.m];
      return true;
    }
    if ((!last.code && /\s/.test(last.c)) || (punct(last) && (isWord(after) || joins(after) || (o.end < to && chars[o.end]!.x)))) {
      delete last[o.m];
      return true;
    }
    const inside = new Set([...open, o.m]);
    // Two marks glued to a word («10**~~50~~**»): marked takes it, Word's parser doesn't. The inner one gives way.
    const glued = (c: string | undefined) => isWord(c) || joins(c);
    if (glued(before)) {
      const inner = outerMark(chars, i, o.end, inside);
      if (inner) {
        for (let k = i; k < inner.end; k++) delete chars[k]![inner.m];
        return true;
      }
    }
    if (glued(after)) {
      const m = MARKS.find((x) => !inside.has(x) && last[x]);
      if (m) {
        for (let k = o.end - 1; k >= i && chars[k]![m]; k--) delete chars[k]![m];
        return true;
      }
    }
    if (trimMarks(chars, i, o.end, inside)) return true;
    i = o.end;
  }
  return false;
}

/** [from, to) of each run with the same link (or none). Emphasis never crosses a link's edge. */
export function linkRuns(chars: Ch[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < chars.length; ) {
    let j = i + 1;
    while (j < chars.length && chars[j]!.href === chars[i]!.href && chars[j]!.title === chars[i]!.title) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

const blank = (ch: Ch | undefined) => !!ch && !ch.code && (ch.c === " " || ch.c === "\n");
// At a line's or link's edge any space is dropped, the non-breaking one too, as Markdown does.
const edge = (ch: Ch | undefined) => !!ch && !ch.code && /^\s$/.test(ch.c);

export function cleanSpans(spans: Span[], oneLine = false, trim = true): Span[] {
  const out: Ch[] = [];
  for (const src of toChars(spans)) {
    const ch = { ...src };
    if (ch.href !== undefined) ch.href = cleanHref(ch.href);
    if (!ch.href) {
      delete ch.href;
      delete ch.title;
    }
    if (ch.code) {
      if (/[\r\n]/.test(ch.c)) ch.c = " ";
    } else {
      if (ch.c === "\t" || ch.c === "\r" || (oneLine && ch.c === "\n")) ch.c = " ";
      if (/^\s$/.test(ch.c) && (!out.length || out.at(-1)!.c === "\n")) continue; // none at a line's start
      if (ch.c === " " && blank(out.at(-1))) continue; // no double spaces
      if (ch.c === "\n") {
        if (!out.length) continue;
        while (out.length && out.at(-1)!.c !== "\n" && edge(out.at(-1))) out.pop();
        for (const m of MARKS) delete ch[m];
        delete ch.href;
        delete ch.title;
      }
    }
    out.push(ch);
  }
  while (out.length && edge(out.at(-1))) out.pop();
  // A link doesn't begin or end with a space.
  for (const [a, b] of linkRuns(out)) {
    if (!out[a]!.href) continue;
    let from = a;
    let to = b;
    while (from < to && edge(out[from])) from++;
    while (to > from && edge(out[to - 1])) to--;
    for (let i = a; i < b; i++) {
      if (i >= from && i < to) continue;
      delete out[i]!.href;
      delete out[i]!.title;
    }
  }
  if (trim) for (const [a, b] of linkRuns(out)) while (trimMarks(out, a, b, new Set()));
  return toSpans(out);
}

/**
 * The normal form: no empty paragraphs, first table row is the header, emphasis Markdown can write.
 * `trim: false` leaves emphasis as it was, to tell whether the normal form dropped some (and empty
 * task items, which can't be written).
 */
export function clean(blocks: Block[], opts: { trim?: boolean; inside?: boolean } = {}): Block[] {
  const trim = opts.trim ?? true;
  const deeper = { trim, inside: true };
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.t === "p" || b.t === "h") {
      const spans = cleanSpans(b.spans, b.t === "h", trim);
      if (spans.length) out.push(b.t === "p" ? { t: "p", spans } : { t: "h", level: Math.min(6, Math.max(1, b.level)), spans });
    } else if (b.t === "ul" || b.t === "ol" || b.t === "tl") {
      const items = b.items
        .map((it) => ({ ...(b.t === "tl" ? { checked: !!it.checked } : {}), blocks: clean(it.blocks, deeper) }))
        // An empty bullet or number is Markdown («-»); an empty task isn't.
        .filter((it) => it.blocks.length || b.t !== "tl" || !trim);
      if (!items.some((it) => it.blocks.length)) continue;
      // A list number has at most nine digits, the last item's too.
      out.push(b.t === "ol" ? { t: "ol", start: Math.min(1_000_000_000 - items.length, Math.max(0, Math.floor(b.start) || 0)), items } : { t: b.t, items });
    } else if (b.t === "quote") {
      const inner = clean(b.blocks, deeper);
      if (inner.length) out.push({ t: "quote", blocks: inner });
    } else if (b.t === "code") {
      // Inside a list or quote marked reads a tab as spaces.
      const text = b.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      out.push({ t: "code", lang: (b.lang.trim().split(/\s/)[0] ?? "").replace(/`/g, ""), text: opts.inside ? text.replace(/\t/g, "    ") : text });
    } else if (b.t === "table") {
      const width = Math.max(0, ...b.rows.map((r) => r.length));
      if (!width) continue;
      out.push({
        t: "table",
        align: Array.from({ length: width }, (_, i) => b.align[i] ?? null),
        rows: b.rows.map((r) => Array.from({ length: width }, (_, i) => cleanSpans(r[i] ?? [], false, trim))),
      });
    } else out.push(b.t === "keep" ? { t: "keep", id: b.id } : { t: "hr" });
  }
  return out;
}

// ---------------------------------------------------------------- Tiptap

function inlineJson(spans: Span[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const { s, ...f } of spans) {
    const marks: NonNullable<JSONContent["marks"]> = [];
    if (f.href) marks.push({ type: "link", attrs: { href: f.href, title: f.title ?? null } });
    if (f.b) marks.push({ type: "bold" });
    if (f.i) marks.push({ type: "italic" });
    if (f.x) marks.push({ type: "strike" });
    if (f.code) marks.push({ type: "code" });
    s.split("\n").forEach((text, i) => {
      if (i) out.push({ type: "hardBreak" });
      if (text) out.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
    });
  }
  return out;
}

const para = (spans: Span[]): JSONContent => ({ type: "paragraph", ...(spans.length ? { content: inlineJson(spans) } : {}) });

export function blockJson(b: Block): JSONContent {
  switch (b.t) {
    case "p":
      return para(b.spans);
    case "h":
      return { type: "heading", attrs: { level: b.level }, content: inlineJson(b.spans) };
    case "ul":
    case "ol":
    case "tl":
      return {
        type: b.t === "ul" ? "bulletList" : b.t === "ol" ? "orderedList" : "taskList",
        ...(b.t === "ol" ? { attrs: { start: b.start } } : {}),
        content: b.items.map((it) => ({
          type: b.t === "tl" ? "taskItem" : "listItem",
          ...(b.t === "tl" ? { attrs: { checked: !!it.checked } } : {}),
          // An item starts with a paragraph in the editor, even when it only holds a list.
          content: [...(it.blocks[0]?.t === "p" ? [] : [para([])]), ...it.blocks.map(blockJson)],
        })),
      };
    case "quote":
      return { type: "blockquote", content: b.blocks.map(blockJson) };
    case "code":
      return { type: "codeBlock", attrs: { language: b.lang || null }, ...(b.text ? { content: [{ type: "text", text: b.text }] } : {}) };
    case "hr":
      return { type: "horizontalRule" };
    case "keep":
      return { type: "keep", attrs: { id: b.id } };
    case "table":
      return {
        type: "table",
        content: b.rows.map((row, r) => ({
          type: "tableRow",
          content: row.map((spans, c) => ({ type: r === 0 ? "tableHeader" : "tableCell", attrs: { align: b.align[c] ?? null }, content: [para(spans)] })),
        })),
      };
  }
}

export const docJson = (blocks: Block[]): JSONContent => ({ type: "doc", content: blocks.length ? blocks.map(blockJson) : [para([])] });

function inlineFrom(nodes: JSONContent[] = []): Span[] {
  return nodes.map((n): Span => {
    if (n.type === "hardBreak") return { s: "\n" };
    if (n.type !== "text") throw new Error(`unknown inline: ${n.type}`);
    const span: Span = { s: n.text ?? "" };
    for (const m of n.marks ?? []) {
      if (m.type === "bold") span.b = true;
      else if (m.type === "italic") span.i = true;
      else if (m.type === "strike") span.x = true;
      else if (m.type === "code") span.code = true;
      else if (m.type === "link") {
        if (m.attrs?.href && safeHref(String(m.attrs.href))) {
          span.href = String(m.attrs.href);
          if (m.attrs.title) span.title = String(m.attrs.title);
        }
      } else throw new Error(`unknown mark: ${m.type}`);
    }
    return span;
  });
}

/** Throws on a node it doesn't know: saving must never skip content. */
export function blocksFrom(nodes: JSONContent[] = []): Block[] {
  return nodes.map((n): Block => {
    const kids = n.content ?? [];
    switch (n.type) {
      case "paragraph":
        return { t: "p", spans: inlineFrom(kids) };
      case "heading":
        return { t: "h", level: Number(n.attrs?.level ?? 1), spans: inlineFrom(kids) };
      case "bulletList":
        return { t: "ul", items: kids.map((it) => ({ blocks: blocksFrom(it.content) })) };
      case "orderedList":
        return { t: "ol", start: Number(n.attrs?.start ?? 1), items: kids.map((it) => ({ blocks: blocksFrom(it.content) })) };
      case "taskList":
        return { t: "tl", items: kids.map((it) => ({ checked: !!it.attrs?.checked, blocks: blocksFrom(it.content) })) };
      case "blockquote":
        return { t: "quote", blocks: blocksFrom(kids) };
      case "codeBlock":
        return { t: "code", lang: String(n.attrs?.language ?? ""), text: kids.map((k) => k.text ?? "").join("") };
      case "horizontalRule":
        return { t: "hr" };
      case "keep":
        return { t: "keep", id: String(n.attrs?.id ?? "") };
      case "table": {
        const align = (kids[0]?.content ?? []).map((c) => (["left", "center", "right"].includes(c.attrs?.align) ? (c.attrs!.align as Align) : null));
        const rows = kids.map((row) =>
          (row.content ?? []).flatMap((cell) => {
            const spans = (cell.content ?? []).flatMap((p, i) => [...(i ? [{ s: "\n" }] : []), ...inlineFrom(p.content)]);
            // A merged cell (pasted from Word) keeps its place: Markdown has no merging.
            return [spans, ...Array.from({ length: Math.max(0, Number(cell.attrs?.colspan ?? 1) - 1) }, (): Span[] => [])];
          }),
        );
        return { t: "table", align, rows };
      }
    }
    throw new Error(`unknown block: ${n.type}`);
  });
}
