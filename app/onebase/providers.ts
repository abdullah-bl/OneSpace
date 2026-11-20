// AI providers (admin): the model servers the platform talks to, and which model plays each role.
//
// A provider is an OpenAI-compatible server (llama.cpp, vLLM, Ollama, a hosted API): a base URL
// and an optional API key. «افحص» lists its models (GET /models). A role (main: chat and tools,
// fast: titles, routing and the «أساسي» level, vision: reading scanned pages, embed: file search)
// points at one provider and one of its models; a role left unset uses the server's environment
// (LLM_BASE_URL…, EMBED_BASE_URL…), so nothing changes until an admin chooses. The embedding model
// must give vectors of the index's size (INDEX_DIMENSIONS), and changing it means re-indexing
// every file («أعد الفهرسة»; until then search and indexing refuse, ai.ts: ensureEmbeddingIndex).
//
// The API key is write-only: it is stored for the server's own calls and never returned.

import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { requireAdmin, requireUserId, actorFor } from "./access";
import { decideFromEnv, embedConfigFromDb, embeddingSignature, ensureEmbeddingIndex, envEmbed, envTargets, GEMMA_PREFIXES, INDEX_DIMENSIONS, setAiOverrides, type DecisionSwitches, type Overrides, type RoleName } from "./ai";
import { writeAudit } from "./audit";
import { scheduleIngest } from "./ingest";
import { detectFlavor, explainModelError, fitsRole, FLAVOR_LABEL, readModels, TINY_PNG, type Flavor, type ModelInfo, type ServerRole } from "./lib/modelServers";

const ROLES: RoleName[] = ["main", "fast", "vision", "decide"];
type RoleChoice = { providerId: Id<"aiProviders">; model: string };
type EmbedChoice = RoleChoice & { sendDimensions?: boolean; queryPrefix?: string; docPrefix?: string };
type Roles = Partial<Record<RoleName, RoleChoice>> & { embed?: EmbedChoice };

export function cleanBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new OneBaseError("عنوان غير صالح. مثال: http://localhost:8401/v1");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new OneBaseError("العنوان يجب أن يبدأ بـ http أو https");
  if (u.username || u.password) throw new OneBaseError("ضع المفتاح في حقل المفتاح، لا في العنوان");
  return u.toString().replace(/\/+$/, "");
}

/** The decision switches (plans/12): aiSettings "decisions"; missing = on. */
async function readDecisions(ctx: { db: any }): Promise<DecisionSwitches> {
  const row = await ctx.db.query("aiSettings").withIndex("by_key", (q: any) => q.eq("key", "decisions")).unique();
  return (row?.value as DecisionSwitches) ?? {};
}

async function readRoles(ctx: { db: any }): Promise<Roles> {
  const row = await ctx.db.query("aiSettings").withIndex("by_key", (q: any) => q.eq("key", "roles")).unique();
  return (row?.value as Roles) ?? {};
}

function view(p: Doc<"aiProviders">) {
  const flavor = (p.flavor ?? null) as Flavor | null;
  return {
    _id: p._id,
    name: p.name,
    baseUrl: p.baseUrl,
    hasKey: !!p.apiKey,
    enabled: p.enabled,
    models: p.models,
    modelInfo: (p.modelInfo ?? []) as ModelInfo[],
    flavor,
    flavorLabel: flavor ? FLAVOR_LABEL[flavor] : null,
    lastCheck: p.lastCheck ?? null,
    updatedAt: p.updatedAt,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const providers = await ctx.db.query("aiProviders").collect();
    const roles = await readRoles(ctx);
    const decisionsRow = await readDecisions(ctx);
    const env = envTargets();
    return {
      providers: providers.map(view),
      roles: Object.fromEntries(ROLES.map((r) => [r, roles[r] ?? null])) as Record<RoleName, RoleChoice | null>,
      env: Object.fromEntries(ROLES.map((r) => [r, { configured: !!env[r].baseUrl, model: env[r].model, host: env[r].baseUrl ? new URL(env[r].baseUrl!).host : null }])) as Record<RoleName, { configured: boolean; model: string; host: string | null }>,
      embed: await embedStatus(ctx, roles),
      // An unset decision model is the fast one (unless the environment names its own server).
      decideFollowsFast: !roles.decide && !decideFromEnv(),
      decisions: (() => {
        const d = decisionsRow;
        return { route: d.route !== false, cite: d.cite !== false, guard: d.guard !== false };
      })(),
    };
  },
});

