// Skill routing (plans/07 §C). A chat that hasn't pinned an agent ("تلقائي") gets one chosen per
// question: code first narrows the candidates to the agents ("skills") this user may use AND whose
// data scope reaches what the question points at, then the fast model picks one of those by name
// and description. Routing never widens access: the chosen agent is resolved and its scope
// computed exactly as if the user had picked it (agents.resolveAgent / effectiveScope).

import { v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { agentTools, effectiveScope, narrowByMentions, visibleTo } from "./agents";
import { chat, type UsageTrack } from "./ai";
import { tools as registry } from "./tools";

export type Candidate = { agentId: string; name: string; description: string; tools: string[]; isDefault: boolean };
export type RouteInput = { question: string; recent: string[]; mentioned: string[]; candidates: Candidate[]; previous?: string | null; skill?: string | null };
/** How far back a follow-up without its own @mentions inherits the chat's files and agent. */
const LOOKBACK_TURNS = 6;

/**
 * A turn's @mentions, or — for a follow-up that names nothing ("على نفس الملف", "90 يوم") — those of
 * the chat's last question that named some, within LOOKBACK_TURNS. Like an attachment that stays in
 * the chat until the user points at something else. Mentions only ever narrow a turn's scope, so
 * inheriting them can't widen anything. Also returns the agent that answered before.
 */
export async function chatMentions(ctx: QueryCtx, turn: Doc<"turns">) {
  const earlier = await ctx.db
    .query("turns")
    .withIndex("by_thread", (q) => q.eq("threadId", turn.threadId))
    .order("desc")
    .take(LOOKBACK_TURNS + 1);
  const before = earlier.filter((t) => t._id !== turn._id && t.queuedAt <= turn.queuedAt);
  const inherited = turn.mentions?.length ? undefined : before.find((t) => t.mentions?.length)?.mentions;
  return { mentions: turn.mentions?.length ? turn.mentions : inherited, inherited: !!inherited, prevAgentId: before.find((t) => t.state === "done" && t.agentId)?.agentId ?? null };
}

const TABULAR = /\.(csv|tsv|xlsx|xls|json)$/i;
function fileKind(name: string) {
  return TABULAR.test(name) ? "جدول بيانات" : /\.(png|jpe?g|gif|webp)$/i.test(name) ? "صورة" : "مستند";
}

const FILE_TOOLS = ["read_file", "search_documents", "run_analysis", "export_document", "query_records"];
/** Below this the router's pick is ignored and the default skill answers. */
const MIN_CONFIDENCE = 0.45;
/**
 * Which model routes. Measured on the demo's four skills (12 questions, 2026-11-18): the main
 * model 12/12 at ~2.2 s, the 1.7B fast model 9/12 at ~0.3 s (and 3/12 answering by number).
 * A turn takes 10–60 s on this hardware, so the main model is the default; ROUTER_MODEL=fast trades
 * accuracy for latency.
 */
const routerRole = () => (process.env.ROUTER_MODEL === "fast" ? "fast" : "main");

/**
 * What the router needs for a queued turn, or null when the chat doesn't route: an agent is pinned,
 * it's an admin test chat, a scheduled run, or the follow-up to a confirmed action.
 */
export const candidates = internalQuery({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }): Promise<{ state: string; route: RouteInput | null }> => {
    const turn = await ctx.db.get(turnId);
    if (!turn) return { state: "gone", route: null };
    const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", turn.threadId)).unique();
    if (!meta || meta.userId !== turn.userId) return { state: "gone", route: null };
    if (turn.state !== "queued") return { state: turn.state, route: null };
    if (meta.agentId || meta.agentDraft || meta.test || turn.scheduleId || turn.afterProposal) return { state: turn.state, route: null };

    const page = await ctx.components.chat.listMessages({ threadId: turn.threadId, paginationOpts: { numItems: 500, cursor: null } });
    const msgs = page.page.filter((m) => (m.role === "user" || m.role === "assistant") && m.text);
    const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0) return { state: turn.state, route: null };
    // "@name" tokens are dropped: the files are listed separately, with their type (measured: the
    // token alone made the model ignore that "employees.csv" is a data table).
    const question = msgs[lastUser]!.text!.replace(/@\S+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
    const recent = msgs.slice(Math.max(0, lastUser - 2), lastUser).map((m) => `${m.role === "user" ? "المستخدم" : "المساعد"}: ${m.text!.replace(/\s+/g, " ").slice(0, 240)}`);

    // A follow-up ("على نفس الملف", "90 يوم") names nothing itself: it inherits the files of the
    // chat's last question that named some, and the agent that answered before. Measured on a real
    // chat: without this, follow-ups about a personal PDF went to a skill that can't read it.
    const { mentions, inherited, prevAgentId } = await chatMentions(ctx, turn);

    const mentioned: string[] = [];
    const fileIds = (mentions ?? []).filter((m) => m.kind === "file").map((m) => m.id);
    if (meta.scope.kind === "file" && meta.scope.id) fileIds.push(meta.scope.id);
    for (const id of fileIds) {
      const fid = ctx.db.normalizeId("files", id);
      const f = fid ? await ctx.db.get(fid) : null;
      if (f && f.status === "active") mentioned.push(`${f.name} (${fileKind(f.name)}${inherited ? "، من سؤال سابق في المحادثة" : ""})`);
    }
    const pointsAtData = fileIds.length > 0 || (mentions ?? []).some((m) => m.kind === "space");

    const out: Candidate[] = [];
    for (const a of await ctx.db.query("agents").collect()) {
      if (!a.enabled || !a.live || !(await visibleTo(ctx, turn.userId, a.live))) continue;
      if (pointsAtData) {
        // The question names files/spaces: only skills that can read them, inside their scope.
        if (!agentTools(a.live).some((t) => FILE_TOOLS.includes(t))) continue;
        const scope = await narrowByMentions(ctx, await effectiveScope(ctx, turn.userId as Id<"users">, a.live.dataScope, meta.scope), mentions);
        if (!scope.spaceIds.length) continue;
      }
      out.push({
        agentId: a._id,
        name: a.live.name,
        description: a.live.description,
        tools: agentTools(a.live).map((t) => registry[t]!.label.replace(/…$/, "")),
        isDefault: a.isDefault,
      });
    }
    out.sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name, "ar"));
    const previous = out.find((c) => c.agentId === prevAgentId)?.name ?? null;
    const sk = turn.skillId ? await ctx.db.get(turn.skillId) : null;
    const skill = sk && sk.ownerId === turn.userId ? `${sk.title}${sk.description ? `: ${sk.description}` : ""}` : null;
    return { state: turn.state, route: { question, recent, mentioned, candidates: out, previous, skill } };
  },
});

