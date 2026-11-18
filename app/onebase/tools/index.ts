// Registry of every agent tool. Admins pick from this list when defining an agent (Phase 6);
// they never write tools. Add each new tool here.

import type { AppTool } from "./types";
import { create_artifact } from "./create_artifact";
import { update_artifact } from "./update_artifact";
import { query_records } from "./query_records";
import { my_records } from "./my_records";
import { fill_template } from "./fill_template";

export const tools: Record<string, AppTool> = {
  // Phase 4: outputs, records, templates
  create_artifact,
  update_artifact,
  query_records,
  my_records,
  fill_template,
};

export function getTool(name: string): AppTool | undefined {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}
