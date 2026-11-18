// Spaces as their members see them, and membership management by a space's managers.
// A non-member never gets a shared space's name: lists come from readableSpaceIds, and every
// lookup by id goes through assertCan, which answers "not found" for both missing and forbidden.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, readableSpaceIds, requireActive, roleAllows, type SpaceRole } from "./access";
import { memberRole } from "./schema";
import { writeAudit } from "./audit";

function shape(space: Doc<"spaces">, role: SpaceRole) {
  return {
    _id: space._id,
    name: space.name,
    kind: space.kind,
    everyone: space.everyone,
    sensitive: space.sensitive,
    myRole: role,
    canWrite: roleAllows(role, "write"),
    canManage: roleAllows(role, "manage"),
  };
}

/** The sidebar: my personal space first, then the shared spaces I can read. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const out = [];
    for (const id of await readableSpaceIds(ctx, me.userId)) {
      const { space, role } = await assertCan(ctx, me.userId, id, "read");
      out.push(shape(space, role));
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "ar") : a.kind === "personal" ? -1 : 1));
  },
});

export const get = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space, role } = await assertCan(ctx, me.userId, spaceId, "read");
    return { ...shape(space, role), instructions: space.instructions ?? null, instructionsUpdatedAt: space.instructionsUpdatedAt ?? null };
  },
});

/** Phase 3: the space as a "project". Its optional instructions (for the agent) are set by a manager of a shared space. */
export const setInstructions = mutation({
  args: { spaceId: v.id("spaces"), instructions: v.string() },
  handler: async (ctx, { spaceId, instructions }) => {
    const { me } = await requireSharedManage(ctx, spaceId);
    const text = instructions.trim();
    if (text.length > 20_000) throw new OneBaseError("التعليمات أطول من المسموح");
    await ctx.db.patch(spaceId, { instructions: text || undefined, instructionsUpdatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "space.instructions", resourceType: "space", resourceId: spaceId, spaceId, detail: { length: text.length } });
  },
});

/** Named members of a shared space, for anyone who can read it. */
export const members = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space } = await assertCan(ctx, me.userId, spaceId, "read");
    if (space.kind !== "shared") return [];
    const rows = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId)).collect();
    const out = [];
    for (const m of rows) {
      const u = await ctx.db.get(m.userId);
      out.push({ userId: m.userId, name: u?.name ?? null, email: u?.email ?? null, role: m.role, addedAt: m.addedAt });
    }
    return out;
  },
});

/** Active employees a manager may add (everyone in the workspace who isn't a member yet). */
export const candidates = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space } = await assertCan(ctx, me.userId, spaceId, "manage");
    if (space.kind !== "shared") return [];
    const team = await ctx.components.workspace.members({ teamId: me.workspace.teamId });
    const out = [];
    for (const t of team) {
      const userId = t.userId as Id<"users">;
      const existing = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId).eq("userId", userId)).unique();
      if (existing) continue;
      const actor = await actorFor(ctx, userId);
      if (!actor) continue;
      out.push({ userId, name: actor.user.name ?? null, email: actor.user.email ?? null });
    }
    return out;
  },
});

async function requireSharedManage(ctx: MutationCtx, spaceId: Id<"spaces">) {
  const me = await requireActive(ctx);
  const { space } = await assertCan(ctx, me.userId, spaceId, "manage");
  if (space.kind !== "shared") throw new Denied();
  return { me, space };
}

async function managerCount(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">) {
  const rows = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId)).collect();
  return rows.filter((r) => r.role === "manager").length;
}

export const addMember = mutation({
  args: { spaceId: v.id("spaces"), userId: v.id("users"), role: memberRole },
  handler: async (ctx, { spaceId, userId, role }) => {
    const { me } = await requireSharedManage(ctx, spaceId);
    if (!(await actorFor(ctx, userId))) throw new OneBaseError("الموظف غير مفعّل في مساحة العمل");
    const existing = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId).eq("userId", userId)).unique();
    if (existing) throw new OneBaseError("الموظف عضو في المساحة مسبقاً");
    await ctx.db.insert("spaceMembers", { spaceId, userId, role, addedBy: me.userId, addedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "member.add", resourceType: "user", resourceId: userId, spaceId, detail: { role } });
  },
});

export const setMemberRole = mutation({
  args: { spaceId: v.id("spaces"), userId: v.id("users"), role: memberRole },
  handler: async (ctx, { spaceId, userId, role }) => {
    const { me } = await requireSharedManage(ctx, spaceId);
    const existing = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId).eq("userId", userId)).unique();
    if (!existing) throw new OneBaseError("ليس عضواً في المساحة");
    if (existing.role === role) return;
    if (existing.role === "manager" && (await managerCount(ctx, spaceId)) <= 1) throw new OneBaseError("لا بد أن يبقى للمساحة مدير واحد على الأقل");
    await ctx.db.patch(existing._id, { role });
    await writeAudit(ctx, { userId: me.userId, action: "member.role", resourceType: "user", resourceId: userId, spaceId, detail: { from: existing.role, role } });
  },
});

export const removeMember = mutation({
  args: { spaceId: v.id("spaces"), userId: v.id("users") },
  handler: async (ctx, { spaceId, userId }) => {
    const { me } = await requireSharedManage(ctx, spaceId);
    const existing = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId).eq("userId", userId)).unique();
    if (!existing) throw new OneBaseError("ليس عضواً في المساحة");
    if (existing.role === "manager" && (await managerCount(ctx, spaceId)) <= 1) throw new OneBaseError("لا بد أن يبقى للمساحة مدير واحد على الأقل");
    await ctx.db.delete(existing._id);
    await writeAudit(ctx, { userId: me.userId, action: "member.remove", resourceType: "user", resourceId: userId, spaceId, detail: { role: existing.role } });
  },
});
