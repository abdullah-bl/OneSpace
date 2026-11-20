// Agents (Phase 6, plans/04 "المرحلة 6", plans/02 "الصلاحية داخل الذكاء الاصطناعي").
//
// An agent is data, not code: instructions, a subset of the tool registry, a data scope, a model
// role, a step limit and who may use it. The workspace admin edits a *draft*, tries it
// ("جرّب الوكيل": test questions run as the admin, on the draft), and publishes it as a new
// version; users only ever get the published version. Every change is audited and any earlier
// version can be published again (revert = a new version with the old content).
//
// What an agent can never do is widen a user's permissions: its scope is
//   readableSpaceIds(user) ∩ dataScope(agent) ∩ the thread's scope chips
// recomputed on every turn and every confirmed action, its tools are only those it lists (checked
// when offered *and* when executed: chat.ts), and every tool checks access for the user itself.

import { OneBaseError, v, type Infer } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, readableSpaceIds, requireActive, requireAdmin } from "./access";
import { writeAudit } from "./audit";
import { agentConfig } from "./agentsSchema";
import { queueTurn } from "./lib/turns";
import { MEMORY_TOOLS, PERSONAL_TOOLS, tools as registry } from "./tools";

type Ctx = QueryCtx | MutationCtx;
export type AgentConfig = Infer<typeof agentConfig>;
export type DataScope = AgentConfig["dataScope"];

export const MAX_STEPS_LIMIT = 20;
/** No agent gets fewer tool rounds than this: making a list, a page and publishing it is already 3–4. */
export const MIN_STEPS = 10;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const INSTRUCTIONS_MAX = 8000;
const MAX_TEST_QUESTIONS = 10;

export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  everyone: "مساحات «للجميع» فقط",
  member: "المساحات التي المستخدم عضو فيها",
  all: "ما يختاره المستخدم من مساحاته",
};

// ---------------------------------------------------------------- starter agents

const workspaceWide = { kind: "workspace" as const, spaceIds: [] };

/** The default agent and the three starters from the plan. Seeded at bootstrap (and on demand). */
export const STARTER_AGENTS: { key: string; isDefault: boolean; config: AgentConfig; testQuestions: string[] }[] = [
  {
    key: "default",
    isDefault: true,
    config: {
      name: "المساعد العام",
      description: "مساعد لكل شيء: يكتب ويترجم ويلخّص ويجيب، ويرجع إلى ملفاتك ويستشهد بها حين يكون السؤال عنها.",
      instructions:
        "ساعد الموظف في أي طلب: كتابة، صياغة، ترجمة، تلخيص، شرح، أسئلة عامة. حين يسأل عن ملفاته أو أنظمة الإدارة فارجع إلى ملفاته واستشهد بها. إن طلب مخرجاً محفوظاً (ملخصاً، جدولاً، مسودة) فاقترح إنشاءه، وسيؤكده بنفسه.",
      allowedTools: ["search_documents", "read_file", "create_artifact", "update_artifact", "export_document", "my_records"],
      toolMode: "all",
      dataScope: "all",
      modelRole: "main",
      maxSteps: 10,
      visibility: workspaceWide,
      grounding: "open",
    },
    testQuestions: ["ما مدة إجازة الأمومة؟"],
  },
  {
    key: "policies",
    isDefault: false,
    config: {
      name: "السياسات",
      description: "يجيب عن الأنظمة والسياسات المنشورة للجميع، مع ذكر المصدر.",
      instructions: "أنت وكيل السياسات واللوائح. أجب من السياسات المنشورة فقط، واذكر اسم السياسة ورقم المادة أو البند إن وُجد. إن اختلفت نسختان فاذكر الأحدث.",
      allowedTools: ["search_documents", "read_file"],
      dataScope: "everyone",
      modelRole: "main",
      maxSteps: 10,
      visibility: workspaceWide,
      grounding: "documents",
    },
    testQuestions: ["ما مدة إجازة الأمومة؟", "كم ساعة الدوام في رمضان؟"],
  },
  {
    key: "grades",
    isDefault: false,
    config: {
      name: "الدرجات والتقارير",
      description: "يستعلم في سجلات المساحات التي أنت عضو فيها، ويعدّ التقارير ويعبّئ القوالب المعتمدة.",
      instructions:
        "أنت وكيل الدرجات والتقارير. استعلم بأداة السجلات ولا تخمّن أرقاماً. للتقارير اقترح إنشاء مخرج جدولي. الشهادات والمستندات الرسمية تُعبّأ من القوالب المعتمدة فقط، ولا تكتب نصاً داخلها.",
      allowedTools: ["query_records", "fill_template", "create_artifact"],
      dataScope: "member",
      modelRole: "main",
      maxSteps: 10,
      visibility: workspaceWide,
      grounding: "documents",
    },
    testQuestions: ["كم عدد المتدربين في السجل؟"],
  },
  {
    key: "analysis",
    isDefault: false,
    config: {
      name: "التحليل",
      description: "يحلل ملفات البيانات التي تختارها بكود معزول ويعرض النتائج كمخرجات.",
      instructions:
        "أنت وكيل التحليل. اقرأ وصف الملف أولاً، ثم اقترح تشغيل كود Python قصير على الملفات التي اختارها المستخدم فقط.",
      allowedTools: ["run_analysis", "create_artifact", "export_document", "read_file"],
      toolMode: "all",
      dataScope: "all",
      modelRole: "main",
      maxSteps: 10,
      visibility: workspaceWide,
      grounding: "open",
    },
    testQuestions: ["حلّل ملف الدرجات وأعطني المتوسط"],
  },
];

