// Workspace-admin functions: employees (activate, disable, role) and shared spaces (create,
// assign manager, flags). The admin sees that shared spaces exist and who manages them, but
// not their contents unless they are members.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { actorFor, Denied, getWorkspace, requireAdmin, statusOf } from "./access";
import { writeAudit } from "./audit";
import { assignIdentifiers } from "./identifiers";
import { seedStarters } from "./agents";

const wsRole = v.union(v.literal("admin"), v.literal("member"));

/** The user's personal space, created if missing. Called when an employee is activated. */
export async function ensurePersonalSpace(ctx: MutationCtx, workspace: Doc<"workspaces">, user: Doc<"users">) {
  const existing = await ctx.db.query("spaces").withIndex("by_owner", (q) => q.eq("ownerId", user._id)).collect();
  const found = existing.find((s) => s.kind === "personal" && s.workspaceId === workspace._id);
  if (found) return found._id;
  const spaceId = await ctx.db.insert("spaces", {
    workspaceId: workspace._id,
    name: `مساحة ${user.name || user.email || "موظف"}`,
    kind: "personal",
    ownerId: user._id,
    everyone: false,
    sensitive: false,
    createdAt: Date.now(),
  });
  await writeAudit(ctx, { userId: user._id, action: "space.create_personal", resourceType: "space", resourceId: spaceId, spaceId });
  return spaceId;
}

/**
 * First-admin bootstrap. Internal: only callable with the server's admin key (see
 * scripts/bootstrap-admin.ts). The account must have signed up first. Refuses once a
 * workspace exists, so it can't be used to take over a running workspace.
 */
export const bootstrap = internalMutation({
  args: { email: v.string(), workspaceName: v.optional(v.string()) },
  handler: async (ctx, { email, workspaceName }) => {
    if (await getWorkspace(ctx)) throw new OneBaseError("Workspace already exists; add admins from the admin screen.");
    const user = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email.trim().toLowerCase())).first()
      ?? (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email.trim())).first());
    if (!user) throw new OneBaseError(`No account with email ${email}. Sign up in the app first, then run this again.`);
    const teamId = await ctx.components.workspace.createTeam({ userId: user._id, name: workspaceName ?? "الإدارة" });
    const workspaceId = await ctx.db.insert("workspaces", { teamId, name: workspaceName ?? "الإدارة", createdAt: Date.now() });
    await ctx.db.patch(user._id, { status: "active" });
    const workspace = (await ctx.db.get(workspaceId))!;
    await ensurePersonalSpace(ctx, workspace, { ...user, status: "active" });
    await seedStarters(ctx, user._id); // Phase 6: the default agent and the three starters
    await writeAudit(ctx, { userId: user._id, action: "workspace.bootstrap", resourceType: "user", resourceId: user._id, detail: { email: user.email ?? null } });
    return { workspaceId, userId: user._id };
  },
});

/** Every account, including pending ones waiting to be activated. */
export const users = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const all = await ctx.db.query("users").collect();
    const out = [];
    for (const u of all) {
      const role = await ctx.components.workspace.role({ teamId: me.workspace.teamId, userId: u._id });
      out.push({
        _id: u._id,
        name: u.name ?? null,
        email: u.email ?? null,
        status: statusOf(u),
        workspaceRole: role as "admin" | "member" | null,
        employeeNo: u.employeeNo ?? null,
        nationalId: u.nationalId ?? null,
        createdAt: u._creationTime,
      });
    }
    return out.sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === "pending" ? -1 : 1));
  },
});

/** Adds an account to the workspace (or re-enables it) and creates its personal space. */
export const activate = mutation({
  args: { userId: v.id("users"), role: v.optional(wsRole), employeeNo: v.optional(v.string()) },
  handler: async (ctx, { userId, role, employeeNo }) => {
    const me = await requireAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new Denied();
    const current = await ctx.components.workspace.role({ teamId: me.workspace.teamId, userId });
    if (!current) await ctx.components.workspace.addMember({ teamId: me.workspace.teamId, userId, role: role ?? "member", by: me.userId });
    else if (role && role !== current) await ctx.components.workspace.setRole({ teamId: me.workspace.teamId, userId, role, by: me.userId });
    await ctx.db.patch(userId, { status: "active" });
    if (employeeNo !== undefined) await assignIdentifiers(ctx, userId, { employeeNo });
    await ensurePersonalSpace(ctx, me.workspace, { ...user, status: "active" });
    await writeAudit(ctx, {
      userId: me.userId,
      action: statusOf(user) === "disabled" ? "user.reenable" : "user.activate",
      resourceType: "user",
      resourceId: userId,
      detail: { email: user.email ?? null, role: role ?? current ?? "member" },
    });
  },
});

/**
 * Sets an employee's national id and/or employee number (Phase 4). Admin only: the employee
 * can't set their own, so my_records can't be pointed at someone else's records.
 * null clears a value; omitted leaves it unchanged.
 */
export const setIdentifiers = mutation({
  args: { userId: v.id("users"), nationalId: v.optional(v.union(v.string(), v.null())), employeeNo: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { userId, nationalId, employeeNo }) => {
    const me = await requireAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new Denied();
    const patch = await assignIdentifiers(ctx, userId, { nationalId, employeeNo });
    await writeAudit(ctx, {
      userId: me.userId,
      action: "user.identifiers",
      resourceType: "user",
      resourceId: userId,
      detail: { nationalId: "nationalId" in patch ? (patch.nationalId ? "set" : "cleared") : null, employeeNo: "employeeNo" in patch ? (patch.employeeNo ? "set" : "cleared") : null },
    });
  },
});

