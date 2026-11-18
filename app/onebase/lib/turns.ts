// Saves a question and queues its turn on the GPU work-queue (chat.send and "جرّب الوكيل").
// Callers have already checked who owns the thread and which agent it may use.

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { OneBaseError } from "onebase/values";

export async function queueTurn(
  ctx: MutationCtx,
  t: { threadId: string; userId: Id<"users">; text: string; agentId?: string | null; agentVersion?: number },
): Promise<Id<"turns">> {
  const { ok, retryAfter } = await ctx.components.limiter.limit({ name: "chatTurn", key: t.userId });
  if (!ok) throw new OneBaseError(`أرسلت أسئلة كثيرة في وقت قصير. حاول بعد ${Math.ceil((retryAfter ?? 1000) / 1000)} ثانية.`);
  await ctx.components.chat.saveMessage({ threadId: t.threadId, role: "user", text: t.text });
  const turnId = await ctx.db.insert("turns", {
    threadId: t.threadId,
    userId: t.userId,
    state: "queued",
    queuedAt: Date.now(),
    agentId: t.agentId ?? undefined,
    agentVersion: t.agentVersion,
  });
  await ctx.components.gpu.enqueueAction({ fn: internal.chat.runTurn, args: { turnId }, onComplete: internal.chat.turnDone, context: { turnId } });
  return turnId;
}
