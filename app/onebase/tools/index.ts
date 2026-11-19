// Registry of every agent tool. Admins pick from this list when defining an agent (Phase 6);
// they never write tools. Add each new tool here.

import { readFileTool } from "./read_file";
import { searchDocumentsTool } from "./search_documents";
import type { AppTool } from "./types";
import { runAnalysisTool } from "./run_analysis";
import { create_artifact } from "./create_artifact";
import { update_artifact } from "./update_artifact";
import { query_records } from "./query_records";
import { my_records } from "./my_records";
import { fill_template } from "./fill_template";
import { export_document } from "./export_document";
import { query_source } from "./query_source";
import { remember } from "./remember";
import { recall } from "./recall";
import { create_skill } from "./create_skill";

export const tools: Record<string, AppTool> = {
  // Phase 4: outputs, records, templates
  create_artifact,
  update_artifact,
  query_records,
  my_records,
  fill_template,
  export_document,
  // Phase 5: sandbox analysis
  run_analysis: runAnalysisTool,
  // Phase 2 (RAG)
  [searchDocumentsTool.name]: searchDocumentsTool,
  [readFileTool.name]: readFileTool,
  // plans/08 §C: external data sources (read only)
  query_source,
  // plans/09: memory. Not part of any agent's list: every agent gets them while memory is on (chat.ts).
  remember,
  recall,
  // The user's own skills («مهاراتي»): every agent may save one when asked.
  create_skill,
};

/** Memory tools follow the employee's level and the chat («بلا ذاكرة»), not the agent's tool list. */
export const MEMORY_TOOLS = ["remember", "recall"];
/** Tools every agent gets, whatever its tool list: they only touch the user's own things. */
export const PERSONAL_TOOLS = ["create_skill"];

export function getTool(name: string): AppTool | undefined {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}
