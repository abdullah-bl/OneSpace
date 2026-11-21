import { internal } from "../_generated/api";
import type { AppTool } from "./types";

type Args = { templateId: string; recordId?: string; recordIds?: string[]; summary?: { template: string; count: number; people: string[]; existing?: number; error?: string } };

const idsOf = (a: Args) => [...new Set([...(Array.isArray(a?.recordIds) ? a.recordIds : []), ...(a?.recordId ? [a.recordId] : [])].map(String).filter(Boolean))];

/**
 * Drafts official documents (e.g. certificates) from an approved template, for one record or
 * many (plans/17 §5: «أصدر شهادات دورة السلامة لمن أنهاها هذا الشهر» → query_records, then one
 * fill_template with their ids). The model picks the template and the records, nothing else: the
 * field values are copied from each record by code (documents.requestDocument), and every draft
 * still needs a space manager's approval before it is issued. Any other argument is ignored.
 */
export const fill_template: AppTool<Args> = {
  name: "fill_template",
  label: "يجهّز مسودات المستندات…",
  description:
    "Prepare draft official documents (e.g. certificates) from an approved template, for one record or several (up to 50). " +
    "You only choose templateId and the records' ids (recordIds; find them with query_records). The content comes from each record; " +
    "a space manager approves the drafts and issues them in one step.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["templateId"],
    properties: {
      templateId: { type: "string", description: "The approved template's id, or its exact name (e.g. «شهادة حضور»)." },
      recordIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "The records to draft a document for." },
      recordId: { type: "string", description: "One record (same as recordIds with one id)." },
    },
  },
  async prepare(t, args) {
    const recordIds = idsOf(args);
    const base = { templateId: String(args?.templateId ?? ""), recordIds };
    try {
      const { templateId, ...summary } = await t.ctx.runQuery(internal.documents.fillSummary, { userId: t.userId, scopeSpaceIds: t.scopeSpaceIds, templateId: base.templateId, recordIds });
      // The card pins the resolved id: «نفّذ» drafts from exactly the template shown.
      return { ...base, templateId, summary };
    } catch (e) {
      const m = e instanceof Error ? e.message.replace(/^.*Uncaught (OneBaseError: )?/, "").split("\n")[0]! : "";
      return { ...base, summary: { template: "", count: recordIds.length, people: [], error: m.includes("القوالب المعتمدة") ? m : "القالب غير موجود أو لا تملك صلاحية عليه" } };
    }
  },
  async run(t, args) {
    const recordIds = idsOf(args);
    if (recordIds.length === 0) return { content: "اختر سجلاً واحداً على الأقل (recordIds).", failed: true };
    const r = await t.ctx.runMutation(internal.documents.requestManyForUser, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds,
      templateId: String(args?.templateId ?? ""),
      recordIds,
      threadId: t.threadId,
    });
    const made = r.filter((d) => !d.existing).length;
    const issued = r.filter((d) => d.status === "issued");
    const waiting = r.filter((d) => d.status === "draft").length;
    const parts = [made ? `أُنشئت ${made} مسودة` : "لم تُنشأ مسودات جديدة", waiting ? `${waiting} بانتظار اعتماد مدير المساحة` : "", issued.length ? `${issued.length} صدرت سابقاً (${issued.map((d) => d.serial).join("، ")})` : ""].filter(Boolean);
    return {
      content: `${parts.join("؛ ")}. يعتمدها المدير ويصدرها من «القوالب والمستندات» بخطوة واحدة. documentIds=${r.map((d) => d.documentId).join(",")}`,
      display: `${parts.join("؛ ")}.`,
    };
  },
};
