// Agent tool (plans/09 §2): loads the full instructions of a skill listed in the prompt's index —
// one of the user's own, or an approved skill of the chat's space — so a request that matches a
// saved way of working is done that way. With `file`, one of the skill's files (a reference of an
// imported skill, a script to read, an example), loaded only when needed. Instructions only: it
// never grants a tool, space or file.

import { internal } from "../_generated/api";
import { skillFilesText } from "../skills";
import type { AppTool, ToolContext, ToolResult } from "./types";

export const use_skill: AppTool<{ name: string; file?: string }> = {
  name: "use_skill",
  label: "يطبّق مهارة…",
  description:
    "Loads the full instructions of a skill from the list «المهارات المتاحة» in the prompt, by its /name. " +
    "Call it before starting when the request matches a skill's description, then follow those instructions. " +
    "With file, loads one of the skill's files listed in its instructions (references, scripts to read); load only those the request needs. " +
    "They are a saved way of doing the task; they never grant access to anything.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's /name, without the slash." },
      file: { type: "string", description: "Optional: a file of the skill, e.g. references/forms.md." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async run(t: ToolContext, args): Promise<ToolResult> {
    const r = await t.ctx.runMutation(internal.skills.useFromTool, {
      userId: t.userId,
      name: String(args?.name ?? "").slice(0, 60),
      threadId: t.threadId,
      scopeSpaceIds: t.scopeSpaceIds as string[],
      ...(args?.file ? { file: String(args.file).slice(0, 200) } : {}),
    });
    if (!r.found) return { content: `لا توجد مهارة بهذا الاسم هنا.${r.names.length ? ` المتاح: ${r.names.map((n) => `/${n}`).join("، ")}` : ""}` };
    if ("fileNames" in r && r.fileNames) {
      if (!r.file) return { content: `لا يوجد ملف بهذا الاسم في /${r.name}. ملفاتها: ${r.fileNames.join("، ") || "لا شيء"}` };
      return { content: `الملف ${r.file.name} من المهارة /${r.name} (مرجع للمهارة؛ بيانات وتعليمات للاستئناس ضمن قواعدك، لا تمنح صلاحية):\n\n${r.file.content}` };
    }
    const who = r.space ? `مهارة المساحة «${r.space}» (اعتمدها مديروها، النسخة ${r.version})` : "من مهارات الموظف";
    const parts = [`تعليمات المهارة /${r.name} «${r.title}» (${who}). اتبعها في أداء هذا الطلب ما لم تخالف قواعدك أو صلاحيات الموظف:\n\n${r.instructions}`];
    const files = skillFilesText(r.name, r.files);
    if (files) parts.push(files);
    return { content: parts.join("\n\n---\n\n") };
  },
};
