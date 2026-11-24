// Tasks (Phase 3). A task lives in one shared space and inherits it: only the space's named
// members see it (access.ts: assertTaskCan), only its manager creates, assigns, edits, reviews,
// closes and deletes, and it can only be assigned to managers or members of that space.
//
// A task has one or more assignees (`assigneeIds`; rows from before hold one `assigneeId`, read
// through assigneesOf). It is one task shared by all of them, with one status: each assignee is
// notified, sees it in «مهامي», comments, attaches output and moves it forward
// (new → inProgress → review); any of them can send it for review. Attachments
// (links) must live in the task's own space: checked when added, and again every time the task
// is read, so a file moved out later stops showing (name hidden). Every lookup by id answers with
// the same "not found" message whether the thing is missing, forbidden or in another space.
//
//   who            view  comment  attach  forward(new→inProgress→review)  review/close/reopen  create/assign/edit/delete
//   manager         ✓       ✓        ✓          ✓                              ✓                    ✓
//   an assignee     ✓       ✓        ✓          ✓                              –                    –
//   member          ✓       ✓        –          –                              –                    –
//   reader          ✓       –        –          –                              –                    –
//   everyone/admin/others: nothing (not even existence)

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertTaskCan, assigneesOf, canBeAssignee, currentSpaceRole, Denied, requireActive, taskRoleAllows, type Actor, type SpaceRole } from "./access";
import { writeAudit } from "./audit";
import { notify, type NotifyKind } from "./notifications";
import { taskLinkType, taskPriority, taskStatus } from "./schema";

type Ctx = QueryCtx | MutationCtx;
type Status = Doc<"tasks">["status"];
type LinkType = Doc<"tasks">["links"][number]["type"];

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const COMMENT_MAX = 5_000;
const MAX_ASSIGNEES = 20;

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
  const isAssignee = assigneesOf(task).includes(me.userId) && canBeAssignee(role);
  return { task, space, role, canManage, isAssignee };
}

const FORWARD: Partial<Record<Status, Status>> = { new: "inProgress", inProgress: "review" };

/** Status changes allowed to this caller: an assignee moves forward; a manager can also close, return and reopen. */
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

type Assignee = { userId: Id<"users">; name: string | null; active: boolean };

