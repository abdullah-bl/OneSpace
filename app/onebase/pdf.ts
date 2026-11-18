// Deterministic PDF rendering for official documents (pdf-lib + fontkit, fully local).
//
// Same input -> byte-identical file:
//   - no "now": the info dictionary is written by hand (updateMetadata: false) with dates taken
//     from the input (the issue time), never the clock;
//   - fonts are embedded as subsets under fixed names (customName), so there is no random
//     suffix; pdf-lib's resource-name suffixes come from a PRNG seeded per document;
//   - the fonts are Readex Pro from @fontsource/readex-pro (bundled with the app, no network).
//
// Arabic: fontkit does the shaping (initial/medial/final forms, lam-alef) and lays out an
// Arabic run right-to-left. Mixed text (Arabic + digits + Latin) is split into runs and ordered
// with a small subset of the Unicode bidi algorithm (W4 for numbers like 2026-01-15, N1/N2 for
// neutrals, L2 reordering), then drawn run by run.

import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PDFDocument, PDFName, PDFString, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type Align = "left" | "center" | "right";
type Pos = { x: number; y: number; size?: number; align?: Align; bold?: boolean; maxWidth?: number; color?: [number, number, number] };
export type LayoutElement =
  | ({ type: "text"; text: string } & Pos)
  | ({ type: "field"; field: string; prefix?: string; suffix?: string } & Pos)
  | ({ type: "serial" | "verifyCode" | "issuedDate"; prefix?: string } & Pos)
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; width?: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; width?: number };
export type TemplateLayout = { page?: { width: number; height: number }; elements: LayoutElement[] };

export type RenderInput = {
  layout: TemplateLayout;
  background?: Uint8Array | null;
  data: Record<string, string>;
  serial: string;
  verifyCode: string;
  issuedAt: number; // ms; printed as a date and used for the PDF dates
  title: string;
};

const A4_LANDSCAPE = { width: 842, height: 595 };

// ---- layout validation (templates are written by people in the UI; never by the model) ----

const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function parseLayout(json: string, fieldKeys: string[]): TemplateLayout {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("تخطيط القالب ليس JSON صالحاً");
  }
  if (!raw || !Array.isArray(raw.elements)) throw new Error("تخطيط القالب يحتاج elements");
  if (raw.elements.length > 200) throw new Error("عناصر كثيرة في القالب");
  const page = raw.page ?? A4_LANDSCAPE;
  if (!num(page.width, 50, 3000) || !num(page.height, 50, 3000)) throw new Error("مقاس الصفحة غير صالح");
  const elements: LayoutElement[] = [];
  for (const e of raw.elements) {
    const pos = (): Pos => {
      if (!num(e.x, -10, 3000) || !num(e.y, -10, 3000)) throw new Error("موضع عنصر غير صالح");
      if (e.size !== undefined && !num(e.size, 4, 200)) throw new Error("حجم خط غير صالح");
      if (e.align !== undefined && !["left", "center", "right"].includes(e.align)) throw new Error("محاذاة غير صالحة");
      if (e.maxWidth !== undefined && !num(e.maxWidth, 10, 3000)) throw new Error("عرض غير صالح");
      const color = Array.isArray(e.color) && e.color.length === 3 && e.color.every((c: unknown) => num(c, 0, 1)) ? (e.color as [number, number, number]) : undefined;
      return { x: e.x, y: e.y, size: e.size, align: e.align, bold: e.bold === true, maxWidth: e.maxWidth, color };
    };
    const str = (s: unknown, max = 500) => (typeof s === "string" ? s.slice(0, max) : undefined);
    if (e?.type === "text") {
      if (typeof e.text !== "string" || !e.text) throw new Error("عنصر نص بلا نص");
      elements.push({ type: "text", text: e.text.slice(0, 1000), ...pos() });
    } else if (e?.type === "field") {
      if (!fieldKeys.includes(e.field)) throw new Error(`حقل غير معرّف في القالب: ${e.field}`);
      elements.push({ type: "field", field: e.field, prefix: str(e.prefix), suffix: str(e.suffix), ...pos() });
    } else if (e?.type === "serial" || e?.type === "verifyCode" || e?.type === "issuedDate") {
      elements.push({ type: e.type, prefix: str(e.prefix), ...pos() });
    } else if (e?.type === "line") {
      if (![e.x1, e.y1, e.x2, e.y2].every((n) => num(n, -10, 3000))) throw new Error("خط غير صالح");
      elements.push({ type: "line", x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, width: num(e.width, 0.1, 20) ? e.width : 1 });
    } else if (e?.type === "rect") {
      if (![e.x, e.y, e.w, e.h].every((n) => num(n, -10, 3000))) throw new Error("مستطيل غير صالح");
      elements.push({ type: "rect", x: e.x, y: e.y, w: e.w, h: e.h, width: num(e.width, 0.1, 20) ? e.width : 1 });
    } else {
      throw new Error("نوع عنصر غير معروف في القالب");
    }
  }
  return { page: { width: page.width, height: page.height }, elements };
}

