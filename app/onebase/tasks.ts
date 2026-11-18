// Tasks (Phase 3). A task lives in one shared space and inherits it: only the space's named
// members see it (access.ts: assertTaskCan), only its manager creates, assigns, edits, reviews,
// closes and deletes, and it can only be assigned to a manager or member of that space.
//
// The assignee moves it forward (new → inProgress → review) and attaches output. Attachments
// (links) must live in the task's own space: checked when added, and again every time the task
// is read, so a file moved out later stops showing (name hidden). Every lookup by id answers with
// the same "not found" message whether the thing is missing, forbidden or in another space.
//
//   who            view  comment  attach  forward(new→inProgress→review)  review/close/reopen  create/assign/edit/delete
//   manager         ✓       ✓        ✓          ✓                              ✓                    ✓
//   assignee        ✓       ✓        ✓          ✓                              –                    –
//   member          ✓       ✓        –          –                              –                    –
//   reader          ✓       –        –          –                              –                    –
//   everyone/admin/others: nothing (not even existence)

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertTaskCan, canBeAssignee, currentSpaceRole, Denied, requireActive, taskRoleAllows, type Actor, type SpaceRole } from "./access";
import { writeAudit } from "./audit";
import { notify, type NotifyKind } from "./notifications";
import { taskLinkType, taskPriority, taskStatus } from "./schema";

type Ctx = QueryCtx | MutationCtx;
type Status = Doc<"tasks">["status"];
type LinkType = Doc<"tasks">["links"][number]["type"];

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const COMMENT_MAX = 5_000;

function cleanTitle(title: string) {
  const t = title.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, TITLE_MAX);
  if (!t) throw new OneBaseError("عنوان المهمة فارغ");
  return t;
}

function cleanBody(body: string | undefined, max = BODY_MAX) {
  if (body === undefined) return undefined;
  const b = body.trim();
  if (b.length > max) throw new OneBaseError("النص أطول من المسموح");
  return b || undefined;
}

async function loadTask(ctx: Ctx, taskId: string): Promise<Doc<"tasks">> {
  try {
    const id = ctx.db.normalizeId("tasks", taskId);
    const task = id ? await ctx.db.get(id) : null;
    if (task) return task;
  } catch {}
  throw new Denied();
}

/** The task plus what the caller may do with it. Throws Denied unless they may at least view it. */
async function taskAccess(ctx: Ctx, me: Actor, taskId: string, action: "view" | "comment" | "manage" = "view") {
  const task = await loadTask(ctx, taskId);
  const { space, role } = await assertTaskCan(ctx, me.userId, task.spaceId, action === "manage" ? "manage" : "view");
  if (action === "comment" && !taskRoleAllows(role, "comment")) throw new Denied();
  const canManage = taskRoleAllows(role, "manage");
  const isAssignee = task.assigneeId === me.userId && canBeAssignee(role);
  return { task, space, role, canManage, isAssignee };
}

const FORWARD: Partial<Record<Status, Status>> = { new: "inProgress", inProgress: "review" };

/** Status changes allowed to this caller: the assignee moves forward; a manager can also close, return and reopen. */
function nextStatuses(status: Status, isAssignee: boolean, canManage: boolean): Status[] {
  const out = new Set<Status>();
  const fwd = FORWARD[status];
  if (fwd && (isAssignee || canManage)) out.add(fwd);
  if (canManage) {
    if (status !== "done") out.add("done");
    if (status === "review" || status === "done") out.add("inProgress");
  }
  return [...out];
}

async function nameOf(ctx: Ctx, cache: Map<string, string | null>, userId: Id<"users">) {
  if (!cache.has(userId)) {
    const u = await ctx.db.get(userId);
    cache.set(userId, u?.name ?? u?.email ?? null);
  }
  return cache.get(userId) ?? null;
}

