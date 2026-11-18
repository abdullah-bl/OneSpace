// Registry of every agent tool. Admins pick from this list when defining an agent (Phase 6);
// they never write tools. Add each new tool here.

import type { AppTool } from "./types";
import { runAnalysisTool } from "./run_analysis";

export const tools: Record<string, AppTool> = {
  run_analysis: runAnalysisTool,
};

export function getTool(name: string): AppTool | undefined {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}
