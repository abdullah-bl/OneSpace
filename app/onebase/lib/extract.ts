// Text extraction per file type (plans/03-rag.md §1). Uses the poppler CLI tools (pdftotext,
// pdftoppm, pdfinfo) and unzip, which are installed on the server, so there is no npm dependency:
//   - text PDF: pdftotext per page, page numbers kept, repeated headers/footers removed
//   - scanned PDF / image: page → PNG → vision model (OCR), file marked "OCR"; ingest.ts reads a
//     PDF's scanned pages in batches first (scannedPdfPages + ocrPdfPages) and passes them in
//   - Word .docx: headings (styles) and tables kept; page numbers from Word's rendered page breaks
//   - Excel .xlsx / CSV: described (sheets, columns, row count), not chunked as text
//   - .doc/.xls/.odt/.rtf: converted with LibreOffice first

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDisplay } from "./arabic";
import { headingLevel, textToBlocks, type Block } from "./chunk";

/** Written by us into a spreadsheet's indexed text, so it is not shown to the guard (decisions.ts). */
export const SHEET_NOTE = "محتواه لا يُقرأ كنص؛ يُحلَّل بأداة أو في الساندبوكس.";

export type Kind = "pdf" | "docx" | "sheet" | "text" | "image" | "unsupported";

export type Extracted = {
  kind: Kind;
  blocks: Block[];
  pages?: number;
  /** Pages read by the vision model (lower accuracy: the file is marked "OCR"). */
  ocrPages: number[];
  note?: string;
};

/** Reads one page image (a data: URL) with the vision model and returns its text as Markdown. */
export type OcrFn = (imageDataUrl: string, page: number) => Promise<string>;

export function kindOf(name: string, mime: string): Kind | "convert" {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx" || mime.includes("wordprocessingml")) return "docx";
  if (ext === "xlsx" || ext === "csv" || mime.includes("spreadsheetml") || mime === "text/csv") return "sheet";
  if (["doc", "odt", "rtf", "xls", "ods"].includes(ext) || mime === "application/msword" || mime === "application/vnd.ms-excel") return "convert";
  if (/^image\/(png|jpeg|webp|gif|tiff)/.test(mime) || ["png", "jpg", "jpeg", "webp", "tif", "tiff"].includes(ext)) return "image";
  if (mime.startsWith("text/") || ["txt", "md", "markdown", "html", "htm", "json", "xml"].includes(ext)) return "text";
  return "unsupported";
}

async function run(cmd: string[], timeoutMs = 120_000, env?: Record<string, string>): Promise<{ code: number; out: Uint8Array; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: new Uint8Array(out), err };
}

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

async function unzipEntry(file: string, entry: string): Promise<string | null> {
  const r = await run(["unzip", "-p", file, entry], 60_000);
  return r.code === 0 && r.out.length ? utf8(r.out) : null;
}

// ---------------------------------------------------------------- PDF

/** Lines that repeat at the top/bottom of most pages (running headers, footers, page numbers). */
function repeatedEdgeLines(pages: string[]): Set<string> {
  const key = (l: string) => normalizeDisplay(l).replace(/[0-9]+/g, "#");
  const counts = new Map<string, number>();
  for (const p of pages) {
    const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
    const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(key));
    for (const k of edges) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const min = Math.max(2, Math.ceil(pages.length * 0.5));
  return new Set([...counts].filter(([, n]) => pages.length >= 3 && n >= min).map(([k]) => k));
}

const PAGE_NO = /^(-?\s*[0-9]+\s*-?|صفحة\s*[0-9]+(\s*من\s*[0-9]+)?|page\s*[0-9]+(\s*of\s*[0-9]+)?)$/i;

/** The text layer of every page (pdftotext), and the page count. */
async function pdfTexts(path: string): Promise<{ pages: number; texts: string[] }> {
  const info = utf8((await run(["pdfinfo", path])).out);
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  const res = await run(["pdftotext", "-enc", "UTF-8", path, "-"]);
  if (res.code !== 0) throw new Error(`تعذّر قراءة ملف PDF: ${res.err.slice(0, 200)}`);
  return { pages, texts: utf8(res.out).split("\f").slice(0, Math.max(pages, 1)) };
}

