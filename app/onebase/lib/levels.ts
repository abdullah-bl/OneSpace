// The employee's level (plans/08 §D): their own assignment, else the workspace default, else no
// limits (a workspace that hasn't set up levels behaves exactly as before).

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type Level = {
  id: string | null;
  name: string;
  model: "main" | "fast";
  deep: boolean;
  tools: string[] | null; // null = whatever the agent has
  subagents: number;
  dailyQuestions: number; // 0 = unlimited
};

export const MAX_SUBAGENTS = 3;
export const UNLIMITED: Level = { id: null, name: "كامل", model: "main", deep: true, tools: null, subagents: MAX_SUBAGENTS, dailyQuestions: 0 };

export function asLevel(l: Doc<"levels">): Level {
  return { id: l._id, name: l.name, model: l.model, deep: l.deep, tools: l.tools ?? null, subagents: l.subagents, dailyQuestions: l.dailyQuestions };
}

export async function levelOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Level> {
  const a = await ctx.db.query("levelAssignments").withIndex("by_user", (q) => q.eq("userId", userId)).first();
  const own = a ? await ctx.db.get(a.levelId) : null;
  if (own) return asLevel(own);
  const def = await ctx.db.query("levels").withIndex("by_default", (q) => q.eq("isDefault", true)).first();
  return def ? asLevel(def) : UNLIMITED;
}

/** Start of today on the server's clock: the daily limit renews at midnight. */
export const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Questions asked today (scheduled runs and «نفّذ» follow-ups don't count). */
export async function usedToday(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<number> {
  const rows = await ctx.db
    .query("turns")
    .withIndex("by_user", (q) => q.eq("userId", userId).gte("queuedAt", startOfToday()))
    .collect();
  return rows.filter((t) => !t.scheduleId && !t.afterProposal).length;
}

/** Tools this level allows out of an agent's list. */
export const levelTools = (level: Level, tools: string[]) => (level.tools ? tools.filter((t) => level.tools!.includes(t)) : tools);