/** A starting layout for a certificate with the given fields, A4 landscape. */
export function defaultLayout(title: string, fields: { key: string; label: string }[]): TemplateLayout {
  const els: LayoutElement[] = [
    { type: "rect", x: 24, y: 24, w: 794, h: 547, width: 2 },
    { type: "text", text: title, x: 421, y: 480, size: 30, align: "center", bold: true },
  ];
  let y = 400;
  for (const f of fields) {
    els.push({ type: "text", text: `${f.label}:`, x: 700, y, size: 16, align: "right" });
    els.push({ type: "field", field: f.key, x: 560, y, size: 18, align: "right", bold: true, maxWidth: 420 });
    y -= 42;
  }
  els.push({ type: "issuedDate", prefix: "تاريخ الإصدار: ", x: 780, y: 70, size: 11, align: "right" });
  els.push({ type: "serial", prefix: "الرقم التسلسلي: ", x: 780, y: 50, size: 11, align: "right" });
  els.push({ type: "verifyCode", prefix: "رمز التحقق: ", x: 62, y: 50, size: 11, align: "left" });
  return { page: A4_LANDSCAPE, elements: els };
}

// ---- fonts ----

type FontSet = { arabic: Uint8Array; latin: Uint8Array; arabicBold: Uint8Array; latinBold: Uint8Array };
let fontCache: FontSet | null = null;

function fontFile(name: string): Uint8Array {
  const rel = `@fontsource/readex-pro/files/${name}`;
  const candidates: string[] = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve(rel));
  } catch {}
  candidates.push(`${process.cwd()}/node_modules/${rel}`);
  for (const p of candidates) {
    try {
      return new Uint8Array(readFileSync(p));
    } catch {}
  }
  throw new Error(`font not found: ${rel}`);
}

function fonts(): FontSet {
  fontCache ??= {
    arabic: fontFile("readex-pro-arabic-400-normal.woff"),
    latin: fontFile("readex-pro-latin-400-normal.woff"),
    arabicBold: fontFile("readex-pro-arabic-700-normal.woff"),
    latinBold: fontFile("readex-pro-latin-700-normal.woff"),
  };
  return fontCache;
}

// ---- bidi (subset) ----

type Cls = "R" | "AL" | "AN" | "EN" | "L" | "N";

function classOf(cp: number): Cls {
  if ((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9)) return "AN";
  if (cp >= 0x30 && cp <= 0x39) return "EN";
  if (cp === 0x060c || cp === 0x061b || cp === 0x061f || (cp >= 0x066a && cp <= 0x066d)) return "N";
  if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return "AL";
  if (cp >= 0x0590 && cp <= 0x05ff) return "R";
  if (/\p{L}/u.test(String.fromCodePoint(cp))) return "L";
  return "N";
}

const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" };

type Run = { text: string; level: number; font: PDFFont; arabic: boolean };

