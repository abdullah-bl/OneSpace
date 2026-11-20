// Agent tool (plans/13): reads an app's files (all, or one in full) and its grants, to change it.

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

export const read_app: AppTool<{ appId: string; path?: string }> = {
  name: "read_app",
  label: "يقرأ ملفات التطبيق…",
  description: "Reads an app made with write_app: all its files and the lists it may use, or one file in full (path). Use it before changing an app you didn't write in this answer.",
  parameters: { type: "object", additionalProperties: false, required: ["appId"], properties: { appId: { type: "string" }, path: { type: "string" } } },
  async run(t: ToolContext, a): Promise<ToolResult> {
    const r = await t.ctx.runQuery(internal.apps.readForTool, { userId: t.userId, scopeSpaceIds: t.scopeSpaceIds as string[], appId: String(a?.appId ?? ""), ...(a?.path ? { path: String(a.path) } : {}) });
    return { content: r.text };
  },
};
