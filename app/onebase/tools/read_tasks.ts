// Agent tool: reads the tasks assigned to the user («مهامي»: status, priority, due date, space), so
// «كم عندي مهام؟» or «وش المستعجل؟» is answered from them instead of from the files. The same reach as
// the «مهامي» page, narrowed to the turn's spaces; in a shared chat, only that space's. Read-only.

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

export const read_tasks: AppTool<{ includeDone?: boolean }> = {
  name: "read_tasks",
  label: "يقرأ المهام…",
  description:
    "Reads the tasks assigned to the user in their spaces (title, status, priority, due date, space). Use it for any question about their tasks or what is due; " +
    "tasks are not in the files. includeDone also lists finished ones.",
  parameters: { type: "object", additionalProperties: false, properties: { includeDone: { type: "boolean" } } },
  async run(t: ToolContext, a): Promise<ToolResult> {
    const content = await t.ctx.runQuery(internal.tasks.readForTool, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds as string[],
      ...(t.sharedSpaceId ? { sharedSpaceId: t.sharedSpaceId as string } : {}),
      ...(a?.includeDone ? { includeDone: true } : {}),
    });
    return { content };
  },
};