/** A page with (almost) no text layer: a scanned page, read by the vision model. */
const isScanned = (text: string) => normalizeDisplay(text).replace(/\s/g, "").length < 20;

/** One PDF page as a PNG data: URL (150 dpi), or null if poppler can't render it. */
async function renderPage(path: string, page: number): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "onespace-ocr-"));
  try {
    const r = await run(["pdftoppm", "-r", "150", "-png", "-f", String(page), "-l", String(page), path, join(dir, "p")]);
    const png = readdirSync(dir).find((f) => f.endsWith(".png"));
    if (r.code !== 0 || !png) return null;
    return `data:image/png;base64,${Buffer.from(readFileSync(join(dir, png))).toString("base64")}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param done pages already read by the batched OCR steps (ingest.ts). When given, scanned pages
 *   come from it and nothing is sent to the vision model here; pages missing from it are noted.
 */
async function extractPdf(path: string, ocr: OcrFn | null, maxOcrPages: number, done?: Map<number, string>): Promise<Extracted> {
  const { pages, texts } = await pdfTexts(path);
  const repeated = repeatedEdgeLines(texts);
  const blocks: Block[] = [];
  const ocrPages: number[] = [];
  let scanned = 0;
  let note: string | undefined;
  for (let i = 0; i < texts.length; i++) {
    const page = i + 1;
    let text = texts[i] ?? "";
    if (isScanned(text)) {
      // No text layer: a scanned page.
      scanned++;
      if (done) {
        const read = done.get(page);
        if (read === undefined) continue;
        text = read;
        ocrPages.push(page);
      } else {
        if (!ocr) {
          note = "صفحات ممسوحة ضوئياً ولا يوجد نموذج رؤية مضبوط";
          continue;
        }
        if (ocrPages.length >= maxOcrPages) {
          note = `قُرئت أول ${maxOcrPages} صفحة ممسوحة فقط`;
          continue;
        }
        const url = await renderPage(path, page);
        if (!url) continue;
        text = await ocr(url, page);
        ocrPages.push(page);
      }
    } else {
      const key = (l: string) => normalizeDisplay(l).replace(/[0-9]+/g, "#");
      text = text
        .split("\n")
        .filter((l) => !repeated.has(key(l.trim())) && !PAGE_NO.test(normalizeDisplay(l)))
        .join("\n");
    }
    blocks.push(...textToBlocks(normalizeDisplay(text), page));
  }
  if (done && scanned > ocrPages.length) {
    const missing = scanned - ocrPages.length;
    note = !ocr ? "صفحات ممسوحة ضوئياً ولا يوجد نموذج رؤية مضبوط" : scanned > maxOcrPages ? `قُرئت أول ${maxOcrPages} صفحة ممسوحة فقط` : `تعذّرت قراءة ${missing} صفحة ممسوحة`;
  }
  return { kind: "pdf", blocks, pages: pages || texts.length, ocrPages, note };
}

async function withFile<T>(bytes: Uint8Array, ext: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "onespace-pdf-"));
  try {
    const path = join(dir, `in.${ext}`);
    writeFileSync(path, bytes);
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The scanned pages of a PDF (no text layer), in order. Not a PDF → none. */
export async function scannedPdfPages(bytes: Uint8Array, name: string, mime: string): Promise<{ pages: number; scanned: number[] }> {
  if (kindOf(name, mime) !== "pdf") return { pages: 0, scanned: [] };
  return await withFile(bytes, "pdf", async (path) => {
    const { pages, texts } = await pdfTexts(path);
    return { pages: pages || texts.length, scanned: texts.flatMap((t, i) => (isScanned(t) ? [i + 1] : [])) };
  });
}

/**
 * Reads the given pages of a PDF with the vision model, `concurrency` at a time. Each page is
 * tried twice; `onPage` gets every page as soon as it is read (so a crash keeps what was done).
 * Returns the pages that could not be read.
 */
export async function ocrPdfPages(
  bytes: Uint8Array,
  pages: number[],
  ocr: OcrFn,
  opts: { concurrency: number; onPage: (page: number, text: string) => Promise<void> },
): Promise<{ failed: number[] }> {
  return await withFile(bytes, "pdf", async (path) => {
    const failed: number[] = [];
    let next = 0;
    const worker = async () => {
      while (next < pages.length) {
        const page = pages[next++]!;
        let text: string | null = null;
        for (let attempt = 0; attempt < 2 && text === null; attempt++) {
          try {
            const url = await renderPage(path, page);
            if (!url) break;
            text = await ocr(url, page);
          } catch {
            text = null;
          }
        }
        if (text === null) failed.push(page);
        else await opts.onPage(page, text);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, pages.length)) }, worker));
    return { failed: failed.sort((a, b) => a - b) };
  });
}

// ---------------------------------------------------------------- Word

function docxParagraph(xml: string): { text: string; style: string | null } {
  const style = /<w:pStyle w:val="([^"]+)"/.exec(xml)?.[1] ?? null;
  const outline = /<w:outlineLvl w:val="(\d)"/.exec(xml)?.[1];
  let text = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
    if (m[0] === "<w:tab/>") text += " ";
    else if (m[0] === "<w:br/>") text += "\n";
    else text += decodeXml(m[1] ?? "");
  }
  return { text, style: style ?? (outline !== undefined ? `Heading${Number(outline) + 1}` : null) };
}

function styleLevel(style: string | null, text: string): number {
  if (style) {
    if (/^(Title|Subtitle)$/i.test(style)) return -1; // the document title: every chunk header already names the document
    const h = /heading\s*([1-6])|^([1-6])$|عنوان\s*([1-6])/i.exec(style);
    if (h) return Number(h[1] ?? h[2] ?? h[3]);
  }
  return headingLevel(text);
}

async function extractDocx(path: string): Promise<Extracted> {
  const xml = await unzipEntry(path, "word/document.xml");
  if (!xml) throw new Error("ملف Word تالف أو غير مدعوم");
  const blocks: Block[] = [];
  let page = 1;
  const paged = /<w:lastRenderedPageBreak\/>|<w:br w:type="page"\/>/.test(xml);
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const part = m[0];
    const breaks = (part.match(/<w:lastRenderedPageBreak\/>|<w:br w:type="page"\/>/g) ?? []).length;
    if (part.startsWith("<w:tbl>")) {
      const rows: string[] = [];
      for (const tr of part.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        const cells = [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) =>
          [...tc[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => docxParagraph(p[0]).text.trim()).filter(Boolean).join(" "),
        );
        if (cells.some(Boolean)) rows.push(`| ${cells.map((c) => normalizeDisplay(c)).join(" | ")} |`);
      }
      if (rows.length) blocks.push({ kind: "table", text: rows.join("\n"), page: paged ? page : undefined });
    } else {
      const { text, style } = docxParagraph(part);
      const t = normalizeDisplay(text);
      if (t) {
        const level = styleLevel(style, t);
        if (level >= 0) blocks.push(level ? { kind: "heading", level, text: t, page: paged ? page : undefined } : { kind: "para", text: t, page: paged ? page : undefined });
      }
    }
    page += breaks;
  }
  return { kind: "docx", blocks, pages: paged ? page : undefined, ocrPages: [] };
}

// ---------------------------------------------------------------- Excel / CSV (described, not chunked)

function colIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

async function extractXlsx(path: string, name: string): Promise<Extracted> {
  const wb = await unzipEntry(path, "xl/workbook.xml");
  if (!wb) throw new Error("ملف Excel تالف أو غير مدعوم");
  const rels = (await unzipEntry(path, "xl/_rels/workbook.xml.rels")) ?? "";
  const shared: string[] = [];
  const ss = await unzipEntry(path, "xl/sharedStrings.xml");
  if (ss) for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeXml([...si[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")));
  const lines: string[] = [`ملف جدول بيانات (Excel): ${name}. ${SHEET_NOTE}`];
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const sheetName = decodeXml(/name="([^"]*)"/.exec(s[0])?.[1] ?? "");
    const rid = /r:id="([^"]*)"/.exec(s[0])?.[1];
    const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
    const t = (target?.[1] ?? target?.[2] ?? "").replace(/^\/?xl\//, "");
    const xml = t ? await unzipEntry(path, `xl/${t}`) : null;
    if (!xml) continue;
    const rows = [...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)];
    const headers: string[] = [];
    const first = rows[0]?.[0] ?? "";
    for (const c of first.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const inner = c[2] ?? "";
      let val = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(inner)?.[1] ?? "";
      if (type === "s") val = shared[Number(val)] ?? "";
      headers[ref ? colIndex(ref) : headers.length] = normalizeDisplay(decodeXml(val));
    }
    lines.push(`الورقة "${sheetName}": ${Math.max(rows.length - 1, 0)} صفاً من البيانات. الأعمدة: ${headers.filter(Boolean).join("، ") || "—"}.`);
  }
  return { kind: "sheet", blocks: [{ kind: "para", text: lines.join("\n") }], ocrPages: [] };
}

function extractCsv(text: string, name: string): Extracted {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = (rows[0] ?? "").includes("\t") ? "\t" : (rows[0] ?? "").includes(";") && !(rows[0] ?? "").includes(",") ? ";" : ",";
  const headers = (rows[0] ?? "").split(sep).map((h) => normalizeDisplay(h.replace(/^"|"$/g, "")));
  const desc = `ملف جدول بيانات (CSV): ${name}. ${Math.max(rows.length - 1, 0)} صفاً من البيانات. الأعمدة: ${headers.join("، ")}. ${SHEET_NOTE}`;
  return { kind: "sheet", blocks: [{ kind: "para", text: desc }], ocrPages: [] };
}

// ---------------------------------------------------------------- entry point

export async function extract(
  bytes: Uint8Array,
  name: string,
  mime: string,
  opts: { ocr: OcrFn | null; maxOcrPages?: number; /** scanned PDF pages already read (batched OCR) */ ocrDone?: Map<number, string> },
): Promise<Extracted> {
  let kind = kindOf(name, mime);
  const dir = mkdtempSync(join(tmpdir(), "onespace-extract-"));
  try {
    const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "bin").toLowerCase();
    let path = join(dir, `in.${ext}`);
    writeFileSync(path, bytes);
    if (kind === "convert") {
      const to = ["xls", "ods"].includes(ext) ? "xlsx" : "docx";
      // SAL_DISABLE_CUPS: without it LibreOffice waits ~25 s on the printer service when importing .odt, .rtf and .ods.
      const r = await run(["soffice", "--headless", "--norestore", `-env:UserInstallation=file://${dir}/lo`, "--convert-to", to, "--outdir", dir, path], 180_000, { SAL_DISABLE_CUPS: "1" });
      const out = join(dir, `in.${to}`);
      if (r.code !== 0) throw new Error("تعذّر تحويل الملف بـLibreOffice");
      path = out;
      kind = to === "xlsx" ? "sheet" : "docx";
      name = name.replace(/\.[a-z0-9]+$/i, `.${to}`);
    }
    switch (kind) {
      case "pdf":
        return await extractPdf(path, opts.ocr, opts.maxOcrPages ?? 50, opts.ocrDone);
      case "docx":
        return await extractDocx(path);
      case "sheet":
        return /\.csv$/i.test(name) || mime === "text/csv" ? extractCsv(utf8(bytes), name) : await extractXlsx(path, name);
      case "image": {
        if (!opts.ocr) return { kind, blocks: [], ocrPages: [], note: "لا يوجد نموذج رؤية مضبوط لقراءة الصور" };
        const type = /^image\//.test(mime) ? mime : `image/${ext === "jpg" ? "jpeg" : ext}`;
        const text = await opts.ocr(`data:${type};base64,${Buffer.from(bytes).toString("base64")}`, 1);
        return { kind, blocks: textToBlocks(normalizeDisplay(text), 1), pages: 1, ocrPages: [1] };
      }
      case "text": {
        let text = utf8(bytes);
        if (/\.html?$/i.test(name) || mime === "text/html") text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "\n");
        return { kind, blocks: textToBlocks(normalizeDisplay(text)), ocrPages: [] };
      }
      default:
        return { kind: "unsupported", blocks: [], ocrPages: [], note: "نوع الملف لا يُفهرس" };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
