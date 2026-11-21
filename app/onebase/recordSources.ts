// Where structured records come from, and the validation every source goes through.
//
// A RecordSource turns some input (an Excel file today; an existing student/HR system later)
// into raw rows keyed by column header. validateRows() then checks them against the record
// set's columns (missing columns, types, required cells, duplicates) and either returns typed
// rows or a list of precise errors. Nothing is written unless validation passes for every row,
// and the insert itself is a single mutation (records.ts: insertImport), so an import is
// all-or-nothing whatever the source.
//
// To add a second source: implement RecordSource (e.g. kind "sis", read() fetching from the
// existing system in an action) and register it in SOURCES. The rest of the pipeline
// (validation, versioning, query_records/my_records) doesn't change.

import ExcelJS from "exceljs";

export type ColumnType = "text" | "number" | "date" | "boolean";
export type ColumnDef = { key: string; header: string; type: ColumnType; required: boolean };
export type Cell = string | number | boolean | null;
export type RecordSetDef = { columns: ColumnDef[]; subjectColumn: string; uniqueBy: string[] };

export type RawTable = { headers: string[]; rows: { rowNo: number; cells: Record<string, unknown> }[] };

export interface RecordSource<Input = unknown> {
  kind: string;
  label: string;
  read(input: Input): Promise<RawTable>;
}

export const MAX_ROWS = 20_000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** National id / employee number as stored and matched: trimmed, ASCII digits, no spaces or dashes. */
export function normalizeRef(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? (Number.isInteger(value) ? String(value) : String(value)) : String(value);
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return s.replace(/[\s\-_.‏‎]/g, "").trim();
}

/** Unwraps exceljs cell values (rich text, formulas, hyperlinks, errors) to plain JS values. */
function plainCell(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const o = value as any;
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join("");
    if ("result" in o) return plainCell(o.result);
    if ("formula" in o || "sharedFormula" in o) return null;
    if ("text" in o) return String(o.text);
    if ("error" in o) return null;
    return String(value);
  }
  return value;
}

export const excelSource: RecordSource<{ bytes: Uint8Array }> = {
  kind: "excel",
  label: "ملف Excel",
  async read({ bytes }) {
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportError(["الملف أكبر من 10 م.ب"]);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes as any);
    } catch {
      throw new ImportError(["تعذّر قراءة الملف: يجب أن يكون ملف Excel بصيغة ‎.xlsx"]);
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new ImportError(["الملف لا يحوي أي ورقة"]);
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    const colByHeader = new Map<number, string>();
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = String(plainCell(cell.value) ?? "").trim();
      if (h) {
        headers.push(h);
        colByHeader.set(col, h);
      }
    });
    const rows: RawTable["rows"] = [];
    const last = ws.rowCount;
    if (last - 1 > MAX_ROWS) throw new ImportError([`عدد الصفوف أكبر من الحد (${MAX_ROWS})`]);
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: Record<string, unknown> = {};
      let any = false;
      for (const [col, h] of colByHeader) {
        const val = plainCell(row.getCell(col).value);
        if (val !== null && !(typeof val === "string" && val.trim() === "")) any = true;
        cells[h] = val;
      }
      if (any) rows.push({ rowNo: r, cells });
    }
    return { headers, rows };
  },
};

export const SOURCES: Record<string, RecordSource<any>> = { excel: excelSource };

export class ImportError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("\n"));
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = normalizeDigits(v).replace(/,/g, "").trim();
    if (s !== "" && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return null;
}

function normalizeDigits(s: string) {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/٫/g, ".");
}

function toDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    const s = normalizeDigits(v).trim();
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
    if (m) {
      const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
      if (d.getUTCMonth() === +m[2]! - 1) return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["نعم", "true", "yes", "1"].includes(s)) return true;
    if (["لا", "false", "no", "0"].includes(s)) return false;
  }
  if (v === 1) return true;
  if (v === 0) return false;
  return null;
}

