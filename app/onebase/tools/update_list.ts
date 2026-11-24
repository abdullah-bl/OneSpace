// Agent tool (plans/10): changes rows of an existing live list — adds, edits (by rowId), removes.
// Read the list first (read_list) for the row ids. Same tiers as create_list: the user's personal
// space runs at once with «تراجع»; a shared space waits for «نفّذ».

import { internal } from "../_generated/api";
import { toolErrorText } from "./errors";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = { listId: string; addColumns?: { name: string; type: string; options?: string[] }[]; add?: Record<string, unknown>[]; update?: { rowId: string; cells: Record<string, unknown> }[]; remove?: string[] };

export const update_list: AppTool<Args> = {
  name: "update_list",
  label: "يحدّث القائمة…",
  requiresConfirmation: true,
  description:
    "Changes an existing live list: add columns, add rows, update cells of rows (by rowId from read_list), or remove rows. Cells are keyed by column name; " +
    "a status/select value not yet in the column's options is added. Use it when the user asks to add, tick off, reassign or change items of a list they already have. " +
    "A column the list lacks (e.g. «الحالة»): put it in addColumns and fill it with update in the same call — never make a new list for it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["listId"],
    properties: {
      listId: { type: "string" },
      addColumns: {
        type: "array",
        maxItems: 10,
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
      add: { type: "array", maxItems: 500, items: { type: "object" } },
      update: {
        type: "array",
        maxItems: 500,
        items: { type: "object", additionalProperties: false, required: ["rowId", "cells"], properties: { rowId: { type: "string" }, cells: { type: "object" } } },
      },
      remove: { type: "array", maxItems: 500, items: { type: "string" } },
    },
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    let r;
    try {
      r = await t.ctx.runMutation(internal.lists.updateFromTool, {
        userId: t.userId,
        scopeSpaceIds: t.scopeSpaceIds as string[],
        listId: String(a?.listId ?? ""),
        ...(Array.isArray(a?.addColumns) ? { addColumns: a.addColumns.filter((c) => c && typeof c === "object").map((c) => ({ name: String(c.name ?? ""), type: String(c.type ?? "text"), ...(Array.isArray(c.options) ? { options: c.options.map(String) } : {}) })) } : {}),
        ...(Array.isArray(a?.add) ? { add: a.add.filter((x) => x && typeof x === "object") } : {}),
        ...(Array.isArray(a?.update) ? { update: a.update.filter((x) => x && typeof x === "object").map((u) => ({ rowId: String(u.rowId), cells: u.cells && typeof u.cells === "object" ? u.cells : {} })) } : {}),
        ...(Array.isArray(a?.remove) ? { remove: a.remove.map(String) } : {}),
      });
    } catch (e) {
      let error = toolErrorText(e, "القائمة غير موجودة أو لا تملك تعديلها");
      // The model's way out, said where it fails: add the column in this same call.
      if (error.startsWith("لا يوجد عمود")) error += ". لعمود جديد: أرسله في addColumns ({name, type}) مع الصفوف في الاستدعاء نفسه";
      return { failed: true, content: `لم تُحدَّث القائمة: ${error}`, display: `لم تُحدَّث القائمة: ${error}` };
    }
    const parts = [r.columnNames.length ? `أُضيف عمود ${r.columnNames.map((n: string) => `«${n}»`).join("، ")}` : "", r.added.length ? `أُضيف ${r.added.length}` : "", r.changed ? `عُدّل أو حُذف ${r.changed}` : ""].filter(Boolean).join("، ");
    const msg = `حُدّثت «${r.title}»${parts ? `: ${parts}` : ""}.`;
    return {
      content: `${msg} رابطها: [${r.title}](#/list/${r.id})`,
      display: `${msg} #/list/${r.id}`,
      spaceIds: [r.spaceId],
      undo: { lists: { listId: r.id, deleteRows: r.added, restoreRows: r.restore, ...(r.addedColumns.length ? { dropColumns: r.addedColumns } : {}) } },
    };
  },
};