/** Turns one decision (plans/12) on or off; off returns it to the code it replaced. */
export const setDecision = mutation({
  args: { kind: v.union(v.literal("route"), v.literal("cite"), v.literal("guard")), on: v.boolean() },
  handler: async (ctx, { kind, on }) => {
    const me = await requireAdmin(ctx);
    const value = { ...(await readDecisions(ctx)), [kind]: on };
    const row = await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "decisions")).unique();
    if (row) await ctx.db.patch(row._id, { value, updatedAt: Date.now() });
    else await ctx.db.insert("aiSettings", { key: "decisions", value, updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "provider.decision", resourceType: "aiSettings", resourceId: kind, detail: { kind, on } });
  },
});

export const save = mutation({
  args: { providerId: v.optional(v.string()), name: v.string(), baseUrl: v.string(), apiKey: v.optional(v.string()), clearKey: v.optional(v.boolean()), enabled: v.boolean() },
  handler: async (ctx, a) => {
    const me = await requireAdmin(ctx);
    const name = a.name.trim().slice(0, 80);
    if (!name) throw new OneBaseError("اكتب اسماً للمزوّد");
    const baseUrl = cleanBaseUrl(a.baseUrl);
    const key = a.apiKey?.trim();
    const now = Date.now();
    if (a.providerId) {
      const id = ctx.db.normalizeId("aiProviders", a.providerId);
      const p = id ? await ctx.db.get(id) : null;
      if (!p) throw new OneBaseError("المزوّد غير موجود");
      if (!a.enabled && Object.values(await readRoles(ctx)).some((r) => (r as RoleChoice | undefined)?.providerId === p._id)) throw new OneBaseError("هذا المزوّد مستخدم في دور؛ غيّر الدور أولاً");
      await ctx.db.patch(p._id, { name, baseUrl, enabled: a.enabled, updatedAt: now, ...(key ? { apiKey: key } : a.clearKey ? { apiKey: undefined } : {}), ...(baseUrl !== p.baseUrl ? { models: [], modelInfo: undefined, flavor: undefined, lastCheck: undefined } : {}) });
      await writeAudit(ctx, { userId: me.userId, action: "provider.update", resourceType: "aiProvider", resourceId: p._id, detail: { name, host: new URL(baseUrl).host, keyChanged: !!key || !!a.clearKey, enabled: a.enabled } });
      return p._id;
    }
    const id = await ctx.db.insert("aiProviders", { name, baseUrl, ...(key ? { apiKey: key } : {}), enabled: a.enabled, models: [], createdBy: me.userId, createdAt: now, updatedAt: now });
    await writeAudit(ctx, { userId: me.userId, action: "provider.create", resourceType: "aiProvider", resourceId: id, detail: { name, host: new URL(baseUrl).host } });
    return id;
  },
});

export const remove = mutation({
  args: { providerId: v.string() },
  handler: async (ctx, { providerId }) => {
    const me = await requireAdmin(ctx);
    const id = ctx.db.normalizeId("aiProviders", providerId);
    const p = id ? await ctx.db.get(id) : null;
    if (!p) return;
    if (Object.values(await readRoles(ctx)).some((r) => (r as RoleChoice | undefined)?.providerId === p._id)) throw new OneBaseError("هذا المزوّد مستخدم في دور؛ غيّر الدور أولاً");
    await ctx.db.delete(p._id);
    await writeAudit(ctx, { userId: me.userId, action: "provider.delete", resourceType: "aiProvider", resourceId: p._id, detail: { name: p.name } });
  },
});

async function embedStatus(ctx: { db: any }, roles: Roles) {
  const e = envEmbed();
  const pinned = (await ctx.db.query("aiSettings").withIndex("by_key", (q: any) => q.eq("key", "embedding")).unique())?.value as { model: string; dimensions: number } | undefined;
  const sig = embeddingSignature(await embedConfigFromDb(ctx.db));
  const pinnedSig = pinned as any;
  const mismatch = !!pinnedSig && (pinnedSig.model !== sig.model || pinnedSig.dimensions !== sig.dimensions || pinnedSig.queryPrefix !== sig.queryPrefix || pinnedSig.docPrefix !== sig.docPrefix);
  return {
    choice: roles.embed ? { providerId: roles.embed.providerId, model: roles.embed.model } : null,
    env: { configured: !!e.baseUrl, model: e.model },
    dimensions: INDEX_DIMENSIONS,
    indexedWith: pinned?.model ?? null,
    mismatch,
  };
}

