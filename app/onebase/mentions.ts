// @mentions (UX redesign).
//
// Two kinds, decided deliberately differently:
//  - In the chat composer, "@" lists files and spaces (agents are chosen in the picker). Mentioning a file or a space only
//    *narrows* that question's scope (chat.send → turn.mentions → agents.narrowByMentions, always
//    intersected with readable ∩ agent scope ∩ thread scope). Chats
//    are private, so there are no people to mention there.
//  - In a task comment, "@" lists people: the task space's named members who can view the task.
//    A mention notifies them and lands in their "الإشارات" list, shown only while they can still
//    view the task (re-checked on every read, fail-closed). Mentioning someone who can't see the
//    task does nothing (no notification, no row, no error that would reveal anything).
//
// The suggestion lists come only from what the caller can read right now.

import { v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assertCan, assertTaskCan, currentSpaceRole, Denied, readableSpaceIds, requireActive, taskRoleAllows } from "./access";

const norm = (s: string) => s.toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
const matches = (name: string, q: string) => !q || norm(name).includes(q);

/** What "@" offers in the chat composer: files and spaces I can read (in the space, for a space chat). */
export const suggest = query({
  args: { q: v.optional(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, { q, spaceId }) => {
    const me = await requireActive(ctx);
    const needle = norm((q ?? "").trim());
    let spaceIds: Id<"spaces">[];
    if (spaceId) spaceIds = [(await assertCan(ctx, me.userId, spaceId, "read")).space._id];
    else spaceIds = await readableSpaceIds(ctx, me.userId);
    const spaces: { kind: "space"; id: string; name: string; detail: string }[] = [];
    const files: { kind: "file"; id: string; name: string; detail: string; updatedAt: number }[] = [];
    for (const id of spaceIds) {
      const s = await ctx.db.get(id);
      if (!s) continue;
      const name = s.kind === "personal" ? "مساحتي" : s.name;
      if (!spaceId && matches(name, needle)) spaces.push({ kind: "space", id: s._id, name, detail: s.kind === "personal" ? "مساحتك الخاصة" : "مساحة مشتركة" });
      for (const f of await ctx.db.query("files").withIndex("by_space", (q) => q.eq("spaceId", id)).collect()) {
        if (f.status === "active" && matches(f.name, needle)) files.push({ kind: "file", id: f._id, name: f.name, detail: name, updatedAt: f.updatedAt });
      }
    }
    // Agents are not offered here: they're picked in the composer's agent picker. Mixing them with
    // files made "@name" switch the whole chat to an agent the user took for a file.
    const agents: { kind: "agent"; id: string; name: string; detail: string }[] = [];
    return {
      files: files.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(({ updatedAt: _, ...f }) => f),
      spaces: spaces.slice(0, 6),
      agents: agents.slice(0, 6),
    };
  },
});

/** People I can mention in a comment on this task: its space's named members who can view it (not me). */
export const people = query({
  args: { taskId: v.string(), q: v.optional(v.string()) },
  handler: async (ctx, { taskId, q }) => {
    const me = await requireActive(ctx);
    const id = ctx.db.normalizeId("tasks", taskId);
    const task = id ? await ctx.db.get(id) : null;
    if (!task) throw new Denied();
    const { space } = await assertTaskCan(ctx, me.userId, task.spaceId, "comment");
    const needle = norm((q ?? "").trim());
    const out = [];
    for (const m of await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", space._id)).collect()) {
      if (m.userId === me.userId) continue;
      if (!taskRoleAllows(await currentSpaceRole(ctx, m.userId, space), "view")) continue;
      const u = await ctx.db.get(m.userId);
      const name = u?.name ?? u?.email ?? "";
      if (!matches(name, needle)) continue;
      out.push({ userId: m.userId, name, role: m.role });
    }
    return out.slice(0, 10);
  },
});

async function visibleMentions(ctx: QueryCtx, userId: Id<"users">, limit: number) {
  const rows = await ctx.db.query("mentions").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").take(300);
  const names = new Map<string, string | null>();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    let task: Doc<"tasks"> | null = null;
    try {
      task = await ctx.db.get(r.taskId);
      if (!task) continue;
      await assertTaskCan(ctx, userId, task.spaceId, "view");
    } catch {
      continue; // lost access or the task is gone: hidden
    }
    const comment = await ctx.db.get(r.commentId);
    if (!comment) continue;
    if (!names.has(r.byId)) {
      const u = await ctx.db.get(r.byId);
      names.set(r.byId, u?.name ?? u?.email ?? null);
    }
    const space = await ctx.db.get(task.spaceId);
    out.push({
      id: r._id,
      taskId: task._id,
      taskTitle: task.title,
      spaceId: task.spaceId,
      spaceName: space?.name ?? "",
      by: names.get(r.byId) ?? null,
      excerpt: r.excerpt,
      createdAt: r.createdAt,
      read: !!r.readAt,
    });
  }
  return out;
}

/** "الإشارات": where people mentioned me (task comments I can still see), newest first. */
export const inbox = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const me = await requireActive(ctx);
    return visibleMentions(ctx, me.userId, Math.min(Math.max(Math.floor(limit ?? 50), 1), 100));
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    return (await visibleMentions(ctx, me.userId, 100)).filter((m) => !m.read).length;
  },
});

/** Marks my mentions read (all, or the given ones). Other people's rows are never touched. */
export const markRead = mutation({
  args: { ids: v.optional(v.array(v.string())) },
  handler: async (ctx, { ids }) => {
    const me = await requireActive(ctx);
    const now = Date.now();
    if (ids) {
      for (const raw of ids) {
        const id = ctx.db.normalizeId("mentions", raw);
        const row = id ? await ctx.db.get(id) : null;
        if (!row || row.userId !== me.userId) throw new Denied();
        if (!row.readAt) await ctx.db.patch(row._id, { readAt: now });
      }
      return;
    }
    for (const row of await ctx.db.query("mentions").withIndex("by_user", (q) => q.eq("userId", me.userId)).collect()) {
      if (!row.readAt) await ctx.db.patch(row._id, { readAt: now });
    }
  },
});
