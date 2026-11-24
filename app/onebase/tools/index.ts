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
import { propose_record_set } from "./propose_record_set";
import { export_document } from "./export_document";
import { query_source } from "./query_source";
import { remember } from "./remember";
import { recall } from "./recall";
import { create_skill } from "./create_skill";
import { use_skill } from "./use_skill";
import { create_list } from "./create_list";
import { update_list } from "./update_list";
import { read_list } from "./read_list";
import { publish_output } from "./publish_output";
import { write_app } from "./write_app";
import { read_app } from "./read_app";
import { test_app } from "./test_app";
import { read_chat } from "./read_chat";
import { read_tasks } from "./read_tasks";
import { create_task } from "./create_task";
import { update_task } from "./update_task";
import { notify_colleague } from "./notify_colleague";

export const tools: Record<string, AppTool> = {
  // Phase 4: outputs, records, templates
  create_artifact,
  update_artifact,
  query_records,
  my_records,
  fill_template,
  // plans/17 §5: an Excel file in the chat becomes a record set (the server proposes, the user confirms)
  propose_record_set,
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
  // plans/09 §2: loads a skill from the prompt's index (mine, or the chat's space's).
  use_skill,
  // plans/10: live lists («القوائم»), every agent: tracked items belong in a list, not a static table.
  create_list,
  update_list,
  read_list,
  read_chat,
  read_tasks,
  // Tasks: create/assign and move them on, as the person could on the screen; always «نفّذ».
  create_task,
  update_task,
  notify_colleague,
  // plans/11: publish an output or an app (a plain page may carry a form bound to a list).
  publish_output,
  // plans/13: build an app (files, handlers, list grants), test it in a browser, read it back.
  write_app,
  read_app,
  test_app,
};

/** Memory tools follow the employee's level and the chat («بلا ذاكرة»), not the agent's tool list. */
export const MEMORY_TOOLS = ["remember", "recall"];
/** Tools every agent gets, whatever its tool list: the user's own skills and the lists they can write (checked per call). */
export const PERSONAL_TOOLS = ["create_skill", "use_skill", "create_list", "update_list", "read_list", "read_chat", "read_tasks", "create_task", "update_task", "notify_colleague", "publish_output", "write_app", "read_app", "test_app"];

export function getTool(name: string): AppTool | undefined {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}