function resolveLevels(chars: string[]): { levels: number[]; base: 0 | 1; cls: Cls[] } {
  const cls = chars.map((c) => classOf(c.codePointAt(0)!));
  const firstStrong = cls.find((c) => c === "L" || c === "R" || c === "AL");
  const base: 0 | 1 = firstStrong === "L" ? 0 : 1;
  // W7: European digits after Latin text belong to it (OS-2026-000001, K7Q2).
  let lastStrong: Cls = base === 1 ? "R" : "L";
  for (let i = 0; i < chars.length; i++) {
    const c = cls[i]!;
    if (c === "L" || c === "R" || c === "AL") lastStrong = c;
    else if (c === "EN" && lastStrong === "L") cls[i] = "L";
  }
  // W4 (+ the same for separators between Latin text, after W7): a single separator between
  // two numbers joins them (2026-01-15, 3.5, 1/2).
  for (let i = 1; i < chars.length - 1; i++) {
    if (cls[i] === "N" && "-+/.,:_".includes(chars[i]!) && cls[i - 1] === "L" && cls[i + 1] === "L") cls[i] = "L";
  }
  // W4: a single separator between two numbers joins them (2026-01-15, 3.5, 1/2).
  for (let i = 1; i < chars.length - 1; i++) {
    if (cls[i] === "N" && "-+/.,:".includes(chars[i]!)) {
      const a = cls[i - 1], b = cls[i + 1];
      if ((a === "EN" || a === "AN") && a === b) cls[i] = a;
    }
  }
  const dirOf = (c: Cls) => (c === "L" ? "L" : c === "N" ? null : "R"); // N1: numbers count as R
  const levels: number[] = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    const c = cls[i]!;
    if (c === "L") levels[i] = base === 1 ? 2 : 0;
    else if (c === "R" || c === "AL") levels[i] = 1;
    else if (c === "EN" || c === "AN") levels[i] = base === 1 ? 2 : c === "AN" ? 2 : 0;
    else {
      let p: string | null = null, n: string | null = null;
      for (let j = i - 1; j >= 0 && p === null; j--) p = dirOf(cls[j]!);
      for (let j = i + 1; j < chars.length && n === null; j++) n = dirOf(cls[j]!);
      p ??= base === 1 ? "R" : "L";
      n ??= base === 1 ? "R" : "L";
      const dir = p === n ? p : base === 1 ? "R" : "L"; // N1, else N2 (embedding direction)
      levels[i] = dir === "R" ? 1 : base === 1 ? 2 : 0;
    }
  }
  return { levels, base, cls };
}

function has(font: any, ch: string) {
  return font.__fk.hasGlyphForCodePoint(ch.codePointAt(0)!);
}

/** Splits text into drawable runs in visual (left-to-right) order. */
function visualRuns(text: string, f: { arabic: PDFFont; latin: PDFFont }): Run[] {
  const chars = [...text.replace(/[‎‏‪-‮⁦-⁩]/g, "")];
  if (chars.length === 0) return [];
  const { levels, cls } = resolveLevels(chars);
  const runs: Run[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const c = cls[i]!;
    const level = levels[i]!;
    const wantsArabic = c === "AL" || c === "AN" || c === "R" || (level % 2 === 1 && !has(f.latin, ch));
    const font = wantsArabic ? (has(f.arabic, ch) ? f.arabic : f.latin) : has(f.latin, ch) ? f.latin : f.arabic;
    const arabicLetters = c === "AL" && font === f.arabic && level % 2 === 1;
    const prev = runs[runs.length - 1];
    // Multi-character runs only where fontkit lays them out in the right direction itself:
    // Arabic letters (RTL) and anything drawn LTR with the Latin font.
    const joinable = arabicLetters || (level % 2 === 0 && font === f.latin);
    if (prev && joinable && prev.level === level && prev.font === font && prev.arabic === arabicLetters && (arabicLetters || prev.text.length > 0) && (prev as any).joinable) {
      prev.text += ch;
    } else {
      const run: any = { text: level % 2 === 1 && !arabicLetters ? (MIRROR[ch] ?? ch) : ch, level, font, arabic: arabicLetters, joinable };
      runs.push(run);
    }
  }
  // L2: reverse every maximal sequence at level >= k, from the highest level down to 1.
  const max = Math.max(...runs.map((r) => r.level));
  for (let k = max; k >= 1; k--) {
    let i = 0;
    while (i < runs.length) {
      if (runs[i]!.level >= k) {
        let j = i;
        while (j + 1 < runs.length && runs[j + 1]!.level >= k) j++;
        const seg = runs.slice(i, j + 1).reverse();
        runs.splice(i, seg.length, ...seg);
        i = j + 1;
      } else i++;
    }
  }
  return runs;
}

