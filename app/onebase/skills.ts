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
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, requireActive, requireUserId } from "./access";
import { chat, primeAi } from "./ai";
import { writeAudit } from "./audit";

export const NAME_RE = /^[\p{L}\p{N}_-]{2,40}$/u;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 300;
const INSTRUCTIONS_MAX = 16000;
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
  const rows = await ctx.db
    .query("skills")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("name", name))
    .collect();
  return rows.some((r) => !r.spaceId && r._id !== except);
}

/** My own personal skills (a space skill I wrote belongs to the space, not to «مهاراتي»). */
async function personalOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return (await ctx.db.query("skills").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect()).filter((s) => !s.spaceId);
}

async function mine(ctx: QueryCtx | MutationCtx, userId: Id<"users">, skillId: string): Promise<Doc<"skills">> {
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (!s || s.ownerId !== userId || s.spaceId) throw new Denied();
  return s;
}

function shape(s: Doc<"skills">) {
  return { _id: s._id, name: s.name, title: s.title, description: s.description, instructions: s.instructions, source: s.source, uses: s.uses, updatedAt: s.updatedAt };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const rows = await personalOf(ctx, me.userId);
    return rows.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name, "ar")).map(shape);
  },
});

async function insertSkill(ctx: MutationCtx, userId: Id<"users">, a: Input & { fromThreadId?: string }) {
  const c = clean(a);
  if (await nameTaken(ctx, userId, c.name)) throw new OneBaseError(`لديك مهارة باسم /${c.name}`);
  const count = (await personalOf(ctx, userId)).length;
  if (count >= MAX_SKILLS) throw new OneBaseError(`الحد ${MAX_SKILLS} مهارة`);
  let fromThreadId: string | undefined;
  if (a.fromThreadId) {
    const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", a.fromThreadId!)).unique();
    if (meta?.userId === userId) fromThreadId = a.fromThreadId;
  }
  const now = Date.now();
  const id = await ctx.db.insert("skills", { ownerId: userId, ...c, source: fromThreadId ? "chat" : "manual", fromThreadId, uses: 0, createdAt: now, updatedAt: now });
  await writeAudit(ctx, { userId, action: "skill.create", resourceType: "skill", resourceId: id, detail: { name: c.name, source: fromThreadId ? "chat" : "manual" } });
  return { id, name: c.name };
}

export const create = mutation({
  args: { name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), fromThreadId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requireActive(ctx);
    return (await insertSkill(ctx, me.userId, a)).id;
  },
});