/** Adds the starter agents that are missing (by key). Idempotent. */
export async function seedStarters(ctx: MutationCtx, by?: Id<"users">): Promise<number> {
  let added = 0;
  const hasDefault = !!(await ctx.db.query("agents").withIndex("by_default", (q) => q.eq("isDefault", true)).first());
  for (const s of STARTER_AGENTS) {
    if (await ctx.db.query("agents").withIndex("by_key", (q) => q.eq("key", s.key)).first()) continue;
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      key: s.key,
      live: s.config,
      version: 1,
      enabled: true,
      isDefault: s.isDefault && !hasDefault,
      testQuestions: s.testQuestions,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentVersions", { agentId, version: 1, config: s.config, publishedBy: by, publishedAt: now });
    await writeAudit(ctx, { userId: by, action: "agent.create", resourceType: "agent", resourceId: agentId, detail: { name: s.config.name, version: 1, tools: s.config.toolMode === "all" ? "all" : s.config.allowedTools.join(","), starter: true } });
    added++;
  }
  // UX redesign: the starter default agent from before (no `grounding`) becomes a general
  // assistant ("open") as a new published version, keeping whatever else the admin changed.
  const def = await ctx.db.query("agents").withIndex("by_key", (q) => q.eq("key", "default")).first();
  if (def?.live && def.live.grounding === undefined) {
    const now = Date.now();
    const config = { ...def.live, grounding: "open" as const };
    const version = def.version + 1;
    await ctx.db.insert("agentVersions", { agentId: def._id, version, config, publishedBy: by, publishedAt: now });
    await ctx.db.patch(def._id, { live: config, version, updatedAt: now });
    await writeAudit(ctx, { userId: by, action: "agent.publish", resourceType: "agent", resourceId: def._id, detail: { name: config.name, version, previousVersion: def.version, changes: "grounding", upgrade: true } });
  }
  return added;
}

/** "open" unless the agent was explicitly made document-only (or predates the setting). */
/** The tools an agent may use: the whole registry for "all", else its own list (registry order). */
export function agentTools(cfg: AgentConfig): string[] {
  const all = Object.keys(registry).filter((t) => !MEMORY_TOOLS.includes(t) && !PERSONAL_TOOLS.includes(t));
  return cfg.toolMode === "all" ? all : all.filter((t) => cfg.allowedTools.includes(t));
}

export function groundingOf(cfg: AgentConfig): "open" | "documents" {
  return cfg.grounding === "open" ? "open" : "documents";
}

// ---------------------------------------------------------------- validation