/** Saves a role's choice (providerId null = the environment); the caller checked the admin. */
async function applyRole(ctx: MutationCtx, userId: Id<"users">, role: RoleName, providerId: string | null, model?: string) {
  const roles = await readRoles(ctx);
  if (providerId === null) delete roles[role];
  else {
    const id = ctx.db.normalizeId("aiProviders", providerId);
    const p = id ? await ctx.db.get(id) : null;
    if (!p) throw new OneBaseError("المزوّد غير موجود");
    if (!p.enabled) throw new OneBaseError("المزوّد معطّل");
    const m = (model ?? "").trim();
    if (!m) throw new OneBaseError("اختر نموذجاً");
    if (p.models.length && !p.models.includes(m)) throw new OneBaseError("النموذج غير موجود لدى المزوّد؛ افحص المزوّد مجدداً");
    roles[role] = { providerId: p._id, model: m };
  }
  const row = await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "roles")).unique();
  if (row) await ctx.db.patch(row._id, { value: roles, updatedAt: Date.now() });
  else await ctx.db.insert("aiSettings", { key: "roles", value: roles, updatedAt: Date.now() });
  await writeAudit(ctx, { userId, action: "provider.role", resourceType: "aiSettings", resourceId: role, detail: { role, providerId: providerId ?? "env", model: model ?? null } });
}

const roleV = v.union(v.literal("main"), v.literal("fast"), v.literal("vision"), v.literal("decide"));

/** Points a role at a provider's model, or back at the environment (providerId null). No try: see tryRole. */
export const setRole = mutation({
  args: { role: roleV, providerId: v.union(v.string(), v.null()), model: v.optional(v.string()) },
  handler: async (ctx, { role, providerId, model }) => {
    const me = await requireAdmin(ctx);
    await applyRole(ctx, me.userId, role, providerId, model);
  },
});

export const saveTriedRole = internalMutation({
  args: { userId: v.id("users"), role: roleV, providerId: v.string(), model: v.string() },
  handler: async (ctx, a) => {
    const actor = await actorFor(ctx, a.userId);
    if (actor?.role !== "admin") throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
    await applyRole(ctx, a.userId, a.role, a.providerId, a.model);
  },
});

type Server = { baseUrl: string; apiKey?: string; flavor: Flavor };

