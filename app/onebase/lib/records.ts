// Where ranking input comes from. Two kinds, both turned into the same RecordSet by code:
//   - "file":    a CSV/XLSX file in the criteria's space, parsed by lib/tabular.ts;
//   - "records": an imported Phase 4 record set (records.ts) in the criteria's space, one exact
//                import version (the current one unless a version is named).
// Both are read through access.ts (read on the source's space) and must live in the criteria's
// own space. The ranking code only sees a RecordSet, so nothing else changes.
//
// A records set becomes a table the way its Excel file looked: fields = the column headers in
// the set's column order, rows in import row order (rowNo). Booleans become 1/0 (the ranking
// input is numbers/strings only). The snapshot hash is canonicalJson({fields, rows}) of exactly
// that, so the same import version always gives the same snapshot hash.

import type { Cell, Row } from "./ranking";

export type RecordRef = { kind: "file"; fileId: string } | { kind: "records"; recordSetId: string; version?: number };

/** Identifies exactly which bytes/rows a snapshot was taken from. */
export type RecordSourceInfo =
  | { kind: "file"; fileId: string; version: number; name: string; sha256: string | null }
  /** sha256 = hash of the imported Excel file of that version (recordImports.source.sha256). */
  | { kind: "records"; recordSetId: string; version: number; name: string; sha256: string | null };

export type RecordSet = { fields: string[]; rows: Row[]; source: RecordSourceInfo };

type Column = { key: string; header: string };
type StoredCell = string | number | boolean | null | undefined;

function cell(c: StoredCell): Cell {
  if (c === undefined || c === null || c === "") return null;
  if (typeof c === "boolean") return c ? 1 : 0;
  return c;
}

/** Rows of one record-set version → the table the ranking sees. Pure and deterministic. */
export function recordsToTable(columns: Column[], rows: { rowNo: number; data: Record<string, StoredCell> }[]): { fields: string[]; rows: Row[] } {
  const fields = columns.map((c) => c.header);
  const sorted = [...rows].sort((a, b) => a.rowNo - b.rowNo);
  return {
    fields,
    rows: sorted.map((r) => {
      const row: Row = {};
      for (const c of columns) row[c.header] = cell(r.data[c.key]);
      return row;
    }),
  };
}