export const disable = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await requireAdmin(ctx);
    if (userId === me.userId) throw new OneBaseError("لا يمكنك تعطيل حسابك");
    const user = await ctx.db.get(userId);
    if (!user) throw new Denied();
    await ctx.db.patch(userId, { status: "disabled" });
    await writeAudit(ctx, { userId: me.userId, action: "user.disable", resourceType: "user", resourceId: userId, detail: { email: user.email ?? null } });
  },
});

export const setRole = mutation({
  args: { userId: v.id("users"), role: wsRole },
  handler: async (ctx, { userId, role }) => {
    const me = await requireAdmin(ctx);
    if (!(await actorFor(ctx, userId))) throw new OneBaseError("الحساب غير مفعّل");
    await ctx.components.workspace.setRole({ teamId: me.workspace.teamId, userId, role, by: me.userId });
    await writeAudit(ctx, { userId: me.userId, action: "user.role", resourceType: "user", resourceId: userId, detail: { role } });
  },
});

/** Shared spaces as the admin sees them: existence, flags and managers. No files, no member list. */
export const spaces = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const shared = await ctx.db
      .query("spaces")
      .withIndex("by_workspace_kind", (q) => q.eq("workspaceId", me.workspace._id).eq("kind", "shared"))
      .collect();
    const out = [];
    for (const s of shared) {
      const members = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", s._id)).collect();
      const managers = [];
      for (const m of members.filter((m) => m.role === "manager")) {
        const u = await ctx.db.get(m.userId);
        managers.push({ userId: m.userId, name: u?.name ?? u?.email ?? "" });
      }
      out.push({
        _id: s._id,
        name: s.name,
        everyone: s.everyone,
        sensitive: s.sensitive,
        managers,
        memberCount: members.length,
        iAmMember: members.some((m) => m.userId === me.userId),
      });
    }
    return out;
  },
});

async function requireActiveEmployee(ctx: MutationCtx, userId: Id<"users">) {
  const target = await actorFor(ctx, userId);
  if (!target) throw new OneBaseError("الموظف غير مفعّل في مساحة العمل");
  return target;
}

export const createSharedSpace = mutation({
  args: { name: v.string(), managerId: v.id("users"), everyone: v.optional(v.boolean()), sensitive: v.optional(v.boolean()) },
  handler: async (ctx, { name, managerId, everyone, sensitive }) => {
    const me = await requireAdmin(ctx);
    const clean = name.trim();
    if (!clean) throw new OneBaseError("اكتب اسماً للمساحة");
    await requireActiveEmployee(ctx, managerId);
    const spaceId = await ctx.db.insert("spaces", {
      workspaceId: me.workspace._id,
      name: clean,
      kind: "shared",
      everyone: everyone ?? false,
      sensitive: sensitive ?? false,
      createdBy: me.userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId: managerId, role: "manager", addedBy: me.userId, addedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "space.create", resourceType: "space", resourceId: spaceId, spaceId, detail: { everyone: everyone ?? false, sensitive: sensitive ?? false } });
    await writeAudit(ctx, { userId: me.userId, action: "member.add", resourceType: "user", resourceId: managerId, spaceId, detail: { role: "manager" } });
    return spaceId;
  },
});

/** Makes a workspace employee a manager of a shared space (adding them if needed). */
export const setSpaceManager = mutation({
  args: { spaceId: v.id("spaces"), userId: v.id("users") },
  handler: async (ctx, { spaceId, userId }) => {
    const me = await requireAdmin(ctx);
    const space = await ctx.db.get(spaceId);
    if (!space || space.kind !== "shared" || space.workspaceId !== me.workspace._id) throw new Denied();
    await requireActiveEmployee(ctx, userId);
    const existing = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId).eq("userId", userId)).unique();
    if (existing) {
      if (existing.role === "manager") return;
      await ctx.db.patch(existing._id, { role: "manager" });
      await writeAudit(ctx, { userId: me.userId, action: "member.role", resourceType: "user", resourceId: userId, spaceId, detail: { from: existing.role, role: "manager" } });
    } else {
      await ctx.db.insert("spaceMembers", { spaceId, userId, role: "manager", addedBy: me.userId, addedAt: Date.now() });
      await writeAudit(ctx, { userId: me.userId, action: "member.add", resourceType: "user", resourceId: userId, spaceId, detail: { role: "manager" } });
    }
  },
});

export const updateSpace = mutation({
  args: { spaceId: v.id("spaces"), name: v.optional(v.string()), everyone: v.optional(v.boolean()), sensitive: v.optional(v.boolean()) },
  handler: async (ctx, { spaceId, name, everyone, sensitive }) => {
    const me = await requireAdmin(ctx);
    const space = await ctx.db.get(spaceId);
    if (!space || space.kind !== "shared" || space.workspaceId !== me.workspace._id) throw new Denied();
    const changes: Partial<Doc<"spaces">> = {};
    if (name !== undefined && name.trim()) changes.name = name.trim();
    if (everyone !== undefined) changes.everyone = everyone;
    if (sensitive !== undefined) changes.sensitive = sensitive;
    await ctx.db.patch(spaceId, changes);
    await writeAudit(ctx, {
      userId: me.userId,
      action: "space.update",
      resourceType: "space",
      resourceId: spaceId,
      spaceId,
      detail: { everyone: changes.everyone ?? null, sensitive: changes.sensitive ?? null, renamed: changes.name !== undefined },
    });
  },
});