function cleanText(s: string, max: number, what: string, required = false) {
  const t = s.replace(/\u0000/g, "").trim();
  if (required && !t) throw new OneBaseError(`${what} مطلوب`);
  if (t.length > max) throw new OneBaseError(`${what} أطول من المسموح (${max} حرفاً)`);
  return t;
}

/** Checks an admin-submitted config: tools only from the registry, sane limits, real shared spaces. */
async function normalizeConfig(ctx: Ctx, workspaceId: Id<"workspaces">, c: AgentConfig): Promise<AgentConfig> {
  const tools = [...new Set(c.allowedTools.map(String))];
  const unknown = tools.filter((t) => !Object.hasOwn(registry, t));
  if (unknown.length) throw new OneBaseError(`أدوات غير موجودة في السجل: ${unknown.join("، ")}`);
  const steps = Math.floor(Number(c.maxSteps));
  if (!Number.isFinite(steps) || steps < 1 || steps > MAX_STEPS_LIMIT) throw new OneBaseError(`عدد الخطوات بين 1 و ${MAX_STEPS_LIMIT}`);
  const spaceIds = [...new Set(c.visibility.spaceIds)];
  if (c.visibility.kind === "spaces") {
    if (!spaceIds.length) throw new OneBaseError("اختر مساحة واحدة على الأقل، أو أتحه لكل مساحة العمل");
    for (const id of spaceIds) {
      const s = await ctx.db.get(id);
      if (!s || s.kind !== "shared" || s.workspaceId !== workspaceId) throw new OneBaseError("مساحة غير صالحة في من يستخدم الوكيل");
    }
  }
  return {
    name: cleanText(c.name, NAME_MAX, "اسم الوكيل", true),
    description: cleanText(c.description, DESCRIPTION_MAX, "الوصف"),
    instructions: cleanText(c.instructions, INSTRUCTIONS_MAX, "التعليمات"),
    allowedTools: Object.keys(registry).filter((t) => tools.includes(t)), // registry order
    toolMode: c.toolMode === "all" ? "all" : "custom",
    dataScope: c.dataScope,
    modelRole: c.modelRole,
    maxSteps: steps,
    visibility: c.visibility.kind === "spaces" ? { kind: "spaces", spaceIds } : workspaceWide,
    ...(c.grounding ? { grounding: c.grounding } : {}),
    ...(c.lightRouting ? { lightRouting: true } : {}),
  };
}

/** Which config fields differ (for the audit row). */
function changedFields(a: AgentConfig | undefined, b: AgentConfig): string {
  if (!a) return "all";
  return (Object.keys(b) as (keyof AgentConfig)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).join(",") || "none";
}

async function loadAgent(ctx: Ctx, agentId: string): Promise<Doc<"agents">> {
  const id = ctx.db.normalizeId("agents", agentId);
  const a = id ? await ctx.db.get(id) : null;
  if (!a) throw new Denied();
  return a;
}

// ---------------------------------------------------------------- resolution (used by chat.ts)

/** May `userId` pick an agent with this visibility? (Active member; for "spaces": reads one of them now.) */
export async function visibleTo(ctx: Ctx, userId: Id<"users">, cfg: AgentConfig): Promise<boolean> {
  const actor = await actorFor(ctx, userId);
  if (!actor) return false;
  if (cfg.visibility.kind === "workspace") return true;
  for (const id of cfg.visibility.spaceIds) {
    try {
      await assertCan(ctx, userId, id, "read");
      return true;
    } catch {}
  }
  return false;
}

export type ResolvedAgent = { agentId: string | null; version: number; draft: boolean; config: AgentConfig };