/**
 * Where a link target lives, or null if it doesn't exist. Files and Phase 4 artifacts
 * (`artifacts.spaceId` + `title`). The caller compares the space with the task's own space, on
 * add and on every read, so an artifact moved out of the space (e.g. a sensitive output
 * transferred with its manager's approval) stops showing on the task.
 */
async function linkTarget(ctx: Ctx, type: LinkType, id: string): Promise<{ spaceId: string; name: string; sensitive?: boolean } | null> {
  if (type === "file") {
    const fid = ctx.db.normalizeId("files", id);
    const file = fid ? await ctx.db.get(fid) : null;
    return file && file.status === "active" ? { spaceId: file.spaceId, name: file.name } : null;
  }
  if (type === "artifact") {
    const aid = ctx.db.normalizeId("artifacts", id);
    const art = aid ? await ctx.db.get(aid) : null;
    return art ? { spaceId: art.spaceId, name: art.title, sensitive: art.classification === "sensitive" } : null;
  }
  return null;
}

function summary(task: Doc<"tasks">, extra: { spaceName: string; assigneeName: string | null; assigneeActive: boolean; isAssignee: boolean; canManage: boolean; canComment: boolean }) {
  return {
    _id: task._id,
    spaceId: task.spaceId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: task.due ?? null,
    assigneeId: task.assigneeId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    closedAt: task.closedAt ?? null,
    linkCount: task.links.length,
    nextStatuses: nextStatuses(task.status, extra.isAssignee, extra.canManage),
    canAttach: (extra.isAssignee || extra.canManage) && task.status !== "done",
    ...extra,
  };
}

async function shapeMany(ctx: Ctx, me: Actor, rows: { task: Doc<"tasks">; space: Doc<"spaces">; role: SpaceRole }[]) {
  const names = new Map<string, string | null>();
  const out = [];
  for (const { task, space, role } of rows) {
    const assigneeRole = await currentSpaceRole(ctx, task.assigneeId, space);
    out.push(
      summary(task, {
        spaceName: space.name,
        assigneeName: await nameOf(ctx, names, task.assigneeId),
        assigneeActive: canBeAssignee(assigneeRole),
        isAssignee: task.assigneeId === me.userId && canBeAssignee(role),
        canManage: taskRoleAllows(role, "manage"),
        canComment: taskRoleAllows(role, "comment"),
      }),
    );
  }
  const open = (s: Status) => (s === "done" ? 1 : 0);
  return out.sort((a, b) => open(a.status) - open(b.status) || (a.due ?? Infinity) - (b.due ?? Infinity) || b.updatedAt - a.updatedAt);
}

/** People who may receive a notification about this task right now (still able to view it). */
async function canView(ctx: MutationCtx, userId: Id<"users">, space: Doc<"spaces">) {
  return taskRoleAllows(await currentSpaceRole(ctx, userId, space), "view");
}

async function managersOf(ctx: MutationCtx, spaceId: Id<"spaces">) {
  const rows = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", spaceId)).collect();
  return rows.filter((r) => r.role === "manager").map((r) => r.userId);
}

async function notifyMany(ctx: MutationCtx, me: Actor, space: Doc<"spaces">, task: Doc<"tasks">, to: Id<"users">[], kind: NotifyKind, title: string, body?: string) {
  const seen = new Set<string>();
  for (const userId of to) {
    if (userId === me.userId || seen.has(userId)) continue;
    seen.add(userId);
    if (!(await canView(ctx, userId, space))) continue;
    await notify(ctx, userId, { kind, title, body, taskId: task._id, spaceId: space._id });
  }
}

const who = (me: Actor) => me.user.name ?? me.user.email ?? "";

async function requireAssignable(ctx: MutationCtx, space: Doc<"spaces">, assigneeId: Id<"users">) {
  if (!canBeAssignee(await currentSpaceRole(ctx, assigneeId, space))) throw new OneBaseError("لا تُسند المهمة إلا لمدير أو عضو في المساحة نفسها");
}