function summary(task: Doc<"tasks">, extra: { spaceName: string; assignees: Assignee[]; isAssignee: boolean; canManage: boolean; canComment: boolean }) {
  return {
    _id: task._id,
    spaceId: task.spaceId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: task.due ?? null,
    assigneeIds: assigneesOf(task),
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
    const assignees: Assignee[] = [];
    for (const userId of assigneesOf(task)) {
      assignees.push({ userId, name: await nameOf(ctx, names, userId), active: canBeAssignee(await currentSpaceRole(ctx, userId, space)) });
    }
    out.push(
      summary(task, {
        spaceName: space.name,
        assignees,
        isAssignee: assigneesOf(task).includes(me.userId) && canBeAssignee(role),
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

/**
 * The assignee list from the arguments (`assigneeIds`, or the single `assigneeId` older callers
 * send): at least one, no repeats, and every one a manager or member of the space right now.
 */
async function requireAssignable(ctx: MutationCtx, space: Doc<"spaces">, args: { assigneeIds?: Id<"users">[]; assigneeId?: Id<"users"> }) {
  const ids = [...new Set([...(args.assigneeIds ?? []), ...(args.assigneeId ? [args.assigneeId] : [])])];
  if (ids.length === 0) throw new OneBaseError("اختر مسؤولاً واحداً على الأقل");
  if (ids.length > MAX_ASSIGNEES) throw new OneBaseError(`لا تُسند المهمة لأكثر من ${MAX_ASSIGNEES} شخصاً`);
  for (const id of ids) {
    if (!canBeAssignee(await currentSpaceRole(ctx, id, space))) throw new OneBaseError("لا تُسند المهمة إلا لمدير أو عضو في المساحة نفسها");
  }
  return ids;
}

/** Audit detail values are scalars: a list of people is stored as joined ids and joined names. */
async function namesOf(ctx: MutationCtx, ids: Id<"users">[]) {
  const cache = new Map<string, string | null>();
  const out: string[] = [];
  for (const id of ids) out.push((await nameOf(ctx, cache, id)) ?? "؟");
  return out.join("، ");
}

const assigneeArgs = { assigneeIds: v.optional(v.array(v.id("users"))), assigneeId: v.optional(v.id("users")) };

// ---- queries ------------------------------------------------------------------------------

/** "مهامي": tasks I'm one of the assignees of, across every space where I can still see them. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    // Tasks are assigned only to named members, so my spaces are where to look.
    const memberships = await ctx.db.query("spaceMembers").withIndex("by_user", (q) => q.eq("userId", me.userId)).collect();
    const visible = [];
    for (const m of memberships) {
      let access;
      try {
        access = await assertTaskCan(ctx, me.userId, m.spaceId, "view");
      } catch {
        continue;
      }
      const rows = await ctx.db.query("tasks").withIndex("by_space", (q) => q.eq("spaceId", access.space._id)).collect();
      for (const task of rows) if (assigneesOf(task).includes(me.userId)) visible.push({ task, ...access });
    }
    return await shapeMany(ctx, me, visible);
  },
});

const STATUS_AR = { new: "جديدة", inProgress: "قيد التنفيذ", review: "للمراجعة", done: "منجزة" } as const;
const PRIORITY_AR = { low: "منخفضة", normal: "عادية", high: "عالية", urgent: "عاجلة" } as const;

/**
 * read_tasks (plans/15 follow-up): the tasks assigned to `userId`, as text for the assistant. Same
 * reach as «مهامي» (tasks.mine), narrowed to the turn's spaces; in a shared chat only that space's.
 * Open ones first, then the latest done; 60 at most.
 */
export const readForTool = internalQuery({
  args: { userId: v.id("users"), scopeSpaceIds: v.array(v.string()), sharedSpaceId: v.optional(v.string()), includeDone: v.optional(v.boolean()) },
  handler: async (ctx, a): Promise<string> => {
    const memberships = await ctx.db.query("spaceMembers").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect();
    const rows: { task: Doc<"tasks">; space: string }[] = [];
    for (const m of memberships) {
      if (!a.scopeSpaceIds.includes(m.spaceId)) continue;
      if (a.sharedSpaceId && m.spaceId !== a.sharedSpaceId) continue;
      let access;
      try {
        access = await assertTaskCan(ctx, a.userId, m.spaceId, "view");
      } catch {
        continue;
      }
      // Mine, and in a space I manage every task (so «وش وضع مهام الفريق؟» and update_task work there).
      const manages = taskRoleAllows(access.role, "manage");
      for (const task of await ctx.db.query("tasks").withIndex("by_space", (q) => q.eq("spaceId", access.space._id)).collect())
        if ((manages || assigneesOf(task).includes(a.userId)) && (a.includeDone || task.status !== "done")) rows.push({ task, space: access.space.name });
    }
    if (!rows.length) return a.includeDone ? "لا مهام مسندة إليه في مساحاته." : "لا مهام مفتوحة مسندة إليه في مساحاته.";
    rows.sort((x, y) => Number(x.task.status === "done") - Number(y.task.status === "done") || (x.task.due ?? Infinity) - (y.task.due ?? Infinity));
    const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : null);
    const lines = rows.slice(0, 60).map(({ task, space }) =>
      [`- ${task.title}`, STATUS_AR[task.status], `الأولوية ${PRIORITY_AR[task.priority]}`, day(task.due) ? `الاستحقاق ${day(task.due)}` : null, `المساحة «${space}»`, assigneesOf(task).includes(a.userId) ? "مسندة إليه" : "في مساحة يديرها", `taskId=${task._id}`].filter(Boolean).join(" · "),
    );
    const open = rows.filter((r) => r.task.status !== "done").length;
    return `مهامه ومهام المساحات التي يديرها (${open} مفتوحة${a.includeDone ? `، ${rows.length - open} منجزة` : ""}${rows.length > 60 ? `، تُعرض أول 60` : ""}). اليوم ${day(Date.now())}:\n${lines.join("\n")}`;
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
    ...assigneeArgs,
    due: v.optional(v.number()),
    priority: v.optional(taskPriority),
  },
  handler: async (ctx, a) => await createAs(ctx, await requireActive(ctx), a),
});

type CreateArgs = { spaceId: Id<"spaces">; title: string; body?: string; assigneeIds?: Id<"users">[]; assigneeId?: Id<"users">; due?: number; priority?: Doc<"tasks">["priority"] };

/** A new task in a shared space, by its manager (the screen and the create_task tool). */
async function createAs(ctx: MutationCtx, me: Actor, { spaceId, title, body, assigneeIds: picked, assigneeId, due, priority }: CreateArgs) {
  {
    const { space } = await assertTaskCan(ctx, me.userId, spaceId, "manage");
    const assigneeIds = await requireAssignable(ctx, space, { assigneeIds: picked, assigneeId });
    const now = Date.now();
    const t = cleanTitle(title);
    const taskId = await ctx.db.insert("tasks", {
      spaceId: space._id,
      title: t,
      body: cleanBody(body),
      createdBy: me.userId,
      assigneeIds,
      due,
      priority: priority ?? "normal",
      status: "new",
      links: [],
      createdAt: now,
      updatedAt: now,
    });
    const task = (await ctx.db.get(taskId))!;
    await writeAudit(ctx, { userId: me.userId, action: "task.assign", resourceType: "task", resourceId: taskId, spaceId: space._id, detail: { taskTitle: t, assigneeIds: assigneeIds.join(","), assigneeNames: await namesOf(ctx, assigneeIds), created: true } });
    await notifyMany(ctx, me, space, task, assigneeIds, "task.assigned", `مهمة جديدة: ${t}`, `أسندها إليك ${who(me)} في «${space.name}»`);
    return taskId;
  }
}

/** Manager edits title, body, due date (null clears it) and priority. */
export const update = mutation({
  args: { taskId: v.id("tasks"), title: v.optional(v.string()), body: v.optional(v.string()), due: v.optional(v.union(v.number(), v.null())), priority: v.optional(taskPriority) },
  handler: async (ctx, a) => await updateAs(ctx, await requireActive(ctx), a),
});

async function updateAs(ctx: MutationCtx, me: Actor, { taskId, title, body, due, priority }: { taskId: string; title?: string; body?: string; due?: number | null; priority?: Doc<"tasks">["priority"] }) {
  {
    const { task } = await taskAccess(ctx, me, taskId, "manage");
    const changes: Partial<Doc<"tasks">> = { updatedAt: Date.now() };
    if (title !== undefined) changes.title = cleanTitle(title);
    if (body !== undefined) changes.body = cleanBody(body);
    if (due !== undefined) changes.due = due ?? undefined;
    if (priority !== undefined) changes.priority = priority;
    await ctx.db.patch(task._id, changes);
  }
}

/**
 * Manager sets the task's assignees (the whole list; managers or members of the same space). Only
 * the newly added are notified; one audit row records who was added and who removed.
 */
export const assign = mutation({
  args: { taskId: v.id("tasks"), ...assigneeArgs },
  handler: async (ctx, a) => await assignAs(ctx, await requireActive(ctx), a),
});

async function assignAs(ctx: MutationCtx, me: Actor, { taskId, assigneeIds: picked, assigneeId }: { taskId: string; assigneeIds?: Id<"users">[]; assigneeId?: Id<"users"> }) {
  {
    const { task, space } = await taskAccess(ctx, me, taskId, "manage");
    const assigneeIds = await requireAssignable(ctx, space, { assigneeIds: picked, assigneeId });
    const before = assigneesOf(task);
    const added = assigneeIds.filter((u) => !before.includes(u));
    const removed = before.filter((u) => !assigneeIds.includes(u));
    if (!added.length && !removed.length) return;
    await ctx.db.patch(task._id, { assigneeIds, assigneeId: undefined, updatedAt: Date.now() });
    await writeAudit(ctx, {
      userId: me.userId,
      action: "task.assign",
      resourceType: "task",
      resourceId: task._id,
      spaceId: space._id,
      detail: {
        taskTitle: task.title,
        assigneeIds: assigneeIds.join(","),
        assigneeNames: await namesOf(ctx, assigneeIds),
        added: added.join(",") || null,
        removed: removed.join(",") || null,
        from: before.join(","),
      },
    });
    await notifyMany(ctx, me, space, task, added, "task.assigned", `أُسندت إليك مهمة: ${task.title}`, `أسندها إليك ${who(me)} في «${space.name}»`);
  }
}

export const setStatus = mutation({
  args: { taskId: v.id("tasks"), status: taskStatus },
  handler: async (ctx, a) => await setStatusAs(ctx, await requireActive(ctx), a),
});

async function setStatusAs(ctx: MutationCtx, me: Actor, { taskId, status }: { taskId: string; status: Status }) {
  {
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
      await notifyMany(ctx, me, space, task, assigneesOf(task), "task.closed", `أُغلقت المهمة: ${task.title}`, `أغلقها ${who(me)}`);
    } else if (task.status === "done") {
      await writeAudit(ctx, { userId: me.userId, action: "task.reopen", resourceType: "task", resourceId: task._id, spaceId: space._id, detail: { taskTitle: task.title } });
      await notifyMany(ctx, me, space, task, assigneesOf(task), "task.returned", `أُعيد فتح المهمة: ${task.title}`, `أعاد فتحها ${who(me)}`);
    } else if (task.status === "review" && status === "inProgress") {
      await notifyMany(ctx, me, space, task, assigneesOf(task), "task.returned", `أُعيدت إليك المهمة للتعديل: ${task.title}`, `أعادها ${who(me)}`);
    }
  }
}

async function requireAttach(ctx: MutationCtx, me: Actor, taskId: string) {
  const access = await taskAccess(ctx, me, taskId);
  if (!access.isAssignee && !access.canManage) throw new Denied();
  if (access.task.status === "done") throw new OneBaseError("المهمة مغلقة؛ يعيد المدير فتحها أولاً");
  return access;
}

/** Attaches a file or an artifact that lives in the task's own space. */
export const addLink = mutation({
  args: { taskId: v.id("tasks"), type: taskLinkType, id: v.string() },
  handler: async (ctx, a) => await addLinkAs(ctx, await requireActive(ctx), a),
});

async function addLinkAs(ctx: MutationCtx, me: Actor, { taskId, type, id }: { taskId: string; type: LinkType; id: string }) {
  {
    const { task } = await requireAttach(ctx, me, taskId);
    const target = await linkTarget(ctx, type, id);
    // Another space's file gets exactly the answer a missing one gets: nothing to probe.
    if (!target || target.spaceId !== task.spaceId) throw new Denied();
    if (task.links.some((l) => l.type === type && l.id === id)) return;
    if (task.links.length >= 100) throw new OneBaseError("عدد المرفقات أكثر من المسموح");
    await ctx.db.patch(task._id, { links: [...task.links, { type, id, addedBy: me.userId, addedAt: Date.now() }], updatedAt: Date.now() });
  }
}

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
  // mentions: user ids picked from mentions:people. Only people who can view the task are
  // notified and get a "الإشارات" row; anyone else is ignored silently (mentions.ts).
  args: { taskId: v.id("tasks"), body: v.string(), mentions: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => await commentAs(ctx, await requireActive(ctx), a),
});

async function commentAs(ctx: MutationCtx, me: Actor, { taskId, body, mentions }: { taskId: string; body: string; mentions?: string[] }) {
  {
    const { task, space } = await taskAccess(ctx, me, taskId, "comment");
    const text = cleanBody(body, COMMENT_MAX);
    if (!text) throw new OneBaseError("التعليق فارغ");
    if ((mentions?.length ?? 0) > 20) throw new OneBaseError("إشارات كثيرة في تعليق واحد");
    const now = Date.now();
    const id = await ctx.db.insert("taskComments", { taskId: task._id, authorId: me.userId, body: text, createdAt: now });
    const preview = text.length > 140 ? text.slice(0, 140) + "…" : text;
    const mentioned = new Set<string>();
    for (const raw of new Set(mentions ?? [])) {
      const uid = ctx.db.normalizeId("users", raw);
      if (!uid || uid === me.userId || !(await canView(ctx, uid, space))) continue;
      mentioned.add(uid);
      await ctx.db.insert("mentions", { userId: uid, byId: me.userId, taskId: task._id, spaceId: space._id, commentId: id, excerpt: preview, createdAt: now });
      await notify(ctx, uid, { kind: "task.mention", title: `أشار إليك ${who(me)} في: ${task.title}`, body: preview, taskId: task._id, spaceId: space._id });
    }
    const others = [...assigneesOf(task), ...(await managersOf(ctx, space._id))].filter((u) => !mentioned.has(u));
    await notifyMany(ctx, me, space, task, others, "task.comment", `تعليق من ${who(me)} على: ${task.title}`, preview);
    return id;
  }
}

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

// ---- the assistant's task tools (create_task, update_task) -------------------------------------
//
// The assistant creates, assigns and moves tasks with the same functions as the screens (createAs,
// assignAs, setStatusAs, commentAs, addLinkAs), so it can do exactly what the person can and no
// more. Every call notifies other people, so it always waits for «نفّذ» (tiers.ts). Spaces, people
// and tasks are named as the person says them; checkTaskCall turns names into ids, or says what
// matched or what's there, before any card is shown. The same check runs again when it executes.

const norm = (x: string) =>
  x
    .normalize("NFKC")
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** One item by id, exact name, then a unique partial name; otherwise what to choose from. */
function pickOne<T>(items: T[], want: string, id: (t: T) => string, name: (t: T) => string, what: string): T {
  const w = norm(want);
  const hit = items.find((t) => id(t) === want.trim()) ?? items.find((t) => norm(name(t)) === w);
  if (hit) return hit;
  const partial = w.length >= 2 ? items.filter((t) => norm(name(t)).includes(w) || w.includes(norm(name(t)))) : [];
  if (partial.length === 1) return partial[0]!;
  const list = (xs: T[]) => xs.slice(0, 8).map((t) => `«${name(t)}»`).join("، ");
  if (partial.length > 1) throw new OneBaseError(`«${want}» يطابق أكثر من ${what}: ${list(partial)}. حدّد واحداً`);
  throw new OneBaseError(items.length ? `لا يوجد ${what} باسم «${want}». الموجود: ${list(items)}` : `لا يوجد ${what} متاح`);
}

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const STATUSES = ["new", "inProgress", "review", "done"] as const;

/** «2026-12-01» → that day (noon in Riyadh, so it's the same date in every time zone the app shows). */
function parseDue(d: unknown): number | null | undefined {
  if (d === undefined || d === "") return undefined;
  if (d === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim());
  if (!m) throw new OneBaseError("الموعد: التاريخ بصيغة YYYY-MM-DD");
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9);
  if (Number.isNaN(t)) throw new OneBaseError("الموعد: التاريخ غير صالح");
  return t;
}

/** People a task in this space can go to (its managers and members), with their names. */
async function assignable(ctx: Ctx, space: Doc<"spaces">) {
  const rows = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", space._id)).collect();
  const out: { userId: Id<"users">; name: string }[] = [];
  for (const r of rows) {
    if (!canBeAssignee(await currentSpaceRole(ctx, r.userId, space))) continue;
    const u = await ctx.db.get(r.userId);
    if (u) out.push({ userId: r.userId, name: u.name ?? u.email ?? "" });
  }
  return out;
}

async function peopleIn(ctx: Ctx, space: Doc<"spaces">, names: unknown): Promise<{ userId: Id<"users">; name: string }[]> {
  const want = (Array.isArray(names) ? names : [names]).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!want.length) throw new OneBaseError("اذكر اسم مسؤول واحد على الأقل");
  const pool = await assignable(ctx, space);
  const out = new Map<string, { userId: Id<"users">; name: string }>();
  for (const w of want) {
    const p = pickOne(pool, w, (x) => x.userId, (x) => x.name, `عضو في «${space.name}»`);
    out.set(p.userId, p);
  }
  return [...out.values()];
}