/** The agent a thread runs with, or an error message. No agentId = the default agent. */
export async function resolveAgent(
  ctx: Ctx,
  userId: Id<"users">,
  meta: { agentId?: string; agentDraft?: boolean },
): Promise<ResolvedAgent | { error: string }> {
  const gone = { error: "الوكيل المختار لم يعد متاحاً لك. اختر وكيلاً آخر." };
  if (meta.agentId) {
    const id = ctx.db.normalizeId("agents", meta.agentId);
    const agent = id ? await ctx.db.get(id) : null;
    if (!agent) return gone;
    if (meta.agentDraft) {
      // "جرّب الوكيل": only while the thread's owner is still the workspace admin.
      const actor = await actorFor(ctx, userId);
      const config = agent.draft ?? agent.live;
      if (!actor || actor.role !== "admin" || !config) return gone;
      return { agentId: agent._id, version: agent.version, draft: true, config };
    }
    if (!agent.enabled || !agent.live || !(await visibleTo(ctx, userId, agent.live))) return gone;
    return { agentId: agent._id, version: agent.version, draft: false, config: agent.live };
  }
  const def = await ctx.db
    .query("agents")
    .withIndex("by_default", (q) => q.eq("isDefault", true))
    .first();
  if (def?.enabled && def.live && (await visibleTo(ctx, userId, def.live))) return { agentId: def._id, version: def.version, draft: false, config: def.live };
  // A workspace from before Phase 6 (no agents yet): the built-in default, i.e. Phase 2's behaviour.
  if (!(await ctx.db.query("agents").first())) {
    if (!(await actorFor(ctx, userId))) return gone;
    return { agentId: null, version: 0, draft: false, config: STARTER_AGENTS[0]!.config };
  }
  return { error: "لا يوجد وكيل افتراضي متاح لك. اختر وكيلاً من القائمة." };
}

/** Spaces an agent may touch for this user: readable now ∩ the agent's data scope. */
export async function agentSpaceIds(ctx: Ctx, userId: Id<"users">, scope: DataScope): Promise<Id<"spaces">[]> {
  const readable = await readableSpaceIds(ctx, userId);
  if (scope === "all") return readable;
  const out: Id<"spaces">[] = [];
  for (const id of readable) {
    const s = await ctx.db.get(id);
    if (!s) continue;
    if (scope === "everyone") {
      if (s.kind === "shared" && s.everyone) out.push(id);
    } else if (s.kind === "personal") {
      if (s.ownerId === userId) out.push(id);
    } else {
      const m = await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", id).eq("userId", userId)).unique();
      if (m) out.push(id);
    }
  }
  return out;
}

/**
 * The turn's scope: agent spaces ∩ the thread's chips (all / one space / one file).
 * A file chip outside the agent's spaces gives an empty scope (nothing to search, nothing to read).
 */
export async function effectiveScope(
  ctx: Ctx,
  userId: Id<"users">,
  dataScope: DataScope,
  chips: { kind: "all" | "space" | "file"; id?: string },
): Promise<{ spaceIds: Id<"spaces">[]; fileIds?: string[] }> {
  const allowed = await agentSpaceIds(ctx, userId, dataScope);
  if (chips.kind === "space") return { spaceIds: allowed.filter((s) => s === chips.id) };
  if (chips.kind === "file") {
    const id = ctx.db.normalizeId("files", chips.id ?? "");
    const file = id ? await ctx.db.get(id) : null;
    return { spaceIds: file && allowed.includes(file.spaceId) ? [file.spaceId] : [], fileIds: file ? [file._id] : [] };
  }
  return { spaceIds: allowed };
}

/**
 * Narrows a turn's scope to what the question @mentions. Only ever an intersection with `base`
 * (readable ∩ agent scope ∩ thread scope), so a mention can't widen anything:
 *   files only  → just those files (each must already be inside `base`)
 *   any space   → those spaces plus the spaces of any mentioned files (∩ base)
 */
export async function narrowByMentions(
  ctx: Ctx,
  base: { spaceIds: Id<"spaces">[]; fileIds?: string[] },
  mentions: { kind: "file" | "space"; id: string }[] | undefined,
): Promise<{ spaceIds: Id<"spaces">[]; fileIds?: string[] }> {
  if (!mentions?.length) return base;
  const spaces = new Set(mentions.filter((m) => m.kind === "space").map((m) => m.id));
  const files: { id: string; spaceId: string }[] = [];
  for (const m of mentions) {
    if (m.kind !== "file") continue;
    const id = ctx.db.normalizeId("files", m.id);
    const f = id ? await ctx.db.get(id) : null;
    if (f && f.status === "active") files.push({ id: f._id, spaceId: f.spaceId });
  }
  if (spaces.size) {
    for (const f of files) spaces.add(f.spaceId);
    return { spaceIds: base.spaceIds.filter((s) => spaces.has(s)), fileIds: base.fileIds };
  }
  const ok = files.filter((f) => base.spaceIds.includes(f.spaceId as Id<"spaces">) && (!base.fileIds || base.fileIds.includes(f.id)));
  return { spaceIds: base.spaceIds.filter((s) => ok.some((f) => f.spaceId === s)), fileIds: ok.map((f) => f.id) };
}

