import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { analyzeBytes, createFromBytes } from "../records";
import type { AppTool, ToolContext } from "./types";

type Summary = {
  space: string;
  rows: number;
  columns: { header: string; type: string; required: boolean }[];
  owner: { header: string; kind: string; matched: number; distinct: number } | null;
  uniqueBy: string[];
  errors: string[];
};
type Args = { fileId: string; spaceId?: string; name?: string; summary?: Summary };

const TYPE_AR: Record<string, string> = { text: "نص", number: "رقم", date: "تاريخ", boolean: "نعم/لا" };

/** Reads the file and runs the same analysis as the records tab (records.analyzeBytes). */
async function analyse(t: ToolContext, args: Args) {
  const f = await t.ctx.runQuery(internal.records.fileForRecordSet, { userId: t.userId, fileId: String(args?.fileId ?? ""), spaceId: args?.spaceId ? String(args.spaceId) : undefined, scopeSpaceIds: t.scopeSpaceIds, scopeFileIds: t.scopeFileIds });
  if ("error" in f) return { error: f.error as string };
  const blob = await t.ctx.storage.get(f.storageId);
  if (!blob) return { error: "تعذّر قراءة الملف." };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const a = await analyzeBytes(t.ctx, t.userId, f.spaceId as Id<"spaces">, bytes, f.fileName);
  return { f, a, bytes };
}

/**
 * plans/17 §5: an Excel file shared in the chat becomes a record set. The model gives the file
 * (and the space when the file isn't in a shared one); the server reads the file and proposes
 * everything else (columns and types, the owner column, uniqueness), shown on the card. «نفّذ»
 * creates the set with every column and imports the file as version 1, or nothing on any error.
 * Only a manager of a shared space can; the values come from the file, never from the model.
 */
export const propose_record_set: AppTool<Args> = {
  name: "propose_record_set",
  label: "يقرأ ملف Excel ليجعله سجلاً…",
  description:
    "Turn an Excel (.xlsx) file the user shared into a record set (structured records such as courses, trainees, grades) in a shared space they manage. " +
    "Give the file id; give spaceId only when the file is not already in the shared space the records belong to; name is optional (default: the file name). " +
    "The server reads the file and proposes the columns, their types, the column that identifies each person (national id or employee number) and what must not repeat; " +
    "the user sees all of it and confirms. Use when the user asks to keep, adopt or import a spreadsheet as records (e.g. «اعتمد هذا الملف سجلاً للدورات»).",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["fileId"],
    properties: {
      fileId: { type: "string", description: "The id of the .xlsx file." },
      spaceId: { type: "string", description: "The shared space the record set goes to, if not the file's space." },
      name: { type: "string", description: "A name for the record set." },
    },
  },
  async prepare(t, args) {
    const r = await analyse(t, args);
    if ("error" in r) return { fileId: args.fileId, spaceId: args.spaceId, name: args.name, summary: { space: "", rows: 0, columns: [], owner: null, uniqueBy: [], errors: [r.error!] } };
    const { f, a } = r;
    return {
      fileId: args.fileId,
      spaceId: f.spaceId,
      name: (args.name ?? "").trim() || a.name,
      summary: { space: f.spaceName, rows: a.rowCount, columns: a.columns.map((c) => ({ header: c.header, type: c.type, required: c.required })), owner: a.owner, uniqueBy: a.uniqueBy, errors: a.errors },
    };
  },
  async run(t, args) {
    // Everything is computed again from the file: nothing on the card is taken from the model.
    const r = await analyse(t, args);
    if ("error" in r) return { content: r.error!, failed: true };
    const { f, a, bytes } = r;
    if (!a.ok) return { content: `رُفض الملف ولم يُنشأ شيء:\n${a.errors.join("\n")}`, failed: true };
    if (!a.owner) return { content: "لم نجد في الملف عموداً لأرقام الهوية أو الأرقام الوظيفية، فلا يُعرف صاحب كل سطر. أنشئ السجل من تبويب «السجلات» واختر العمود بنفسك.", failed: true };
    const name = (args.name ?? "").trim() || a.name;
    const res = await createFromBytes(
      t.ctx,
      t.userId,
      { spaceId: f.spaceId as Id<"spaces">, name, fileName: f.fileName, columns: a.columns.map((c) => ({ header: c.header, type: c.type, required: c.required })), ownerHeader: a.owner.header, ownerKind: a.owner.kind, uniqueBy: a.uniqueBy },
      bytes,
    );
    if (!res.ok) return { content: `رُفض الملف ولم يُنشأ شيء. الأخطاء (اشرحها للمستخدم وما يصحّحه في الملف أو في نوع العمود):\n${res.errors.join("\n")}`, failed: true };
    const cols = a.columns.map((c) => `${c.header} (${TYPE_AR[c.type]})`).join("، ");
    return {
      content: `أُنشئ السجل «${name}» في «${f.spaceName}» واستُورد ${res.rowCount} صف (النسخة 1). recordSetId=${res.recordSetId}. الأعمدة: ${cols}. صاحب السطر: ${a.owner.header}. يُعدَّل من تبويب «السجلات» في المساحة.`,
      display: `أُنشئ السجل «${name}» في «${f.spaceName}»: ${res.rowCount} صف.`,
      spaceIds: [f.spaceId],
    };
  },
};
