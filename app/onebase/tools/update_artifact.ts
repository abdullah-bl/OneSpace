import { internal } from "../_generated/api";
import type { AppTool } from "./types";

type Args = {
  artifactId: string;
  content?: string;
  table?: { columns: string[]; rows: (string | number | boolean | null)[][] };
  title?: string;
  note?: string;
  sources?: { type: "file" | "recordSet" | "artifact"; id: string }[];
};

/** Adds a new version to an existing output (old versions stay). */
export const update_artifact: AppTool<Args> = {
  name: "update_artifact",
  label: "يحدّث المخرج…",
  description: "Save a new version of an existing output (same kind). Give the full new content, or `table` for tables. Previous versions are kept.",
  requiresConfirmation: true,
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
      title: args.title,
      note: args.note,
      sources,
    });
    return { content: `حُفظت النسخة ${r.version} من المخرج. artifactId=${r.artifactId}`, display: `حُفظت النسخة ${r.version}.`, undo: { restore: { artifactId: r.artifactId, version: r.version - 1 } }, artifactIds: [r.artifactId], spaceIds: [r.spaceId] };
  },
};
