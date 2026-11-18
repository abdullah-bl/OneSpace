// Saves a question and queues its turn on the GPU work-queue (chat.send, chat.retry, "جرّب الوكيل"
// and scheduled tasks). Callers have already checked who owns the thread and which agent it may use.

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { OneBaseError } from "onebase/values";
import { levelOf, usedToday } from "./levels";

export async function queueTurn(
  ctx: MutationCtx,
  t: {
    threadId: string;
    userId: Id<"users">;
    text: string;
    agentId?: string | null;
    agentVersion?: number;
    mentions?: { kind: "file" | "space"; id: string }[];
    scheduleId?: string;
    /** Answer the last question from this executed proposal's output (no tools, no retrieval). */
    afterProposal?: Id<"proposals">;
    /** false = re-answer the last question (retry): no new user message. */
    saveUser?: boolean;
    /** Scheduled runs aren't the user typing: no per-user rate limit. */
    skipLimit?: boolean;
    /** "/name": the asker's own skill (checked by the caller). */
    skillId?: Id<"skills">;
    /** Thinking level from the composer: auto (decided per question), fast, deep. */
    effort?: "auto" | "fast" | "deep";
  },
): Promise<Id<"turns">> {
  if (!t.skipLimit) {
    const { ok, retryAfter } = await ctx.components.limiter.limit({ name: "chatTurn", key: t.userId });
    if (!ok) throw new OneBaseError(`أرسلت أسئلة كثيرة في وقت قصير. حاول بعد ${Math.ceil((retryAfter ?? 1000) / 1000)} ثانية.`);
  }
  // The employee's level (plans/08 §D): questions per day. Scheduled runs and «نفّذ» follow-ups don't count.
  if (!t.skipLimit && !t.afterProposal) {
    const level = await levelOf(ctx, t.userId);
    if (level.dailyQuestions > 0 && (await usedToday(ctx, t.userId)) >= level.dailyQuestions)
      throw new OneBaseError(`بلغت حدّ اليوم في مستوى «${level.name}» (${level.dailyQuestions} سؤالاً). يتجدد الحد غداً، أو اطلب من مدير مساحة العمل رفعه.`);
  }
  const userMessageId = t.saveUser !== false ? await ctx.components.chat.saveMessage({ threadId: t.threadId, role: "user", text: t.text }) : undefined;
  const turnId = await ctx.db.insert("turns", {
    threadId: t.threadId,
    userId: t.userId,
    state: "queued",
    queuedAt: Date.now(),
    agentId: t.agentId ?? undefined,
    agentVersion: t.agentVersion,
    mentions: t.mentions,
    scheduleId: t.scheduleId,
    afterProposal: t.afterProposal,
    skillId: t.skillId,
    effort: t.effort,
    userMessageId,
  });
  await ctx.components.gpu.enqueueAction({ fn: internal.chat.runTurn, args: { turnId }, onComplete: internal.chat.turnDone, context: { turnId } });
  return turnId;
}