// ---------------------------------------------------------------- public: users

/** Agents I may pick in the chat box (published, enabled, visible to me). The default comes first. */
export const available = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const out = [];
    for (const a of await ctx.db.query("agents").collect()) {
      if (!a.enabled || !a.live || !(await visibleTo(ctx, me.userId, a.live))) continue;
      out.push({
        _id: a._id,
        name: a.live.name,
        description: a.live.description,
        isDefault: a.isDefault,
        tools: agentTools(a.live).map((t) => registry[t]?.label ?? t),
        dataScope: DATA_SCOPE_LABELS[a.live.dataScope],
        grounding: groundingOf(a.live),
      });
    }
    return out.sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name, "ar"));
  },
});

// ---------------------------------------------------------------- public: workspace admin

/** The tool registry, to pick from (admins choose; they never write tools). */
export const toolRegistry = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return Object.values(registry).map((t) => ({ name: t.name, label: t.label, description: t.description, requiresConfirmation: !!t.requiresConfirmation }));
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("agents").collect();
    return rows
      .map((a) => ({
        _id: a._id,
        key: a.key ?? null,
        live: a.live ?? null,
        draft: a.draft ?? null,
        version: a.version,
        enabled: a.enabled,
        isDefault: a.isDefault,
        testQuestions: a.testQuestions,
        updatedAt: a.updatedAt,
      }))
      .sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || ((x.live ?? x.draft)?.name ?? "").localeCompare((y.live ?? y.draft)?.name ?? "", "ar"));
  },
});

export const versions = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    const rows = await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", agent._id)).order("desc").collect();
    const names = new Map<string, string | null>();
    const out = [];
    for (const r of rows) {
      if (r.publishedBy && !names.has(r.publishedBy)) {
        const u = await ctx.db.get(r.publishedBy);
        names.set(r.publishedBy, u?.name ?? u?.email ?? null);
      }
      out.push({ version: r.version, config: r.config, publishedAt: r.publishedAt, publishedBy: r.publishedBy ? names.get(r.publishedBy) ?? null : null, revertedFrom: r.revertedFrom ?? null, current: r.version === agent.version });
    }
    return out;
  },
});

/** New agent: saved as a draft (version 0) until published. */
export const create = mutation({
  args: { config: agentConfig },
  handler: async (ctx, { config }) => {
    const me = await requireAdmin(ctx);
    const cfg = await normalizeConfig(ctx, me.workspace._id, config);
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", { draft: cfg, version: 0, enabled: true, isDefault: false, testQuestions: [], createdBy: me.userId, createdAt: now, updatedAt: now });
    await writeAudit(ctx, { userId: me.userId, action: "agent.create", resourceType: "agent", resourceId: agentId, detail: { name: cfg.name, version: 0, tools: cfg.toolMode === "all" ? "all" : cfg.allowedTools.join(","), dataScope: cfg.dataScope } });
    return agentId;
  },
});

export const saveDraft = mutation({
  args: { agentId: v.string(), config: agentConfig },
  handler: async (ctx, { agentId, config }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    const cfg = await normalizeConfig(ctx, me.workspace._id, config);
    await ctx.db.patch(agent._id, { draft: cfg, updatedAt: Date.now() });
    await writeAudit(ctx, {
      userId: me.userId,
      action: "agent.draft",
      resourceType: "agent",
      resourceId: agent._id,
      detail: { name: cfg.name, version: agent.version, changes: changedFields(agent.live, cfg), tools: cfg.toolMode === "all" ? "all" : cfg.allowedTools.join(","), dataScope: cfg.dataScope },
    });
  },
});

