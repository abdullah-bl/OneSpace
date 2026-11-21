// Agent tool (plans/10): makes a live list («قائمة») instead of a static table, when the user will
// track or update the items: tasks, a follow-up register, attendance, a plan to tick off. It lands
// in the chat's space if the user can write there, else their personal space. In the personal space
// it runs at once with «تراجع»; anywhere else it is a card (tiers.ts).

import { internal } from "../_generated/api";
import { toolErrorText } from "./errors";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = { title: string; description?: string; columns: { name: string; type: string; options?: string[] }[]; rows?: Record<string, unknown>[] };

export const create_list: AppTool<Args> = {
  name: "create_list",
  label: "ينشئ قائمة…",
  requiresConfirmation: true,
  description:
    "Creates a live list («قائمة»: a table the user edits in place, like a Notion database) with typed columns and rows. " +
    "Use it — not create_artifact — whenever the result is items the user will track, tick off or come back to: tasks, priorities, a follow-up register, attendance, a checklist, a plan. " +
    "Column types: text, number, date (YYYY-MM-DD), status (options, default لم تبدأ/قيد التنفيذ/منجزة), select (options), person (a name of someone in the space), check (true/false). " +
    "rows: objects keyed by column name. Keep it lean: the columns the user needs, at most ~8. It is saved in the chat's space (or the user's personal space). " +
    "After it is made, give the user its link as a markdown link [title](#/list/<listId>) with a sentence or two; don't repeat its rows as a table in your answer (the list is the table). " +
    "For later changes, use update_list on the same list instead of making a new one. " +
    "A list is also where an app's results go (write_app data grants) or a published form's replies: one column per value to keep (select with the options for a choice, number for a score, text for open answers), " +
    "plus a person column «المرسل» when who sent it matters.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["title", "columns"],
    properties: {
      title: { type: "string", maxLength: 120 },
      description: { type: "string", maxLength: 500 },
      columns: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type"],
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["text", "number", "date", "status", "select", "person", "check"] },
            options: { type: "array", items: { type: "string" } },
          },
        },
      },
      rows: { type: "array", maxItems: 500, items: { type: "object" } },
    },
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    let r;
    try {
      r = await t.ctx.runMutation(internal.lists.createFromTool, {
        userId: t.userId,
        threadId: t.threadId,
        scopeSpaceIds: t.scopeSpaceIds as string[],
        title: String(a?.title ?? ""),
        description: a?.description ? String(a.description) : undefined,
        columns: Array.isArray(a?.columns) ? a.columns.map((c) => ({ name: String(c?.name ?? ""), type: String(c?.type ?? "text"), ...(Array.isArray(c?.options) ? { options: c.options.map(String) } : {}) })) : [],
        rows: Array.isArray(a?.rows) ? a.rows.filter((x) => x && typeof x === "object") : [],
      });
    } catch (e) {
      const error = toolErrorText(e, "لا تملك إنشاء قائمة هنا");
      return { failed: true, content: `لم تُنشأ القائمة: ${error}`, display: `لم تُنشأ القائمة: ${error}` };
    }
    const msg = `أُنشئت القائمة «${a.title}» في ${r.spaceName === "مساحتي" ? "مساحتي" : `«${r.spaceName}»`} (${r.rows} صف).`;
    return {
      content: `${msg} listId=${r.id}. رابطها للمستخدم: [${a.title}](#/list/${r.id})`,
      display: `${msg} #/list/${r.id}`,
      spaceIds: [r.spaceId],
      undo: { deleteLists: [r.id] },
    };
  },
};
