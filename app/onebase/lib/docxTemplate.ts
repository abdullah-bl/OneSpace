// Certificate templates as Word files with {{variables}} (plans/17 §3).
//
// - Word stores text in runs and may split "{{الاسم}}" across several (spell-check marks, a
//   style change on one letter, editing history). Before reading or filling, each paragraph's
//   runs are rejoined around a variable: every character of a {{…}} is moved into the run where
//   it starts. Nothing outside a variable moves, so the formatting the author chose stays.
// - Filling is code only: each variable is replaced by the record's value, XML-escaped. Changed
//   parts get a fixed date in the zip, so the same file and the same data give the same bytes.
// - LibreOffice (already on the server for file conversion, lib/extract.ts) turns the filled
//   file into the PDF.

import JSZip from "jszip";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
const VAR_RE = /\{\{\s*([^{}<>]{1,60}?)\s*\}\}/g;
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1));

/** Variables filled at issue, by every name they may be written with. */
export const RESERVED: Record<string, "serial" | "verifyCode" | "issuedDate"> = {
  الرقم_التسلسلي: "serial",
  "الرقم التسلسلي": "serial",
  serial: "serial",
  رمز_التحقق: "verifyCode",
  "رمز التحقق": "verifyCode",
  verify_code: "verifyCode",
  تاريخ_الإصدار: "issuedDate",
  "تاريخ الإصدار": "issuedDate",
  issue_date: "issuedDate",
};

export class DocxError extends Error {}

const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/** Rejoins, within one paragraph, the runs a {{variable}} was split across. */
export function mergeParagraph(p: string): string {
  const re = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;
  const nodes: { start: number; end: number; open: string; text: string }[] = [];
  for (let m; (m = re.exec(p)); ) nodes.push({ start: m.index, end: m.index + m[0].length, open: m[1]!, text: m[2]! });
  if (nodes.length < 2) return p;
  const full = nodes.map((n) => n.text).join("");
  if (!full.includes("{{")) return p;
  // Which run each character belongs to; a variable's characters all go to the run it starts in.
  const owner: number[] = [];
  nodes.forEach((n, i) => {
    for (let k = 0; k < n.text.length; k++) owner.push(i);
  });
  let moved = false;
  for (const m of full.matchAll(VAR_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    for (let k = from; k < to; k++) {
      if (owner[k] !== owner[from]) moved = true;
      owner[k] = owner[from]!;
    }
  }
  if (!moved) return p;
  const texts = nodes.map(() => "");
  for (let k = 0; k < full.length; k++) texts[owner[k]!] += full[k];
  let out = "";
  let last = 0;
  nodes.forEach((n, i) => {
    const open = texts[i] !== n.text && !/xml:space=/.test(n.open) ? n.open.replace(/^<w:t/, '<w:t xml:space="preserve"') : n.open;
    out += p.slice(last, n.start) + open + texts[i] + "</w:t>";
    last = n.end;
  });
  return out + p.slice(last);
}

export function mergeRuns(xml: string): string {
  return xml.replace(/<w:p[\s>][\s\S]*?<\/w:p>/g, mergeParagraph);
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function open(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_DOCX_BYTES) throw new DocxError("ملف وورد أكبر من 10 م.ب");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocxError("الملف ليس ملف وورد ‎.docx صالحاً");
  }
  if (!zip.file("word/document.xml")) throw new DocxError("الملف ليس ملف وورد ‎.docx صالحاً");
  const parts = new Map<string, string>();
  for (const name of Object.keys(zip.files).sort()) if (TEXT_PARTS.test(name)) parts.set(name, mergeRuns(await zip.file(name)!.async("string")));
  return { zip, parts };
}

/** The {{variables}} of a Word file, in order of first appearance, with how they're written. */
export async function variablesOf(bytes: Uint8Array): Promise<string[]> {
  const { parts } = await open(bytes);
  const seen = new Set<string>();
  for (const xml of parts.values()) {
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unescapeXml(m[1]!)).join("\n");
    for (const m of text.matchAll(VAR_RE)) seen.add(m[1]!.trim());
  }
  return [...seen];
}

/**
 * In an Arabic line, the bidi algorithm turns "2026-11-22" into "22-11-2026" (digits after
 * Arabic letters are Arabic numbers, and "-" doesn't join those). A value with no Arabic and a
 * separator (a date, a serial, a code) is wrapped in left-to-right marks so it reads as written.
 */
export function bidiSafe(value: string): string {
  if (/[؀-ۿ]/.test(value) || !/[-/.:]/.test(value) || !/\d/.test(value)) return value;
  return `‎${value}‎`;
}

