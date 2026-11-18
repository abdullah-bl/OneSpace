// Structural chunking (plans/03-rag.md §1): by the document's own structure — part › chapter ›
// article › paragraph — not by character count. A short article is one chunk, a long one is split
// on sentence boundaries with overlap, and a table is never cut in the middle (a huge one is cut
// between rows, repeating its header row). Every chunk starts with a context line
// `[document | part › article | p. 8]`, which is also where a citation's section and page come from.

export type Block =
  | { kind: "heading"; level: number; text: string; page?: number }
  | { kind: "para" | "table"; text: string; page?: number };

export type Chunk = {
  ordinal: number;
  /** Context line + body: what is embedded, searched and shown. */
  text: string;
  section?: string;
  page?: number;
  pageEnd?: number;
};

export type ChunkOptions = { maxChars?: number; overlap?: number };

const HEADING_WORDS: [RegExp, number][] = [
  [/^(الباب|باب)\s/, 1],
  [/^(الفصل|فصل|القسم|الفرع)\s/, 2],
  [/^(المادة|مادة|البند|بند)\s*(\(|[0-9]|[ء-ي])/, 3],
  [/^(part|chapter)\s/i, 1],
  [/^(section|article)\s/i, 3],
];

/** Heading level of a plain line (markdown `#`, or "الباب/الفصل/المادة …"), or 0 when it's body text. */
export function headingLevel(line: string): number {
  const t = line.trim();
  const md = /^(#{1,6})\s+\S/.exec(t);
  if (md) return md[1]!.length;
  if (t.length > 90 || /[.!؟?،:]$/.test(t) && !/:$/.test(t)) return 0;
  for (const [re, level] of HEADING_WORDS) if (re.test(t)) return level;
  return 0;
}

/** Turns plain text (one page or a whole text file) into blocks: headings, paragraphs and pipe tables. */
export function textToBlocks(text: string, page?: number): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let table: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ").trim(), page });
    para = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push({ kind: "table", text: table.join("\n"), page });
    table = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushTable();
      continue;
    }
    if (/^\|.*\|$/.test(line) || (line.split("\t").length > 2)) {
      flushPara();
      if (!/^\|?\s*:?-{2,}/.test(line)) table.push(line.replace(/\t/g, " | "));
      continue;
    }
    flushTable();
    const level = headingLevel(line);
    if (level) {
      flushPara();
      blocks.push({ kind: "heading", level, text: line.replace(/^#+\s*/, ""), page });
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushTable();
  return blocks.filter((b) => b.text);
}

/** Splits text into sentences (Arabic and Latin punctuation). */
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!؟?؛;])\s+|\n+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Cuts one long paragraph into pieces of ≤ max chars on sentence boundaries, sharing ~overlap chars. */
function splitLong(text: string, max: number, overlap: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let s of sentences(text)) {
    while (s.length > max) {
      // A "sentence" longer than max (no punctuation): cut on a space.
      const cut = s.lastIndexOf(" ", max) > max / 2 ? s.lastIndexOf(" ", max) : max;
      if (cur) out.push(cur), (cur = "");
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      const tail = cur.length > overlap ? cur.slice(cur.lastIndexOf(" ", cur.length - overlap) + 1) : cur;
      cur = tail.length < max / 2 ? `${tail} ${s}` : s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Splits a big table between rows, repeating its first (header) row in every piece. */
function splitTable(text: string, max: number): string[] {
  const rows = text.split("\n");
  if (text.length <= max || rows.length < 3) return [text];
  const [head, ...rest] = rows;
  const out: string[] = [];
  let cur: string[] = [];
  let len = head!.length;
  for (const r of rest) {
    if (cur.length && len + r.length + 1 > max) {
      out.push([head, ...cur].join("\n"));
      cur = [];
      len = head!.length;
    }
    cur.push(r);
    len += r.length + 1;
  }
  if (cur.length) out.push([head, ...cur].join("\n"));
  return out;
}

function header(title: string, section: string | undefined, page?: number, pageEnd?: number) {
  const parts = [title];
  if (section) parts.push(section);
  if (page) parts.push(pageEnd && pageEnd !== page ? `ص ${page}–${pageEnd}` : `ص ${page}`);
  return `[${parts.join(" | ")}]`;
}

/** Structural chunks for a document. `title` is the document name shown in every context line. */
export function chunkBlocks(title: string, blocks: Block[], opts: ChunkOptions = {}): Chunk[] {
  const max = opts.maxChars ?? 1200;
  const overlap = opts.overlap ?? 150;
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let body: { text: string; page?: number }[] = [];

  const emit = (pieces: { text: string; page?: number; pageEnd?: number }[]) => {
    const section = path.filter(Boolean).join(" › ") || undefined;
    for (const p of pieces) {
      chunks.push({ ordinal: chunks.length, text: `${header(title, section, p.page, p.pageEnd)}\n${p.text}`, section, page: p.page, pageEnd: p.pageEnd });
    }
  };

  const flush = () => {
    if (!body.length) return;
    const pieces: { text: string; page?: number; pageEnd?: number }[] = [];
    let cur: { parts: string[]; page?: number; pageEnd?: number; len: number } = { parts: [], len: 0 };
    const push = () => {
      if (cur.parts.length) pieces.push({ text: cur.parts.join("\n"), page: cur.page, pageEnd: cur.pageEnd });
      cur = { parts: [], len: 0 };
    };
    const add = (text: string, page?: number) => {
      if (cur.len && cur.len + text.length + 1 > max) push();
      if (!cur.parts.length) cur.page = page;
      cur.pageEnd = page ?? cur.pageEnd;
      cur.parts.push(text);
      cur.len += text.length + 1;
    };
    for (const b of body) {
      if (b.text.length <= max) add(b.text, b.page);
      else {
        push();
        const isTable = b.text.includes(" | ") && b.text.includes("\n");
        const parts = isTable ? splitTable(b.text, max) : splitLong(b.text, max, overlap);
        for (const p of parts) {
          add(p, b.page);
          push();
        }
      }
    }
    push();
    emit(pieces);
    body = [];
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      flush();
      const level = Math.max(1, Math.min(6, b.level));
      path.length = level - 1;
      for (let i = 0; i < level - 1; i++) path[i] ??= "";
      path[level - 1] = b.text.trim();
      continue;
    }
    body.push({ text: b.text, page: b.page });
  }
  flush();
  return chunks;
}
