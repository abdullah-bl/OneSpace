// Registry of every agent tool. Admins pick from this list when defining an agent (Phase 6);
// they never write tools. Add each new tool here.

import { readFileTool } from "./read_file";
import { searchDocumentsTool } from "./search_documents";
import type { AppTool } from "./types";

export const tools: Record<string, AppTool> = {
  // Phase 2 (RAG)
  [searchDocumentsTool.name]: searchDocumentsTool,
  [readFileTool.name]: readFileTool,
};

export function getTool(name: string): AppTool | undefined {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}
