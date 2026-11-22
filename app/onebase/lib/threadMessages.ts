// Every message of a chat (plans/18). The agent component lists a thread oldest first, a page at a
// time, so reading one page loses the *newest* messages of a long chat: always read to the end.

import type { AgentMessage } from "onebase/components/agent";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const PAGE = 1000;

export async function threadMessages(ctx: QueryCtx | MutationCtx, threadId: string): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  let cursor: string | null = null;
  while (true) {
    const r: { page: AgentMessage[]; isDone: boolean; continueCursor: string } = await ctx.components.chat.listMessages({ threadId, paginationOpts: { numItems: PAGE, cursor } });
    out.push(...r.page);
    if (r.isDone) return out;
    cursor = r.continueCursor;
  }
}
