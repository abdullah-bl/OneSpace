// Agent tool (plans/16): in a shared chat, sends a message to colleagues for the person who called
// the assistant («خلّ محمد يراجعها», «أرسلها للمدير»). It is a team message from that person,
// marked «عبر المساعد»: the people named are notified and get the same card as any message to
// them (hand it to the assistant, take it, done). It grants nothing: the assistant never works
// with their permissions; only they can hand it to the assistant. At most 3 people, members who
// can read the chat. Shared chats only.

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

export const notify_colleague: AppTool<{ people: string[]; message: string }> = {
  name: "notify_colleague",
  label: "يرسل لزميل…",
  requiresConfirmation: true,
  description:
    "In a shared chat only: sends a message to up to 3 colleagues for the user who asked (they are notified and can act on it). " +
    "Use it only when the user asks you to tell, send to, hand to, or ask a named person or role (e.g. «خلّ محمد يراجعها», «أرسلها للمدير»). " +
    "people: their names as the user wrote them (or user ids). message: what they should know or do, short and self-contained.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["people", "message"],
    properties: {
      people: { type: "array", items: { type: "string" }, maxItems: 3 },
      message: { type: "string", maxLength: 2000 },
    },
  },
  async run(t: ToolContext, a): Promise<ToolResult> {
    if (!t.threadId || !t.sharedSpaceId) return { failed: true, content: "الإرسال للزملاء متاح في المحادثات المشتركة فقط.", display: "الإرسال للزملاء متاح في المحادثات المشتركة فقط." };
    const r = await t.ctx.runMutation(internal.chat.notifyFromTool, {
      userId: t.userId,
      threadId: t.threadId,
      people: (Array.isArray(a?.people) ? a.people : []).map((p) => String(p).slice(0, 120)).slice(0, 5),
      message: String(a?.message ?? "").slice(0, 2000),
    });
    if (!r.ok) return { failed: true, content: `لم تُرسل: ${r.error}`, display: `لم تُرسل: ${r.error}` };
    const to = r.names.join("، ");
    return { content: `أُرسلت الرسالة إلى ${to} في هذه المحادثة، ووصلهم إشعار. لا تكرّر نصها في إجابتك.`, display: `أُرسلت إلى ${to}`, undo: { withdrawMessages: [r.messageId] } };
  },
};
