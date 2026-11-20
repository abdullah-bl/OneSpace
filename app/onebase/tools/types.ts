// Shared contract for agent tools (Phases 2, 4, 5, 6). Each tool lives in its own file under
// onebase/tools/ and is listed in onebase/tools/index.ts. The model only picks a tool and its
// arguments; the tool itself checks permissions for the *user* (never trusts the model).

import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

/** Who the tool runs as, and the limits of this turn. Identity comes from the session, never the model. */
export type ToolContext = {
  ctx: ActionCtx;
  userId: Id<"users">;
  /** Spaces this turn may touch: readable spaces of the user ∩ the agent's data scope ∩ the chosen scope chips. */
  scopeSpaceIds: Id<"spaces">[];
  /** Set when the turn is scoped to specific files ("اسأل عن هذا الملف"): tools stay inside them. (Phase 2, optional.) */
  scopeFileIds?: string[];
  threadId?: string;
  agentId?: string;
  taskId?: string;
};

export type Citation = {
  fileId: string;
  fileName: string;
  page?: number;
  section?: string;
  quote: string;
  /** plans/12 guard: the file holds text aimed at the assistant; its passage is shown as data. */
  steering?: boolean;
};

export type ToolResult = {
  /** Text handed back to the model (may carry ids and details meant for it only). */
  content: string;
  /** What the user sees on the action card after «نفّذ». Without it the card shows the raw output folded. */
  display?: string;
  /** How «تراجع» reverses an action that ran without asking (tier 1, onebase/tiers.ts). */
  undo?: {
    deleteArtifacts?: string[];
    deleteFiles?: string[];
    deleteMemories?: string[];
    deleteSkills?: string[];
    deleteLists?: string[];
    lists?: { listId: string; deleteRows: string[]; restoreRows: { rowId?: string; cells: Record<string, string | number | boolean | null>; order: number }[] };
    restore?: { artifactId: string; version: number };
  };
  citations?: Citation[];
  /** Artifacts created or updated by the tool (shown in the side panel). */
  artifactIds?: string[];
  /** Spaces the tool touched, for the audit log. */
  spaceIds?: string[];
};

export type AppTool<Args = any> = {
  name: string;
  /** Shown to the model. */
  description: string;
  /** Arabic label shown to the user while the tool runs, e.g. "يبحث في المستندات…". */
  label: string;
  /** JSON Schema for the arguments (used for constrained decoding). */
  parameters: Record<string, unknown>;
  /** Write tools: the agent proposes, the user presses "نفّذ" before run() is called. */
  requiresConfirmation?: boolean;
  /** Its output is data for the model, not an answer: after "نفّذ" the agent writes the reply from it. */
  answerAfterRun?: boolean;
  /**
   * Optional: fills in, from the server, what the confirmation card must show and pin before it is
   * proposed (publish_output: the app's version and grants). Its result is what «نفّذ» runs.
   */
  prepare?(t: ToolContext, args: Args): Promise<Args>;
  run(t: ToolContext, args: Args): Promise<ToolResult>;
};
