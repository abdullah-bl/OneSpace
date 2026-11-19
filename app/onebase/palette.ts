// Global search (Ctrl+K): finds the caller's chats, spaces, files, tasks and skills by name.
// Only what the caller can read right now (readableSpaceIds; their own chats and skills), and
// titles/names only: searching inside file contents is the assistant's job (search_documents).

import { v } from "onebase/values";
import { query } from "./_generated/server";
import { readableSpaceIds, requireActive } from "./access";

const PER_KIND = 6;

/** Lower-cased, Arabic letters unified (hamza forms, taa marbuta, alef maqsura) and diacritics dropped. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .trim();
}

export const find = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const me = await requireActive(ctx);
    const words = norm(q).split(/\s+/).filter(Boolean).slice(0, 6);
    const empty = { chats: [], spaces: [], files: [], tasks: [], skills: [] };
    if (!words.length || words.join("").length < 2) return empty;
    const hit = (text: string) => {
      const t = norm(text);
      return words.every((w) => t.includes(w));
    };

    const spaceIds = await readableSpaceIds(ctx, me.userId);
    const spaces = [];
    const spaceName = new Map<string, string>();
    for (const id of spaceIds) {
      const s = await ctx.db.get(id);
      if (!s) continue;
      const name = s.kind === "personal" ? "مساحتي" : s.name;
      spaceName.set(s._id, name);
      if (hit(name)) spaces.push({ _id: s._id, name, kind: s.kind });
    }

    const files = [];
    const tasks = [];
    for (const id of spaceIds) {
      if (files.length < PER_KIND)
        for (const f of await ctx.db.query("files").withIndex("by_space", (x) => x.eq("spaceId", id)).collect()) {
          if (f.status === "active" && hit(f.name)) files.push({ _id: f._id, name: f.name, spaceId: f.spaceId, spaceName: spaceName.get(f.spaceId) ?? "", updatedAt: f.updatedAt });
          if (files.length >= PER_KIND) break;
        }
      if (tasks.length < PER_KIND)
        for (const t of await ctx.db.query("tasks").withIndex("by_space", (x) => x.eq("spaceId", id)).collect()) {
          if (hit(t.title)) tasks.push({ _id: t._id, title: t.title, status: t.status, spaceName: spaceName.get(t.spaceId) ?? "" });
          if (tasks.length >= PER_KIND) break;
        }
    }

    const chats = (await ctx.db.query("threadMeta").withIndex("by_user", (x) => x.eq("userId", me.userId)).order("desc").take(500))
      .filter((t) => !t.test && t.title && hit(t.title))
      .slice(0, PER_KIND)
      .map((t) => ({ threadId: t.threadId, title: t.title, lastAt: t.lastAt ?? 0 }));

    const skills = (await ctx.db.query("skills").withIndex("by_owner", (x) => x.eq("ownerId", me.userId)).collect())
      .filter((s) => hit(`${s.name} ${s.title} ${s.description}`))
      .slice(0, PER_KIND)
      .map((s) => ({ _id: s._id, name: s.name, title: s.title }));

    return { chats, spaces: spaces.slice(0, PER_KIND), files: files.sort((a, b) => b.updatedAt - a.updatedAt), tasks, skills };
  },
});
