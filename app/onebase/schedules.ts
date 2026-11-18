// Scheduled tasks (UX redesign): "every Sunday at 8:00, summarize what changed in space X".
//
// A schedule is a prompt + an agent + an optional space scope + a recurrence (daily / weekly /
// monthly at a time, or a 5-field cron), in workspace time (ONESPACE_TZ_OFFSET_MIN, default +180
// = Asia/Riyadh). A one-minute cron (crons.ts → tick) fires what is due. Each run:
//   - runs as the creator, with their permissions *at run time*: the creator must still be an
//     active member, still able to read the space, and still allowed to use the agent; otherwise
//     the schedule stops (disabled with the reason, audited, the creator notified if still active).
//     The turn itself recomputes readable ∩ agent scope ∩ space like any chat turn (chat.ts).
//   - is a normal turn in the schedule's own thread (owned by the creator, private), so results
//     land in a chat; the creator is notified when it finishes.
//   - never executes write tools: like every turn they become pending proposals, which wait 24 h
//     for the creator's "نفّذ" (chat.ts SCHEDULED_PROPOSAL_TTL).
//   - is audited (schedule.run / schedule.skip / schedule.stopped), plus the turn's own ai.turn rows.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, requireActive } from "./access";
import { resolveAgent } from "./agents";
import { writeAudit } from "./audit";
import { nextCronTime, parseCron } from "./lib/cron";
import { queueTurn } from "./lib/turns";
import { notify } from "./notifications";

type Ctx = QueryCtx | MutationCtx;
const MAX_PER_USER = 20;
const MAX_PROMPT = 4000;
const MIN_GAP_MS = 15 * 60_000;
const tzOffset = () => Number(process.env.ONESPACE_TZ_OFFSET_MIN ?? 180) * 60_000;

const recurrenceV = v.object({
  kind: v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly"), v.literal("cron")),
  time: v.optional(v.string()),
  weekday: v.optional(v.number()),
  monthDay: v.optional(v.number()),
  cron: v.optional(v.string()),
});
type Recurrence = Doc<"schedules">["recurrence"];

