// Where ranking input comes from. For now: a CSV/XLSX file uploaded to a space, parsed by code.
// Phase 4 adds real `records_*` tables (Excel import); after the merge add a source here
// ({ kind: "records", table, spaceId, filter? }) that reads those rows through access.ts. The
// ranking code only sees a RecordSet, so nothing else changes.

import type { Row } from "./ranking";

export type RecordRef = { kind: "file"; fileId: string };

/** Identifies exactly which bytes/rows a snapshot was taken from. */
export type RecordSourceInfo = { kind: "file"; fileId: string; version: number; name: string; sha256: string | null };

export type RecordSet = { fields: string[]; rows: Row[]; source: RecordSourceInfo };