export const discardDraft = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    if (!agent.draft) return;
    if (!agent.live) throw new OneBaseError("لا توجد نسخة منشورة؛ احذف الوكيل بتعطيله بدلاً من ذلك");
    await ctx.db.patch(agent._id, { draft: undefined, updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "agent.discardDraft", resourceType: "agent", resourceId: agent._id, detail: { name: agent.live.name, version: agent.version } });
  },
});

async function publishConfig(ctx: MutationCtx, me: { userId: Id<"users"> }, agent: Doc<"agents">, cfg: AgentConfig, revertedFrom?: number) {
  const version = agent.version + 1;
  const now = Date.now();
  if (agent.isDefault && cfg.visibility.kind !== "workspace") throw new OneBaseError("الوكيل الافتراضي يجب أن يكون متاحاً لكل مساحة العمل");
  await ctx.db.insert("agentVersions", { agentId: agent._id, version, config: cfg, publishedBy: me.userId, publishedAt: now, revertedFrom });
  await ctx.db.patch(agent._id, { live: cfg, version, updatedAt: now, ...(revertedFrom === undefined ? { draft: undefined } : {}) });
  await writeAudit(ctx, {
    userId: me.userId,
    action: revertedFrom === undefined ? "agent.publish" : "agent.revert",
    resourceType: "agent",
    resourceId: agent._id,
    detail: {
      name: cfg.name,
      version,
      previousVersion: agent.version,
      revertedFrom: revertedFrom ?? null,
      changes: changedFields(agent.live, cfg),
      tools: cfg.toolMode === "all" ? "all" : cfg.allowedTools.join(","),
      dataScope: cfg.dataScope,
    },
  });
  return version;
}

/** The draft becomes the next published version (what users get from their next question on). */
export const publish = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    if (!agent.draft) throw new OneBaseError("لا توجد مسودة لنشرها");
    // Re-validate: a space in the visibility list may have been deleted since the draft was saved.
    const cfg = await normalizeConfig(ctx, me.workspace._id, agent.draft);
    return await publishConfig(ctx, me, agent, cfg);
  },
});

/** Publishes an earlier version's content again, as a new version (history is never rewritten). */
export const revert = mutation({
  args: { agentId: v.string(), version: v.number() },
  handler: async (ctx, { agentId, version }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    const row = await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", agent._id).eq("version", version)).unique();
    if (!row) throw new OneBaseError("النسخة غير موجودة");
    // Tools removed from the registry since then are dropped, spaces deleted since then are refused.
    const cfg = await normalizeConfig(ctx, me.workspace._id, { ...row.config, allowedTools: row.config.allowedTools.filter((t) => Object.hasOwn(registry, t)) });
    return await publishConfig(ctx, me, agent, cfg, version);
  },
});

export const setEnabled = mutation({
  args: { agentId: v.string(), enabled: v.boolean() },
  handler: async (ctx, { agentId, enabled }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    if (!enabled && agent.isDefault) throw new OneBaseError("لا يمكن تعطيل الوكيل الافتراضي؛ اجعل وكيلاً آخر افتراضياً أولاً");
    if (agent.enabled === enabled) return;
    await ctx.db.patch(agent._id, { enabled, updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: enabled ? "agent.enable" : "agent.disable", resourceType: "agent", resourceId: agent._id, detail: { name: (agent.live ?? agent.draft)?.name ?? null, version: agent.version } });
  },
});

export const setDefault = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    if (!agent.live || !agent.enabled) throw new OneBaseError("انشر الوكيل وفعّله قبل جعله افتراضياً");
    if (agent.live.visibility.kind !== "workspace") throw new OneBaseError("الوكيل الافتراضي يجب أن يكون متاحاً لكل مساحة العمل");
    if (agent.isDefault) return;
    const previous = await ctx.db.query("agents").withIndex("by_default", (q) => q.eq("isDefault", true)).collect();
    for (const p of previous) await ctx.db.patch(p._id, { isDefault: false, updatedAt: Date.now() });
    await ctx.db.patch(agent._id, { isDefault: true, updatedAt: Date.now() });
    await writeAudit(ctx, {
      userId: me.userId,
      action: "agent.default",
      resourceType: "agent",
      resourceId: agent._id,
      detail: { name: agent.live.name, version: agent.version, previous: previous.map((p) => p._id).join(",") || null },
    });
  },
});