function widthOf(runs: Run[], size: number) {
  return runs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
}

function drawLine(page: PDFPage, text: string, p: Pos, f: { arabic: PDFFont; latin: PDFFont }) {
  let size = p.size ?? 14;
  const runs = visualRuns(text, f);
  let width = widthOf(runs, size);
  if (p.maxWidth && width > p.maxWidth) {
    size = Math.max(4, (size * p.maxWidth) / width);
    width = widthOf(runs, size);
  }
  const align = p.align ?? "right";
  let x = align === "left" ? p.x : align === "center" ? p.x - width / 2 : p.x - width;
  const color = p.color ? rgb(...p.color) : rgb(0.1, 0.1, 0.12);
  for (const r of runs) {
    page.drawText(r.text, { x, y: p.y, size, font: r.font, color });
    x += r.font.widthOfTextAtSize(r.text, size);
  }
}

function pdfDate(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function isoDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function renderPdf(input: RenderInput): Promise<Uint8Array> {
  const pageSize = input.layout.page ?? A4_LANDSCAPE;
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const set = fonts();
  const embed = async (bytes: Uint8Array, name: string) => {
    const font = await doc.embedFont(bytes, { subset: true, customName: name });
    (font as any).__fk = (font as any).embedder.font;
    return font;
  };
  const regular = { arabic: await embed(set.arabic, "ReadexPro-Arabic"), latin: await embed(set.latin, "ReadexPro-Latin") };
  const bold = { arabic: await embed(set.arabicBold, "ReadexPro-Arabic-Bold"), latin: await embed(set.latinBold, "ReadexPro-Latin-Bold") };

  let page: PDFPage;
  if (input.background && input.background.byteLength > 0) {
    const bg = await PDFDocument.load(input.background, { updateMetadata: false });
    const [embedded] = await doc.embedPdf(bg, [0]);
    page = doc.addPage([embedded!.width, embedded!.height]);
    page.drawPage(embedded!, { x: 0, y: 0, width: embedded!.width, height: embedded!.height });
  } else {
    page = doc.addPage([pageSize.width, pageSize.height]);
  }

  const date = isoDate(input.issuedAt);
  for (const e of input.layout.elements) {
    if (e.type === "line") {
      page.drawLine({ start: { x: e.x1, y: e.y1 }, end: { x: e.x2, y: e.y2 }, thickness: e.width ?? 1, color: rgb(0.3, 0.3, 0.35) });
      continue;
    }
    if (e.type === "rect") {
      page.drawRectangle({ x: e.x, y: e.y, width: e.w, height: e.h, borderWidth: e.width ?? 1, borderColor: rgb(0.06, 0.37, 0.36) });
      continue;
    }
    let text = "";
    if (e.type === "text") text = e.text;
    else if (e.type === "field") text = `${e.prefix ?? ""}${input.data[e.field] ?? ""}${e.suffix ?? ""}`;
    else if (e.type === "serial") text = `${e.prefix ?? ""}${input.serial}`;
    else if (e.type === "verifyCode") text = `${e.prefix ?? ""}${input.verifyCode}`;
    else if (e.type === "issuedDate") text = `${e.prefix ?? ""}${date}`;
    if (text) drawLine(page, text, e, e.bold ? bold : regular);
  }

  // Info dictionary by hand: fixed values only, no clock.
  const when = PDFString.of(pdfDate(input.issuedAt));
  const info = doc.context.obj({});
  info.set(PDFName.of("Title"), PDFString.of(input.title.replace(/[^\x20-\x7e]/g, "?")));
  info.set(PDFName.of("Producer"), PDFString.of("OneSpace"));
  info.set(PDFName.of("Creator"), PDFString.of("OneSpace"));
  info.set(PDFName.of("CreationDate"), when);
  info.set(PDFName.of("ModDate"), when);
  doc.context.trailerInfo.Info = doc.context.register(info);

  return await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
