// The new-chat screen's suggestions, made from the user's own recent work: files they touched
// lately (with the right verb for the kind of file; the file itself goes in as a chip, not text), their most used /skills, and the last chat
// to pick up again. Only what the caller can read right now; the client mixes these with a
// rotating general list so the screen changes from visit to visit.

import { v } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { assertCan, readableSpaceIds, requireActive } from "./access";

export type HomeSuggestion =
  | { kind: "file"; title: string; text: string; file: { id: string; name: string; spaceId: string } }
  | { kind: "skill"; title: string; text: string; skill: { id: string; name: string } }
  | { kind: "thread"; title: string; threadId: string };

const DAY = 24 * 3600 * 1000;

function fileSuggestion(name: string): { title: string; text: string } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["csv", "xlsx", "xls"].includes(ext)) return { title: `حلّل ${name}`, text: "حلّل بيانات هذا الملف وأعطني أهم الملاحظات والأرقام" };
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return { title: `صِف ${name}`, text: "صِف محتوى هذه الصورة" };
  if (["pptx", "ppt"].includes(ext)) return { title: `لخّص عرض ${name}`, text: "لخّص هذا العرض في نقاط" };
  return { title: `لخّص ${name}`, text: "لخّص هذا الملف وأبرز أهم ما فيه" };
}

export const suggestions = query({
  args: { spaceId: v.optional(v.string()) },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const out: HomeSuggestion[] = [];

    // Recent files: mine first, from the last month, in this space or any I can read.
    const spaceIds: Id<"spaces">[] = spaceId ? [(await assertCan(ctx, me.userId, spaceId, "read")).space._id] : await readableSpaceIds(ctx, me.userId);
    const files = [];
    for (const id of spaceIds) {
      for (const f of await ctx.db.query("files").withIndex("by_space", (q) => q.eq("spaceId", id)).collect()) {
        if (f.status === "active" && f.ingest === "ready" && f.updatedAt > Date.now() - 30 * DAY) files.push(f);
      }
    }
    files.sort((a, b) => Number(b.uploadedBy === me.userId) - Number(a.uploadedBy === me.userId) || b.updatedAt - a.updatedAt);
    for (const f of files.slice(0, 3)) out.push({ kind: "file", ...fileSuggestion(f.name), file: { id: f._id, name: f.name, spaceId: f.spaceId } });

    // Skills I actually use.
    const skills = await ctx.db.query("skills").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).collect();
    for (const s of skills.sort((a, b) => b.uses - a.uses || b.updatedAt - a.updatedAt).slice(0, 2)) {
      out.push({ kind: "skill", title: `/${s.name} · ${s.title}`, text: `/${s.name} `, skill: { id: s._id, name: s.name } });
    }

    // The last chat from the past week (not a test, scheduled or task chat), to continue.
    if (!spaceId) {
      const recent = await ctx.db.query("threadMeta").withIndex("by_user", (q) => q.eq("userId", me.userId)).order("desc").take(10);
      const last = recent.find((t) => !t.test && !t.scheduleId && !t.taskId && !t.titlePending && t.title);
      if (last && (last.lastAt ?? 0) > Date.now() - 7 * DAY) out.push({ kind: "thread", title: `تابِع «${last.title}»`, threadId: last.threadId });
    }
    return out;
  },
});
