// Agent tool: a new task in a shared space, assigned to people by name (tasks.ts checkTaskCall).
// Only the space's manager creates tasks, as on the screen. It notifies the assignees, so it always
// waits for «نفّذ» (tiers.ts); the card shows the space, the people and the date in words.

import { internal } from "../_generated/api";
import { toolErrorText } from "./errors";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = { title: string; description?: string; assignees: string[]; space?: string; due?: string; priority?: string; summary?: unknown };

/** The chat's own space, when it is in one (a space chat's scope is that space alone). */
export const chatSpaceOf = (t: ToolContext): string | null => (t.sharedSpaceId as string | undefined) ?? (t.scopeSpaceIds.length === 1 ? (t.scopeSpaceIds[0] as string) : null);

export const create_task: AppTool<Args> = {
  name: "create_task",
  label: "يُنشئ مهمة…",
  requiresConfirmation: true,
  description:
    "Creates a task in a shared space and assigns it to people by name (only the space's manager can). Use it when the user asks to create, assign or delegate a task («أسند لـ…», «سوّ مهمة…»). " +
    "space: the space's name (default: this chat's space, or the only one they manage). due: YYYY-MM-DD. The assignees are notified after the user confirms.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["title", "assignees"],
    properties: {
      title: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 10000 },
      assignees: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "People's names as the user said them." },
      space: { type: "string" },
      due: { type: "string", description: "YYYY-MM-DD" },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    },
  },
  async prepare(t: ToolContext, a: Args): Promise<Args> {
    // What the card shows: resolved by the server, never the model's words.
    try {
      const summary = await t.ctx.runQuery(internal.tasks.describeForTool, { userId: t.userId, tool: "create_task", args: { ...a, summary: undefined }, scopeSpaceIds: t.scopeSpaceIds as string[], chatSpaceId: chatSpaceOf(t) });
      return { ...a, summary };
    } catch {
      return { ...a, summary: undefined };
    }
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    try {
      const r = await t.ctx.runMutation(internal.tasks.runForTool, { userId: t.userId, tool: "create_task", args: { ...a, summary: undefined }, scopeSpaceIds: t.scopeSpaceIds as string[], chatSpaceId: chatSpaceOf(t) });
      const msg = `المهمة «${r.title}» في «${r.spaceName}»: ${r.done.join("، ")}.`;
      return { content: `${msg} taskId=${r.taskId}`, display: `${msg} #/tasks/${r.taskId}`, spaceIds: [r.spaceId] };
    } catch (e) {
      const error = toolErrorText(e, "تعذّر إنشاء المهمة");
      return { failed: true, content: `لم تُنشأ المهمة: ${error}`, display: `لم تُنشأ المهمة: ${error}` };
    }
  },
};
