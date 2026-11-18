// Append-only audit log. writeAudit is the only writer; nothing patches or deletes rows.
// Readers: the workspace admin (everything, with file names redacted for spaces they can't read)
// and a space's managers (their space only).

import { v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx } from "./_generated/server";
import { assertCan, Denied, readableSpaceIds, requireActive } from "./access";

type Detail = Record<string, string | number | boolean | null>;

export async function writeAudit(
  ctx: MutationCtx,
  entry: { userId?: Id<"users">; action: string; resourceType: string; resourceId?: string; spaceId?: Id<"spaces">; detail?: Detail },
) {
  await ctx.db.insert("auditLog", { at: Date.now(), ...entry });
}

/** Detail fields that name file contents; hidden from viewers who can't read the space. */
const NAME_FIELDS = new Set(["fileName", "name", "fromName", "toName", "taskTitle"]);

export const list = query({
  args: {
    spaceId: v.optional(v.id("spaces")),
    userId: v.optional(v.id("users")), // a filter, not an identity: who is asking always comes from the session
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { spaceId, userId, from, to, limit }) => {
    const me = await requireActive(ctx);
    if (spaceId) {
      if (me.role !== "admin") await assertCan(ctx, me.userId, spaceId, "manage");
    } else if (me.role !== "admin") {
      throw new Denied(); // the whole-workspace log is for the workspace admin only
    }
    const max = Math.min(Math.max(Math.floor(limit ?? 200), 1), 500);
    const lo = from ?? 0;
    const hi = to ?? Number.MAX_SAFE_INTEGER;
    let rows: Doc<"auditLog">[];
    if (spaceId) {
      rows = await ctx.db
        .query("auditLog")
        .withIndex("by_space_at", (q) => q.eq("spaceId", spaceId).gte("at", lo).lte("at", hi))
        .order("desc")
        .take(userId ? 5000 : max);
    } else if (userId) {
      rows = await ctx.db
        .query("auditLog")
        .withIndex("by_user_at", (q) => q.eq("userId", userId).gte("at", lo).lte("at", hi))
        .order("desc")
        .take(max);
    } else {
      rows = await ctx.db.query("auditLog").withIndex("by_at", (q) => q.gte("at", lo).lte("at", hi)).order("desc").take(max);
    }
    if (userId) rows = rows.filter((r) => r.userId === userId).slice(0, max);

    const readable = new Set(await readableSpaceIds(ctx, me.userId));
    const names = new Map<string, string>();
    const nameOf = async (id: Id<"users"> | Id<"spaces"> | undefined) => {
      if (!id) return null;
      if (!names.has(id)) {
        const doc = (await ctx.db.get(id as any)) as any;
        names.set(id, doc ? (doc.name ?? doc.email ?? "") : "");
      }
      return names.get(id) || null;
    };
    const out = [];
    for (const r of rows) {
      const canSee = !r.spaceId || readable.has(r.spaceId);
      const detail: Detail = {};
      for (const [k, val] of Object.entries(r.detail ?? {})) detail[k] = !canSee && NAME_FIELDS.has(k) ? "•••" : val;
      out.push({
        _id: r._id,
        at: r.at,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId ?? null,
        spaceId: r.spaceId ?? null,
        spaceName: await nameOf(r.spaceId),
        userId: r.userId ?? null,
        userName: await nameOf(r.userId),
        detail,
      });
    }
    return out;
  },
});
