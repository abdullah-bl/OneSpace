// Runs one registered agent tool with a ToolContext, the way the chat loop (Phase 2) will.
// Internal: only reachable with the server's admin key (tests, ops), never from a client.
// If no scope is given, the scope is every space the user can read right now.

import { v } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { readableSpaceIds } from "./access";
import { getTool } from "./tools/index";

export const readableFor = internalQuery({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) => readableSpaceIds(ctx, userId),
});

export const run = internalAction({
  args: { userId: v.id("users"), name: v.string(), args: v.optional(v.any()), scopeSpaceIds: v.optional(v.array(v.string())), threadId: v.optional(v.string()) },
  handler: async (ctx, { userId, name, args, scopeSpaceIds, threadId }) => {
    const tool = getTool(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const scope = (scopeSpaceIds ?? (await ctx.runQuery(internal.toolHarness.readableFor, { userId }))) as Id<"spaces">[];
    return await tool.run({ ctx, userId, scopeSpaceIds: scope, threadId }, args ?? {});
  },
});
