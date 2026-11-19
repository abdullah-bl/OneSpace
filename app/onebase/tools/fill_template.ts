import { internal } from "../_generated/api";
import type { AppTool } from "./types";

type Args = { templateId: string; recordId: string };

/**
 * Drafts an official document. The model picks the template and the record, nothing else: the
 * field values are copied from the record by code (documents.requestDocument), the layout is the
 * approved template version, and the draft still needs a space manager's approval before it can
 * be issued. Any other argument is ignored.
 */
export const fill_template: AppTool<Args> = {
  name: "fill_template",
  label: "يجهّز مسودة المستند…",
  description:
    "Prepare a draft official document (e.g. a certificate) from an approved template and one record. " +
    "You only choose templateId and recordId (find records with query_records). The content comes from the record; " +
    "a space manager must approve the draft before it is issued.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["templateId", "recordId"],
    properties: { templateId: { type: "string" }, recordId: { type: "string" } },
  },
  async run(t, args) {
    const r = await t.ctx.runMutation(internal.documents.requestForUser, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds,
      templateId: String(args?.templateId ?? ""),
      recordId: String(args?.recordId ?? ""),
      threadId: t.threadId,
    });
    const status = r.status === "issued" ? `صدر سابقاً برقم ${r.serial}` : r.status === "approved" ? "معتمدة وجاهزة للإصدار" : "مسودة بانتظار اعتماد مدير المساحة";
    return {
      content: `${r.existing ? "المستند موجود مسبقاً" : "أُنشئت مسودة المستند"}: ${status}. documentId=${r.documentId}. الحقول: ${JSON.stringify(r.data)}`,
      display: `${r.existing ? "المستند موجود مسبقاً" : "أُنشئت مسودة المستند"}: ${status}.`,
    };
  },
};