/** The recurrence as a cron expression in workspace time (validated). */
export function cronOf(r: Recurrence): string {
  if (r.kind === "cron") return (r.cron ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec((r.time ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new OneBaseError("اختر وقتاً صحيحاً (س:د)");
  const [h, mi] = [Number(m[1]), Number(m[2])];
  if (r.kind === "daily") return `${mi} ${h} * * *`;
  if (r.kind === "weekly") {
    if (!Number.isInteger(r.weekday) || r.weekday! < 0 || r.weekday! > 6) throw new OneBaseError("اختر يوم الأسبوع");
    return `${mi} ${h} * * ${r.weekday}`;
  }
  if (!Number.isInteger(r.monthDay) || r.monthDay! < 1 || r.monthDay! > 28) throw new OneBaseError("اختر يوماً من 1 إلى 28");
  return `${mi} ${h} ${r.monthDay} * *`;
}

/** The next run strictly after `after` (UTC ms), evaluating the recurrence in workspace time. */
export function nextRun(r: Recurrence, after: number): number {
  let parsed;
  try {
    parsed = parseCron(cronOf(r));
  } catch (e) {
    if (e instanceof OneBaseError) throw e;
    throw new OneBaseError("تعبير cron غير صحيح: خمسة حقول «دقيقة ساعة يوم شهر يوم-الأسبوع»");
  }
  try {
    return nextCronTime(parsed, after + tzOffset()) - tzOffset();
  } catch {
    throw new OneBaseError("هذا التكرار لا يقع أبداً");
  }
}

function checkRecurrence(r: Recurrence) {
  let t = Date.now();
  const runs = [];
  for (let i = 0; i < 6; i++) runs.push((t = nextRun(r, t)));
  for (let i = 1; i < runs.length; i++) if (runs[i]! - runs[i - 1]! < MIN_GAP_MS) throw new OneBaseError("أقل فاصل بين تشغيلين ربع ساعة");
}

function describe(r: Recurrence) {
  const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  if (r.kind === "daily") return `يومياً ${r.time}`;
  if (r.kind === "weekly") return `كل ${days[r.weekday ?? 0]} ${r.time}`;
  if (r.kind === "monthly") return `شهرياً يوم ${r.monthDay} ${r.time}`;
  return `cron: ${r.cron}`;
}

async function own(ctx: Ctx, userId: Id<"users">, scheduleId: string): Promise<Doc<"schedules">> {
  const id = ctx.db.normalizeId("schedules", scheduleId);
  const s = id ? await ctx.db.get(id) : null;
  if (!s || s.userId !== userId) throw new Denied();
  return s;
}

/** Validates what the creator submits, as the creator, now. */
async function validate(ctx: MutationCtx, userId: Id<"users">, a: { title: string; prompt: string; agentId?: string | null; spaceId?: string | null; recurrence: Recurrence }) {
  const title = a.title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) throw new OneBaseError("اكتب اسماً للمهمة");
  const prompt = a.prompt.trim();
  if (!prompt) throw new OneBaseError("اكتب ما تريد تنفيذه");
  if (prompt.length > MAX_PROMPT) throw new OneBaseError("النص أطول من المسموح");
  let spaceId: Id<"spaces"> | undefined;
  if (a.spaceId) spaceId = (await assertCan(ctx, userId, a.spaceId, "read")).space._id;
  const agent = await resolveAgent(ctx, userId, { agentId: a.agentId ?? undefined });
  if ("error" in agent) throw new OneBaseError(agent.error);
  checkRecurrence(a.recurrence);
  const recurrence: Recurrence = { kind: a.recurrence.kind };
  if (a.recurrence.kind === "cron") recurrence.cron = (a.recurrence.cron ?? "").trim().replace(/\s+/g, " ");
  else recurrence.time = (a.recurrence.time ?? "").trim();
  if (a.recurrence.kind === "weekly") recurrence.weekday = a.recurrence.weekday;
  if (a.recurrence.kind === "monthly") recurrence.monthDay = a.recurrence.monthDay;
  return { title, prompt, spaceId, agentId: a.agentId ? (agent.agentId ?? undefined) : undefined, recurrence };
}

const scopeOf = (spaceId?: Id<"spaces">) => (spaceId ? { kind: "space" as const, id: spaceId as string } : { kind: "all" as const });

// ---------------------------------------------------------------- public (the creator only)

/** My scheduled tasks. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const rows = await ctx.db.query("schedules").withIndex("by_user", (q) => q.eq("userId", me.userId)).order("desc").collect();
    const out = [];
    for (const s of rows) {
      let spaceName: string | null = null;
      if (s.spaceId) {
        try {
          const { space } = await assertCan(ctx, me.userId, s.spaceId, "read");
          spaceName = space.kind === "personal" ? "مساحتي" : space.name;
        } catch {
          spaceName = null;
        }
      }
      const agent = await resolveAgent(ctx, me.userId, { agentId: s.agentId });
      out.push({
        _id: s._id,
        title: s.title,
        prompt: s.prompt,
        agentId: s.agentId ?? null,
        agentName: "error" in agent ? null : agent.config.name,
        spaceId: spaceName ? s.spaceId : null,
        spaceName,
        recurrence: s.recurrence,
        recurrenceLabel: describe(s.recurrence),
        enabled: s.enabled,
        stoppedReason: s.stoppedReason ?? null,
        nextRunAt: s.enabled ? s.nextRunAt : null,
        lastRunAt: s.lastRunAt ?? null,
        lastStatus: s.lastStatus ?? null,
        runs: s.runs,
        threadId: s.threadId,
      });
    }
    return out;
  },
});

export const create = mutation({
  args: { title: v.string(), prompt: v.string(), agentId: v.optional(v.union(v.string(), v.null())), spaceId: v.optional(v.union(v.string(), v.null())), recurrence: recurrenceV },
  handler: async (ctx, args) => {
    const me = await requireActive(ctx);
    const count = (await ctx.db.query("schedules").withIndex("by_user", (q) => q.eq("userId", me.userId)).collect()).length;
    if (count >= MAX_PER_USER) throw new OneBaseError(`حتى ${MAX_PER_USER} مهمة مجدولة لكل موظف`);
    const a = await validate(ctx, me.userId, args);
    const now = Date.now();
    const threadTitle = `مجدولة: ${a.title}`.slice(0, 80);
    const { threadId } = await ctx.components.chat.createThread({ userId: me.userId, title: threadTitle });
    const id = await ctx.db.insert("schedules", { userId: me.userId, ...a, enabled: true, nextRunAt: nextRun(a.recurrence, now), runs: 0, threadId, createdAt: now, updatedAt: now });
    await ctx.db.insert("threadMeta", { threadId, userId: me.userId, title: threadTitle, scope: scopeOf(a.spaceId), agentId: a.agentId, spaceId: a.spaceId, scheduleId: id, createdAt: now, lastAt: now });
    await writeAudit(ctx, { userId: me.userId, action: "schedule.create", resourceType: "schedule", resourceId: id, spaceId: a.spaceId, detail: { title: a.title, recurrence: cronOf(a.recurrence), agentId: a.agentId ?? null } });
    return id;
  },
});

export const update = mutation({
  args: { scheduleId: v.string(), title: v.string(), prompt: v.string(), agentId: v.optional(v.union(v.string(), v.null())), spaceId: v.optional(v.union(v.string(), v.null())), recurrence: recurrenceV },
  handler: async (ctx, { scheduleId, ...args }) => {
    const me = await requireActive(ctx);
    const s = await own(ctx, me.userId, scheduleId);
    const a = await validate(ctx, me.userId, args);
    const now = Date.now();
    await ctx.db.patch(s._id, { ...a, agentId: a.agentId, spaceId: a.spaceId, nextRunAt: nextRun(a.recurrence, now), updatedAt: now });
    await writeAudit(ctx, { userId: me.userId, action: "schedule.update", resourceType: "schedule", resourceId: s._id, spaceId: a.spaceId, detail: { title: a.title, recurrence: cronOf(a.recurrence), agentId: a.agentId ?? null } });
  },
});

export const setEnabled = mutation({
  args: { scheduleId: v.string(), enabled: v.boolean() },
  handler: async (ctx, { scheduleId, enabled }) => {
    const me = await requireActive(ctx);
    const s = await own(ctx, me.userId, scheduleId);
    if (enabled) {
      // Turning it back on checks everything again, as the creator, now.
      await validate(ctx, me.userId, { ...s, spaceId: s.spaceId ?? null, agentId: s.agentId ?? null });
    }
    await ctx.db.patch(s._id, { enabled, stoppedReason: undefined, nextRunAt: enabled ? nextRun(s.recurrence, Date.now()) : s.nextRunAt, updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: enabled ? "schedule.enable" : "schedule.disable", resourceType: "schedule", resourceId: s._id, spaceId: s.spaceId, detail: { title: s.title } });
  },
});

/** Deletes the schedule (its results thread stays in my chats). */
export const remove = mutation({
  args: { scheduleId: v.string() },
  handler: async (ctx, { scheduleId }) => {
    const me = await requireActive(ctx);
    const s = await own(ctx, me.userId, scheduleId);
    await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: "schedule.remove", resourceType: "schedule", resourceId: s._id, spaceId: s.spaceId, detail: { title: s.title, runs: s.runs } });
  },
});

