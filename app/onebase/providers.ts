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
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireAdmin, requireUserId, actorFor } from "./access";
import { embedConfigFromDb, embeddingSignature, ensureEmbeddingIndex, envEmbed, envTargets, GEMMA_PREFIXES, INDEX_DIMENSIONS, setAiOverrides, type Overrides, type RoleName } from "./ai";
import { writeAudit } from "./audit";
import { scheduleIngest } from "./ingest";

const ROLES: RoleName[] = ["main", "fast", "vision"];
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

async function readRoles(ctx: { db: any }): Promise<Roles> {
  const row = await ctx.db.query("aiSettings").withIndex("by_key", (q: any) => q.eq("key", "roles")).unique();
  return (row?.value as Roles) ?? {};
}

function view(p: Doc<"aiProviders">) {
  return { _id: p._id, name: p.name, baseUrl: p.baseUrl, hasKey: !!p.apiKey, enabled: p.enabled, models: p.models, lastCheck: p.lastCheck ?? null, updatedAt: p.updatedAt };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const providers = await ctx.db.query("aiProviders").collect();
    const roles = await readRoles(ctx);
    const env = envTargets();
    return {
      providers: providers.map(view),
      roles: Object.fromEntries(ROLES.map((r) => [r, roles[r] ?? null])) as Record<RoleName, RoleChoice | null>,
      env: Object.fromEntries(ROLES.map((r) => [r, { configured: !!env[r].baseUrl, model: env[r].model, host: env[r].baseUrl ? new URL(env[r].baseUrl!).host : null }])) as Record<RoleName, { configured: boolean; model: string; host: string | null }>,
      embed: await embedStatus(ctx, roles),
    };
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
      await ctx.db.patch(p._id, { name, baseUrl, enabled: a.enabled, updatedAt: now, ...(key ? { apiKey: key } : a.clearKey ? { apiKey: undefined } : {}), ...(baseUrl !== p.baseUrl ? { models: [], lastCheck: undefined } : {}) });
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

/** Points a role at a provider's model, or back at the environment (providerId null). */
export const setRole = mutation({
  args: { role: v.union(v.literal("main"), v.literal("fast"), v.literal("vision")), providerId: v.union(v.string(), v.null()), model: v.optional(v.string()) },
  handler: async (ctx, { role, providerId, model }) => {
    const me = await requireAdmin(ctx);
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
    await writeAudit(ctx, { userId: me.userId, action: "provider.role", resourceType: "aiSettings", resourceId: role, detail: { role, providerId: providerId ?? "env", model: model ?? null } });
  },
});

/** Role → endpoint, for primeAi (ai.ts). Disabled or deleted providers fall back to the environment. */
export const resolved = internalQuery({
  args: {},
  handler: async (ctx): Promise<Overrides> => {
    const roles = await readRoles(ctx);
    const out: Overrides = {};
    if (roles.embed) {
      const p = await ctx.db.get(roles.embed.providerId);
      if (p?.enabled) out.embed = await embedConfigFromDb(ctx.db);
    }
    for (const r of ROLES) {
      const c = roles[r];
      if (!c) continue;
      const p = await ctx.db.get(c.providerId);
      if (p?.enabled) out[r] = { baseUrl: p.baseUrl, model: c.model, apiKey: p.apiKey };
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
    return { baseUrl: p.baseUrl, apiKey: p.apiKey };
  },
});

export const recordCheck = internalMutation({
  args: { providerId: v.id("aiProviders"), ok: v.boolean(), models: v.array(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { providerId, ok, models, error }) => {
    const p = await ctx.db.get(providerId);
    if (!p) return;
    await ctx.db.patch(providerId, { lastCheck: { ok, at: Date.now(), ...(error ? { error } : {}) }, ...(ok ? { models } : {}) });
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
    try {
      const r = await fetch(`${p.baseUrl}/models`, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) result = { ok: false, models: [], error: r.status === 401 || r.status === 403 ? "المفتاح مرفوض" : `HTTP ${r.status}` };
      else {
        const data: any = await r.json().catch(() => null);
        const models = [...new Set(((data?.data ?? data?.models ?? []) as any[]).map((m) => String(m?.id ?? m?.name ?? m)).filter(Boolean))].slice(0, 200);
        result = { ok: true, models };
      }
    } catch (e) {
      result = { ok: false, models: [], error: (e as Error)?.name === "TimeoutError" ? "لا رد خلال 8 ثوانٍ" : "تعذّر الوصول إلى الخادم" };
    }
    await ctx.runMutation(internal.providers.recordCheck, { providerId: id, ...result });
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
      if (!r) throw new OneBaseError("تعذّر الوصول إلى الخادم");
      if (!r.ok) return { error: `HTTP ${r.status}: ${(await r.text()).slice(0, 160)}` };
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
    } else if ("error" in first) throw new OneBaseError(`لم ينجح الاختبار: ${first.error}`);
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
