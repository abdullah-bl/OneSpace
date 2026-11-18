// Phase 6 tables (agents, their published versions, and write-tool proposals), spread into schema.ts.

import { defineTable } from "onebase/server";
import { v } from "onebase/values";

/**
 * Which spaces an agent may touch, intersected with what the user can read right now:
 *   everyone — "everyone" spaces only (e.g. the policies agent)
 *   member   — the user's personal space and the shared spaces they are a named member of
 *   all      — whatever the user picks from their readable spaces (the scope chips)
 */
export const dataScope = v.union(v.literal("everyone"), v.literal("member"), v.literal("all"));
/** Who may pick the agent: every active workspace member, or readers of specific shared spaces. */
export const agentVisibility = v.object({ kind: v.union(v.literal("workspace"), v.literal("spaces")), spaceIds: v.array(v.id("spaces")) });
export const modelRole = v.union(v.literal("main"), v.literal("fast"));

/** Everything an admin edits about an agent. A published version is an immutable copy of this. */
export const agentConfig = v.object({
  name: v.string(),
  description: v.string(),
  instructions: v.string(),
  allowedTools: v.array(v.string()), // names from the registry (onebase/tools/index.ts) only
  dataScope,
  modelRole,
  maxSteps: v.number(),
  visibility: agentVisibility,
  // UX redesign: "open" = a general assistant that answers anything and uses the documents as a
  // tool (cites when it does); "documents" = answers only from the documents and abstains when
  // they don't cover the question (Phase 2 behaviour). Missing = "documents" (agents from before).
  grounding: v.optional(v.union(v.literal("open"), v.literal("documents"))),
});

export const proposalState = v.union(v.literal("pending"), v.literal("running"), v.literal("executed"), v.literal("failed"), v.literal("cancelled"), v.literal("expired"));

export const agentsTables = {
  // `live` is what users get (version = its number, 0 = never published); `draft` is what the
  // admin edits and tries ("جرّب الوكيل") before publishing. Every publish and revert writes an
  // agentVersions row; every change writes an audit row (agents.ts).
  agents: defineTable({
    key: v.optional(v.string()), // starter agents: default | policies | grades | analysis
    live: v.optional(agentConfig),
    draft: v.optional(agentConfig),
    version: v.number(),
    enabled: v.boolean(),
    isDefault: v.boolean(),
    testQuestions: v.array(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_default", ["isDefault"]),

  agentVersions: defineTable({
    agentId: v.id("agents"),
    version: v.number(),
    config: agentConfig,
    publishedBy: v.optional(v.id("users")),
    publishedAt: v.number(),
    revertedFrom: v.optional(v.number()),
  }).index("by_agent", ["agentId", "version"]),

  // A write tool the model asked for (plans/02 rule 5): stored, shown as a card, and run only
  // when the thread's owner presses "نفّذ" — once, before it expires, after checking again.
  proposals: defineTable({
    threadId: v.string(),
    userId: v.id("users"),
    messageId: v.string(),
    agentId: v.optional(v.string()),
    agentVersion: v.optional(v.number()),
    agentDraft: v.optional(v.boolean()),
    tool: v.string(),
    label: v.string(),
    args: v.any(),
    state: proposalState,
    createdAt: v.number(),
    expiresAt: v.number(),
    decidedAt: v.optional(v.number()),
    result: v.optional(v.string()),
    artifactIds: v.optional(v.array(v.string())),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_message", ["messageId"]),
};
