// External data sources (plans/08 §C): databases, systems' REST APIs and search engines an admin
// connects, for agents to read live facts from.
//
// - Read only, always (lib/sourceQuery.ts): one SELECT in a read-only transaction, GET under the
//   base URL, or a search query.
// - The connection string and auth header are write-only: kept for the server's own calls and
//   never returned to any browser or shown to the model.
// - Who: a source is for the whole workspace or members of chosen spaces, and an employee's level
//   may narrow it further (levels.sources). The query_source tool checks both on every call.
// - Every call is audited (who, which source, the request; not the returned rows).

import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, requireAdmin, requireUserId } from "./access";
import { writeAudit } from "./audit";
import { levelOf } from "./lib/levels";
import { describeSource, listMcpTools, type SourceKind, type SourceSecret } from "./lib/sourceQuery";

export const KINDS: Record<SourceKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  sqlite: "SQLite",
  http: "نظام عبر واجهة REST",
  search: "محرك بحث",
  mcp: "خادم MCP",
};
const MAX_SOURCES = 50;

const kind = v.union(v.literal("postgres"), v.literal("mysql"), v.literal("sqlite"), v.literal("http"), v.literal("search"), v.literal("mcp"));

/** The connection string with its password hidden, for display. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "••••";
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret|pass|auth/i.test(k)) u.searchParams.set(k, "••••");
    return decodeURIComponent(u.toString());
  } catch {
    return raw.replace(/:\/\/([^:@/]+):[^@/]+@/, "://$1:••••@");
  }
}

function checkUrl(k: SourceKind, raw: string): string {
  const url = raw.trim();
  if (!url) throw new OneBaseError("اكتب عنوان الاتصال");
  if (k === "sqlite") {
    if (!/^(sqlite:\/\/)?\/[^\0]+$/.test(url)) throw new OneBaseError("مسار ملف SQLite كامل، مثل sqlite:///data/hr.db");
    return url.startsWith("sqlite://") ? url : `sqlite://${url}`;
  }
  let u: URL;
  try {
    u = new URL(url.replace("{q}", "q"));
  } catch {
    throw new OneBaseError("عنوان غير صالح");
  }
  const ok = k === "postgres" ? ["postgres:", "postgresql:"] : k === "mysql" ? ["mysql:", "mariadb:"] : ["http:", "https:"];
  if (!ok.includes(u.protocol)) throw new OneBaseError(`يبدأ العنوان بـ ${ok.map((p) => p + "//").join(" أو ")}`);
  return url;
}

function view(d: Doc<"dataSources">) {
  return {
    _id: d._id,
    name: d.name,
    kind: d.kind,
    kindLabel: KINDS[d.kind],
    description: d.description,
    url: maskUrl(d.config.url),
    headerName: d.config.headerName ?? "",
    hasHeader: !!d.config.headerValue,
    paths: d.config.paths ?? [],
    tools: d.config.tools ?? [],
    schemaHint: d.schemaHint,
    rowLimit: d.rowLimit,
    visibility: d.visibility,
    enabled: d.enabled,
    lastCheck: d.lastCheck ?? null,
    updatedAt: d.updatedAt,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("dataSources").collect();
    const levels = await ctx.db.query("levels").collect();
    return {
      sources: rows.sort((a, b) => a.createdAt - b.createdAt).map((d) => ({ ...view(d), levels: levels.filter((l) => !l.sources || l.sources.includes(d._id)).map((l) => l.name) })),
      kinds: KINDS,
    };
  },
});

export const save = mutation({
  args: {
    sourceId: v.optional(v.string()),
    name: v.string(),
    kind,
    description: v.string(),
    url: v.optional(v.string()), // empty on edit = keep
    headerName: v.optional(v.string()),
    headerValue: v.optional(v.string()), // empty on edit = keep
    clearHeader: v.optional(v.boolean()),
    paths: v.optional(v.array(v.string())),
    tools: v.optional(v.array(v.string())),
    schemaHint: v.string(),
    rowLimit: v.number(),
    visibility: v.object({ kind: v.union(v.literal("workspace"), v.literal("spaces")), spaceIds: v.array(v.string()) }),
    enabled: v.boolean(),
  },
  handler: async (ctx, a) => {
    const me = await requireAdmin(ctx);
    const name = a.name.trim().slice(0, 80);
    if (!name) throw new OneBaseError("اكتب اسماً للمصدر");
    const description = a.description.trim().slice(0, 1000);
    if (!description) throw new OneBaseError("اكتب ما يحويه المصدر: يقرؤه المساعد ليعرف متى يستخدمه");
    const spaceIds: Id<"spaces">[] = [];
    if (a.visibility.kind === "spaces") {
      for (const sid of new Set(a.visibility.spaceIds)) {
        const id = ctx.db.normalizeId("spaces", sid);
        const s = id ? await ctx.db.get(id) : null;
        if (!s || s.kind !== "shared" || s.workspaceId !== me.workspace._id) throw new OneBaseError("مساحة غير صالحة");
        spaceIds.push(s._id);
      }
      if (!spaceIds.length) throw new OneBaseError("اختر مساحة واحدة على الأقل، أو أتحه لكل مساحة العمل");
    }
    const paths = (a.paths ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 30);
    const tools = [...new Set((a.tools ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 100);
    const now = Date.now();
    const common = {
      name,
      kind: a.kind,
      description,
      schemaHint: a.schemaHint.trim().slice(0, 12_000),
      rowLimit: Math.min(Math.max(Math.round(a.rowLimit) || 50, 1), 1000),
      visibility: { kind: a.visibility.kind, spaceIds },
      enabled: a.enabled,
      updatedAt: now,
    };
    const existing = a.sourceId ? ctx.db.normalizeId("dataSources", a.sourceId) : null;
    if (a.sourceId) {
      const d = existing ? await ctx.db.get(existing) : null;
      if (!d) throw new OneBaseError("المصدر غير موجود");
      const url = a.url?.trim() ? checkUrl(a.kind, a.url) : d.config.url;
      if (a.kind !== d.kind && !a.url?.trim()) throw new OneBaseError("غيّرت النوع: اكتب عنوان الاتصال من جديد");
      const config = {
        url,
        headerName: a.headerName?.trim() || undefined,
        headerValue: a.clearHeader ? undefined : a.headerValue?.trim() || d.config.headerValue,
        paths,
        tools,
      };
      await ctx.db.patch(d._id, { ...common, config, ...(url !== d.config.url ? { lastCheck: undefined } : {}) });
      await writeAudit(ctx, { userId: me.userId, action: "source.update", resourceType: "dataSource", resourceId: d._id, detail: { name, kind: a.kind, urlChanged: url !== d.config.url, headerChanged: !!a.headerValue?.trim() || !!a.clearHeader, enabled: a.enabled } });
      return d._id;
    }
    if ((await ctx.db.query("dataSources").collect()).length >= MAX_SOURCES) throw new OneBaseError(`الحد ${MAX_SOURCES} مصدراً`);
    if (!a.url?.trim()) throw new OneBaseError("اكتب عنوان الاتصال");
    const id = await ctx.db.insert("dataSources", {
      ...common,
      config: { url: checkUrl(a.kind, a.url), headerName: a.headerName?.trim() || undefined, headerValue: a.headerValue?.trim() || undefined, paths, tools },
      createdBy: me.userId,
      createdAt: now,
    });
    await writeAudit(ctx, { userId: me.userId, action: "source.create", resourceType: "dataSource", resourceId: id, detail: { name, kind: a.kind } });
    return id;
  },
});

export const remove = mutation({
  args: { sourceId: v.string() },
  handler: async (ctx, { sourceId }) => {
    const me = await requireAdmin(ctx);
    const id = ctx.db.normalizeId("dataSources", sourceId);
    const d = id ? await ctx.db.get(id) : null;
    if (!d) return;
    for (const l of await ctx.db.query("levels").collect()) if (l.sources?.includes(d._id)) await ctx.db.patch(l._id, { sources: l.sources.filter((x) => x !== d._id) });
    await ctx.db.delete(d._id);
    await writeAudit(ctx, { userId: me.userId, action: "source.delete", resourceType: "dataSource", resourceId: d._id, detail: { name: d.name } });
  },
});

function secretOf(d: Doc<"dataSources">): SourceSecret {
  return { kind: d.kind, url: d.config.url, headerName: d.config.headerName, headerValue: d.config.headerValue, paths: d.config.paths, tools: d.config.tools, rowLimit: d.rowLimit };
}

/** Sources this employee may use now: enabled, visible to them, and allowed by their level. */
export async function sourcesFor(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"dataSources">[]> {
  const actor = await actorFor(ctx, userId);
  if (!actor) return [];
  const level = await levelOf(ctx, userId);
  const out: Doc<"dataSources">[] = [];
  for (const d of await ctx.db.query("dataSources").collect()) {
    if (!d.enabled) continue;
    if (level.sources && !level.sources.includes(d._id)) continue;
    if (d.visibility.kind === "spaces") {
      let ok = false;
      for (const sid of d.visibility.spaceIds) {
        try {
          await assertCan(ctx, userId, sid, "read");
          ok = true;
          break;
        } catch {}
      }
      if (!ok) continue;
    }
    out.push(d);
  }
  return out;
}

/** What the model is told about the sources it may query (no secrets). */
export function sourcesContext(list: Doc<"dataSources">[]): string | null {
  if (!list.length) return null;
  const lines = list.map((d) => {
    const how =
      d.kind === "http" ? "GET: أرسل path و params" : d.kind === "search" ? "بحث: أرسل query" : d.kind === "mcp" ? `أدوات MCP: أرسل tool و arguments؛ المسموحة: ${(d.config.tools ?? []).join("، ") || "لا شيء"}` : `قاعدة ${KINDS[d.kind]}: أرسل sql (SELECT فقط)`;
    return `- «${d.name}» (source: ${d._id}، ${how}): ${d.description}${d.schemaHint ? `\n  البنية: ${d.schemaHint.slice(0, 2500).replace(/\n/g, "\n  ")}` : ""}`;
  });
  return `مصادر بيانات خارجية متاحة لهذا الموظف بأداة query_source (قراءة فقط، بيانات حيّة). استخدمها حين يسأل عمّا تحويه، واذكر المصدر باسمه في الإجابة:\n${lines.join("\n")}`;
}

export const forUser = internalQuery({
  args: { userId: v.id("users"), sourceId: v.string() },
  handler: async (ctx, { userId, sourceId }): Promise<{ id: string; name: string; secret: SourceSecret } | { error: string }> => {
    const list = await sourcesFor(ctx, userId);
    const d = list.find((x) => x._id === sourceId || x.name === sourceId);
    if (!d) return { error: `لا يوجد مصدر «${sourceId}» متاح لهذا الموظف. المتاحة: ${list.map((x) => `«${x.name}» (${x._id})`).join("، ") || "لا شيء"}` };
    return { id: d._id, name: d.name, secret: secretOf(d) };
  },
});

export const logCall = internalMutation({
  args: { userId: v.id("users"), sourceId: v.string(), request: v.string(), ok: v.boolean(), rows: v.optional(v.number()), error: v.optional(v.string()), threadId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await writeAudit(ctx, { userId: a.userId, action: "source.query", resourceType: "dataSource", resourceId: a.sourceId, detail: { request: a.request.slice(0, 1000), ok: a.ok, rows: a.rows ?? null, error: a.error ?? null, threadId: a.threadId ?? null } });
  },
});

export const forCheck = internalQuery({
  args: { userId: v.id("users"), sourceId: v.id("dataSources") },
  handler: async (ctx, { userId, sourceId }) => {
    const actor = await actorFor(ctx, userId);
    if (actor?.role !== "admin") throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
    const d = await ctx.db.get(sourceId);
    if (!d) throw new OneBaseError("المصدر غير موجود");
    return secretOf(d);
  },
});

export const recordCheck = internalMutation({
  args: { sourceId: v.id("dataSources"), ok: v.boolean(), error: v.optional(v.string()), schemaHint: v.optional(v.string()) },
  handler: async (ctx, { sourceId, ok, error, schemaHint }) => {
    const d = await ctx.db.get(sourceId);
    if (!d) return;
    await ctx.db.patch(sourceId, { lastCheck: { ok, at: Date.now(), ...(error ? { error } : {}) }, ...(schemaHint && !d.schemaHint.trim() ? { schemaHint: schemaHint.slice(0, 12_000) } : {}) });
  },
});

/** «افحص الاتصال»: connects, and fills the structure (tables/columns) if it's still empty. */
export const check = action({
  args: { sourceId: v.string() },
  handler: async (ctx, { sourceId }): Promise<{ ok: boolean; error?: string; schemaHint?: string; tools?: string[] }> => {
    const userId = await requireUserId(ctx);
    const id = sourceId as Id<"dataSources">;
    const secret = await ctx.runQuery(internal.dataSources.forCheck, { userId, sourceId: id });
    let out: { ok: boolean; error?: string; schemaHint?: string };
    let tools: string[] | undefined;
    try {
      if (secret.kind === "mcp") tools = (await listMcpTools(secret)).map((t) => t.name);
      out = { ok: true, schemaHint: await describeSource(secret) };
    } catch (e) {
      out = { ok: false, error: friendly(e) };
    }
    await ctx.runMutation(internal.dataSources.recordCheck, { sourceId: id, ...out });
    return { ...out, ...(tools ? { tools } : {}) };
  },
});

/** A connection error without hosts, users or passwords in it. */
export function friendly(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/ECONNREFUSED|connect|ENOTFOUND|EHOSTUNREACH|getaddrinfo/i.test(msg)) return "تعذّر الوصول إلى الخادم";
  if (/password|auth|denied|28P01|1045/i.test(msg)) return "رُفض الدخول: تحقّق من المستخدم وكلمة المرور";
  if (/timeout|الوقت/i.test(msg)) return "لا رد خلال الوقت المسموح";
  if (/[؀-ۿ]/.test(msg)) return msg.slice(0, 300);
  return msg.replace(/(postgres(ql)?|mysql|mariadb):\/\/\S+/gi, "<connection>").slice(0, 300);
}