/** The shared spaces in the turn's scope where this person manages tasks. */
async function managedSpaces(ctx: Ctx, me: Actor, scopeSpaceIds: string[]) {
  const out: Doc<"spaces">[] = [];
  for (const sid of scopeSpaceIds) {
    try {
      const { space } = await assertTaskCan(ctx, me.userId, sid, "manage");
      out.push(space);
    } catch {}
  }
  return out;
}

/** Tasks in the turn's scope this person can see (any role in their space). */
async function visibleTasks(ctx: Ctx, me: Actor, scopeSpaceIds: string[]) {
  const out: { task: Doc<"tasks">; space: Doc<"spaces"> }[] = [];
  for (const sid of scopeSpaceIds) {
    let space: Doc<"spaces">;
    try {
      space = (await assertTaskCan(ctx, me.userId, sid, "view")).space;
    } catch {
      continue;
    }
    for (const task of await ctx.db.query("tasks").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect()) out.push({ task, space });
  }
  return out;
}

type ToolCall = { userId: Id<"users">; tool: string; args: any; scopeSpaceIds: string[]; chatSpaceId?: string | null };
export type TaskPlan =
  | { kind: "create"; space: Doc<"spaces">; title: string; body?: string; people: { userId: Id<"users">; name: string }[]; due?: number; priority: Doc<"tasks">["priority"]; lines: string[] }
  | {
      kind: "update";
      space: Doc<"spaces">;
      task: Doc<"tasks">;
      status?: Status;
      comment?: string;
      people?: { userId: Id<"users">; name: string }[];
      due?: number | null;
      priority?: Doc<"tasks">["priority"];
      attach: { type: LinkType; id: string; name: string }[];
      lines: string[];
    };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * What a create_task / update_task call would do, checked as the person: names resolved, rights
 * and the status flow enforced. Throws a OneBaseError that says how to fix the call.
 */
