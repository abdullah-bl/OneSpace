// Agent tool: changes a task the user can see (tasks.ts checkTaskCall): moves its status along the
// same flow as the screen (an assignee forwards it, a manager also closes, returns and reopens),
// comments, attaches a file or output from the task's space, or (manager) reassigns it and changes
// its date or priority. Others are notified, so it always waits for «نفّذ».

import { internal } from "../_generated/api";
import { chatSpaceOf } from "./create_task";
import { toolErrorText } from "./errors";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = {
  task: string;
  status?: string;
  comment?: string;
  assignees?: string[];
  due?: string | null;
  priority?: string;
  attach?: { type: "file" | "artifact"; id: string }[];
  summary?: unknown;
};

export const update_task: AppTool<Args> = {
  name: "update_task",
  label: "يحدّث مهمة…",
  requiresConfirmation: true,
  description:
    "Changes an existing task: status (new → inProgress → review; a manager also done or back to inProgress), a comment, attachments from the task's own space, " +
    "or (manager only) assignees, due (YYYY-MM-DD, null clears) and priority. task: its taskId from read_tasks, or its title. Send only what changes.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task"],
    properties: {
      task: { type: "string" },
      status: { type: "string", enum: ["new", "inProgress", "review", "done"] },
      comment: { type: "string", maxLength: 5000 },
      assignees: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
      due: { type: ["string", "null"] },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      attach: {
        type: "array",
        maxItems: 10,
        items: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { type: "string", enum: ["file", "artifact"] }, id: { type: "string" } } },
      },
    },
  },
  async prepare(t: ToolContext, a: Args): Promise<Args> {
    try {
      const summary = await t.ctx.runQuery(internal.tasks.describeForTool, { userId: t.userId, tool: "update_task", args: { ...a, summary: undefined }, scopeSpaceIds: t.scopeSpaceIds as string[], chatSpaceId: chatSpaceOf(t) });
      return { ...a, summary };
    } catch {
      return { ...a, summary: undefined };
    }
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    try {
      const r = await t.ctx.runMutation(internal.tasks.runForTool, { userId: t.userId, tool: "update_task", args: { ...a, summary: undefined }, scopeSpaceIds: t.scopeSpaceIds as string[], chatSpaceId: chatSpaceOf(t) });
      const msg = `المهمة «${r.title}»: ${r.done.join("، ")}.`;
      return { content: `${msg} taskId=${r.taskId}`, display: `${msg} #/tasks/${r.taskId}`, spaceIds: [r.spaceId] };
    } catch (e) {
      const error = toolErrorText(e, "تعذّر تحديث المهمة");
      return { failed: true, content: `لم تُحدَّث المهمة: ${error}`, display: `لم تُحدَّث المهمة: ${error}` };
    }
  },
};