/** One request to the server; status 0 when there was no answer. */
async function call(p: Server, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: string; json: any; timeout?: boolean }> {
  try {
    const r = await fetch(`${p.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: r.status, body: text.slice(0, 2000), json };
  } catch (e) {
    return { status: 0, body: "", json: null, timeout: (e as Error)?.name === "TimeoutError" };
  }
}

/**
 * Tries `model` for `role` with one small request of the kind the role makes: a short chat (main,
 * fast), a chat with an image (vision), or a decision (decide: /v1/systemone for a decision model,
 * else a short chat). Returns null when it worked, else what went wrong and how to fix it.
 */
async function tryModel(p: Server, role: Exclude<ServerRole, "embed">, model: string, info: ModelInfo | undefined): Promise<string | null> {
  const kinds = info?.kinds ?? ["chat"];
  if (!fitsRole(kinds, role)) {
    if (kinds.includes("decide")) return "هذا نموذج قرار: يجيب عن أسئلة محددة ولا يكتب نصاً. يصلح لدور «نموذج القرار» فقط.";
    if (kinds.includes("embed")) return "هذا نموذج تضمين: يحوّل النص إلى أرقام للبحث ولا يكتب نصاً. يصلح لدور «نموذج التضمين» فقط.";
    if (kinds.includes("rerank")) return "هذا نموذج ترتيب نتائج البحث ولا يكتب نصاً، فلا يصلح لهذا الدور.";
    return "هذا النموذج لا يكتب نصاً (صوت أو صور)، فلا يصلح لهذا الدور.";
  }
  const timeoutMs = 90_000; // a router may start the model on the first request
  let r;
  if (role === "decide" && kinds.includes("decide")) {
    r = await call(p, "/systemone", { model, state: "اختبار", questions: { ok: { type: "noul", instructions: "هل هذا نص عربي؟" } } }, timeoutMs);
    if (r.status === 200 && r.json?.answers) return null;
  } else {
    const content = role === "vision" ? [{ type: "text", text: "صف الصورة بكلمة." }, { type: "image_url", image_url: { url: TINY_PNG } }] : "قل: نعم";
    r = await call(p, "/chat/completions", { model, messages: [{ role: "user", content }], max_tokens: 16, temperature: 0 }, timeoutMs);
    if (r.status === 200 && Array.isArray(r.json?.choices)) return null;
  }
  return explainModelError({ role, flavor: p.flavor, model, status: r.status === 200 ? 500 : r.status, body: r.status === 200 ? "الرد ليس بالشكل المتوقع" : r.body, timeout: r.timeout });
}

/** «جرّب واحفظ»: tries the model for the role, and saves it only if it worked. */
export const tryRole = action({
  args: { role: roleV, providerId: v.string(), model: v.string() },
  handler: async (ctx, { role, providerId, model }): Promise<null> => {
    const userId = await requireUserId(ctx);
    const p = await ctx.runQuery(internal.providers.forCheck, { userId, providerId: providerId as Id<"aiProviders"> });
    const m = model.trim();
    if (!m) throw new OneBaseError("اختر نموذجاً");
    const error = await tryModel(p, role, m, p.modelInfo.find((x) => x.id === m));
    if (error) throw new OneBaseError(`لم ينجح التجريب: ${error}`);
    await ctx.runMutation(internal.providers.saveTriedRole, { userId, role, providerId, model: m });
    setAiOverrides(await ctx.runQuery(internal.providers.resolved, {}));
    return null;
  },
});

/** Role → endpoint, for primeAi (ai.ts). Disabled or deleted providers fall back to the environment. */
export const resolved = internalQuery({
  args: {},
  handler: async (ctx): Promise<Overrides> => {
    const roles = await readRoles(ctx);
    const out: Overrides = { decisions: await readDecisions(ctx) };
    if (roles.embed) {
      const p = await ctx.db.get(roles.embed.providerId);
      if (p?.enabled) out.embed = await embedConfigFromDb(ctx.db);
    }
    for (const r of ROLES) {
      const c = roles[r];
      if (!c) continue;
      const p = await ctx.db.get(c.providerId);
      if (p?.enabled) out[r] = { baseUrl: p.baseUrl, model: c.model, apiKey: p.apiKey, provider: p.name };
    }
    return out;
  },
});

export const forCheck = internalQuery({
  args: { userId: v.id("users"), providerId: v.id("aiProviders") },
  handler: async (ctx, { userId, providerId }) => {
    const actor = await actorFor(ctx, userId);
    if (actor?.role !== "admin") throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
    const p = await ctx.db.get(providerId);
    if (!p) throw new OneBaseError("المزوّد غير موجود");
    return { baseUrl: p.baseUrl, apiKey: p.apiKey, flavor: (p.flavor ?? detectFlavor(p.baseUrl, null)) as Flavor, modelInfo: (p.modelInfo ?? []) as ModelInfo[] };
  },
});

export const recordCheck = internalMutation({
  args: {
    providerId: v.id("aiProviders"),
    ok: v.boolean(),
    models: v.array(v.string()),
    modelInfo: v.optional(v.array(v.object({ id: v.string(), kinds: v.array(v.string()) }))),
    flavor: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { providerId, ok, models, modelInfo, flavor, error }) => {
    const p = await ctx.db.get(providerId);
    if (!p) return;
    await ctx.db.patch(providerId, { lastCheck: { ok, at: Date.now(), ...(error ? { error } : {}) }, ...(ok ? { models, ...(modelInfo ? { modelInfo } : {}), ...(flavor ? { flavor } : {}) } : {}) });
  },
});

/** «افحص»: reaches the server and lists its models. */
export const check = action({
  args: { providerId: v.string() },
  handler: async (ctx, { providerId }): Promise<{ ok: boolean; models: string[]; error?: string }> => {
    const userId = await requireUserId(ctx);
    const id = providerId as Id<"aiProviders">;
    const p = await ctx.runQuery(internal.providers.forCheck, { userId, providerId: id });
    let result: { ok: boolean; models: string[]; error?: string };
    let extra: { modelInfo?: ModelInfo[]; flavor?: Flavor } = {};
    try {
      const r = await fetch(`${p.baseUrl}/models`, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) result = { ok: false, models: [], error: explainModelError({ role: "main", flavor: p.flavor, model: "", status: r.status, body: (await r.text()).slice(0, 500) }) };
      else {
        const data: any = await r.json().catch(() => null);
        const modelInfo = readModels(data);
        extra = { modelInfo, flavor: detectFlavor(p.baseUrl, data) };
        result = { ok: true, models: modelInfo.map((m) => m.id) };
      }
    } catch (e) {
      result = { ok: false, models: [], error: (e as Error)?.name === "TimeoutError" ? "لا رد خلال 8 ثوانٍ: تأكد أن الخادم يعمل" : "تعذّر الوصول إلى الخادم: تأكد أنه يعمل وأن العنوان صحيح (وينتهي بـ ‎/v1‎)" };
    }
    await ctx.runMutation(internal.providers.recordCheck, { providerId: id, ...result, ...extra });
    setAiOverrides(await ctx.runQuery(internal.providers.resolved, {}));
    return result;
  },
});

// ---------------------------------------------------------------- the embedding model

export const saveEmbedRole = internalMutation({
  args: { userId: v.id("users"), choice: v.union(v.null(), v.object({ providerId: v.id("aiProviders"), model: v.string(), sendDimensions: v.boolean(), queryPrefix: v.string(), docPrefix: v.string() })) },
  handler: async (ctx, { userId, choice }) => {
    const actor = await actorFor(ctx, userId);
    if (actor?.role !== "admin") throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
    const roles = await readRoles(ctx);
    if (choice) roles.embed = choice;
    else delete roles.embed;
    const row = await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "roles")).unique();
    if (row) await ctx.db.patch(row._id, { value: roles, updatedAt: Date.now() });
    else await ctx.db.insert("aiSettings", { key: "roles", value: roles, updatedAt: Date.now() });
    await writeAudit(ctx, { userId, action: "provider.role", resourceType: "aiSettings", resourceId: "embed", detail: { role: "embed", providerId: choice?.providerId ?? "env", model: choice?.model ?? null } });
    return (await embedStatus(ctx, roles)).mismatch;
  },
});

/**
 * Chooses the embedding model (providerId null = the environment). Calls the server once to check
 * the vector size: it must equal the index's; if not, it asks for that size (`dimensions`, which
 * OpenAI-style APIs support) and refuses if the model can't give it. Returns whether the files
 * must be re-indexed (a different model than the index was built with).
 */
export const setEmbedding = action({
  args: { providerId: v.union(v.string(), v.null()), model: v.optional(v.string()) },
  handler: async (ctx, { providerId, model }): Promise<{ needsReindex: boolean }> => {
    const userId = await requireUserId(ctx);
    if (!providerId) return { needsReindex: await ctx.runMutation(internal.providers.saveEmbedRole, { userId, choice: null }) };
    const id = providerId as Id<"aiProviders">;
    const p = await ctx.runQuery(internal.providers.forCheck, { userId, providerId: id });
    const m = (model ?? "").trim();
    if (!m) throw new OneBaseError("اختر نموذجاً");
    const probe = async (withDims: boolean) => {
      const r = await fetch(`${p.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({ model: m, input: ["اختبار"], ...(withDims ? { dimensions: INDEX_DIMENSIONS } : {}) }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (!r) throw new OneBaseError(`لم ينجح التجريب: ${explainModelError({ role: "embed", flavor: p.flavor, model: m, status: 0 })}`);
      if (!r.ok) return { error: explainModelError({ role: "embed", flavor: p.flavor, model: m, status: r.status, body: await r.text() }) };
      const data: any = await r.json().catch(() => null);
      const vec = data?.data?.[0]?.embedding;
      return Array.isArray(vec) ? { size: vec.length } : { error: "الرد ليس متجه تضمين: هل هذا نموذج تضمين؟" };
    };
    let first = await probe(false);
    let sendDimensions = false;
    if ("size" in first && first.size !== INDEX_DIMENSIONS) {
      const second = await probe(true);
      if ("size" in second && second.size === INDEX_DIMENSIONS) sendDimensions = true;
      else throw new OneBaseError(`أبعاد هذا النموذج ${first.size}، والفهرس مبني على ${INDEX_DIMENSIONS}. اختر نموذجاً بأبعاد ${INDEX_DIMENSIONS} (أو يدعم تقليصها).`);
    } else if ("error" in first) throw new OneBaseError(`لم ينجح التجريب: ${first.error}`);
    const prefixes = /embeddinggemma/i.test(m) ? GEMMA_PREFIXES : { queryPrefix: "", docPrefix: "" };
    const needsReindex = await ctx.runMutation(internal.providers.saveEmbedRole, { userId, choice: { providerId: id, model: m, sendDimensions, ...prefixes } });
    setAiOverrides(await ctx.runQuery(internal.providers.resolved, {}));
    return { needsReindex };
  },
});

/** «أعد الفهرسة»: pins the current embedding model and indexes every file again with it. */
export const reindex = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const pinned = await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "embedding")).unique();
    if (pinned) await ctx.db.delete(pinned._id);
    await ensureEmbeddingIndex(ctx);
    let n = 0;
    for (const f of await ctx.db.query("files").collect()) {
      if (f.status !== "active") continue;
      await scheduleIngest(ctx, f._id);
      n++;
    }
    await writeAudit(ctx, { userId: me.userId, action: "index.rebuild", resourceType: "aiSettings", resourceId: "embedding", detail: { files: n, model: (await embedConfigFromDb(ctx.db)).model } });
    return n;
  },
});
