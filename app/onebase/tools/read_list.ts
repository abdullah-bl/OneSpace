// Agent tool (plans/10): reads a live list (by listId from the prompt's index, or by title) as a
// table with row ids, so the assistant can answer from it or change it with update_list.

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

export const read_list: AppTool<{ listId?: string; title?: string }> = {
  name: "read_list",
  label: "يقرأ القائمة…",
  description:
    "Reads a live list («قائمة») with its rows and row ids: by listId (from «القوائم الحية هنا» in the prompt) or by its title. " +
    "Use it to answer about the user's tasks or tracked items, or before update_list.",
  parameters: { type: "object", additionalProperties: false, properties: { listId: { type: "string" }, title: { type: "string" } } },
  async run(t: ToolContext, a): Promise<ToolResult> {
    const r = await t.ctx.runQuery(internal.lists.readForTool, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds as string[],
      ...(a?.listId ? { listId: String(a.listId) } : {}),
      ...(a?.title ? { title: String(a.title).slice(0, 120) } : {}),
    });
    return { content: r.ok ? r.text : `تعذّرت قراءة القائمة: ${r.error}` };
  },
};