/** The create_skill tool: same checks, as the turn's user; errors come back for the model to fix. */
export const createFromTool = internalMutation({
  args: { userId: v.id("users"), name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), threadId: v.optional(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, { userId, threadId, spaceId, ...a }) => {
    try {
      if (spaceId) {
        const r = await insertSpaceSkill(ctx, userId, spaceId, { ...a, fromThreadId: threadId });
        return { ok: true as const, id: r.id as string, name: r.name, state: r.state, space: r.space };
      }
      const r = await insertSkill(ctx, userId, { ...a, fromThreadId: threadId });
      return { ok: true as const, id: r.id as string, name: r.name, state: "active" as const, space: null };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

/** «تراجع» for a skill the assistant saved: removes it if it is still mine. */
export async function undoSkills(ctx: MutationCtx, userId: Id<"users">, ids: string[]) {
  for (const raw of ids) {
    const id = ctx.db.normalizeId("skills", raw);
    const s = id ? await ctx.db.get(id) : null;
    if (s && s.ownerId === userId && (!s.spaceId || s.state === "proposed")) {
      await ctx.db.delete(s._id);
      await writeAudit(ctx, { userId, action: "skill.delete", resourceType: "skill", resourceId: s._id, detail: { name: s.name, via: "undo" } });
    }
  }
}

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

/**
 * The skill a question uses (chat.send and the turn): one of mine, or an active skill of the chat's
 * own shared space that I can read. Anything else answers like a missing skill.
 */
export async function ownSkill(ctx: QueryCtx | MutationCtx, userId: Id<"users">, skillId: string | undefined, spaceId?: Id<"spaces"> | null) {
  if (!skillId) return null;
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (s && !s.spaceId && s.ownerId === userId) return s;
  if (s && s.spaceId && s.state === "active" && spaceId && s.spaceId === spaceId) {
    await spaceRole(ctx, userId, s.spaceId);
    return s;
  }
  throw new Denied();
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
    const names = (await personalOf(ctx, userId)).map((s) => s.name);
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
      maxTokens: 6000,
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
      console.error(`skills:draftFromThread: unparsable draft (finish ${res.finishReason}, ${res.text.length} chars)`);
      throw new OneBaseError(res.finishReason === "length" ? "المحادثة أطول من أن تُلخَّص في مهارة دفعة واحدة. جرّب «مهارة جديدة» والصق التعليمات بنفسك." : "تعذّر تجهيز المسودة، حاول مرة أخرى");
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

// ---------------------------------------------------------------- «مهارات المساحة» (plans/09 §2)

const MAX_SPACE_SKILLS = 100;
/** Index lines in the prompt: one per skill, like the memory index. */
const INDEX_MAX_ITEMS = 30;
const INDEX_MAX_CHARS = 3000;

async function spaceRole(ctx: QueryCtx | MutationCtx, userId: Id<"users">, spaceId: string) {
  const { space, role } = await assertCan(ctx, userId, spaceId, "read");
  if (space.kind !== "shared") throw new OneBaseError("مهارات المساحة للمساحات المشتركة؛ في مساحتك الخاصة استخدم «مهاراتي»");
  return { space, role, manager: role === "manager", member: role === "member" || role === "manager" };
}

async function spaceNameTaken(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">, name: string, except?: Id<"skills">) {
  for (const state of ["active", "proposed"] as const) {
    const row = await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", spaceId).eq("state", state).eq("name", name)).first();
    if (row && row._id !== except) return true;
  }
  return false;
}

/** A manager's skill is active at once; a member's waits for a manager. Readers can't add. */
async function insertSpaceSkill(ctx: MutationCtx, userId: Id<"users">, spaceId: string, a: Input & { fromThreadId?: string }) {
  const { space, manager, member } = await spaceRole(ctx, userId, spaceId);
  if (!member) throw new Denied();
  const c = clean(a);
  if (await spaceNameTaken(ctx, space._id, c.name)) throw new OneBaseError(`في المساحة مهارة باسم /${c.name}`);
  const count = (await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect()).length;
  if (count >= MAX_SPACE_SKILLS) throw new OneBaseError(`الحد ${MAX_SPACE_SKILLS} مهارة للمساحة`);
  let fromThreadId: string | undefined;
  if (a.fromThreadId) {
    const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", a.fromThreadId!)).unique();
    if (meta?.userId === userId) fromThreadId = a.fromThreadId;
  }
  const now = Date.now();
  const state = manager ? ("active" as const) : ("proposed" as const);
  const id = await ctx.db.insert("skills", {
    ownerId: userId,
    ...c,
    source: fromThreadId ? "chat" : "manual",
    fromThreadId,
    uses: 0,
    createdAt: now,
    updatedAt: now,
    spaceId: space._id,
    state,
    version: 1,
    ...(manager ? { approvedBy: userId } : {}),
  });
  await writeAudit(ctx, { userId, action: manager ? "skill.create" : "skill.propose", resourceType: "skill", resourceId: id, spaceId: space._id, detail: { name: c.name, space: true } });
  return { id, name: c.name, state, space: space.name };
}

async function spaceSkill(ctx: QueryCtx | MutationCtx, skillId: string): Promise<Doc<"skills">> {
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (!s || !s.spaceId) throw new Denied();
  return s;
}

export const space = query({
  args: { spaceId: v.string() },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space, manager, member } = await spaceRole(ctx, me.userId, spaceId);
    const rows = await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect();
    const names = new Map<string, string>();
    const by = async (uid: Id<"users">) => {
      if (!names.has(uid)) {
        const u = await ctx.db.get(uid);
        names.set(uid, u?.name ?? u?.email ?? "");
      }
      return names.get(uid)!;
    };
    const shapeS = async (s: Doc<"skills">) => ({ ...shape(s), version: s.version ?? 1, by: await by(s.ownerId), mine: s.ownerId === me.userId });
    const active = rows.filter((s) => s.state !== "proposed").sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name, "ar"));
    // Proposals: managers see all of them, a member only their own.
    const proposed = rows.filter((s) => s.state === "proposed" && (manager || s.ownerId === me.userId)).sort((a, b) => b.createdAt - a.createdAt);
    return { canManage: manager, canPropose: member && !manager, skills: await Promise.all(active.map(shapeS)), proposals: await Promise.all(proposed.map(shapeS)) };
  },
});

export const addSpace = mutation({
  args: { spaceId: v.string(), name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), fromThreadId: v.optional(v.string()) },
  handler: async (ctx, { spaceId, ...a }) => {
    const me = await requireActive(ctx);
    const r = await insertSpaceSkill(ctx, me.userId, spaceId, a);
    return { id: r.id, state: r.state };
  },
});

