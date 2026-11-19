// The user's own skills ("/" in the chat box, plans/07). A skill is instructions the user owns —
// a way of doing a task ("خطاب رسمي بصيغتنا", "تحليل سجل الغياب") — applied to one question with
// /name. Agents stay automatic (the router picks the agent by the kind of task); a skill only adds
// the user's own instructions to that answer. It never grants a tool, a space or a file: what the
// answer may touch is still the agent's scope ∩ what the user can read.
//
// The AI can draft a skill from a finished chat (draftFromThread): it returns a draft for the user
// to review and save; nothing is stored until they do.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { Denied, requireActive, requireUserId } from "./access";
import { chat, primeAi } from "./ai";
import { writeAudit } from "./audit";

export const NAME_RE = /^[\p{L}\p{N}_-]{2,40}$/u;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 300;
const INSTRUCTIONS_MAX = 8000;
const MAX_SKILLS = 100;

type Input = { name: string; title: string; description: string; instructions: string };

function clean(i: Input): Input {
  const name = String(i.name ?? "").trim().replace(/^\//, "").replace(/\s+/g, "-");
  if (!NAME_RE.test(name)) throw new OneBaseError("اسم المهارة من 2 إلى 40 حرفاً أو رقماً، بلا مسافات (يُكتب بعد /)");
  const title = String(i.title ?? "").trim().slice(0, TITLE_MAX) || name;
  const description = String(i.description ?? "").trim().slice(0, DESCRIPTION_MAX);
  const instructions = String(i.instructions ?? "").trim();
  if (!instructions) throw new OneBaseError("اكتب تعليمات المهارة");
  if (instructions.length > INSTRUCTIONS_MAX) throw new OneBaseError(`التعليمات أطول من ${INSTRUCTIONS_MAX} حرف`);
  return { name, title, description, instructions };
}

async function nameTaken(ctx: QueryCtx | MutationCtx, ownerId: Id<"users">, name: string, except?: Id<"skills">) {
  const row = await ctx.db
    .query("skills")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("name", name))
    .first();
  return !!row && row._id !== except;
}

async function mine(ctx: QueryCtx | MutationCtx, userId: Id<"users">, skillId: string): Promise<Doc<"skills">> {
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (!s || s.ownerId !== userId) throw new Denied();
  return s;
}

function shape(s: Doc<"skills">) {
  return { _id: s._id, name: s.name, title: s.title, description: s.description, instructions: s.instructions, source: s.source, uses: s.uses, updatedAt: s.updatedAt };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const rows = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerId", me.userId))
      .collect();
    return rows.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name, "ar")).map(shape);
  },
});

export const create = mutation({
  args: { name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), fromThreadId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requireActive(ctx);
    const c = clean(a);
    if (await nameTaken(ctx, me.userId, c.name)) throw new OneBaseError(`لديك مهارة باسم /${c.name}`);
    const count = (await ctx.db.query("skills").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).collect()).length;
    if (count >= MAX_SKILLS) throw new OneBaseError(`الحد ${MAX_SKILLS} مهارة`);
    let fromThreadId: string | undefined;
    if (a.fromThreadId) {
      const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", a.fromThreadId!)).unique();
      if (meta?.userId === me.userId) fromThreadId = a.fromThreadId;
    }
    const now = Date.now();
    const id = await ctx.db.insert("skills", { ownerId: me.userId, ...c, source: fromThreadId ? "chat" : "manual", fromThreadId, uses: 0, createdAt: now, updatedAt: now });
    await writeAudit(ctx, { userId: me.userId, action: "skill.create", resourceType: "skill", resourceId: id, detail: { name: c.name, source: fromThreadId ? "chat" : "manual" } });
    return id;
  },
});

export const update = mutation({
  args: { skillId: v.string(), name: v.string(), title: v.string(), description: v.string(), instructions: v.string() },
  handler: async (ctx, { skillId, ...a }) => {
    const me = await requireActive(ctx);
    const s = await mine(ctx, me.userId, skillId);
    const c = clean(a);
    if (await nameTaken(ctx, me.userId, c.name, s._id)) throw new OneBaseError(`لديك مهارة باسم /${c.name}`);
    await ctx.db.patch(s._id, { ...c, updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "skill.update", resourceType: "skill", resourceId: s._id, detail: { name: c.name } });
  },
});