/** "شغّل الآن": one run now, with the same checks as a scheduled one. */
export const runNow = mutation({
  args: { scheduleId: v.string() },
  handler: async (ctx, { scheduleId }) => {
    const me = await requireActive(ctx);
    const s = await own(ctx, me.userId, scheduleId);
    // Not thrown: a stop (lost access) must be kept, not rolled back with the mutation.
    const r = await fire(ctx, s, Date.now(), true);
    const fresh = await ctx.db.get(s._id);
    return { threadId: fresh?.threadId ?? s.threadId, error: r.error ?? null };
  },
});

// ---------------------------------------------------------------- the runner

async function stop(ctx: MutationCtx, s: Doc<"schedules">, reason: string, tell: boolean) {
  await ctx.db.patch(s._id, { enabled: false, stoppedReason: reason, updatedAt: Date.now() });
  await writeAudit(ctx, { userId: s.userId, action: "schedule.stopped", resourceType: "schedule", resourceId: s._id, spaceId: s.spaceId, detail: { title: s.title, reason } });
  if (tell) await notify(ctx, s.userId, { kind: "schedule.stopped", title: `توقفت المهمة المجدولة: ${s.title}`, body: reason, scheduleId: s._id });
  return { error: reason };
}

/** Runs one occurrence as the creator (permissions checked now). Returns an error message when it couldn't. */
async function fire(ctx: MutationCtx, s: Doc<"schedules">, now: number, manual: boolean): Promise<{ error?: string }> {
  const advance = manual ? {} : { nextRunAt: nextRun(s.recurrence, now) };
  const actor = await actorFor(ctx, s.userId);
  if (!actor) return stop(ctx, s, "صاحب المهمة لم يعد نشطاً في مساحة العمل", false);
  if (s.spaceId) {
    try {
      await assertCan(ctx, s.userId, s.spaceId, "read");
    } catch {
      return stop(ctx, s, "لم تعد تملك صلاحية الوصول إلى مساحة المهمة", true);
    }
  }
  const agent = await resolveAgent(ctx, s.userId, { agentId: s.agentId });
  if ("error" in agent) return stop(ctx, s, agent.error, true);

  // The results thread: the schedule's own, owned by the creator (recreated if they deleted it).
  let meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", s.threadId)).unique();
  let threadId = s.threadId;
  if (!meta || meta.userId !== s.userId) {
    const title = `مجدولة: ${s.title}`.slice(0, 80);
    threadId = (await ctx.components.chat.createThread({ userId: s.userId, title })).threadId;
    const id = await ctx.db.insert("threadMeta", { threadId, userId: s.userId, title, scope: scopeOf(s.spaceId), spaceId: s.spaceId, scheduleId: s._id, createdAt: now, lastAt: now });
    meta = (await ctx.db.get(id))!;
    await ctx.db.patch(s._id, { threadId });
  }
  const busy = await ctx.db
    .query("turns")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .filter((q) => q.or(q.eq(q.field("state"), "queued"), q.eq(q.field("state"), "running")))
    .first();
  if (busy) {
    await ctx.db.patch(s._id, { ...advance, updatedAt: now });
    await writeAudit(ctx, { userId: s.userId, action: "schedule.skip", resourceType: "schedule", resourceId: s._id, spaceId: s.spaceId, detail: { title: s.title, reason: "previous run still running" } });
    return { error: "التشغيل السابق لم ينتهِ بعد" };
  }
  // The schedule defines the thread's agent and scope (whatever was changed in the chat since).
  await ctx.db.patch(meta._id, { agentId: s.agentId, scope: scopeOf(s.spaceId), spaceId: s.spaceId, lastAt: now });
  const turnId = await queueTurn(ctx, { threadId, userId: s.userId, text: s.prompt, agentId: agent.agentId, agentVersion: agent.version, scheduleId: s._id, skipLimit: true });
  await ctx.db.patch(s._id, { ...advance, lastRunAt: now, lastTurnId: turnId, lastStatus: "running", runs: s.runs + 1, updatedAt: now });
  await writeAudit(ctx, {
    userId: s.userId,
    action: "schedule.run",
    resourceType: "schedule",
    resourceId: s._id,
    spaceId: s.spaceId,
    detail: { title: s.title, manual, run: s.runs + 1, agentId: agent.agentId, agentVersion: agent.version, turnId },
  });
  return {};
}

/** Every minute (crons.ts): fires the schedules that are due. `now` only for tests (internal). */
export const tick = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now }) => {
    const at = now ?? Date.now();
    const due = await ctx.db
      .query("schedules")
      .withIndex("by_due", (q) => q.eq("enabled", true).lte("nextRunAt", at))
      .take(50);
    let fired = 0;
    for (const s of due) {
      const r = await fire(ctx, s, at, false);
      if (!r.error) fired++;
    }
    return fired;
  },
});