/** «شارك مع المساحة»: a copy of one of «مهاراتي» (mine stays as it is). */
export const shareToSpace = mutation({
  args: { skillId: v.string(), spaceId: v.string() },
  handler: async (ctx, { skillId, spaceId }) => {
    const me = await requireActive(ctx);
    const s = await mine(ctx, me.userId, skillId);
    const r = await insertSpaceSkill(ctx, me.userId, spaceId, { name: s.name, title: s.title, description: s.description, instructions: s.instructions });
    return { id: r.id, state: r.state };
  },
});

export const reviewSpace = mutation({
  args: { skillId: v.string(), approve: v.boolean() },
  handler: async (ctx, { skillId, approve }) => {
    const me = await requireActive(ctx);
    const s = await spaceSkill(ctx, skillId);
    const { manager } = await spaceRole(ctx, me.userId, s.spaceId!);
    if (!manager) throw new Denied();
    if (s.state !== "proposed") throw new OneBaseError("ليست مقترحة");
    if (approve) {
      if (await spaceNameTaken(ctx, s.spaceId!, s.name, s._id)) throw new OneBaseError(`في المساحة مهارة باسم /${s.name}`);
      await ctx.db.patch(s._id, { state: "active", approvedBy: me.userId, updatedAt: Date.now() });
    } else await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: approve ? "skill.approve" : "skill.reject", resourceType: "skill", resourceId: s._id, spaceId: s.spaceId, detail: { name: s.name } });
  },
});

export const updateSpace = mutation({
  args: { skillId: v.string(), name: v.string(), title: v.string(), description: v.string(), instructions: v.string() },
  handler: async (ctx, { skillId, ...a }) => {
    const me = await requireActive(ctx);
    const s = await spaceSkill(ctx, skillId);
    const { manager } = await spaceRole(ctx, me.userId, s.spaceId!);
    // Managers edit any; a member may still edit their own proposal.
    if (!manager && !(s.state === "proposed" && s.ownerId === me.userId)) throw new Denied();
    const c = clean(a);
    if (await spaceNameTaken(ctx, s.spaceId!, c.name, s._id)) throw new OneBaseError(`في المساحة مهارة باسم /${c.name}`);
    await ctx.db.patch(s._id, { ...c, version: (s.version ?? 1) + (s.state === "active" ? 1 : 0), updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "skill.update", resourceType: "skill", resourceId: s._id, spaceId: s.spaceId, detail: { name: c.name } });
  },
});

export const removeSpace = mutation({
  args: { skillId: v.string() },
  handler: async (ctx, { skillId }) => {
    const me = await requireActive(ctx);
    const s = await spaceSkill(ctx, skillId);
    const { manager } = await spaceRole(ctx, me.userId, s.spaceId!);
    if (!manager && !(s.state === "proposed" && s.ownerId === me.userId)) throw new Denied();
    await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: "skill.delete", resourceType: "skill", resourceId: s._id, spaceId: s.spaceId, detail: { name: s.name } });
  },
});

/** The skills a chat may use: mine, and the active ones of the chat's shared space (if I can read it). */
export async function usableSkills(ctx: QueryCtx | MutationCtx, userId: Id<"users">, spaceId: Id<"spaces"> | null) {
  const own = await personalOf(ctx, userId);
  let shared: Doc<"skills">[] = [];
  let spaceName: string | null = null;
  if (spaceId) {
    try {
      const { space } = await spaceRole(ctx, userId, spaceId);
      spaceName = space.name;
      shared = await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", space._id).eq("state", "active")).collect();
    } catch {
      shared = [];
    }
  }
  return { own, shared, spaceName };
}

