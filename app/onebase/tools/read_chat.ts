// Agent tool (plans/15): reads this chat's own older messages word for word. A long chat reaches
// the model as a summary plus its newest messages; when the summary lacks a detail (a number, a
// name, the text of a pasted message), the model looks it up here instead of guessing. This chat
// only, read-only: nothing the user couldn't already scroll up to.

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

export const read_chat: AppTool<{ query?: string; at?: "start" | "end"; message?: number }> = {
  name: "read_chat",
  label: "يراجع أول المحادثة…",
  description:
    "Reads older messages of THIS chat word for word: the ones that match `query` (words to look for), the first ones (`at: start`), " +
    "or one by its number (`message`, from an earlier result). Use it when the chat summary lacks a detail you need, such as an exact number, " +
    "name, or the full text of a long pasted message; never guess it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Words to look for, e.g. «الميزانية» or a name." },
      at: { type: "string", enum: ["start", "end"], description: "start: the first messages of the chat." },
      message: { type: "number", description: "A message number from an earlier read_chat result." },
    },
  },
  async run(t: ToolContext, a): Promise<ToolResult> {
    if (!t.threadId) return { content: "لا محادثة هنا." };
    const r = await t.ctx.runQuery(internal.chat.readForTool, {
      userId: t.userId,
      threadId: t.threadId,
      ...(a?.query ? { query: String(a.query).slice(0, 200) } : {}),
      ...(a?.at === "start" || a?.at === "end" ? { at: a.at } : {}),
      ...(typeof a?.message === "number" ? { message: Math.floor(a.message) } : {}),
    });
    return { content: r };
  },
};