export const seedStarterAgents = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    return await seedStarters(ctx, me.userId);
  },
});

/** Bootstrap hook / ops (admin key only). */
export const seedInternal = internalMutation({ args: {}, handler: (ctx) => seedStarters(ctx) });

export const setTestQuestions = mutation({
  args: { agentId: v.string(), questions: v.array(v.string()) },
  handler: async (ctx, { agentId, questions }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    const qs = questions.map((q) => q.trim()).filter(Boolean);
    if (qs.length > MAX_TEST_QUESTIONS) throw new OneBaseError(`حتى ${MAX_TEST_QUESTIONS} أسئلة اختبار`);
    if (qs.some((q) => q.length > 1000)) throw new OneBaseError("سؤال الاختبار أطول من المسموح");
    await ctx.db.patch(agent._id, { testQuestions: qs, updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "agent.testQuestions", resourceType: "agent", resourceId: agent._id, detail: { count: qs.length } });
  },
});

/**
 * "جرّب الوكيل": runs the draft (or the published version if there is no draft) on the agent's
 * test questions, one hidden thread each, as the admin (admin's permissions ∩ the draft's scope).
 */
export const runTests = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    const cfg = agent.draft ?? agent.live;
    if (!cfg) throw new Denied();
    if (!agent.testQuestions.length) throw new OneBaseError("أضف أسئلة اختبار أولاً");
    const threads: string[] = [];
    for (const question of agent.testQuestions) {
      const title = `اختبار: ${question.replace(/\s+/g, " ").slice(0, 60)}`;
      const { threadId } = await ctx.components.chat.createThread({ userId: me.userId, title });
      const now = Date.now();
      await ctx.db.insert("threadMeta", { threadId, userId: me.userId, title, scope: { kind: "all" }, agentId: agent._id, agentDraft: true, test: true, createdAt: now, lastAt: now });
      await queueTurn(ctx, { threadId, userId: me.userId, text: question, agentId: agent._id, agentVersion: agent.version });
      threads.push(threadId);
    }
    await writeAudit(ctx, { userId: me.userId, action: "agent.test", resourceType: "agent", resourceId: agent._id, detail: { name: cfg.name, version: agent.version, draft: !!agent.draft, questions: threads.length } });
    return threads;
  },
});

/** The admin's latest test runs of this agent: question, answer, tools, state. */
export const testResults = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const me = await requireAdmin(ctx);
    const agent = await loadAgent(ctx, agentId);
    const metas = (await ctx.db.query("threadMeta").withIndex("by_user", (q) => q.eq("userId", me.userId)).order("desc").take(300)).filter(
      (m) => m.test && m.agentId === agent._id,
    );
    const out = [];
    for (const m of metas.slice(0, MAX_TEST_QUESTIONS * 2)) {
      const page = await ctx.components.chat.listMessages({ threadId: m.threadId, paginationOpts: { numItems: 20, cursor: null } });
      const msgs = page.page.filter((x) => (x.role === "user" || x.role === "assistant") && x.text);
      const answer = msgs.find((x) => x.role === "assistant");
      const meta = answer ? await ctx.db.query("messageMeta").withIndex("by_message", (q) => q.eq("messageId", answer.id)).unique() : null;
      const turn = await ctx.db.query("turns").withIndex("by_thread", (q) => q.eq("threadId", m.threadId)).order("desc").first();
      out.push({
        threadId: m.threadId,
        at: m.createdAt,
        question: msgs.find((x) => x.role === "user")?.text ?? "",
        answer: answer?.text ?? null,
        state: turn?.state ?? "queued",
        error: turn?.error ?? null,
        version: turn?.agentVersion ?? null,
        toolRuns: (meta?.toolRuns ?? []).map((t) => ({ name: t.name, label: t.label, ok: t.ok, summary: t.summary })),
        citations: (meta?.citations ?? []).map((c) => ({ n: c.n, fileName: c.fileName })),
      });
    }
    return out;
  },
});