// ---- queries ------------------------------------------------------------------------------

/** "مهامي": tasks assigned to me, across every space where I can still see them. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const rows = await ctx.db.query("tasks").withIndex("by_assignee", (q) => q.eq("assigneeId", me.userId)).collect();
    const visible = [];
    for (const task of rows) {
      try {
        const { space, role } = await assertTaskCan(ctx, me.userId, task.spaceId, "view");
        visible.push({ task, space, role });
      } catch {}
    }
    return await shapeMany(ctx, me, visible);
  },
});

/** A space's task board: every task in it, for its named members. */
export const board = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space, role } = await assertTaskCan(ctx, me.userId, spaceId, "view");
    const rows = await ctx.db.query("tasks").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect();
    return await shapeMany(ctx, me, rows.map((task) => ({ task, space, role })));
  },
});

/** One task with its body, links (same-space only) and comments. */
export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const me = await requireActive(ctx);
    const { task, space, role } = await taskAccess(ctx, me, taskId);
    const [shaped] = await shapeMany(ctx, me, [{ task, space, role }]);
    const names = new Map<string, string | null>();
    const links = [];
    for (const l of task.links) {
      const target = await linkTarget(ctx, l.type, l.id);
      // Re-checked on every read: a target that left the space (or vanished) shows no name.
      const available = target !== null && target.spaceId === task.spaceId;
      links.push({ type: l.type, id: l.id, name: available ? target.name : null, available, sensitive: available && !!target.sensitive, addedByName: await nameOf(ctx, names, l.addedBy), addedAt: l.addedAt });
    }
    const commentRows = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
    const comments = [];
    for (const c of commentRows) comments.push({ _id: c._id, body: c.body, createdAt: c.createdAt, authorId: c.authorId, authorName: await nameOf(ctx, names, c.authorId) });
    return {
      ...shaped!,
      body: task.body ?? null,
      threadId: task.threadId ?? null,
      createdByName: await nameOf(ctx, names, task.createdBy),
      links,
      comments,
    };
  },
});

/** Who a manager may assign tasks to in this space: its active managers and members. */
export const assignees = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space } = await assertTaskCan(ctx, me.userId, spaceId, "manage");
    const rows = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", space._id)).collect();
    const out = [];
    for (const m of rows) {
      if (!canBeAssignee(await currentSpaceRole(ctx, m.userId, space))) continue;
      const u = await ctx.db.get(m.userId);
      out.push({ userId: m.userId, name: u?.name ?? u?.email ?? null, role: m.role });
    }
    return out;
  },
});

// ---- mutations ----------------------------------------------------------------------------

export const create = mutation({
  args: {
    spaceId: v.id("spaces"),
    title: v.string(),
    body: v.optional(v.string()),
    assigneeId: v.id("users"),
    due: v.optional(v.number()),
    priority: v.optional(taskPriority),
  },
  handler: async (ctx, { spaceId, title, body, assigneeId, due, priority }) => {
    const me = await requireActive(ctx);
    const { space } = await assertTaskCan(ctx, me.userId, spaceId, "manage");
    await requireAssignable(ctx, space, assigneeId);
    const now = Date.now();
    const t = cleanTitle(title);
    const taskId = await ctx.db.insert("tasks", {
      spaceId: space._id,
      title: t,
      body: cleanBody(body),
      createdBy: me.userId,
      assigneeId,
      due,
      priority: priority ?? "normal",
      status: "new",
      links: [],
      createdAt: now,
      updatedAt: now,
    });
    const task = (await ctx.db.get(taskId))!;
    const assignee = await ctx.db.get(assigneeId);
    await writeAudit(ctx, { userId: me.userId, action: "task.assign", resourceType: "task", resourceId: taskId, spaceId: space._id, detail: { taskTitle: t, assigneeId, assigneeName: assignee?.name ?? null, created: true } });
    await notifyMany(ctx, me, space, task, [assigneeId], "task.assigned", `مهمة جديدة: ${t}`, `أسندها إليك ${who(me)} في «${space.name}»`);
    return taskId;
  },
});

