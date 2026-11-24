// Model usage for the admin («نظرة عامة»). Every chat() call that carries `track` (ai.ts) adds
// its tokens to one row per workspace day × model × purpose × employee. Only counts are kept, never
// prompt or answer text. Embeddings, reranking and OCR are not counted yet.

import { v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import { requireAdmin } from "./access";

const tzOffset = () => Number(process.env.ONESPACE_TZ_OFFSET_MIN ?? 180) * 60_000;
/** The workspace day (YYYY-MM-DD) of a moment. */
export const dayOf = (at: number) => new Date(at + tzOffset()).toISOString().slice(0, 10);

export const record = internalMutation({
  args: {
    model: v.string(),
    provider: v.string(),
    role: v.string(),
    purpose: v.string(),
    userId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    prompt: v.number(),
    completion: v.number(),
    counted: v.boolean(),
    ms: v.number(),
    ok: v.boolean(),
  },
  handler: async (ctx, a) => {
    let userKey = a.userId ?? "-";
    if (!a.userId && a.turnId) {
      const id = ctx.db.normalizeId("turns", a.turnId);
      const turn = id ? await ctx.db.get(id) : null;
      if (turn) userKey = turn.userId;
    }
    // The answering model's fullest request in a turn: what the chat's context meter shows.
    if (a.turnId && a.ok && a.counted && (a.role === "main" || a.role === "fast")) {
      const id = ctx.db.normalizeId("turns", a.turnId);
      const turn = id ? await ctx.db.get(id) : null;
      const used = Math.max(0, a.prompt) + Math.max(0, a.completion);
      if (turn && used > (turn.contextTokens ?? 0)) await ctx.db.patch(turn._id, { contextTokens: used, contextRole: a.role });
    }
    const day = dayOf(Date.now());
    const model = a.model.slice(0, 200);
    const row = await ctx.db
      .query("aiUsage")
      .withIndex("by_key", (q) => q.eq("day", day).eq("model", model).eq("purpose", a.purpose).eq("userKey", userKey))
      .first();
    const add = { calls: 1, failed: a.ok ? 0 : 1, uncounted: a.counted || !a.ok ? 0 : 1, prompt: Math.max(0, a.prompt), completion: Math.max(0, a.completion), ms: Math.max(0, a.ms) };
    if (row) {
      await ctx.db.patch(row._id, {
        calls: row.calls + add.calls,
        failed: row.failed + add.failed,
        uncounted: row.uncounted + add.uncounted,
        prompt: row.prompt + add.prompt,
        completion: row.completion + add.completion,
        ms: row.ms + add.ms,
        provider: a.provider.slice(0, 120),
      });
    } else await ctx.db.insert("aiUsage", { day, model, provider: a.provider.slice(0, 120), role: a.role, purpose: a.purpose, userKey, ...add });
  },
});

type Totals = { calls: number; failed: number; uncounted: number; prompt: number; completion: number; ms: number };
const zero = (): Totals => ({ calls: 0, failed: 0, uncounted: 0, prompt: 0, completion: 0, ms: 0 });
const addTo = (t: Totals, r: Doc<"aiUsage">) => {
  t.calls += r.calls;
  t.failed += r.failed;
  t.uncounted += r.uncounted;
  t.prompt += r.prompt;
  t.completion += r.completion;
  t.ms += r.ms;
};

/** «استهلاك النماذج»: the last `days` workspace days (today included), and today alone. */
export const summary = query({
  args: { days: v.number() },
  handler: async (ctx, { days }) => {
    await requireAdmin(ctx);
    const n = Math.min(Math.max(Math.round(days), 1), 90);
    const today = dayOf(Date.now());
    const dayList = Array.from({ length: n }, (_, i) => dayOf(Date.now() - (n - 1 - i) * 86_400_000));
    const rows: Doc<"aiUsage">[] = [];
    for (const d of dayList) rows.push(...(await ctx.db.query("aiUsage").withIndex("by_day", (q) => q.eq("day", d)).collect()));

    const total = zero();
    const todayTotals = zero();
    const byModel = new Map<string, Totals & { model: string; provider: string; role: string }>();
    const byPurpose = new Map<string, Totals & { purpose: string }>();
    const byUser = new Map<string, Totals & { userKey: string }>();
    const byDay = new Map<string, Totals>(dayList.map((d) => [d, zero()]));
    for (const r of rows) {
      addTo(total, r);
      if (r.day === today) addTo(todayTotals, r);
      const m = byModel.get(r.model) ?? { ...zero(), model: r.model, provider: r.provider, role: r.role };
      addTo(m, r);
      byModel.set(r.model, m);
      const p = byPurpose.get(r.purpose) ?? { ...zero(), purpose: r.purpose };
      addTo(p, r);
      byPurpose.set(r.purpose, p);
      if (r.userKey !== "-") {
        const u = byUser.get(r.userKey) ?? { ...zero(), userKey: r.userKey };
        addTo(u, r);
        byUser.set(r.userKey, u);
      }
      addTo(byDay.get(r.day)!, r);
    }
    const tokens = (t: Totals) => t.prompt + t.completion;
    const people = [...byUser.values()].sort((a, b) => tokens(b) - tokens(a)).slice(0, 8);
    const named = [];
    for (const u of people) {
      const id = ctx.db.normalizeId("users", u.userKey);
      const user = id ? await ctx.db.get(id as Id<"users">) : null;
      named.push({ ...u, name: user?.name ?? user?.email ?? "—" });
    }
    return {
      days: n,
      total,
      today: todayTotals,
      byModel: [...byModel.values()].sort((a, b) => tokens(b) - tokens(a)),
      byPurpose: [...byPurpose.values()].sort((a, b) => tokens(b) - tokens(a)),
      byUser: named,
      daily: dayList.map((d) => ({ day: d, ...byDay.get(d)! })),
    };
  },
});