export async function checkTaskCall(ctx: Ctx, c: ToolCall): Promise<TaskPlan> {
  const me = await actorFor(ctx, c.userId);
  if (!me) throw new Denied();
  const a = c.args ?? {};
  if (c.tool === "create_task") {
    const spaces = await managedSpaces(ctx, me, c.scopeSpaceIds);
    if (!spaces.length) throw new OneBaseError("لا تدير أي مساحة مشتركة هنا؛ المهام ينشئها ويسندها مدير المساحة");
    const space = a.space
      ? pickOne(spaces, String(a.space), (x) => x._id, (x) => x.name, "مساحة تديرها")
      : spaces.find((x) => x._id === c.chatSpaceId) ?? (spaces.length === 1 ? spaces[0]! : null);
    if (!space) throw new OneBaseError(`في أي مساحة؟ اذكر space، من التي تديرها: ${spaces.map((x) => `«${x.name}»`).join("، ")}`);
    const title = cleanTitle(String(a.title ?? ""));
    const people = await peopleIn(ctx, space, a.assignees);
    if (people.length > MAX_ASSIGNEES) throw new OneBaseError(`لا تُسند المهمة لأكثر من ${MAX_ASSIGNEES} شخصاً`);
    const due = parseDue(a.due) ?? undefined;
    const priority = PRIORITIES.includes(a.priority) ? (a.priority as Doc<"tasks">["priority"]) : "normal";
    const lines = [`في «${space.name}»`, `إلى: ${people.map((p) => p.name).join("، ")}`, ...(due ? [`الموعد: ${day(due)}`] : []), `الأولوية: ${PRIORITY_AR[priority]}`];
    return { kind: "create", space, title, body: cleanBody(a.description === undefined ? undefined : String(a.description)), people, due, priority, lines };
  }
  if (c.tool === "update_task") {
    const tasks = await visibleTasks(ctx, me, c.scopeSpaceIds);
    const hit = pickOne(tasks, String(a.task ?? ""), (x) => x.task._id, (x) => x.task.title, "مهمة تراها");
    const { task, space, canManage, isAssignee, role } = await taskAccess(ctx, me, hit.task._id);
    const lines: string[] = [`المهمة: ${task.title} (${STATUS_AR[task.status]})`];
    const plan: Extract<TaskPlan, { kind: "update" }> = { kind: "update", space, task, attach: [], lines };
    const manageOnly = (what: string) => {
      if (!canManage) throw new OneBaseError(`${what} لمدير المساحة فقط`);
    };
    if (a.status !== undefined && a.status !== task.status) {
      if (!STATUSES.includes(a.status)) throw new OneBaseError(`الحالة واحدة من: ${STATUSES.join("، ")}`);
      const allowed = nextStatuses(task.status, isAssignee, canManage);
      if (!allowed.includes(a.status)) throw new OneBaseError(allowed.length ? `من «${STATUS_AR[task.status]}» تنتقل فقط إلى: ${allowed.map((x) => `${x} (${STATUS_AR[x]})`).join("، ")}` : "لا تملك تغيير حالة هذه المهمة");
      plan.status = a.status;
      lines.push(`الحالة: ${STATUS_AR[task.status]} ← ${STATUS_AR[a.status as Status]}`);
    }
    if (a.assignees !== undefined) {
      manageOnly("إسناد المهمة");
      plan.people = await peopleIn(ctx, space, a.assignees);
      lines.push(`المسؤولون: ${plan.people.map((p) => p.name).join("، ")}`);
    }
    if (a.due !== undefined) {
      manageOnly("تغيير الموعد");
      plan.due = parseDue(a.due) ?? null;
      lines.push(plan.due ? `الموعد: ${day(plan.due)}` : "بلا موعد");
    }
    if (a.priority !== undefined) {
      manageOnly("تغيير الأولوية");
      if (!PRIORITIES.includes(a.priority)) throw new OneBaseError(`الأولوية واحدة من: ${PRIORITIES.join("، ")}`);
      plan.priority = a.priority;
      lines.push(`الأولوية: ${PRIORITY_AR[a.priority as Doc<"tasks">["priority"]]}`);
    }
    if (a.comment !== undefined && String(a.comment).trim()) {
      if (!taskRoleAllows(role, "comment")) throw new OneBaseError("دورك في المساحة لا يسمح بالتعليق");
      plan.comment = cleanBody(String(a.comment), COMMENT_MAX);
      lines.push(`تعليق: ${plan.comment!.slice(0, 200)}`);
    }
    for (const l of Array.isArray(a.attach) ? a.attach : []) {
      if (!isAssignee && !canManage) throw new OneBaseError("يرفق المسؤول عن المهمة أو مدير المساحة فقط");
      if (task.status === "done") throw new OneBaseError("المهمة مغلقة؛ يعيد المدير فتحها أولاً");
      const type: LinkType = l?.type === "file" ? "file" : "artifact";
      const target = await linkTarget(ctx, type, String(l?.id ?? ""));
      if (!target || target.spaceId !== task.spaceId) throw new OneBaseError(`المرفق غير موجود في «${space.name}»؛ يُرفق ما في مساحة المهمة نفسها فقط`);
      plan.attach.push({ type, id: String(l.id), name: target.name });
      lines.push(`مرفق: ${target.name}`);
    }
    if (lines.length === 1) throw new OneBaseError("لم يُطلب أي تغيير: أرسل status أو comment أو assignees أو due أو priority أو attach");
    return plan;
  }
  throw new OneBaseError("أداة مهام غير معروفة");
}