/** Manager edits title, body, due date (null clears it) and priority. */
export const update = mutation({
  args: { taskId: v.id("tasks"), title: v.optional(v.string()), body: v.optional(v.string()), due: v.optional(v.union(v.number(), v.null())), priority: v.optional(taskPriority) },
  handler: async (ctx, { taskId, title, body, due, priority }) => {
    const me = await requireActive(ctx);
    const { task } = await taskAccess(ctx, me, taskId, "manage");
    const changes: Partial<Doc<"tasks">> = { updatedAt: Date.now() };
    if (title !== undefined) changes.title = cleanTitle(title);
    if (body !== undefined) changes.body = cleanBody(body);
    if (due !== undefined) changes.due = due ?? undefined;
    if (priority !== undefined) changes.priority = priority;
    await ctx.db.patch(task._id, changes);
  },
});

/** Manager (re)assigns to another manager or member of the same space. */
export const assign = mutation({
  args: { taskId: v.id("tasks"), assigneeId: v.id("users") },
  handler: async (ctx, { taskId, assigneeId }) => {
    const me = await requireActive(ctx);
    const { task, space } = await taskAccess(ctx, me, taskId, "manage");
    await requireAssignable(ctx, space, assigneeId);
    if (task.assigneeId === assigneeId) return;
    await ctx.db.patch(task._id, { assigneeId, updatedAt: Date.now() });
    const assignee = await ctx.db.get(assigneeId);
    await writeAudit(ctx, { userId: me.userId, action: "task.assign", resourceType: "task", resourceId: task._id, spaceId: space._id, detail: { taskTitle: task.title, assigneeId, assigneeName: assignee?.name ?? null, from: task.assigneeId } });
    await notifyMany(ctx, me, space, task, [assigneeId], "task.assigned", `أُسندت إليك مهمة: ${task.title}`, `أسندها إليك ${who(me)} في «${space.name}»`);
  },
});

export const setStatus = mutation({
  args: { taskId: v.id("tasks"), status: taskStatus },
  handler: async (ctx, { taskId, status }) => {
    const me = await requireActive(ctx);
    const { task, space, canManage, isAssignee } = await taskAccess(ctx, me, taskId);
    if (task.status === status) return;
    if (!nextStatuses(task.status, isAssignee, canManage).includes(status)) {
      if (!canManage && !isAssignee) throw new Denied();
      throw new OneBaseError("لا يمكنك نقل المهمة إلى هذه الحالة");
    }
    const now = Date.now();
    await ctx.db.patch(task._id, { status, updatedAt: now, closedAt: status === "done" ? now : undefined });
    if (status === "review") {
      await notifyMany(ctx, me, space, task, await managersOf(ctx, space._id), "task.review", `مهمة بانتظار مراجعتك: ${task.title}`, `أرسلها ${who(me)} للمراجعة في «${space.name}»`);
    } else if (status === "done") {
      await writeAudit(ctx, { userId: me.userId, action: "task.close", resourceType: "task", resourceId: task._id, spaceId: space._id, detail: { taskTitle: task.title, from: task.status } });
      await notifyMany(ctx, me, space, task, [task.assigneeId], "task.closed", `أُغلقت المهمة: ${task.title}`, `أغلقها ${who(me)}`);
    } else if (task.status === "done") {
      await writeAudit(ctx, { userId: me.userId, action: "task.reopen", resourceType: "task", resourceId: task._id, spaceId: space._id, detail: { taskTitle: task.title } });
      await notifyMany(ctx, me, space, task, [task.assigneeId], "task.returned", `أُعيد فتح المهمة: ${task.title}`, `أعاد فتحها ${who(me)}`);
    } else if (task.status === "review" && status === "inProgress") {
      await notifyMany(ctx, me, space, task, [task.assigneeId], "task.returned", `أُعيدت إليك المهمة للتعديل: ${task.title}`, `أعادها ${who(me)}`);
    }
  },
});

