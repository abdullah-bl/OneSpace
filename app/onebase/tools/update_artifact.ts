import { internal } from "../_generated/api";
import type { AppTool } from "./types";

type Args = {
  artifactId: string;
  content?: string;
  table?: { columns: string[]; rows: (string | number | boolean | null)[][] };
  renameColumns?: Record<string, string>;
  removeColumns?: string[];
  title?: string;
  note?: string;
  sources?: { type: "file" | "recordSet" | "artifact"; id: string }[];
};

/** Adds a new version to an existing output (old versions stay). */
export const update_artifact: AppTool<Args> = {
  name: "update_artifact",
  label: "يحدّث المخرج…",
  description:
    "Save a new version of an existing output (same kind). Give the full new content, or `table` for tables (all rows, not only the changed ones). " +
    "To rename or drop table columns, send only renameColumns ({old: new}) and/or removeColumns — the rows are kept. Previous versions are kept.",
  requiresConfirmation: true,
  // Seven calls in a row with only artifactId and a note (gov demo, 2026-11-24): turned back here, with the ways out.
  checkArgs: (a) =>
    a?.table || (typeof a?.content === "string" && a.content.trim()) || (a?.renameColumns && Object.keys(a.renameColumns).length) || a?.removeColumns?.length
      ? null
      : "لم يصل المحتوى الجديد: لجدول أرسل table كاملاً {columns, rows} بكل الصفوف، أو renameColumns / removeColumns فقط لتسمية عمود أو حذفه؛ ولغير الجدول أرسل content كاملاً",
  edits: (args) => (args?.artifactId ? String(args.artifactId) : null),
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string" },
      content: { type: "string" },
      table: {
        type: "object",
        additionalProperties: false,
        required: ["columns", "rows"],
        properties: {
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } } },
        },
      },
      renameColumns: { type: "object", additionalProperties: { type: "string" }, description: "Table only: {current column name: new name}." },
      removeColumns: { type: "array", items: { type: "string" }, description: "Table only: column names to drop." },
      title: { type: "string", maxLength: 200 },
      note: { type: "string", maxLength: 500, description: "What changed." },
      sources: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { type: "string", enum: ["file", "recordSet", "artifact"] }, id: { type: "string" } } },
      },
    },
  },
  async run(t, args) {
    const sources = Array.isArray(args.sources) ? args.sources.map((s) => ({ type: s.type, id: String(s.id) })) : undefined;
    const r = await t.ctx.runMutation(internal.artifacts.updateForUser, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds,
      artifactId: String(args.artifactId ?? ""),
      content: args.table ?? args.content ?? "",
      ...(args.renameColumns || args.removeColumns ? { tableEdit: { ...(args.renameColumns ? { renameColumns: Object.fromEntries(Object.entries(args.renameColumns).map(([k, v]) => [k, String(v)])) } : {}), ...(Array.isArray(args.removeColumns) ? { removeColumns: args.removeColumns.map(String) } : {}) } } : {}),
      title: args.title,
      note: args.note,
      sources,
      expectVersion: t.expectVersion,
    });
    return { content: `حُفظت النسخة ${r.version} من المخرج. artifactId=${r.artifactId}`, display: `حُفظت النسخة ${r.version}.`, undo: { restore: { artifactId: r.artifactId, version: r.version - 1 } }, artifactIds: [r.artifactId], spaceIds: [r.spaceId], version: r.version };
  },
};