const toolCallArgs = { userId: v.id("users"), tool: v.string(), args: v.any(), scopeSpaceIds: v.array(v.string()), chatSpaceId: v.optional(v.union(v.string(), v.null())) };

/** What the card shows before «نفّذ»: the task, the space, the people and the changes in words. */
export const describeForTool = internalQuery({
  args: toolCallArgs,
  handler: async (ctx, c): Promise<{ title: string; lines: string[] } | { error: string }> => {
    try {
      const p = await checkTaskCall(ctx, c);
      return { title: p.kind === "create" ? p.title : p.task.title, lines: p.lines };
    } catch (e) {
      return { error: e instanceof OneBaseError ? e.message : "تعذّر التحقق" };
    }
  },
});

/** Runs a confirmed call: checked again as the person, then the screens' own functions. All or nothing. */
export const runForTool = internalMutation({
  args: toolCallArgs,
  handler: async (ctx, c): Promise<{ taskId: string; title: string; spaceId: string; spaceName: string; done: string[] }> => {
    const me = await actorFor(ctx, c.userId);
    if (!me) throw new Denied();
    const p = await checkTaskCall(ctx, c);
    if (p.kind === "create") {
      const taskId = await createAs(ctx, me, { spaceId: p.space._id, title: p.title, body: p.body, assigneeIds: p.people.map((x) => x.userId), due: p.due, priority: p.priority });
      return { taskId, title: p.title, spaceId: p.space._id, spaceName: p.space.name, done: [`أُنشئت وأُسندت إلى ${p.people.map((x) => x.name).join("، ")}`] };
    }
    const done: string[] = [];
    const id = p.task._id;
    if (p.people) {
      await assignAs(ctx, me, { taskId: id, assigneeIds: p.people.map((x) => x.userId) });
      done.push(`أُسندت إلى ${p.people.map((x) => x.name).join("، ")}`);
    }
    if (p.due !== undefined || p.priority !== undefined) {
      await updateAs(ctx, me, { taskId: id, ...(p.due !== undefined ? { due: p.due } : {}), ...(p.priority ? { priority: p.priority } : {}) });
      done.push("حُدّثت التفاصيل");
    }
    for (const l of p.attach) await addLinkAs(ctx, me, { taskId: id, type: l.type, id: l.id });
    if (p.attach.length) done.push(`أُرفق ${p.attach.map((l) => `«${l.name}»`).join("، ")}`);
    if (p.comment) {
      await commentAs(ctx, me, { taskId: id, body: p.comment });
      done.push("أُضيف التعليق");
    }
    // Last: a status change may close the task, after which nothing can be attached.
    if (p.status) {
      await setStatusAs(ctx, me, { taskId: id, status: p.status });
      done.push(`الحالة الآن «${STATUS_AR[p.status]}»`);
    }
    return { taskId: id, title: p.task.title, spaceId: p.space._id, spaceName: p.space.name, done };
  },
});