async function requireAttach(ctx: MutationCtx, me: Actor, taskId: string) {
  const access = await taskAccess(ctx, me, taskId);
  if (!access.isAssignee && !access.canManage) throw new Denied();
  if (access.task.status === "done") throw new OneBaseError("المهمة مغلقة؛ يعيد المدير فتحها أولاً");
  return access;
}

/** Attaches a file or an artifact that lives in the task's own space. */
export const addLink = mutation({
  args: { taskId: v.id("tasks"), type: taskLinkType, id: v.string() },
  handler: async (ctx, { taskId, type, id }) => {
    const me = await requireActive(ctx);
    const { task } = await requireAttach(ctx, me, taskId);
    const target = await linkTarget(ctx, type, id);
    // Another space's file gets exactly the answer a missing one gets: nothing to probe.
    if (!target || target.spaceId !== task.spaceId) throw new Denied();
    if (task.links.some((l) => l.type === type && l.id === id)) return;
    if (task.links.length >= 100) throw new OneBaseError("عدد المرفقات أكثر من المسموح");
    await ctx.db.patch(task._id, { links: [...task.links, { type, id, addedBy: me.userId, addedAt: Date.now() }], updatedAt: Date.now() });
  },
});

export const removeLink = mutation({
  args: { taskId: v.id("tasks"), type: taskLinkType, id: v.string() },
  handler: async (ctx, { taskId, type, id }) => {
    const me = await requireActive(ctx);
    const { task } = await requireAttach(ctx, me, taskId);
    await ctx.db.patch(task._id, { links: task.links.filter((l) => !(l.type === type && l.id === id)), updatedAt: Date.now() });
  },
});

/**
 * Records the chat thread opened for this task (Phase 2). A generic id: it grants nothing by
 * itself, since the chat functions check the thread's own access. null clears it.
 */
export const setThread = mutation({
  args: { taskId: v.id("tasks"), threadId: v.union(v.string(), v.null()) },
  handler: async (ctx, { taskId, threadId }) => {
    const me = await requireActive(ctx);
    const { task, canManage, isAssignee } = await taskAccess(ctx, me, taskId);
    if (!canManage && !isAssignee) throw new Denied();
    if (threadId !== null && (!threadId.trim() || threadId.length > 200)) throw new OneBaseError("معرّف المحادثة غير صالح");
    await ctx.db.patch(task._id, { threadId: threadId ?? undefined, updatedAt: Date.now() });
  },
});

export const comment = mutation({
  args: { taskId: v.id("tasks"), body: v.string() },
  handler: async (ctx, { taskId, body }) => {
    const me = await requireActive(ctx);
    const { task, space } = await taskAccess(ctx, me, taskId, "comment");
    const text = cleanBody(body, COMMENT_MAX);
    if (!text) throw new OneBaseError("التعليق فارغ");
    const id = await ctx.db.insert("taskComments", { taskId: task._id, authorId: me.userId, body: text, createdAt: Date.now() });
    const preview = text.length > 140 ? text.slice(0, 140) + "…" : text;
    await notifyMany(ctx, me, space, task, [task.assigneeId, ...(await managersOf(ctx, space._id))], "task.comment", `تعليق من ${who(me)} على: ${task.title}`, preview);
    return id;
  },
});

/** Manager deletes a task and its comments. */
export const remove = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const me = await requireActive(ctx);
    const { task, space } = await taskAccess(ctx, me, taskId, "manage");
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
    for (const c of comments) await ctx.db.delete(c._id);
    await ctx.db.delete(task._id);
    await writeAudit(ctx, { userId: me.userId, action: "task.delete", resourceType: "task", resourceId: task._id, spaceId: space._id, detail: { taskTitle: task.title, status: task.status } });
  },
});