export const remove = mutation({
  args: { skillId: v.string() },
  handler: async (ctx, { skillId }) => {
    const me = await requireActive(ctx);
    const s = await mine(ctx, me.userId, skillId);
    await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: "skill.delete", resourceType: "skill", resourceId: s._id, detail: { name: s.name } });
  },
});

/** The skill a question uses, checked against its owner (chat.send and the turn). */
export async function ownSkill(ctx: QueryCtx | MutationCtx, userId: Id<"users">, skillId: string | undefined) {
  if (!skillId) return null;
  return await mine(ctx, userId, skillId);
}

// ---------------------------------------------------------------- AI drafts

/** The chat to learn from: only my own thread, its recent messages. */
export const threadForDraft = internalQuery({
  args: { userId: v.id("users"), threadId: v.string() },
  handler: async (ctx, { userId, threadId }) => {
    const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", threadId)).unique();
    if (!meta || meta.userId !== userId) throw new Denied();
    const page = await ctx.components.chat.listMessages({ threadId, paginationOpts: { numItems: 500, cursor: null } });
    const msgs = page.page.filter((m) => (m.role === "user" || m.role === "assistant") && m.text).slice(-30);
    const names = (await ctx.db.query("skills").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect()).map((s) => s.name);
    return { title: meta.title, summary: meta.summary?.text ?? null, msgs: msgs.map((m) => ({ role: m.role, text: m.text!.slice(0, 2000) })), taken: names };
  },
});

const DRAFT_PROMPT = `أنت تكتب «مهارة» لموظف: تعليمات قصيرة يعيد استخدامها لاحقاً بكتابة /الاسم قبل طلب مشابه.
اقرأ المحادثة واستخرج منها طريقة العمل التي يريدها هذا الموظف: نوع المهمة، الخطوات، الصيغة والأسلوب، ما فضّله أو صحّحه، وما يجب تجنبه.
- اكتب التعليمات بصيغة الأمر للمساعد («اكتب…»، «ابدأ بـ…»، «لا تذكر…»)، عامة تصلح لطلبات مشابهة، لا لهذه المحادثة وحدها.
- لا تضع فيها بيانات شخصية ولا أرقاماً أو أسماء خاصة بهذه المحادثة إلا إن كانت جزءاً ثابتاً من طريقة العمل.
- name: كلمة أو كلمتان بلا مسافات (استخدم - بينها)، بالعربية أو الإنجليزية.
- description: جملة تقول متى تُستخدم.
أعد JSON فقط.`;

export const draftFromThread = action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<Input> => {
    await primeAi(ctx);
    const userId = await requireUserId(ctx);
    const t = await ctx.runQuery(internal.skills.threadForDraft, { userId, threadId });
    if (!t.msgs.some((m) => m.role === "assistant")) throw new OneBaseError("لا توجد إجابات في هذه المحادثة بعد");
    const convo = t.msgs.map((m) => `${m.role === "user" ? "الموظف" : "المساعد"}: ${m.text}`).join("\n\n");
    const res = await chat({
      role: "main",
      temperature: 0.2,
      maxTokens: 1500,
      messages: [
        { role: "system", content: DRAFT_PROMPT },
        { role: "user", content: `${t.summary ? `ملخص الجزء الأقدم: ${t.summary}\n\n` : ""}عنوان المحادثة: ${t.title}\n\n${convo}` },
      ],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "title", "description", "instructions"],
        properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, instructions: { type: "string" } },
      },
    });
    let d: Input;
    try {
      d = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, ""));
    } catch {
      throw new OneBaseError("تعذّر تجهيز المسودة، حاول مرة أخرى");
    }
    // A usable, free /name: cleaned, and suffixed if the user already has one like it.
    let name = String(d.name ?? "").trim().replace(/^\//, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 36) || "مهارة";
    if (name.length < 2) name = `مهارة-${name}`;
    const base = name;
    for (let i = 2; t.taken.includes(name); i++) name = `${base}-${i}`;
    return {
      name,
      title: String(d.title ?? "").slice(0, TITLE_MAX),
      description: String(d.description ?? "").slice(0, DESCRIPTION_MAX),
      instructions: String(d.instructions ?? "").slice(0, INSTRUCTIONS_MAX),
    };
  },
});
