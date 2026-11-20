// The single permission checkpoint. Every public query, mutation and HTTP route goes through
// requireActive/requireAdmin and assertCan/readableSpaceIds here. Identity only ever comes from
// the session (getAuthUserId); no public function accepts a userId for "who is asking".
// Anything unknown or unexpected is a denial (fail-closed).

import { getAuthUserId } from "onebase/server";
import { OneBaseError } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type SpaceAction = "read" | "write" | "manage";
export type SpaceRole = "owner" | "manager" | "member" | "reader" | "everyone";
export type WorkspaceRole = "admin" | "member";
type Ctx = QueryCtx | MutationCtx;

/** One message for "doesn't exist" and "not allowed", so errors never confirm that a space or file exists. */
export const NOT_FOUND = "غير موجود أو لا تملك صلاحية الوصول إليه";

export class Denied extends OneBaseError {
  constructor(message = NOT_FOUND) {
    super(message);
  }
}

export type Actor = {
  userId: Id<"users">;
  user: Doc<"users">;
  workspace: Doc<"workspaces">;
  role: WorkspaceRole;
};

/** The workspace (there is one in Phase 1), or null before bootstrap. */
export async function getWorkspace(ctx: Ctx): Promise<Doc<"workspaces"> | null> {
  return await ctx.db.query("workspaces").first();
}

/** Status with the fail-closed default: an account without a status is pending. */
export function statusOf(user: Doc<"users"> | null): "pending" | "active" | "disabled" {
  return user?.status ?? "pending";
}

/** The user's workspace role if they are active and a member of the workspace team, else null. */
export async function actorFor(ctx: Ctx, userId: Id<"users">): Promise<Actor | null> {
  try {
    const user = await ctx.db.get(userId);
    if (!user || statusOf(user) !== "active") return null;
    const workspace = await getWorkspace(ctx);
    if (!workspace) return null;
    const role = await ctx.components.workspace.role({ teamId: workspace.teamId, userId });
    if (role !== "admin" && role !== "member") return null;
    return { userId, user, workspace, role };
  } catch {
    return null;
  }
}

/** The signed-in user's id, or throws. */
export async function requireUserId(ctx: Ctx | { auth: any }): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx as any);
  if (!userId) throw new OneBaseError("يجب تسجيل الدخول");
  return userId as Id<"users">;
}

/** The signed-in, active workspace member, or throws. Pending and disabled accounts stop here. */
export async function requireActive(ctx: Ctx): Promise<Actor> {
  const userId = await requireUserId(ctx);
  const actor = await actorFor(ctx, userId);
  if (!actor) throw new OneBaseError("حسابك غير مفعّل في مساحة العمل");
  return actor;
}

/** The signed-in workspace admin, or throws. */
export async function requireAdmin(ctx: Ctx): Promise<Actor> {
  const actor = await requireActive(ctx);
  if (actor.role !== "admin") throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
  return actor;
}

/** The user's role in a space, or null. Requires an active workspace member. */
export async function spaceRoleOf(ctx: Ctx, userId: Id<"users">, space: Doc<"spaces">, actor?: Actor | null): Promise<SpaceRole | null> {
  const who = actor ?? (await actorFor(ctx, userId));
  if (!who || who.userId !== userId) return null;
  if (space.workspaceId !== who.workspace._id) return null;
  if (space.kind === "personal") return space.ownerId === userId ? "owner" : null;
  if (space.kind !== "shared") return null;
  const membership = await ctx.db
    .query("spaceMembers")
    .withIndex("by_space_user", (q) => q.eq("spaceId", space._id).eq("userId", userId))
    .unique();
  if (membership) return membership.role;
  return space.everyone ? "everyone" : null;
}

const ALLOWED: Record<SpaceRole, SpaceAction[]> = {
  owner: ["read", "write"],
  manager: ["read", "write", "manage"],
  member: ["read", "write"],
  reader: ["read"],
  everyone: ["read"],
};

export function roleAllows(role: SpaceRole | null, action: SpaceAction): boolean {
  return role !== null && (ALLOWED[role]?.includes(action) ?? false);
}

/** Throws Denied unless `userId` may do `action` in the space. Returns the space and the role. */
export async function assertCan(
  ctx: Ctx,
  userId: Id<"users">,
  spaceId: Id<"spaces"> | string,
  action: SpaceAction,
): Promise<{ space: Doc<"spaces">; role: SpaceRole }> {
  let space: Doc<"spaces"> | null = null;
  let role: SpaceRole | null = null;
  try {
    const id = ctx.db.normalizeId("spaces", spaceId as string);
    space = id ? await ctx.db.get(id) : null;
    role = space ? await spaceRoleOf(ctx, userId, space) : null;
  } catch {
    throw new Denied();
  }
  if (!space || !roleAllows(role, action)) throw new Denied();
  return { space, role: role! };
}

