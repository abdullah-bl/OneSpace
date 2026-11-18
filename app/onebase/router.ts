// Skill routing (plans/07 §C). A chat that hasn't pinned an agent ("تلقائي") gets one chosen per
// question: code first narrows the candidates to the agents ("skills") this user may use AND whose
// data scope reaches what the question points at, then the fast model picks one of those by name
// and description. Routing never widens access: the chosen agent is resolved and its scope
// computed exactly as if the user had picked it (agents.resolveAgent / effectiveScope).

import { v } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { effectiveScope, narrowByMentions, visibleTo } from "./agents";
import { chat } from "./ai";
import { tools as registry } from "./tools";

export type Candidate = { agentId: string; name: string; description: string; tools: string[]; isDefault: boolean };
export type RouteInput = { question: string; recent: string[]; mentioned: string[]; candidates: Candidate[] };

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

    const mentioned: string[] = [];
    const fileIds = (turn.mentions ?? []).filter((m) => m.kind === "file").map((m) => m.id);
    if (meta.scope.kind === "file" && meta.scope.id) fileIds.push(meta.scope.id);
    for (const id of fileIds) {
      const fid = ctx.db.normalizeId("files", id);
      const f = fid ? await ctx.db.get(fid) : null;
      if (f && f.status === "active") mentioned.push(`${f.name} (${fileKind(f.name)})`);
    }
    const pointsAtData = fileIds.length > 0 || (turn.mentions ?? []).some((m) => m.kind === "space");

    const out: Candidate[] = [];
    for (const a of await ctx.db.query("agents").collect()) {
      if (!a.enabled || !a.live || !(await visibleTo(ctx, turn.userId, a.live))) continue;
      if (pointsAtData) {
        // The question names files/spaces: only skills that can read them, inside their scope.
        if (!a.live.allowedTools.some((t) => FILE_TOOLS.includes(t))) continue;
        const scope = await narrowByMentions(ctx, await effectiveScope(ctx, turn.userId as Id<"users">, a.live.dataScope, meta.scope), turn.mentions);
        if (!scope.spaceIds.length) continue;
      }
      out.push({
        agentId: a._id,
        name: a.live.name,
        description: a.live.description,
        tools: a.live.allowedTools.filter((t) => Object.hasOwn(registry, t)).map((t) => registry[t]!.label.replace(/…$/, "")),
        isDefault: a.isDefault,
      });
    }
    out.sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name, "ar"));
    return { state: turn.state, route: { question, recent, mentioned, candidates: out } };
  },
});

export function routerPrompt(r: RouteInput) {
  const list = r.candidates.map((c, i) => `${i + 1}. ${c.name}${c.isDefault ? " (الافتراضي)" : ""} — ${c.description} [أدواته: ${c.tools.join("، ") || "بلا أدوات"}]`).join("\n");
  const system =
    "أنت موجِّه. اختر المهارة الأنسب للإجابة عن طلب المستخدم من القائمة، باسمها كما في القائمة.\n" +
    "- اختر المهارة التي تملك الأدوات اللازمة.\n" +
    "- إن كان بين الملفات المشار إليها «جدول بيانات» والطلب تلخيصه أو حسابه أو رسمه أو تحليله، فاختر المهارة التي تملك «يشغّل التحليل في بيئة معزولة»؛ لا تُقرأ الجداول كنص.\n" +
    "- إنشاء ملف Word/PDF/PowerPoint يحتاج «يُنشئ ملفاً»؛ السجلات والشهادات والقوالب تحتاج «يستعلم في السجلات» أو «يجهّز مسودة المستند»؛ الأنظمة واللوائح المنشورة للجميع للمهارة التي تجيب عنها.\n" +
    "- إن كان الطلب عاماً (كتابة، ترجمة، سؤال عام، متابعة عادية) فاختر الافتراضية.\n" +
    "- confidence بين 0 و1: مدى تأكدك.\n\nالمهارات:\n" +
    list;
  const user = [
    r.recent.length ? `آخر المحادثة:\n${r.recent.join("\n")}` : "",
    r.mentioned.length ? `الملفات المشار إليها: ${r.mentioned.join("، ")}` : "",
    `الطلب: ${r.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

/** Picks a candidate. One candidate: no model call. Unsure, failed or invalid: the default. */
export async function pickSkill(r: RouteInput): Promise<{ agentId: string | null; confidence: number; via: "only" | "model" | "fallback" }> {
  const c = r.candidates;
  if (!c.length) return { agentId: null, confidence: 0, via: "fallback" };
  const fallback = (c.find((x) => x.isDefault) ?? c[0]!).agentId;
  if (c.length === 1) return { agentId: c[0]!.agentId, confidence: 1, via: "only" };
  try {
    const { system, user } = routerPrompt(r);
    const res = await chat({
      role: routerRole(),
      temperature: 0,
      maxTokens: 60,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["skill", "confidence"],
        // By name, not number: small models map list positions badly (measured above).
        properties: { skill: { type: "string", enum: c.map((x) => x.name) }, confidence: { type: "number", minimum: 0, maximum: 1 } },
      },
    });
    const out = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, ""));
    const hit = c.find((x) => x.name === String(out.skill ?? "").trim());
    const confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
    if (!hit || confidence < MIN_CONFIDENCE) return { agentId: fallback, confidence, via: "fallback" };
    return { agentId: hit.agentId, confidence, via: "model" };
  } catch {
    return { agentId: fallback, confidence: 0, via: "fallback" };
  }
}
