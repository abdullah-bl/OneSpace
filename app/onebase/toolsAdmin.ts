// The admin console's «الأدوات» page (plans/08 §B). Tools are defined in code (onebase/tools/);
// this only reports on them.

import { query } from "./_generated/server";
import { requireAdmin } from "./access";
import { agentTools } from "./agents";
import { tools as registry } from "./tools";

// ---------------------------------------------------------------- tools tab (plans/08 §B)

/**
 * Every tool in the registry: what it does, whether it writes (and so waits for «نفّذ» in shared
 * spaces), which published agents and which levels may use it, and how often it ran and failed in
 * the last 7 days (from the audit log: ai.turn, ai.autorun, ai.confirm and source.query rows).
 */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const agents = (await ctx.db.query("agents").collect()).filter((a) => a.live);
    const levels = await ctx.db.query("levels").collect();
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const rows = await ctx.db.query("auditLog").withIndex("by_at", (q) => q.gte("at", since)).collect();
    const ran = new Map<string, number>();
    const failed = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    const seenTurn = new Set<string>();
    for (const r of rows) {
      const d = (r.detail ?? {}) as Record<string, unknown>;
      if (r.action === "ai.turn") {
        const key = `${r.resourceId}:${r.at}`; // one row per touched space: count the turn once
        if (seenTurn.has(key)) continue;
        seenTurn.add(key);
        for (const t of String(d.tools ?? "").split(",").filter(Boolean)) bump(ran, t);
        for (const t of String(d.refused ?? "").split(",").filter(Boolean)) bump(failed, t);
      } else if (r.action === "ai.autorun" && d.tool) bump(ran, String(d.tool));
      else if (r.action === "ai.confirm" && d.tool) {
        bump(ran, String(d.tool));
        if (d.ok === false) bump(failed, String(d.tool));
      } else if (r.action === "source.query" && d.ok === false) bump(failed, "query_source");
    }
    return Object.values(registry).map((t) => ({
      name: t.name,
      label: t.label.replace(/…$/, ""),
      description: t.description,
      writes: !!t.requiresConfirmation,
      agents: agents.filter((a) => agentTools(a.live!).includes(t.name)).map((a) => ({ _id: a._id, name: a.live!.name, enabled: a.enabled })),
      levels: levels.filter((l) => !l.tools || l.tools.includes(t.name)).map((l) => l.name),
      levelsTotal: levels.length,
      ran7d: ran.get(t.name) ?? 0,
      failed7d: failed.get(t.name) ?? 0,
    }));
  },
});