/**
 * «تلقائي» thinking when the router didn't run (one candidate, a pinned agent): long questions and
 * ones that ask to analyse, compare, plan, calculate or reason. Short and direct requests answer at once.
 */
export function wantsDeepThought(question: string): boolean {
  const q = question.replace(/@\S+/g, "").trim();
  if (q.length > 600) return true;
  return /(حلّ?ل|تحليل|قارن|مقارنة|استنتج|خطة|خطّة|احسب|لماذا|ما السبب|راجع|قيّ?م|تقييم|برهن|اشرح بالتفصيل|خطوة بخطوة|compare|analy[sz]e|plan|why|step by step|calculate)/i.test(q);
}

export function routerPrompt(r: RouteInput) {
  const list = r.candidates.map((c, i) => `${i + 1}. ${c.name}${c.isDefault ? " (الافتراضي)" : ""} — ${c.description} [أدواته: ${c.tools.join("، ") || "بلا أدوات"}]`).join("\n");
  const system =
    "أنت موجِّه. اختر المهارة الأنسب للإجابة عن طلب المستخدم من القائمة، باسمها كما في القائمة.\n" +
    "- اختر المهارة التي تملك الأدوات اللازمة.\n" +
    "- إن كان بين الملفات المشار إليها «جدول بيانات» والطلب تلخيصه أو حسابه أو رسمه أو تحليله، فاختر المهارة التي تملك «يشغّل التحليل في بيئة معزولة»؛ لا تُقرأ الجداول كنص.\n" +
    "- إنشاء ملف Word/PDF/PowerPoint يحتاج «يُنشئ ملفاً»؛ السجلات والشهادات والقوالب تحتاج «يستعلم في السجلات» أو «يجهّز مسودة المستند»؛ الأنظمة واللوائح المنشورة للجميع للمهارة التي تجيب عنها.\n" +
    "- إن كان الطلب متابعة للسؤال السابق (مثل «على نفس الملف»، «وماذا عن…»، رقم أو كلمات قليلة تكمل ما قبلها) فاختر المهارة التي أجابت عن السؤال السابق.\n" +
    "- إن كان الطلب عاماً جديداً (كتابة، ترجمة، سؤال عام) فاختر الافتراضية.\n" +
    "- deep: true إن احتاج الطلب تفكيراً متأنياً قبل الإجابة (تحليل أو مقارنة أو استنتاج متعدد الخطوات، حساب، خطة، مراجعة دقيقة لنص نظامي)، وfalse للطلبات المباشرة (كتابة قصيرة، ترجمة، سؤال واضح، متابعة بسيطة).\n" +
    "- split: true فقط إن كان الطلب يتكون من أجزاء مستقلة واضحة يُنجز كل منها وحده ثم تُجمع (مثل مقارنة عدة ملفات، أو طلب يجمع البحث في الأنظمة مع تحليل جدول، أو عدة مهام مختلفة في رسالة واحدة)، وfalse لغير ذلك وهو الغالب.\n" +
    "- confidence بين 0 و1: مدى تأكدك.\n\nالمهارات:\n" +
    list;
  const user = [
    r.recent.length ? `آخر المحادثة:\n${r.recent.join("\n")}` : "",
    r.mentioned.length ? `الملفات المشار إليها: ${r.mentioned.join("، ")}` : "",
    r.previous ? `المهارة التي أجابت عن السؤال السابق: ${r.previous}` : "",
    r.skill ? `طريقة العمل التي اختارها المستخدم لهذا الطلب: ${r.skill}` : "",
    `الطلب: ${r.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

/** Picks a candidate. One candidate: no model call. Unsure, failed or invalid: the default. */
export async function pickSkill(r: RouteInput, track?: UsageTrack): Promise<{ agentId: string | null; confidence: number; via: "only" | "model" | "fallback"; deep?: boolean; split?: boolean }> {
  const c = r.candidates;
  if (!c.length) return { agentId: null, confidence: 0, via: "fallback" };
  const fallback = (c.find((x) => x.isDefault) ?? c[0]!).agentId;
  if (c.length === 1) return { agentId: c[0]!.agentId, confidence: 1, via: "only" };
  try {
    const { system, user } = routerPrompt(r);
    const res = await chat({
      ...(track ? { track } : {}),
      role: routerRole(),
      temperature: 0,
      maxTokens: 90,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["skill", "deep", "split", "confidence"],
        // By name, not number: small models map list positions badly (measured above).
        properties: { skill: { type: "string", enum: c.map((x) => x.name) }, deep: { type: "boolean" }, split: { type: "boolean" }, confidence: { type: "number", minimum: 0, maximum: 1 } },
      },
    });
    const out = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, ""));
    const hit = c.find((x) => x.name === String(out.skill ?? "").trim());
    const confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
    const deep = typeof out.deep === "boolean" ? out.deep : undefined;
    const split = out.split === true;
    if (!hit || confidence < MIN_CONFIDENCE) return { agentId: fallback, confidence, via: "fallback", deep, split };
    return { agentId: hit.agentId, confidence, via: "model", deep, split };
  } catch {
    return { agentId: fallback, confidence: 0, via: "fallback" };
  }
}

// ---------------------------------------------------------------- sub-agents (plans/08 §A)

export type Part = { goal: string; agentId: string; agent: string };

/**
 * Splits a multi-part request into 2..max parts, each with a goal and the agent best placed to do
 * it. Fewer than two usable parts (or any failure) = don't split. Agents come only from the
 * candidates the router already narrowed to what this user may use.
 */
export async function planParts(r: RouteInput, max: number, track?: UsageTrack): Promise<Part[]> {
  const c = r.candidates;
  if (max < 2 || c.length === 0) return [];
  try {
    const list = c.map((x) => `- ${x.name}: ${x.description} [أدواته: ${x.tools.join("، ") || "بلا أدوات"}]`).join("\n");
    const res = await chat({
      ...(track ? { track } : {}),
      role: "main",
      temperature: 0,
      maxTokens: 500,
      messages: [
        {
          role: "system",
          content:
            `قسّم طلب المستخدم إلى أجزاء مستقلة (من 2 إلى ${max}) يُنجز كل منها وكيل وحده، ثم تُجمع نتائجها في إجابة واحدة.\n` +
            "- goal: جملة واحدة واضحة بما يجب أن يخرج به هذا الجزء، وتذكر الملف باسمه إن كان الجزء عن ملف بعينه.\n" +
            "- agent: الوكيل الذي يملك الأدوات اللازمة لهذا الجزء، باسمه كما في القائمة.\n" +
            "- الجزء عن «جدول بيانات» (csv/xlsx) يأخذه الوكيل الذي يملك «يشغّل التحليل في بيئة معزولة»؛ لا تُقرأ الجداول كنص.\n" +
            "- لا تضع جزءاً للتجميع أو الكتابة النهائية؛ هذا يتم بعد الأجزاء.\n" +
            `الوكلاء:\n${list}\nأعد JSON فقط.`,
        },
        { role: "user", content: [r.mentioned.length ? `الملفات المشار إليها: ${r.mentioned.join("، ")}` : "", `الطلب: ${r.question}`].filter(Boolean).join("\n\n") },
      ],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["parts"],
        properties: {
          parts: {
            type: "array",
            minItems: 2,
            maxItems: max,
            items: { type: "object", additionalProperties: false, required: ["goal", "agent"], properties: { goal: { type: "string" }, agent: { type: "string", enum: c.map((x) => x.name) } } },
          },
        },
      },
    });
    const out = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, ""));
    const parts: Part[] = [];
    for (const p of Array.isArray(out.parts) ? out.parts : []) {
      const hit = c.find((x) => x.name === String(p?.agent ?? "").trim());
      const goal = String(p?.goal ?? "").trim().slice(0, 400);
      if (hit && goal) parts.push({ goal, agentId: hit.agentId, agent: hit.name });
    }
    return parts.length >= 2 ? parts.slice(0, max) : [];
  } catch {
    return [];
  }
}