/** Composer «/»: my skills and the chat's space skills. */
export const forChat = query({
  args: { spaceId: v.optional(v.string()) },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const sid = spaceId ? ctx.db.normalizeId("spaces", spaceId) : null;
    const { own, shared, spaceName } = await usableSkills(ctx, me.userId, sid);
    const rank = (a: Doc<"skills">, b: Doc<"skills">) => b.uses - a.uses || a.name.localeCompare(b.name, "ar");
    return [...shared.sort(rank).map((s) => ({ ...shape(s), space: spaceName })), ...own.sort(rank).map((s) => ({ ...shape(s), space: null }))];
  },
});

/** One line per usable skill for the system prompt; the model loads one with use_skill. */
export async function skillIndex(ctx: QueryCtx, userId: Id<"users">, spaceId: Id<"spaces"> | null): Promise<string | null> {
  const { own, shared, spaceName } = await usableSkills(ctx, userId, spaceId);
  const rank = (a: Doc<"skills">, b: Doc<"skills">) => b.uses - a.uses || b.updatedAt - a.updatedAt;
  const all = [...shared.sort(rank).map((s) => ({ s, where: `مهارة المساحة «${spaceName}»` })), ...own.sort(rank).map((s) => ({ s, where: "من مهارات الموظف" }))];
  const lines: string[] = [];
  let chars = 0;
  for (const { s, where } of all.slice(0, INDEX_MAX_ITEMS)) {
    const line = `- /${s.name}: ${s.description || s.title} (${where})`;
    if (chars + line.length > INDEX_MAX_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  const head =
    "المهارات المتاحة في هذه المحادثة (طرق عمل محفوظة؛ إذا طابق الطلب إحداها فحمّل تعليماتها بأداة use_skill قبل أن تبدأ واتبعها. لا تمنح أي صلاحية):";
  const tail =
    "إذا أنجزت مهمة من عدة خطوات يُرجّح أن تتكرر، ولم تكن هناك مهارة لها، فاعرض في آخر إجابتك حفظ هذه الطريقة كمهارة" +
    (spaceName ? ` للمساحة «${spaceName}» (create_skill مع scope=space)` : " (create_skill)") +
    "، ولا تحفظها إلا إذا وافق.";
  return lines.length ? `${head}\n${lines.join("\n")}${all.length > lines.length ? `\n(و${all.length - lines.length} غيرها: اكتب اسمها لـ use_skill)` : ""}\n\n${tail}` : tail;
}

/** The chat's shared space, if it is mine and in this turn's scope (the same rule as the index). */
async function chatSpace(ctx: QueryCtx | MutationCtx, userId: Id<"users">, threadId: string | undefined, scopeSpaceIds: string[]) {
  if (!threadId) return null;
  const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", threadId)).unique();
  if (!meta || meta.userId !== userId) return null;
  const here = meta.spaceId ?? (meta.scope.kind === "space" && meta.scope.id ? ctx.db.normalizeId("spaces", meta.scope.id) : null);
  return here && scopeSpaceIds.includes(here) ? here : null;
}

/** use_skill: the full instructions of a skill this chat may use, by /name; counts a use. */
export const useFromTool = internalMutation({
  args: { userId: v.id("users"), name: v.string(), threadId: v.optional(v.string()), scopeSpaceIds: v.array(v.string()) },
  handler: async (ctx, { userId, name, threadId, scopeSpaceIds }) => {
    const { own, shared, spaceName } = await usableSkills(ctx, userId, await chatSpace(ctx, userId, threadId, scopeSpaceIds));
    const n = name.trim().replace(/^\//, "");
    const hit = shared.find((s) => s.name === n) ?? own.find((s) => s.name === n);
    if (!hit) return { found: false as const, names: [...shared, ...own].map((s) => s.name).slice(0, 30) };
    await ctx.db.patch(hit._id, { uses: hit.uses + 1 });
    return { found: true as const, name: hit.name, title: hit.title, instructions: hit.instructions, space: hit.spaceId ? spaceName : null, version: hit.version ?? 1 };
  },
});

/** create_skill with scope "space": the chat's own shared space, never one the model names. */
export const spaceForTool = internalQuery({
  args: { userId: v.id("users"), threadId: v.optional(v.string()), scopeSpaceIds: v.array(v.string()) },
  handler: async (ctx, { userId, threadId, scopeSpaceIds }) => {
    const id = await chatSpace(ctx, userId, threadId, scopeSpaceIds);
    const space = id ? await ctx.db.get(id) : null;
    return space?.kind === "shared" ? (space._id as string) : null;
  },
});