/** Every space the user may read right now: their personal space, shared spaces they belong to, and "everyone" spaces. */
export async function readableSpaceIds(ctx: Ctx, userId: Id<"users">): Promise<Id<"spaces">[]> {
  try {
    const actor = await actorFor(ctx, userId);
    if (!actor) return [];
    const ids = new Set<Id<"spaces">>();
    const personal = await ctx.db.query("spaces").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect();
    for (const s of personal) if (s.kind === "personal" && s.workspaceId === actor.workspace._id) ids.add(s._id);
    const memberships = await ctx.db.query("spaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const m of memberships) {
      const s = await ctx.db.get(m.spaceId);
      if (s && s.kind === "shared" && s.workspaceId === actor.workspace._id) ids.add(s._id);
    }
    const shared = await ctx.db
      .query("spaces")
      .withIndex("by_workspace_kind", (q) => q.eq("workspaceId", actor.workspace._id).eq("kind", "shared"))
      .collect();
    for (const s of shared) if (s.everyone) ids.add(s._id);
    return [...ids];
  } catch {
    return [];
  }
}

// ---- Tasks (Phase 3) ------------------------------------------------------------------------
// A task lives in one shared space and is seen only by the space's *named* members: manager,
// member and reader. The implicit readers of an "everyone" space, the owner of a personal space
// and the workspace admin (unless named) get nothing. Readers only view; managers and members
// comment; only a manager creates, assigns, edits, reviews and closes. What the assignee may do
// on top of that is decided per task in tasks.ts (isAssignee).

export type TaskAction = "view" | "comment" | "manage";

const TASK_ALLOWED: Record<SpaceRole, TaskAction[]> = {
  owner: [],
  manager: ["view", "comment", "manage"],
  member: ["view", "comment"],
  reader: ["view"],
  everyone: [],
};

export function taskRoleAllows(role: SpaceRole | null, action: TaskAction): boolean {
  return role !== null && (TASK_ALLOWED[role]?.includes(action) ?? false);
}

/** Roles a task may be assigned to: people who can write in the space (and so attach output). */
export function canBeAssignee(role: SpaceRole | null): boolean {
  return role === "manager" || role === "member";
}

/** A named member of a shared space (a spaceMembers row, not "everyone") who can read it right now. */
export async function namedReader(ctx: Ctx, userId: Id<"users">, space: Doc<"spaces">): Promise<boolean> {
  if (space.kind !== "shared") return false;
  const role = await currentSpaceRole(ctx, userId, space);
  return role !== "everyone" && roleAllows(role, "read");
}

/** A task's assignees: its list, or the single assignee of a row written before tasks had several. */
export function assigneesOf(task: Doc<"tasks">): Id<"users">[] {
  return task.assigneeIds ?? (task.assigneeId ? [task.assigneeId] : []);
}

/** Throws Denied (same message as a missing space) unless `userId` may do `action` on tasks of the space. */
export async function assertTaskCan(
  ctx: Ctx,
  userId: Id<"users">,
  spaceId: Id<"spaces"> | string,
  action: TaskAction,
): Promise<{ space: Doc<"spaces">; role: SpaceRole }> {
  const { space, role } = await assertCan(ctx, userId, spaceId, "read");
  if (space.kind !== "shared" || !taskRoleAllows(role, action)) throw new Denied();
  return { space, role };
}

/** The role `userId` holds in the space right now, or null (inactive, not a member, any error). */
export async function currentSpaceRole(ctx: Ctx, userId: Id<"users">, space: Doc<"spaces">): Promise<SpaceRole | null> {
  try {
    return await spaceRoleOf(ctx, userId, space);
  } catch {
    return null;
  }
}

// ---- Chats shared with a space (plans/14) ---------------------------------------------------
// A private chat belongs to its owner alone. A shared chat (threadMeta.shared, in a shared space)
// follows the space: whoever may read the space reads the chat, whoever may write there asks in
// it. The owner too: leaving the space ends their access to a shared chat like anyone else's.

export type ThreadUse = "read" | "write";

/** A chat the space's members see: shared, in a space, and not a test, scheduled or task thread. */
export function isSharedThread(meta: Doc<"threadMeta">): boolean {
  return !!meta.shared && !!meta.spaceId && !meta.test && !meta.scheduleId && !meta.taskId;
}

/** Whether `userId` may read (or ask in) this chat right now. */
export async function threadAllows(ctx: Ctx, userId: Id<"users">, meta: Doc<"threadMeta">, use: ThreadUse): Promise<boolean> {
  if (!isSharedThread(meta)) return meta.userId === userId;
  const space = await ctx.db.get(meta.spaceId!);
  if (!space || space.kind !== "shared") return false;
  return roleAllows(await currentSpaceRole(ctx, userId, space), use);
}
