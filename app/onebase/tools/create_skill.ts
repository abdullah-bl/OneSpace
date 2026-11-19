// Agent tool: saves a skill to «مهاراتي» (skills.ts) when the user asks for one ("اكتبها كمهارة",
// "احفظها مهارة", a pasted SKILL.md). Private to the user, so it runs at once with «تراجع» when
// their own message asks for a skill; otherwise it waits for «نفّذ» (chat.ts). It never grants a
// tool, a space or a file: a skill is only the user's own instructions, applied with /name.

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = { name: string; title?: string; description?: string; instructions: string; scope?: "user" | "space" };

export const create_skill: AppTool<Args> = {
  name: "create_skill",
  label: "يحفظ مهارة…",
  requiresConfirmation: true,
  description:
    "Saves a skill to the user's «مهاراتي» (their own reusable instructions, run later with /name). Use it — not create_artifact — when the user asks to make, save or write something as a skill/مهارة, " +
    "or pastes a skill (e.g. a SKILL.md with name/description) to add. " +
    "name: the /name, 2–40 letters, digits, - or _, no spaces (e.g. arabic-writing). title: a short Arabic title. description: when to use it (≤ 300 chars). " +
    "instructions: the whole skill text, in one piece (≤ 16000 chars): merge any reference sections into it, condensed if needed; never leave parts for later. " +
    "scope: \"user\" (default) saves to the user's «مهاراتي»; \"space\" saves it for everyone in this chat's shared space (a manager approves a member's). " +
    "Never include keys, passwords or personal data.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "instructions"],
    properties: {
      name: { type: "string", maxLength: 40 },
      title: { type: "string", maxLength: 80 },
      description: { type: "string", maxLength: 300 },
      instructions: { type: "string" },
      scope: { type: "string", enum: ["user", "space"] },
    },
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    let spaceId: string | undefined;
    if (a?.scope === "space") {
      spaceId = (await t.ctx.runQuery(internal.skills.spaceForTool, { userId: t.userId, threadId: t.threadId, scopeSpaceIds: t.scopeSpaceIds as string[] })) ?? undefined;
      if (!spaceId) return { content: "لم تُحفظ المهارة: هذه المحادثة ليست في مساحة مشتركة. احفظها في «مهاراتي» (scope=user).", display: "لم تُحفظ المهارة: المحادثة ليست في مساحة مشتركة." };
    }
    const r = await t.ctx.runMutation(internal.skills.createFromTool, { userId: t.userId, name: String(a?.name ?? ""), title: String(a?.title ?? ""), description: String(a?.description ?? ""), instructions: String(a?.instructions ?? ""), threadId: t.threadId, spaceId });
    if (!r.ok) return { content: `لم تُحفظ المهارة: ${r.error}`, display: `لم تُحفظ المهارة: ${r.error}` };
    if (r.space) {
      const msg = r.state === "active" ? `حُفظت المهارة /${r.name} في «مهارات المساحة» (${r.space}). يستخدمها أعضاء المساحة بكتابة /${r.name}.` : `اقتُرحت المهارة /${r.name} على مديري مساحة «${r.space}»، وتظهر للأعضاء بعد اعتمادها.`;
      return { content: msg, display: msg };
    }
    return { content: `حُفظت المهارة /${r.name} في «مهاراتي». يشغّلها المستخدم بكتابة /${r.name} في أي محادثة.`, display: `حُفظت المهارة /${r.name} في «مهاراتي».`, undo: { deleteSkills: [r.id] } };
  },
};