function toText(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

const TYPE_LABEL: Record<ColumnType, string> = { text: "نص", number: "رقم", date: "تاريخ (YYYY-MM-DD)", boolean: "نعم/لا" };

export type ValidRow = { rowNo: number; subjectRef: string; data: Record<string, Cell> };

/**
 * Checks raw rows against the record set. Returns typed rows, or throws ImportError with every
 * problem found (capped), each naming the row and column.
 */
export function validateRows(def: RecordSetDef, raw: RawTable): ValidRow[] {
  const errors: string[] = [];
  const push = (m: string) => {
    if (errors.length < 50) errors.push(m);
  };
  const present = new Set(raw.headers);
  const missing = def.columns.filter((c) => !present.has(c.header)).map((c) => c.header);
  if (missing.length) throw new ImportError([`أعمدة ناقصة: ${missing.join("، ")}`]);
  const dupHeaders = raw.headers.filter((h, i) => raw.headers.indexOf(h) !== i);
  if (dupHeaders.length) throw new ImportError([`أعمدة مكررة في الملف: ${[...new Set(dupHeaders)].join("، ")}`]);
  if (raw.rows.length === 0) throw new ImportError(["الملف لا يحوي أي صف بيانات"]);
  if (raw.rows.length > MAX_ROWS) throw new ImportError([`عدد الصفوف أكبر من الحد (${MAX_ROWS})`]);

  const out: ValidRow[] = [];
  const seen = new Map<string, number>();
  const subjectCol = def.columns.find((c) => c.key === def.subjectColumn)!;
  for (const { rowNo, cells } of raw.rows) {
    const data: Record<string, Cell> = {};
    for (const c of def.columns) {
      const v = cells[c.header];
      const empty = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
      if (empty) {
        if (c.required || c.key === def.subjectColumn) push(`الصف ${rowNo}: العمود "${c.header}" فارغ`);
        data[c.key] = null;
        continue;
      }
      let val: Cell = null;
      if (c.key === def.subjectColumn) val = normalizeRef(v) || null;
      else if (c.type === "number") val = toNumber(v);
      else if (c.type === "date") val = toDate(v);
      else if (c.type === "boolean") val = toBool(v);
      else val = toText(v);
      if (val === null) push(`الصف ${rowNo}: القيمة في العمود "${c.header}" ليست ${TYPE_LABEL[c.type]}`);
      data[c.key] = val;
    }
    const subjectRef = typeof data[subjectCol.key] === "string" ? (data[subjectCol.key] as string) : "";
    const key = JSON.stringify(def.uniqueBy.map((k) => data[k] ?? null));
    const first = seen.get(key);
    if (first !== undefined) push(`الصف ${rowNo}: مكرر مع الصف ${first} (${def.uniqueBy.map((k) => def.columns.find((c) => c.key === k)?.header ?? k).join(" + ")})`);
    else seen.set(key, rowNo);
    out.push({ rowNo, subjectRef, data });
  }
  if (errors.length) throw new ImportError(errors);
  return out;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ---------- starting from a file: guess the definition, the user chooses ----------

export type InferredColumn = { header: string; type: ColumnType; required: boolean; idLike: boolean; distinct: number; samples: string[] };

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const ID_RE = /^\d{5,15}$/;

/**
 * Guesses a column definition from the file's own values: the type every non-empty cell fits
 * (id-like digits stay text), required when no cell is empty. Nothing here is trusted: the
 * user sees and changes it, and validateRows checks the file against whatever they choose.
 */
export function inferColumns(raw: RawTable): InferredColumn[] {
  return raw.headers.map((header) => {
    const values = raw.rows.map((r) => r.cells[header]).filter((v) => !isEmpty(v));
    const refs = values.map((v) => normalizeRef(v));
    const idLike = values.length > 0 && refs.every((r) => ID_RE.test(r));
    let type: ColumnType = "text";
    if (values.length > 0 && !idLike) {
      if (values.every((v) => toDate(v) !== null)) type = "date";
      else if (values.every((v) => toNumber(v) !== null)) type = "number";
      else if (values.every((v) => typeof v !== "number" && toBool(v) !== null)) type = "boolean";
    }
    const distinct = new Set(values.map((v) => (idLike ? normalizeRef(v) : toText(v)))).size;
    const samples = [...new Set(values.map((v) => (idLike ? normalizeRef(v) : toText(v))))].slice(0, 3).map((s) => s.slice(0, 60));
    return { header, type, required: values.length === raw.rows.length && raw.rows.length > 0, idLike, distinct, samples };
  });
}

/** Columns that may name the record's owner: id-like digits, header hints first. Repeats are fine (one person, many courses). */
export function ownerCandidates(columns: InferredColumn[]): string[] {
  const hint = (h: string) => (/هوية|سجل مدني|إقامة|national|id/i.test(h) ? 2 : /وظيفي|موظف|employee|staff/i.test(h) ? 1 : 0);
  return columns
    .filter((c) => c.idLike)
    .sort((a, b) => hint(b.header) - hint(a.header) || b.distinct - a.distinct)
    .map((c) => c.header);
}

function cellKey(v: unknown, owner: boolean) {
  if (isEmpty(v)) return null;
  return owner ? normalizeRef(v) : toText(v);
}

function uniqueUnder(raw: RawTable, headers: string[], owner: string) {
  const seen = new Set<string>();
  for (const r of raw.rows) {
    const k = JSON.stringify(headers.map((h) => cellKey(r.cells[h], h === owner)));
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/**
 * The fewest chosen columns (owner first) under which no two rows repeat: the owner alone, the
 * owner + one column, + two columns, else every chosen column. A file with true duplicate rows
 * still fails validation, which is the point.
 */
export function suggestUnique(raw: RawTable, chosen: string[], owner: string): string[] {
  const others = chosen.filter((h) => h !== owner);
  if (uniqueUnder(raw, [owner], owner)) return [owner];
  for (const a of others) if (uniqueUnder(raw, [owner, a], owner)) return [owner, a];
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) if (uniqueUnder(raw, [owner, others[i]!, others[j]!], owner)) return [owner, others[i]!, others[j]!];
  return [owner, ...others];
}

/** Keys for columns defined from a file: never typed, never shown. */
export function keysFor(headers: string[]): Map<string, string> {
  return new Map(headers.map((h, i) => [h, `c${i + 1}`]));
}
