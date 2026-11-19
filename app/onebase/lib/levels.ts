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
  sources: string[] | null; // data sources; null = every source the employee may see
  subagents: number;
  dailyQuestions: number; // 0 = unlimited
};

export const MAX_SUBAGENTS = 3;
export const UNLIMITED: Level = { id: null, name: "كامل", model: "main", deep: true, tools: null, sources: null, subagents: MAX_SUBAGENTS, dailyQuestions: 0 };

export function asLevel(l: Doc<"levels">): Level {
  return { id: l._id, name: l.name, model: l.model, deep: l.deep, tools: l.tools ?? null, sources: (l.sources as string[] | undefined) ?? null, subagents: l.subagents, dailyQuestions: l.dailyQuestions };
}

function generosity(l: Doc<"levels">): number {
  return (l.model === "main" ? 4e6 : 0) + (l.deep ? 2e6 : 0) + (l.dailyQuestions === 0 ? 1e6 : Math.min(l.dailyQuestions, 999_999)) + l.subagents;
}

/** Which rule gave the level: the person's own, a team (space), the workspace default, or none. */
export async function levelSource(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<"own" | "team" | "default" | "none"> {
  const a = await ctx.db.query("levelAssignments").withIndex("by_user", (q) => q.eq("userId", userId)).first();
  if (a && (await ctx.db.get(a.levelId))) return "own";
  const l = await levelOf(ctx, userId);
  if (!l.id) return "none";
  const row = await ctx.db.get(l.id as Id<"levels">);
  return row?.isDefault && !row.spaceIds?.length ? "default" : row?.spaceIds?.length ? "team" : "default";
}

export async function levelOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Level> {
  const a = await ctx.db.query("levelAssignments").withIndex("by_user", (q) => q.eq("userId", userId)).first();
  const own = a ? await ctx.db.get(a.levelId) : null;
  if (own) return asLevel(own);
  // Team levels: a level given to a shared space applies to its members. In several such teams,
  // the most generous one wins (model, then thinking, then the daily limit; 0 = unlimited).
  const teams = (await ctx.db.query("levels").collect()).filter((l) => l.spaceIds?.length);
  if (teams.length) {
    const mine = new Set((await ctx.db.query("spaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect()).map((m) => m.spaceId as string));
    const hits = teams.filter((l) => l.spaceIds!.some((sid) => mine.has(sid)));
    if (hits.length) return asLevel(hits.sort((a, b) => generosity(b) - generosity(a))[0]!);
  }
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
