// The in-app notification feed (@onebase/notifications, mounted as `notes`), one subject per
// user id. The component's own functions are never exposed: these wrappers take the subject from
// the session only. A notification about a task is shown only while the reader can still see
// that task (removed from the space → its notifications disappear from the feed too); one about
// a chat thread (a scheduled task's result, a colleague's question in a shared chat) only while
// the reader may still read that thread.

import { v } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertTaskCan, requireActive, threadAllows } from "./access";

export type NotifyKind =
  | "task.assigned"
  | "task.review"
  | "task.closed"
  | "task.comment"
  | "task.returned"
  | "task.mention"
  | "schedule.result"
  | "schedule.failed"
  | "schedule.stopped"
  | "chat.shared";

/** Publishes one notification to `userId`. Internal helper; callers decide who may receive it. */
export async function notify(
  ctx: MutationCtx,
  userId: Id<"users">,
  n: { kind: NotifyKind; title: string; body?: string; taskId?: Id<"tasks">; spaceId?: Id<"spaces">; threadId?: string; scheduleId?: string; dedupeKey?: string },
) {
  const metadata: Record<string, string> = {};
  if (n.taskId) metadata.taskId = n.taskId;
  if (n.spaceId) metadata.spaceId = n.spaceId;
  if (n.threadId) metadata.threadId = n.threadId;
  if (n.scheduleId) metadata.scheduleId = n.scheduleId;
  await ctx.components.notes.publish({
    subject: userId,
    kind: n.kind,
    severity: n.kind === "task.closed" ? "success" : n.kind === "schedule.failed" || n.kind === "schedule.stopped" ? "warning" : "info",
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    metadata,
    ...(n.dedupeKey ? { dedupeKey: n.dedupeKey } : {}),
  });
}

async function visibleFeed(ctx: QueryCtx, limit: number) {
  const me = await requireActive(ctx);
  const rows = await ctx.components.notes.list({ subject: me.userId, limit });
  const out = [];
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as { taskId?: string; spaceId?: string; threadId?: string; scheduleId?: string };
    if (meta.taskId) {
      try {
        const id = ctx.db.normalizeId("tasks", meta.taskId);
        const task = id ? await ctx.db.get(id) : null;
        if (!task) continue;
        await assertTaskCan(ctx, me.userId, task.spaceId, "view");
      } catch {
        continue; // lost access (or the task is gone): drop it, fail-closed
      }
    }
    if (meta.threadId) {
      const t = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", meta.threadId!)).unique();
      // My own chat, or a shared chat I can still read (plans/14).
      if (!t || !(await threadAllows(ctx, me.userId, t, "read"))) continue;
    }
    if (meta.scheduleId) {
      const id = ctx.db.normalizeId("schedules", meta.scheduleId);
      const s = id ? await ctx.db.get(id) : null;
      if (!s || s.userId !== me.userId) continue;
    }
    out.push({
      id: r.id,
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      body: r.body ?? null,
      taskId: meta.taskId ?? null,
      threadId: meta.threadId ?? null,
      scheduleId: meta.scheduleId ?? null,
      createdAt: r.createdAtMs,
      read: r.read,
    });
  }
  return out;
}

/** My notifications, newest first. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => visibleFeed(ctx, Math.min(Math.max(Math.floor(limit ?? 30), 1), 100)),
});

/** The bell's badge: unread notifications I can still see. */
export const unreadCount = query({
  args: {},
  handler: async (ctx) => (await visibleFeed(ctx, 100)).filter((n) => !n.read).length,
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    await ctx.components.notes.markAllRead({ subject: me.userId });
  },
});
