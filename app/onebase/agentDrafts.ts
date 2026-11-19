// AI-written agents (plans/07): the workspace admin describes what an agent is for (or asks to
// improve an existing one) and the main model drafts its name, "when to use" line, instructions,
// tools, data scope and answer mode. It only returns a draft: the admin reviews it in the agent
// screen, saves it as a draft (agents.saveDraft validates it like any hand-written config), tries it
// and publishes. Tools can only come from the code registry; scopes and modes from their fixed sets.

import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";
import { actorFor, Denied, requireUserId } from "./access";
import { chat, primeAi } from "./ai";
import { MAX_STEPS_LIMIT } from "./agents";
import { tools as registry } from "./tools";

const GOAL_MAX = 4000;
type ToolInfo = { name: string; label: string; description: string; writes: boolean };
export type AgentDraft = { name: string; description: string; instructions: string; toolMode: "all" | "custom"; allowedTools: string[]; dataScope: "everyone" | "member" | "all"; grounding: "open" | "documents"; maxSteps: number };

/** Admin only; the registry the draft may choose from. */
export const draftContext = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<ToolInfo[]> => {
    const actor = await actorFor(ctx, userId);
    if (!actor || actor.role !== "admin") throw new Denied();
    return Object.values(registry).map((t) => ({ name: t.name, label: t.label.replace(/…$/, ""), description: t.description, writes: !!t.requiresConfirmation }));
  },
});

const PROMPT = `أنت تصمّم «وكيلاً» لمساعد موظفي جهة حكومية (OneSpace). الوكيل = تعليمات + أدوات + نطاق بيانات.
يختار النظامُ الوكيلَ تلقائياً لكل سؤال من «description»، فاكتبه جملة واحدة واضحة تقول متى يُستخدم ولأي نوع من المهام.
اكتب «instructions» بالعربية للمساعد مباشرة (أنت…، افعل…)، مختصرة ومنظّمة:
- الدور ونوع الطلبات التي يتولاها.
- خطوات العمل: متى يبحث في المستندات أو يقرأ ملفاً أو يشغّل تحليلاً، وماذا يتحقق منه قبل الإجابة.
- شكل الإجابة: العناوين أو الجدول أو الطول، واللغة الرسمية إن لزم، وذكر المصدر برقمه عند الأخذ من الملفات.
- الحدود: ما لا يفعله، ومتى يعتذر أو يطلب توضيحاً. لا تَعِد بصلاحيات أو أدوات غير المختارة.
toolMode: all (الغالب) = كل الأدوات؛ الأدوات لا تمنح صلاحية، فهي تعمل بصلاحيات الموظف، وما يكتب في مكان مشترك ينتظر تأكيده. اختر custom فقط إن وجب منع أدوات لطبيعة الوكيل (مثل وكيل للأنظمة لا ينشئ ملفات)، وحينها ضع في allowedTools ما يلزم بأسمائه كما في القائمة.
dataScope: everyone = مساحات «للجميع» فقط (الأنظمة المنشورة)؛ member = مساحته الخاصة والمساحات التي هو عضو فيها؛ all = كل ما يقرؤه.
grounding: open = يجيب عن أي سؤال ويستعين بالمستندات حين تتعلق؛ documents = يجيب من المستندات فقط ويعتذر إن لم تغطِّ السؤال (للأنظمة والسياسات).
maxSteps: عدد جولات الأدوات (1 إلى ${MAX_STEPS_LIMIT})، أكثر للمهام متعددة الخطوات.
أعد JSON فقط.`;

export const draftWithAI = action({
  args: {
    goal: v.string(),
    // An existing config to improve (the agent screen's current form), optional.
    current: v.optional(v.object({ name: v.string(), description: v.string(), instructions: v.string(), allowedTools: v.array(v.string()) })),
  },
  handler: async (ctx, { goal, current }): Promise<AgentDraft> => {
    await primeAi(ctx);
    const userId = await requireUserId(ctx);
    const tools: ToolInfo[] = await ctx.runQuery(internal.agentDrafts.draftContext, { userId });
    const want = goal.trim().slice(0, GOAL_MAX);
    if (!want && !current) throw new OneBaseError("صف ما تريد أن يفعله الوكيل");
    const list = tools.map((t) => `- ${t.name} («${t.label}»${t.writes ? "، كتابة" : ""}): ${t.description}`).join("\n");
    const user = [
      `الأدوات المتاحة:\n${list}`,
      current
        ? `الوكيل الحالي:\nالاسم: ${current.name}\nمتى يُستخدم: ${current.description}\nالأدوات: ${current.allowedTools.join(", ")}\nالتعليمات:\n${current.instructions}\n\nحسّنه${want ? ` بحسب هذا الطلب: ${want}` : ": وضّح التعليمات، وأكمل ما ينقصها، واضبط الأدوات والنطاق."}`
        : `المطلوب: ${want}`,
    ].join("\n\n");
    const res = await chat({
      role: "main",
      temperature: 0.2,
      maxTokens: 2500,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: user },
      ],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "instructions", "toolMode", "allowedTools", "dataScope", "grounding", "maxSteps"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string" },
          toolMode: { type: "string", enum: ["all", "custom"] },
          allowedTools: { type: "array", items: { type: "string", enum: tools.map((t) => t.name) }, maxItems: 8 },
          dataScope: { type: "string", enum: ["everyone", "member", "all"] },
          grounding: { type: "string", enum: ["open", "documents"] },
          maxSteps: { type: "integer", minimum: 1, maximum: MAX_STEPS_LIMIT },
        },
      },
    });
    let d: any;
    try {
      d = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, ""));
    } catch {
      throw new OneBaseError("تعذّر تجهيز مسودة الوكيل، حاول مرة أخرى");
    }
    const names = new Set(tools.map((t) => t.name));
    // Only what the form takes, and only allowed values: the admin still reviews and saves it.
    return {
      name: String(d.name ?? "").trim().slice(0, 80),
      description: String(d.description ?? "").trim().slice(0, 500),
      instructions: String(d.instructions ?? "").trim().slice(0, 8000),
      toolMode: d.toolMode === "custom" ? "custom" : "all",
      allowedTools: [...new Set<string>((Array.isArray(d.allowedTools) ? d.allowedTools : []).map((t: unknown) => String(t)))].filter((t) => names.has(t)),
      dataScope: (["everyone", "member", "all"].includes(d.dataScope) ? d.dataScope : "all") as "everyone" | "member" | "all",
      grounding: (d.grounding === "documents" ? "documents" : "open") as "open" | "documents",
      maxSteps: Math.min(Math.max(Math.round(Number(d.maxSteps) || 4), 1), MAX_STEPS_LIMIT),
    };
  },
});
