// Per-employee levels (plans/08 §D), like Claude's plans but set by the workspace admin: which
// model, whether «تفكير عميق» is allowed, which tools, how many parts a request may be split into,
// and how many questions a day. The admin edits levels and assigns them; everyone can read their
// own. Enforcement is in lib/turns.ts (daily limit) and chat.turnContext (model, thinking, tools).

import { OneBaseError, v } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { Denied, requireActive, requireAdmin, statusOf } from "./access";
import { writeAudit } from "./audit";
import { asLevel, levelOf, MAX_SUBAGENTS, usedToday } from "./lib/levels";
import { tools as registry } from "./tools";

const NAME_MAX = 40;
const MAX_LEVELS = 20;
const MAX_DAILY = 10_000;

const fields = {
  name: v.string(),
  description: v.string(),
  model: v.union(v.literal("main"), v.literal("fast")),
  deep: v.boolean(),
  tools: v.union(v.array(v.string()), v.null()),
  subagents: v.number(),
  dailyQuestions: v.number(),
};

/** All levels with how many people are on each, the tool list to pick from, and every account's level. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const levels = await ctx.db.query("levels").collect();
    const assignments = await ctx.db.query("levelAssignments").collect();
    const byUser = new Map(assignments.map((a) => [a.userId as string, a.levelId as string]));
    const users = [];
    for (const u of await ctx.db.query("users").collect()) {
      if (statusOf(u) !== "active") continue;
      if (!(await ctx.components.workspace.role({ teamId: me.workspace.teamId, userId: u._id }))) continue;
      users.push({ _id: u._id, name: u.name ?? u.email ?? "—", levelId: byUser.get(u._id) ?? null });
    }
    return {
      levels: levels
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((l) => ({ ...asLevel(l), _id: l._id, description: l.description, isDefault: l.isDefault, members: assignments.filter((a) => a.levelId === l._id).length })),
      tools: Object.values(registry).map((t) => ({ name: t.name, label: t.label.replace(/…$/, ""), writes: !!t.requiresConfirmation })),
      users: users.sort((a, b) => a.name.localeCompare(b.name, "ar")),
      maxSubagents: MAX_SUBAGENTS,
    };
  },
});

export const save = mutation({
  args: { levelId: v.optional(v.string()), ...fields },
  handler: async (ctx, { levelId, ...a }) => {
    const me = await requireAdmin(ctx);
    const name = a.name.trim().slice(0, NAME_MAX);
    if (!name) throw new OneBaseError("اكتب اسم المستوى");
    const tools = a.tools === null ? undefined : [...new Set(a.tools)];
    if (tools?.some((t) => !Object.hasOwn(registry, t))) throw new OneBaseError("أداة غير معروفة");
    const row = {
      name,
      description: a.description.trim().slice(0, 300),
      model: a.model,
      deep: a.model === "main" && a.deep, // the small model doesn't think
      tools,
      subagents: Math.min(Math.max(Math.round(a.subagents) || 0, 0), MAX_SUBAGENTS),
      dailyQuestions: Math.min(Math.max(Math.round(a.dailyQuestions) || 0, 0), MAX_DAILY),
      updatedAt: Date.now(),
    };
    const clash = (await ctx.db.query("levels").collect()).find((l) => l.name === name && l._id !== levelId);
    if (clash) throw new OneBaseError(`يوجد مستوى باسم «${name}»`);
    let id: Id<"levels">;
    if (levelId) {
      const nid = ctx.db.normalizeId("levels", levelId);
      if (!nid || !(await ctx.db.get(nid))) throw new Denied();
      id = nid;
      await ctx.db.patch(id, row);
    } else {
      const count = (await ctx.db.query("levels").collect()).length;
      if (count >= MAX_LEVELS) throw new OneBaseError(`الحد ${MAX_LEVELS} مستوى`);
      // The first level becomes the default: until then, everyone has no limits.
      id = await ctx.db.insert("levels", { ...row, isDefault: count === 0, createdAt: Date.now() });
    }
    await writeAudit(ctx, { userId: me.userId, action: levelId ? "level.update" : "level.create", resourceType: "level", resourceId: id, detail: { name: row.name, model: row.model, deep: row.deep, tools: row.tools ? row.tools.join(",") : null, subagents: row.subagents, dailyQuestions: row.dailyQuestions } });
    return id;
  },
});

export const remove = mutation({
  args: { levelId: v.string() },
  handler: async (ctx, { levelId }) => {
    const me = await requireAdmin(ctx);
    const id = ctx.db.normalizeId("levels", levelId);
    const l = id ? await ctx.db.get(id) : null;
    if (!l) throw new Denied();
    // Its people fall back to the default level (or no limits if this was the default).
    for (const a of await ctx.db.query("levelAssignments").withIndex("by_level", (q) => q.eq("levelId", l._id)).collect()) await ctx.db.delete(a._id);
    await ctx.db.delete(l._id);
    await writeAudit(ctx, { userId: me.userId, action: "level.delete", resourceType: "level", resourceId: l._id, detail: { name: l.name } });
  },
});

/** The level of everyone without one of their own (null = no limits). */
export const setDefault = mutation({
  args: { levelId: v.union(v.string(), v.null()) },
  handler: async (ctx, { levelId }) => {
    const me = await requireAdmin(ctx);
    const id = levelId ? ctx.db.normalizeId("levels", levelId) : null;
    if (levelId && (!id || !(await ctx.db.get(id)))) throw new Denied();
    for (const l of await ctx.db.query("levels").collect()) if (l.isDefault !== (l._id === id)) await ctx.db.patch(l._id, { isDefault: l._id === id });
    await writeAudit(ctx, { userId: me.userId, action: "level.default", resourceType: "level", resourceId: id ?? "none", detail: {} });
  },
});

/** Puts a workspace member on a level (null = back to the default). */
export const assign = mutation({
  args: { userId: v.string(), levelId: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, levelId }) => {
    const me = await requireAdmin(ctx);
    const uid = ctx.db.normalizeId("users", userId);
    if (!uid || !(await ctx.components.workspace.role({ teamId: me.workspace.teamId, userId: uid }))) throw new Denied();
    const lid = levelId ? ctx.db.normalizeId("levels", levelId) : null;
    if (levelId && (!lid || !(await ctx.db.get(lid)))) throw new Denied();
    for (const a of await ctx.db.query("levelAssignments").withIndex("by_user", (q) => q.eq("userId", uid)).collect()) await ctx.db.delete(a._id);
    if (lid) await ctx.db.insert("levelAssignments", { userId: uid, levelId: lid, by: me.userId, at: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "level.assign", resourceType: "user", resourceId: uid, detail: { levelId: lid } });
  },
});

/** My level and today's use: for the composer (thinking) and the account menu. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const l = await levelOf(ctx, me.userId);
    return { name: l.name, configured: l.id !== null, model: l.model, deep: l.deep, subagents: l.subagents, dailyQuestions: l.dailyQuestions, usedToday: await usedToday(ctx, me.userId) };
  },
});
