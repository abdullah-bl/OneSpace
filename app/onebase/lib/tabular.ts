// Parses an uploaded table (CSV or the first sheet of an XLSX) into rows keyed by the header row.
// Done in code, never by the model. No dependencies: XLSX is a zip of XML, read with node:zlib.

import { inflateRawSync } from "node:zlib";
export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export type Table = { fields: string[]; rows: Row[] };

export class TableError extends Error {}

const MAX_ROWS = 20_000;
const MAX_COLS = 200;

export function parseTable(bytes: Uint8Array, name: string, mime = ""): Table {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip || /\.xlsx$/i.test(name) || mime.includes("spreadsheetml")) {
    if (!isZip) throw new TableError("ملف Excel غير صالح");
    return toTable(readXlsx(bytes));
  }
  if (/\.(csv|txt)$/i.test(name) || mime.startsWith("text/")) return toTable(readCsv(new TextDecoder("utf-8").decode(bytes)));
  throw new TableError("نوع الملف غير مدعوم: ارفع CSV أو XLSX");
}

function toTable(grid: Cell[][]): Table {
  const nonEmpty = grid.filter((r) => r.some((c) => c !== null && c !== ""));
  if (nonEmpty.length === 0) throw new TableError("الجدول فارغ");
  const header = nonEmpty[0]!.map((h, i) => (h === null || String(h).trim() === "" ? `عمود${i + 1}` : String(h).trim()));
  if (header.length > MAX_COLS) throw new TableError("أعمدة كثيرة جداً");
  if (new Set(header).size !== header.length) throw new TableError("أسماء الأعمدة مكررة");
  if (nonEmpty.length - 1 > MAX_ROWS) throw new TableError(`أكثر من ${MAX_ROWS} صف`);
  const rows = nonEmpty.slice(1).map((r) => {
    const row: Row = {};
    header.forEach((h, i) => {
      const c = r[i];
      row[h] = c === undefined || c === "" ? null : c;
    });
    return row;
  });
  return { fields: header, rows };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF/LF, BOM. Cells stay strings. */
export function readCsv(text: string): Cell[][] {
  const s = text.replace(/^﻿/, "");
  const firstLine = s.slice(0, s.indexOf("\n") >>> 0);
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

// ---------- XLSX ----------

function unzip(bytes: Uint8Array): Map<string, () => Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new TableError("ملف Excel غير صالح");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map<string, () => Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new TableError("ملف Excel غير صالح");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, () => {
      if (size > 200 * 1024 * 1024) throw new TableError("ملف Excel كبير جداً");
      const lNameLen = view.getUint16(local + 26, true);
      const lExtraLen = view.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
      throw new TableError("ضغط غير مدعوم في ملف Excel");
    });
  }
  return entries;
}

function xmlDecode(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1]!)).join("");

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(bytes: Uint8Array): Cell[][] {
  const zip = unzip(bytes);
  const read = (path: string) => {
    const get = zip.get(path);
    return get ? new TextDecoder().decode(get()) : null;
  };
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new TableError("ملف Excel غير صالح");
  const firstSheet = workbook.match(/<sheet\s[^>]*>/)?.[0];
  const relId = firstSheet ? (attr(firstSheet, "r:id") ?? attr(firstSheet, "[a-zA-Z0-9]+:id")) : undefined;
  let sheetPath = "xl/worksheets/sheet1.xml";
  const rels = read("xl/_rels/workbook.xml.rels");
  if (rels && relId) {
    for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
      if (attr(m[0], "Id") === relId) {
        const target = attr(m[0], "Target") ?? "";
        sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }
  const shared: string[] = [];
  const sst = read("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1]!));
  const sheet = read(sheetPath);
  if (!sheet) throw new TableError("لا توجد ورقة في ملف Excel");
  const grid: Cell[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: Cell[] = [];
    const body = rm[1] ?? "";
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1] ?? "";
      const inner = cm[2] ?? "";
      const ref = attr(head, "r");
      const idx = ref ? colIndex(ref) : next;
      if (idx >= MAX_COLS) continue;
      next = idx + 1;
      const t = attr(head, "t");
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let cell: Cell = null;
      if (t === "s") cell = v !== undefined ? (shared[Number(v)] ?? null) : null;
      else if (t === "inlineStr") cell = texts(inner);
      else if (t === "str") cell = v !== undefined ? xmlDecode(v) : null;
      else if (t === "b") cell = v === "1" ? 1 : 0;
      else if (t === "e") cell = null;
      else if (v !== undefined) {
        const n = Number(v);
        cell = Number.isFinite(n) ? n : xmlDecode(v);
      }
      while (row.length < idx) row.push(null);
      row[idx] = cell;
    }
    grid.push(row);
    if (grid.length > MAX_ROWS + 1) throw new TableError(`أكثر من ${MAX_ROWS} صف`);
  }
  return grid;
}
