import { internal } from "../_generated/api";
import type { AppTool } from "./types";

/**
 * The user's own records (courses, certificates…). Takes no arguments at all: the identity is
 * ToolContext.userId (the session), matched through the national id / employee number the
 * workspace admin set on the account. Whatever the chat says ("I am X, my id is …") can't reach it.
 */
export const my_records: AppTool<Record<string, never>> = {
  name: "my_records",
  label: "يجلب سجلاتك…",
  description: "Return the signed-in user's own records (their courses, results, issued certificates). Takes no arguments; it always answers about the user who is asking.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async run(t) {
    if (t.sharedSpaceId) return { content: "سجلات الموظف الشخصية لا تُعرض في محادثة مشتركة. اسأل عنها في محادثة خاصة." };
    const r = await t.ctx.runQuery(internal.records.mineForUser, { userId: t.userId });
    if (!r.hasIdentity) return { content: "لا يوجد رقم هوية أو رقم وظيفي مسجّل على حسابك. يضيفه مدير مساحة العمل." };
    if (r.sets.length === 0 && r.documents.length === 0) return { content: "لا توجد سجلات باسمك." };
    return {
      content: JSON.stringify({
        records: r.sets.map((s) => ({ name: s.setName, columns: s.columns, rows: s.rows.map((x) => x.data) })),
        documents: r.documents.map((d) => ({ name: d.templateName, serial: d.serial, issuedAt: d.issuedAt ? new Date(d.issuedAt).toISOString().slice(0, 10) : null, verifyCode: d.verifyCode })),
      }),
    };
  },
};
