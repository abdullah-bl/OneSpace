// Phase 4 data on top of the Phase 1 fixture: identifiers on accounts, a record set + import, an
// approved template, an issued document and table artifacts in every shared space, and an
// artifact in mem's personal space. Built through the public API only (tools via the admin-key
// tool harness, as the chat loop will call them).

import ExcelJS from "exceljs";
import { must, type Result, type Server } from "./harness";
import type { Fixture, SpaceKey } from "./fixture";

export const IDS = { mem: "1010101010", out: "3030303030", rdr: "2020202020", ghost: "9090909090" };
export const COURSE_HEADERS = ["رقم الهوية", "الاسم", "الدورة", "تاريخ الإتمام", "الساعات"];
export const COLUMNS = [
  { key: "nid", header: "رقم الهوية", type: "text", required: true },
  { key: "name", header: "الاسم", type: "text", required: true },
  { key: "course", header: "الدورة", type: "text", required: true },
  { key: "date", header: "تاريخ الإتمام", type: "date", required: true },
  { key: "hours", header: "الساعات", type: "number", required: false },
] as const;

export const COURSE_ROWS: (string | number | Date)[][] = [
  [IDS.mem, "موظف mem", "إدارة المشاريع", new Date(Date.UTC(2026, 0, 15)), 30],
  [IDS.mem, "موظف mem", "Excel المتقدم", "2026-03-02", 12],
  [IDS.out, "موظف out", "السلامة المهنية", "2026-02-10", 8],
  [IDS.ghost, "شخص-بلا-حساب-GH77", "التفاوض", "2026-04-20", 6],
];

export async function xlsxBase64(headers: string[], rows: unknown[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("بيانات");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r as any[]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString("base64");
}

export type OutputsFixture = {
  sets: Partial<Record<SpaceKey, string>>;
  templates: Partial<Record<SpaceKey, string>>;
  docs: Partial<Record<SpaceKey, string>>;
  artifacts: Record<SpaceKey, string>;
  recordOf: (space: SpaceKey, nid: string, course?: string) => Promise<string>;
};

export async function tool(s: Server, userId: string, name: string, args: any, scopeSpaceIds?: string[]): Promise<Result> {
  return s.adminRun("toolHarness:run", { userId, name, args, ...(scopeSpaceIds ? { scopeSpaceIds } : {}) });
}

export function layoutFor(title: string) {
  return JSON.stringify({
    page: { width: 842, height: 595 },
    elements: [
      { type: "text", text: title, x: 421, y: 470, size: 28, align: "center", bold: true },
      { type: "text", text: "تشهد الإدارة بأن", x: 421, y: 410, size: 16, align: "center" },
      { type: "field", field: "name", x: 421, y: 370, size: 22, align: "center", bold: true },
      { type: "field", field: "course", prefix: "أتم دورة: ", x: 421, y: 330, size: 16, align: "center" },
      { type: "field", field: "date", prefix: "بتاريخ ", x: 421, y: 300, size: 14, align: "center" },
      { type: "serial", prefix: "الرقم التسلسلي: ", x: 780, y: 50, size: 10, align: "right" },
      { type: "verifyCode", prefix: "رمز التحقق: ", x: 60, y: 50, size: 10, align: "left" },
      { type: "issuedDate", prefix: "تاريخ الإصدار: ", x: 780, y: 70, size: 10, align: "right" },
    ],
  });
}

export const FIELDS = [
  { key: "name", label: "الاسم" },
  { key: "course", label: "الدورة" },
  { key: "date", label: "التاريخ" },
];

export async function buildOutputs(s: Server, f: Fixture): Promise<OutputsFixture> {
  const admin = f.tokens.admin!;
  must(await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.mem, nationalId: IDS.mem }, admin));
  must(await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.out, nationalId: IDS.out }, admin));
  must(await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.rdr, nationalId: IDS.rdr }, admin));

  const mgr = f.tokens.mgr!;
  const mem = f.tokens.mem!;
  const sets: OutputsFixture["sets"] = {};
  const templates: OutputsFixture["templates"] = {};
  const docs: OutputsFixture["docs"] = {};
  const artifacts = {} as Record<SpaceKey, string>;
  const data = await xlsxBase64(COURSE_HEADERS, COURSE_ROWS);
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
    sets[sp] = must(
      await s.call("mutation", "records:createSet", { spaceId: f.spaces[sp], name: `دورات ${sp}`, columns: COLUMNS, subjectColumn: "nid", subjectKind: "nationalId", uniqueBy: ["nid", "course"] }, mgr),
    );
    must(await s.call("action", "records:commitImport", { recordSetId: sets[sp], fileName: "courses.xlsx", dataBase64: data }, mgr));
    const saved = must(
      await s.call("action", "templates:saveVersion", { spaceId: f.spaces[sp], name: `شهادة ${sp}`, layout: layoutFor("شهادة إتمام دورة"), fieldsSchema: FIELDS, dataBinding: { recordSetId: sets[sp], fields: { name: "name", course: "course", date: "date" } } }, mgr),
    );
    templates[sp] = saved.templateId;
    must(await s.call("mutation", "templates:approveVersion", { templateId: saved.templateId, version: saved.version }, mgr));
    artifacts[sp] = must(await s.call("mutation", "artifacts:create", { title: `جدول ${sp}`, kind: "table", content: JSON.stringify({ columns: ["أ", "ب"], rows: [["1", 2]] }), spaceId: f.spaces[sp] }, mgr)).artifactId;
  }
  artifacts.P_mem = must(await s.call("mutation", "artifacts:create", { title: "جدولي", kind: "table", content: JSON.stringify({ columns: ["x"], rows: [["y"]] }) }, mem)).artifactId;

  const recordOf = async (sp: SpaceKey, nid: string, course?: string) => {
    const r = must(await s.call("query", "records:rows", { recordSetId: sets[sp] }, mgr));
    const row = r.rows.find((x: any) => x.data.nid === nid && (!course || x.data.course === course));
    if (!row) throw new Error("no record " + nid);
    return row.recordId as string;
  };
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
    const draft = must(await s.call("mutation", "documents:request", { templateId: templates[sp], recordId: await recordOf(sp, IDS.mem, "إدارة المشاريع") }, mem));
    must(await s.call("mutation", "documents:approve", { documentId: draft.documentId }, mgr));
    must(await s.call("action", "documents:issue", { documentId: draft.documentId }, mem));
    docs[sp] = draft.documentId;
  }
  return { sets, templates, docs, artifacts, recordOf };
}
