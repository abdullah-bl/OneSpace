import { internal } from "../_generated/api";
import type { AppTool } from "./types";

type Args = {
  title: string;
  kind: "markdown" | "html" | "table";
  content?: string;
  table?: { columns: string[]; rows: (string | number | boolean | null)[][] };
  sources?: { type: "file" | "recordSet" | "artifact"; id: string }[];
  spaceId?: string;
};

/** Saves an output in the side panel. Where it is saved follows its sources (artifacts.ts). */
export const create_artifact: AppTool<Args> = {
  name: "create_artifact",
  label: "يُنشئ مخرجاً…",
  description:
    "Create an output shown in the side panel: a Markdown document, an HTML page (rendered sandboxed: no network, and its own <script> doesn't run), or a table. " +
    "Every table in an output is interactive automatically: a search box, sortable columns and a row count. So for a searchable or sortable page of data, " +
    "make a table output (or an HTML page with a <table>) — never paste page code into the chat. For a whole spreadsheet, use run_analysis to write the HTML/CSV to /output. " +
    "List the files/record sets/artifacts it was built from in `sources`; it is saved in their space (or the user's personal space). " +
    "Outputs are not official documents: certificates are only produced with fill_template.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["title", "kind"],
    properties: {
      title: { type: "string", maxLength: 200 },
      kind: { type: "string", enum: ["markdown", "html", "table"] },
      content: { type: "string", description: "Markdown or HTML text (kind markdown/html)." },
      table: {
        type: "object",
        description: "For kind=table.",
        additionalProperties: false,
        required: ["columns", "rows"],
        properties: {
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } } },
        },
      },
      sources: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { type: "string", enum: ["file", "recordSet", "artifact"] }, id: { type: "string" } } },
      },
      spaceId: { type: "string", description: "Optional target space; must be the sources' space or the personal space." },
    },
  },
  async run(t, args) {
    const content = args.kind === "table" ? (args.table ?? args.content) : args.content;
    if (typeof content === "string" ? !content.trim() : !content) throw new Error("المخرج فارغ: اكتب محتواه كاملاً");
    const sources = Array.isArray(args.sources) ? args.sources.map((s) => ({ type: s.type, id: String(s.id) })) : undefined;
    const r = await t.ctx.runMutation(internal.artifacts.createForUser, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds,
      threadId: t.threadId,
      title: String(args.title ?? ""),
      kind: args.kind,
      content: content ?? "",
      sources,
      spaceId: args.spaceId,
    });
    return {
      content: `أُنشئ المخرج "${args.title}" (النسخة 1)${r.classification === "sensitive" ? "، وهو مبني على مساحة حسّاسة فيبقى فيها" : ""}. artifactId=${r.artifactId}`,
      display: `أُنشئ «${args.title}»${r.classification === "sensitive" ? "، ويبقى في المساحة الحسّاسة التي بُني عليها" : ""}.`,
      artifactIds: [r.artifactId],
      spaceIds: [r.spaceId],
      undo: { deleteArtifacts: [r.artifactId] },
    };
  },
};