/** Fills the variables present in `values` (others stay as written). Same input, same bytes. */
export async function fillDocx(bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array> {
  const { zip, parts } = await open(bytes);
  for (const [name, xml] of parts) {
    const filled = xml.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (_all, o: string, t: string, c: string) => {
      const next = unescapeXml(t).replace(VAR_RE, (whole, v: string) => (Object.hasOwn(values, v.trim()) ? bidiSafe(values[v.trim()]!) : whole));
      const opened = next !== unescapeXml(t) && !/xml:space=/.test(o) ? o.replace(/^<w:t/, '<w:t xml:space="preserve"') : o;
      return opened + escapeXml(next) + c;
    });
    zip.file(name, filled, { date: FIXED_DATE });
  }
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Font families the file asks for (run properties, styles, theme). */
export async function fontsOf(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(document|styles|header\d*|footer\d*|theme\/theme\d+)\.xml$/.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    for (const m of xml.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"/g)) names.add(m[1]!);
    for (const m of xml.matchAll(/<a:(?:latin|cs)\s+typeface="([^"]+)"/g)) if (m[1]) names.add(m[1]);
  }
  return [...names].filter((n) => n && !n.startsWith("+")).sort();
}

let installed: Set<string> | null = null;
/** Fonts the file uses that this server doesn't have (LibreOffice would substitute them). */
export async function missingFonts(bytes: Uint8Array): Promise<string[]> {
  if (!installed) {
    try {
      const proc = Bun.spawn(["fc-list", ":", "family"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      installed = new Set(out.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    } catch {
      return [];
    }
  }
  return (await fontsOf(bytes)).filter((f) => !installed!.has(f.toLowerCase()));
}

/** The filled Word file as a PDF, with LibreOffice. */
export async function docxToPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "onespace-docx-"));
  try {
    const src = join(dir, "doc.docx");
    writeFileSync(src, bytes);
    // SAL_DISABLE_CUPS: without it, importing a .docx waits ~25 s on the printer service.
    const proc = Bun.spawn(["soffice", "--headless", "--norestore", `-env:UserInstallation=file://${dir}/lo`, "--convert-to", "pdf", "--outdir", dir, src], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, SAL_DISABLE_CUPS: "1" },
    });
    const timer = setTimeout(() => proc.kill(), 120_000);
    const code = await proc.exited;
    clearTimeout(timer);
    let pdf: Uint8Array;
    try {
      pdf = new Uint8Array(readFileSync(join(dir, "doc.pdf")));
    } catch {
      throw new DocxError("تعذّر تحويل ملف وورد إلى PDF");
    }
    if (code !== 0 || pdf.byteLength === 0) throw new DocxError("تعذّر تحويل ملف وورد إلى PDF");
    return pdf;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A starting Word file: a centred A4-landscape certificate with the given variables and the
 * reserved ones, right-to-left, in Amiri (a free Arabic font the server has), for the author
 * to restyle in Word.
 */
export async function sampleDocx(title: string, variables: string[]): Promise<Uint8Array> {
  const para = (text: string, opts: { size?: number; bold?: boolean; align?: string; space?: number } = {}) =>
    `<w:p><w:pPr><w:bidi/><w:jc w:val="${opts.align ?? "center"}"/><w:spacing w:after="${opts.space ?? 160}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Amiri" w:hAnsi="Amiri" w:cs="Amiri"/>${opts.bold ? "<w:b/><w:bCs/>" : ""}<w:sz w:val="${(opts.size ?? 14) * 2}"/><w:szCs w:val="${(opts.size ?? 14) * 2}"/><w:rtl/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  const body = [
    para(title, { size: 30, bold: true, space: 480 }),
    para("تشهد الإدارة بأن", { size: 16 }),
    ...variables.map((v, i) => para(`{{${v}}}`, { size: i === 0 ? 24 : 16, bold: i === 0 })),
    para("", { space: 600 }),
    para("الرقم التسلسلي: {{الرقم_التسلسلي}}    رمز التحقق: {{رمز_التحقق}}    تاريخ الإصدار: {{تاريخ_الإصدار}}", { size: 10 }),
  ].join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/><w:pgBorders w:offsetFrom="page"><w:top w:val="double" w:sz="12" w:space="24" w:color="0F5E5C"/><w:left w:val="double" w:sz="12" w:space="24" w:color="0F5E5C"/><w:bottom w:val="double" w:sz="12" w:space="24" w:color="0F5E5C"/><w:right w:val="double" w:sz="12" w:space="24" w:color="0F5E5C"/></w:pgBorders><w:bidi/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  const add = (name: string, data: string) => zip.file(name, data, { date: FIXED_DATE });
  add(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  add("word/document.xml", document);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
