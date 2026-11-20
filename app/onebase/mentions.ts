// @mentions (UX redesign).
//
// Two kinds, decided deliberately differently:
//  - In the chat composer, "@" lists files and spaces (agents are chosen in the picker). Mentioning a file or a space only
//    *narrows* that question's scope (chat.send → turn.mentions → agents.narrowByMentions, always
//    intersected with readable ∩ agent scope ∩ thread scope).
//    In a chat that belongs to a shared space (threadMeta.spaceId), "@" also lists the space's
//    named members: "tell a colleague what I'm working on". On send (chat.send → mentionInChat)
//    each one gets a notification and a "الإشارات" row holding that one message's text only. The
//    chat stays private: no thread id is stored or shown, never the answer, and the row opens the
//    space, not the chat. The assistant answers the message as usual.
//  - In a task comment, "@" lists people: the task space's named members who can view the task.
//    A mention notifies them and lands in their "الإشارات" list, shown only while they can still
//    view the task (re-checked on every read, fail-closed). Mentioning someone who can't see the
//    task does nothing (no notification, no row, no error that would reveal anything). The same
//    rule holds for a chat mention: only a named member who can read the space right now.
//
// The suggestion lists come only from what the caller can read right now.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, assertTaskCan, currentSpaceRole, Denied, namedReader, readableSpaceIds, requireActive, taskRoleAllows, type Actor } from "./access";
import { notify } from "./notifications";

const norm = (s: string) => s.toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
const matches = (name: string, q: string) => !q || norm(name).includes(q);

/** The space's named members I can mention (not me), matching the query. */
async function spacePeople(ctx: QueryCtx, me: Id<"users">, space: Doc<"spaces">, needle: string) {
  const out: { userId: Id<"users">; name: string; role: Doc<"spaceMembers">["role"] }[] = [];
  for (const m of await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", space._id)).collect()) {
    if (m.userId === me || !(await namedReader(ctx, m.userId, space))) continue;
    const u = await ctx.db.get(m.userId);
    const name = u?.name ?? u?.email ?? "";
    if (matches(name, needle)) out.push({ userId: m.userId, name, role: m.role });
  }
  return out;
}

const ROLE_LABEL: Record<string, string> = { manager: "مدير", member: "عضو", reader: "قارئ" };

/** What "@" offers in the chat composer: files and spaces I can read (in the space, for a space chat), and the space's people in a shared space's chat. */
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
    const people: { kind: "person"; id: string; name: string; detail: string }[] = [];
    const home = spaceId ? await ctx.db.get(spaceIds[0]!) : null;
    if (home?.kind === "shared" && (await namedReader(ctx, me.userId, home))) {
      for (const p of await spacePeople(ctx, me.userId, home, needle)) people.push({ kind: "person", id: p.userId, name: p.name, detail: ROLE_LABEL[p.role] ?? "" });
    }
    return {
      people: people.slice(0, 6),
      files: files.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(({ updatedAt: _, ...f }) => f),
      spaces: spaces.slice(0, 6),
      agents: agents.slice(0, 6),
    };
  },
});

const PEOPLE_MAX = 20;
const EXCERPT_MAX = 1_000;

/**
 * chat.send's "@person" (a chat of a shared space): a "الإشارات" row and a notification for each
 * named member who can read the space, with this message's text only. Anyone else (not a member,
 * no longer one, me, a bad id) is skipped silently. Nothing happens outside a shared space's chat.
 */
export async function mentionInChat(ctx: MutationCtx, me: Actor, meta: Doc<"threadMeta">, people: string[], text: string) {
  if (!people.length) return;
  if (people.length > PEOPLE_MAX) throw new OneBaseError("إشارات كثيرة في رسالة واحدة");
  const space = meta.spaceId ? await ctx.db.get(meta.spaceId) : null;
  if (!space || !(await namedReader(ctx, me.userId, space))) return;
  const excerpt = text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) + "…" : text;
  const preview = text.length > 140 ? text.slice(0, 140) + "…" : text;
  const by = me.user.name ?? me.user.email ?? "";
  const now = Date.now();
  for (const raw of new Set(people)) {
    const uid = ctx.db.normalizeId("users", raw);
    if (!uid || uid === me.userId || !(await namedReader(ctx, uid, space))) continue;
    await ctx.db.insert("mentions", { userId: uid, byId: me.userId, source: "chat", spaceId: space._id, excerpt, createdAt: now });
    await notify(ctx, uid, { kind: "chat.mention", title: `أشار إليك ${by} في محادثة · ${space.name}`, body: preview, spaceId: space._id });
  }
}

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
  const by = async (id: Id<"users">) => {
    if (!names.has(id)) {
      const u = await ctx.db.get(id);
      names.set(id, u?.name ?? u?.email ?? null);
    }
    return names.get(id) ?? null;
  };
  for (const r of rows) {
    if (out.length >= limit) break;
    if (r.source === "chat") {
      // A chat mention: shown while I'm still a named member who can read the space.
      const space = await ctx.db.get(r.spaceId);
      if (!space || !(await namedReader(ctx, userId, space))) continue;
      out.push({ id: r._id, source: "chat" as const, taskId: null, taskTitle: null, spaceId: space._id, spaceName: space.name, by: await by(r.byId), excerpt: r.excerpt, createdAt: r.createdAt, read: !!r.readAt });
      continue;
    }
    let task: Doc<"tasks"> | null = null;
    try {
      task = r.taskId ? await ctx.db.get(r.taskId) : null;
      if (!task) continue;
      await assertTaskCan(ctx, userId, task.spaceId, "view");
    } catch {
      continue; // lost access or the task is gone: hidden
    }
    const comment = r.commentId ? await ctx.db.get(r.commentId) : null;
    if (!comment) continue;
    const space = await ctx.db.get(task.spaceId);
    out.push({
      id: r._id,
      source: "task" as const,
      taskId: task._id,
      taskTitle: task.title,
      spaceId: task.spaceId,
      spaceName: space?.name ?? "",
      by: await by(r.byId),
      excerpt: r.excerpt,
      createdAt: r.createdAt,
      read: !!r.readAt,
    });
  }
  return out;
}

/** "الإشارات": where people mentioned me (task comments I can still see; chats of spaces I can still read), newest first. */
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
