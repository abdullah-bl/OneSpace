// Apps (plans/13): small web apps the assistant builds (files + grants), tests in a headless browser,
// and publishes through plans/11. This file holds:
//   - write_app / read_app (internal, for the tools) and the grants they declare;
//   - test links (/t/<token>): a draft served like a published page, every write dry-run;
//   - the data API behind POST <content origin>/a/<slug|test> (publicationsHttp.ts): append, mine,
//     stats, and the rows a server-side handler returns, all checked against the grants;
//   - the migration of plans/11 quiz publications into apps.
//
// Grants are enforced here on every call, from the published version (publication.app.grants), never
// from what the page sends. A handler's code and private files come from the pinned version only.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, requireActive } from "./access";
import { assertVersion, insertArtifact, place, requireActor } from "./artifacts";
import { writeAudit } from "./audit";
import { appendFromForm, cleanListCells, listPeople, placeForTier } from "./lists";
import { findColumn, hashToken, newToken, publicAllowed, publishOrigin, readerMay } from "./publications";
import { appFilesFromSkill } from "./skills";
import {
  ALIAS_RE,
  APP_LIMITS,
  applyFiles,
  appWarnings,
  grantLines,
  handlersOf,
  isPrivate,
  parseApp,
  serializeApp,
  type AppContent,
  type Grant,
  type PageConfig,
  type ReadMode,
  type WriteMode,
} from "./lib/appFiles";

type Ctx = QueryCtx | MutationCtx;

const TEST_TTL_MS = 10 * 60_000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------- grants

export type GrantInput = { listId: string; write?: string; read?: string; columns?: string[]; sender?: string };

/**
 * The model's grants ({ alias: { listId, write, read, columns: names, sender: name } }) as stored
 * (column keys). Every list must be in the app's space and readable by the user; checked again,
 * with write access, when publishing (checkGrantsForPublish).
 */
export async function resolveGrants(ctx: Ctx, userId: Id<"users">, spaceId: Id<"spaces">, input: Record<string, GrantInput>): Promise<Record<string, Grant>> {
  const out: Record<string, Grant> = {};
  const entries = Object.entries(input ?? {});
  if (entries.length > APP_LIMITS.aliases) throw new OneBaseError(`الحد ${APP_LIMITS.aliases} قوائم للتطبيق`);
  for (const [alias, g] of entries) {
    if (!ALIAS_RE.test(alias)) throw new OneBaseError(`اسم القائمة في التطبيق «${alias}»: حروف إنجليزية وأرقام و _ ويبدأ بحرف`);
    const lid = ctx.db.normalizeId("lists", String(g?.listId ?? ""));
    const list = lid ? await ctx.db.get(lid) : null;
    if (!list) throw new OneBaseError(`«${alias}»: لا توجد قائمة بالمعرّف ${g?.listId}`);
    await assertCan(ctx, userId, list.spaceId, "read");
    if (list.spaceId !== spaceId) throw new OneBaseError(`«${alias}»: القائمة «${list.title}» في مساحة أخرى غير مساحة التطبيق؛ أنشئ القائمة في مساحة التطبيق`);
    const write = (["none", "page", "handler"].includes(String(g.write)) ? g.write : "none") as WriteMode;
    const read = (["none", "own", "aggregate"].includes(String(g.read)) ? g.read : "none") as ReadMode;
    const col = (name: string) => {
      const c = findColumn(list.columns, String(name));
      if (!c) throw new OneBaseError(`«${alias}»: لا يوجد عمود «${name}» في «${list.title}». أعمدتها: ${list.columns.map((x) => `«${x.name}»`).join("، ")}`);
      return c;
    };
    const columns = Array.isArray(g.columns) && g.columns.length ? [...new Set(g.columns.map((n) => col(n)).filter((c) => c.type !== "person").map((c) => c.key))] : undefined;
    let sender: string | undefined;
    if (g.sender) {
      const c = col(g.sender);
      if (c.type !== "person") throw new OneBaseError(`«${alias}»: عمود المرسل «${c.name}» يجب أن يكون من نوع person`);
      sender = c.key;
    }
    out[alias] = { listId: list._id, write, read, ...(columns ? { columns } : {}), ...(sender ? { sender } : {}) };
  }
  return out;
}

/** Publishing an app: its lists in its space, writable by the publisher for writes, readable for reads. */
export async function checkGrantsForPublish(ctx: Ctx, userId: Id<"users">, spaceId: Id<"spaces">, grants: Record<string, Grant>) {
  for (const [alias, g] of Object.entries(grants)) {
    const lid = ctx.db.normalizeId("lists", g.listId);
    const list = lid ? await ctx.db.get(lid) : null;
    if (!list || list.spaceId !== spaceId) throw new OneBaseError(`قائمة «${alias}» في التطبيق حُذفت أو ليست في مساحته`);
    await assertCan(ctx, userId, list.spaceId, g.write !== "none" ? "write" : "read");
  }
}

async function listsOf(ctx: Ctx, grants: Record<string, Grant>) {
  const m = new Map<string, Doc<"lists"> | null>();
  for (const g of Object.values(grants)) {
    if (m.has(g.listId)) continue;
    const id = ctx.db.normalizeId("lists", g.listId);
    m.set(g.listId, id ? await ctx.db.get(id) : null);
  }
  return m;
}

export async function grantText(ctx: Ctx, grants: Record<string, Grant>): Promise<string[]> {
  return grantLines(grants, await listsOf(ctx, grants));
}

/** What the page's code sees of its lists: modes, and the granted columns' names, types and options. */
async function pageLists(ctx: Ctx, grants: Record<string, Grant>): Promise<PageConfig["lists"]> {
  const lists = await listsOf(ctx, grants);
  const out: PageConfig["lists"] = {};
  for (const [alias, g] of Object.entries(grants)) {
    const list = lists.get(g.listId);
    const cols = (list?.columns ?? []).filter((c) => c.type !== "person" && (!g.columns || g.columns.includes(c.key)));
    out[alias] = { write: g.write, read: g.read, columns: cols.map((c) => ({ name: c.name, type: c.type, ...(c.options?.length ? { options: c.options } : {}) })) };
  }
  return out;
}

// ---------------------------------------------------------------- loading an app

async function appOf(ctx: Ctx, artifactId: string) {
  const id = ctx.db.normalizeId("artifacts", String(artifactId ?? ""));
  const art = id ? await ctx.db.get(id) : null;
  if (!art || art.kind !== "app") throw new Denied();
  return art;
}

export async function appVersion(ctx: Ctx, artifactId: Id<"artifacts">, version: number): Promise<AppContent | null> {
  const ver = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", artifactId).eq("version", version)).unique();
  return ver ? parseApp(ver.content) : null;
}

function fileList(app: AppContent) {
  return Object.entries(app.files).map(([p, c]) => `- ${p} (${c.length} حرفاً${isPrivate(p) ? "، خاص بالخادم لا يصل للمتصفح" : ""})`);
}

// ---------------------------------------------------------------- the tools

/** write_app: create an app, or write/replace/delete (null) some of its files and its grants, as a new version. */
export const writeFromTool = internalMutation({
  args: {
    userId: v.id("users"),
    scopeSpaceIds: v.array(v.string()),
    threadId: v.optional(v.string()),
    appId: v.optional(v.string()),
    title: v.optional(v.string()),
    files: v.record(v.string(), v.union(v.string(), v.null())),
    data: v.optional(v.record(v.string(), v.any())),
    fromSkill: v.optional(v.string()),
    expectVersion: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const actor = await requireActor(ctx, a.userId);
    const scope = new Set(a.scopeSpaceIds);
    try {
      if (a.appId) {
        const art = await appOf(ctx, a.appId);
        const { space } = await assertCan(ctx, a.userId, art.spaceId, "write");
        if (space.kind !== "personal" && !scope.has(space._id)) throw new Denied();
        assertVersion(art, a.expectVersion);
        const cur = (await appVersion(ctx, art._id, art.currentVersion)) ?? { files: {}, data: {} };
        const files = applyFiles(cur.files, a.files);
        const data = a.data ? await resolveGrants(ctx, a.userId, art.spaceId, a.data as Record<string, GrantInput>) : cur.data;
        const next: AppContent = { files, data };
        const content = serializeApp(next);
        const version = art.currentVersion + 1;
        const now = Date.now();
        const title = a.title?.trim() ? a.title.trim().slice(0, 200) : art.title;
        await ctx.db.insert("artifactVersions", { artifactId: art._id, version, content, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), size: content.length, createdBy: a.userId, createdAt: now });
        await ctx.db.patch(art._id, { currentVersion: version, updatedAt: now, title });
        await writeAudit(ctx, { userId: a.userId, action: "artifact.update", resourceType: "artifact", resourceId: art._id, spaceId: art.spaceId, detail: { name: title, version, via: "write_app", files: Object.keys(a.files).length } });
        return { ok: true as const, artifactId: art._id as string, spaceId: art.spaceId as string, version, previous: art.currentVersion, created: false, files: fileList(next), warnings: appWarnings(next), grants: await grantText(ctx, data), handlers: handlersOf(files) };
      }
      // A new app: where its lists are (they must share its space), else where a new list would go.
      const firstList = Object.values((a.data ?? {}) as Record<string, GrantInput>)[0]?.listId;
      const lid = firstList ? ctx.db.normalizeId("lists", String(firstList)) : null;
      const list = lid ? await ctx.db.get(lid) : null;
      const target = list ? list.spaceId : (await placeForTier(ctx, a.userId, a.threadId, a.scopeSpaceIds))._id;
      const placed = await place(ctx, actor, [], new Set(), target, scope);
      const base = a.fromSkill ? await appFilesFromSkill(ctx, a.userId, a.fromSkill, a.threadId, a.scopeSpaceIds) : {};
      const files = applyFiles(base, a.files);
      const data = await resolveGrants(ctx, a.userId, placed.space._id, (a.data ?? {}) as Record<string, GrantInput>);
      const next: AppContent = { files, data };
      const title = (a.title ?? "").trim().slice(0, 200) || "تطبيق";
      const artifactId = await insertArtifact(ctx, {
        spaceId: placed.space._id,
        ownerId: a.userId,
        kind: "app",
        title,
        content: serializeApp(next),
        sources: [],
        classification: placed.classification,
        originSpaceId: placed.originSpaceId,
        threadId: a.threadId,
        via: "write_app",
      });
      return { ok: true as const, artifactId: artifactId as string, spaceId: placed.space._id as string, version: 1, previous: 0, created: true, files: fileList(next), warnings: appWarnings(next), grants: await grantText(ctx, data), handlers: handlersOf(files) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Denied ? "التطبيق غير موجود أو لا تملك تعديله" : e instanceof Error ? e.message : String(e) };
    }
  },
});

/** read_app: the files (all, or one in full) and the grants, for an app in this turn's scope. */
export const readForTool = internalQuery({
  args: { userId: v.id("users"), scopeSpaceIds: v.array(v.string()), appId: v.string(), path: v.optional(v.string()) },
  handler: async (ctx, a) => {
    try {
      const art = await appOf(ctx, a.appId);
      const { space } = await assertCan(ctx, a.userId, art.spaceId, "read");
      if (space.kind !== "personal" && !a.scopeSpaceIds.includes(space._id)) throw new Denied();
      const app = (await appVersion(ctx, art._id, art.currentVersion))!;
      if (a.path) {
        const c = app.files[a.path];
        if (c === undefined) return { ok: true as const, text: `لا يوجد ${a.path}. الملفات:\n${fileList(app).join("\n")}` };
        return { ok: true as const, text: `${a.path} (التطبيق «${art.title}»، النسخة ${art.currentVersion}):\n\n${c}` };
      }
      const grants = await grantText(ctx, app.data);
      const lists = await listsOf(ctx, app.data);
      const aliases = Object.entries(app.data).map(([k, g]) => `- ${k}: listId=${g.listId} «${lists.get(g.listId)?.title ?? "؟"}» write=${g.write} read=${g.read}`);
      const body = Object.entries(app.files)
        .map(([p, c]) => `===== ${p}${isPrivate(p) ? " (خاص بالخادم)" : ""} =====\n${c.length > 12_000 ? `${c.slice(0, 12_000)}\n… (اقرأه كاملاً بـ path)` : c}`)
        .join("\n\n");
      return { ok: true as const, text: `التطبيق «${art.title}» (appId=${art._id}، النسخة ${art.currentVersion})\nالقوائم:\n${aliases.join("\n") || "لا شيء"}\n${grants.join("\n")}\n\n${body}` };
    } catch (e) {
      return { ok: false as const, text: e instanceof Denied ? "التطبيق غير موجود أو لا تملك قراءته" : e instanceof Error ? e.message : String(e) };
    }
  },
});

// ---------------------------------------------------------------- test links (test_app, «جرّبه»)

async function insertTest(ctx: MutationCtx, userId: Id<"users">, art: Doc<"artifacts">, version: number, grants: Record<string, Grant>, publicationId?: Id<"publications">) {
  const token = newToken();
  await ctx.db.insert("appTests", { tokenHash: hashToken(token), artifactId: art._id, version, userId, grants, events: [], expiresAt: Date.now() + TEST_TTL_MS, ...(publicationId ? { publicationId } : {}) });
  return { token, url: `${publishOrigin()}/t/${token}` };
}

/** A test of the app's current version for its writer; its grants as declared (writes are dry-run). */
async function startTest(ctx: MutationCtx, userId: Id<"users">, artifactId: string, scope: string[] | null) {
  if (!publishOrigin()) throw new OneBaseError("التجربة تحتاج نطاق النشر (PUBLISH_ORIGIN) مضبوطاً على الخادم");
  const art = await appOf(ctx, artifactId);
  const { space } = await assertCan(ctx, userId, art.spaceId, "write");
  if (scope && space.kind !== "personal" && !scope.includes(space._id)) throw new Denied();
  const app = (await appVersion(ctx, art._id, art.currentVersion))!;
  for (const g of Object.values(app.data)) {
    const lid = ctx.db.normalizeId("lists", g.listId);
    const list = lid ? await ctx.db.get(lid) : null;
    if (!list) throw new OneBaseError("إحدى قوائم التطبيق حُذفت؛ حدّث data في write_app");
    await assertCan(ctx, userId, list.spaceId, "read");
  }
  return { ...(await insertTest(ctx, userId, art, art.currentVersion, app.data)), version: art.currentVersion, title: art.title, files: app.files };
}

export const startTestForTool = internalMutation({
  args: { userId: v.id("users"), scopeSpaceIds: v.array(v.string()), appId: v.string() },
  handler: async (ctx, a) => {
    try {
      return { ok: true as const, ...(await startTest(ctx, a.userId, a.appId, a.scopeSpaceIds)) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Denied ? "التطبيق غير موجود أو لا تملك تعديله" : e instanceof Error ? e.message : String(e) };
    }
  },
});

/** The events a test recorded (API calls, handler results, dry-run rows); the link is closed after. */
export const finishTest = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const t = await ctx.db.query("appTests").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(token))).unique();
    if (!t) return [];
    await ctx.db.delete(t._id);
    return t.events;
  },
});

/** «جرّبه» on a draft app (the side panel): a test link for its writer. Nothing a visitor does there is saved. */
export const testLink = mutation({
  args: { artifactId: v.string() },
  handler: async (ctx, { artifactId }) => {
    const me = await requireActive(ctx);
    const r = await startTest(ctx, me.userId, artifactId, null);
    return r.url;
  },
});

/** A publication's «جرّبها» (pageForSession with ?preview=1): its pinned version and grants, dry-run. */
export async function previewTest(ctx: MutationCtx, userId: Id<"users">, p: Doc<"publications">) {
  const art = await ctx.db.get(p.artifactId);
  if (!art || !p.app) return null;
  return insertTest(ctx, userId, art, p.version, p.app.grants, p._id);
}

export const purgeTests = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const t of await ctx.db.query("appTests").withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now())).take(500)) await ctx.db.delete(t._id);
  },
});

// ---------------------------------------------------------------- serving (publicationsHttp.ts)

/** The page config for a test link: the draft (or a publication's pinned version) as its writer sees it. */
export const testPage = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const t = await ctx.db.query("appTests").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(token))).unique();
    if (!t || t.expiresAt < Date.now()) return null;
    const art = await ctx.db.get(t.artifactId);
    const app = art ? await appVersion(ctx, art._id, t.version) : null;
    const user = await ctx.db.get(t.userId);
    if (!art || !app) return null;
    return { title: art.title, files: app.files, lists: await pageLists(ctx, t.grants), visitor: { signedIn: true, name: user?.name ?? user?.email ?? null } };
  },
});

/** An app publication's page parts for a reader: files of the pinned version, its lists, a token. */
export async function appPageFor(ctx: Ctx, p: Doc<"publications">, who: { token: string; signedIn: boolean; name: string | null }) {
  if (!p.app) return null;
  const app = await appVersion(ctx, p.artifactId, p.version);
  if (!app) return null;
  return { files: app.files, lists: await pageLists(ctx, p.app.grants), token: who.token, visitor: { signedIn: who.signedIn, name: who.name } };
}

/** A public page's token: a visitor key for this page load, the hour, and a MAC from the page's secret. */
export function publicAppToken(p: Doc<"publications">, visitorKey = newToken(9), hour = Math.floor(Date.now() / HOUR)) {
  return `${visitorKey}.${hour}.${hashToken(`${p.formSecret ?? p._id}:app:${visitorKey}:${hour}`).slice(0, 32)}`;
}

// ---------------------------------------------------------------- the data API

type Who =
  | { kind: "test"; test: Doc<"appTests">; grants: Record<string, Grant>; visitor: string; userId: Id<"users">; name: string | null; signedIn: true }
  | { kind: "pub"; pub: Doc<"publications">; grants: Record<string, Grant>; visitor: string; userId: Id<"users"> | null; name: string | null; signedIn: boolean };

/** Who is calling, from the page's token: a test link, a reader's page session, or a public page's visitor. */
async function authorize(ctx: MutationCtx, target: string, token: string, ip: string, limit: boolean): Promise<Who | { error: string; status: number }> {
  const gone = { error: "انتهت صلاحية الصفحة؛ أعد تحميلها.", status: 401 };
  if (target === "test") {
    const t = await ctx.db.query("appTests").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(token))).unique();
    if (!t || t.expiresAt < Date.now()) return gone;
    if (limit && !(await ctx.components.limiter.limit({ name: "appCallUser", key: t.userId })).ok) return { error: "طلبات كثيرة؛ حاول بعد دقيقة.", status: 429 };
    const user = await ctx.db.get(t.userId);
    return { kind: "test", test: t, grants: t.grants, visitor: `t:${t._id}`, userId: t.userId, name: user?.name ?? user?.email ?? null, signedIn: true };
  }
  const p = await ctx.db.query("publications").withIndex("by_slug", (q) => q.eq("slug", target)).first();
  if (!p || !p.app || p.state !== "live") return gone;
  // A reader's page session (private pages, or a signed-in reader of a public one).
  const s = await ctx.db.query("publicationSessions").withIndex("by_form_hash", (q) => q.eq("formTokenHash", hashToken(token))).unique();
  if (s) {
    if (s.expiresAt < Date.now() || s.publicationId !== p._id || !(await readerMay(ctx, s.userId, p))) return gone;
    if (limit && !(await ctx.components.limiter.limit({ name: "appCallUser", key: s.userId })).ok) return { error: "طلبات كثيرة؛ حاول بعد دقيقة.", status: 429 };
    const user = await ctx.db.get(s.userId);
    return { kind: "pub", pub: p, grants: p.app.grants, visitor: `u:${s.userId}`, userId: s.userId, name: user?.name ?? user?.email ?? null, signedIn: true };
  }
  // A public page's anonymous visitor.
  const [vk, hourS] = token.split(".");
  const hour = Number(hourS);
  const now = Math.floor(Date.now() / HOUR);
  if (!vk || !Number.isInteger(hour) || hour > now || hour < now - 3 || token !== publicAppToken(p, vk, hour)) return gone;
  const art = await ctx.db.get(p.artifactId);
  const space = await ctx.db.get(p.spaceId);
  if (p.audience !== "public" || !(await publicAllowed(ctx)) || !art || !space || space.sensitive || art.classification === "sensitive") return gone;
  if (limit && !(await ctx.components.limiter.limit({ name: "appCall", key: ip })).ok) return { error: "طلبات كثيرة؛ حاول بعد دقيقة.", status: 429 };
  return { kind: "pub", pub: p, grants: p.app.grants, visitor: `a:${vk}`, userId: null, name: null, signedIn: false };
}

const isErr = (w: Who | { error: string; status: number }): w is { error: string; status: number } => "error" in w;

function grantOf(w: Who, alias: unknown) {
  const g = w.grants[String(alias ?? "")];
  if (!g) throw new OneBaseError(`لا توجد قائمة «${alias}» في هذا التطبيق. المتاح: ${Object.keys(w.grants).join("، ") || "لا شيء"}`);
  return g;
}

async function listFor(ctx: Ctx, g: Grant) {
  const id = ctx.db.normalizeId("lists", g.listId);
  const list = id ? await ctx.db.get(id) : null;
  if (!list) throw new OneBaseError("القائمة المرتبطة بالتطبيق حُذفت");
  return list;
}

/** Cells by column NAME (as the page and handler write them) → keys, only granted columns, never the sender. */
function grantedCells(list: Doc<"lists">, g: Grant, row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, val] of Object.entries(row ?? {})) {
    const col = list.columns.find((c) => c.name === name) ?? list.columns.find((c) => c.key === name) ?? findColumn(list.columns, name);
    if (!col) throw new OneBaseError(`لا يوجد عمود «${name}». الأعمدة: ${list.columns.filter((c) => c.type !== "person").map((c) => c.name).join("، ")}`);
    if (col.type === "person" || col.key === g.sender) throw new OneBaseError(`«${col.name}» يملؤه الخادم، لا الصفحة`);
    if (g.columns && !g.columns.includes(col.key)) throw new OneBaseError(`«${col.name}» ليس من أعمدة التطبيق المسموحة`);
    out[col.key] = typeof val === "object" && val !== null ? JSON.stringify(val) : val;
  }
  return out;
}

const named = (list: Doc<"lists">, cells: Record<string, unknown>) => Object.fromEntries(Object.entries(cells).map(([k, x]) => [list.columns.find((c) => c.key === k)?.name ?? k, x]));

/** Adds one row as the visitor (checked cells; the sender set by the server). Dry-run in a test. */
async function addRow(ctx: MutationCtx, w: Who, alias: string, g: Grant, row: Record<string, unknown>, via: "page" | "handler") {
  const list = await listFor(ctx, g);
  const cells = grantedCells(list, g, row);
  const space = (await ctx.db.get(list.spaceId))!;
  try {
    cleanListCells(list.columns, cells, await listPeople(ctx, space), false);
  } catch (e) {
    throw new OneBaseError(e instanceof Error ? e.message : "قيمة غير مقبولة");
  }
  if (w.kind === "test") return { test: true, list: alias, cells: named(list, cells), via };
  const p = w.pub;
  const createdBy = w.userId ?? p.createdBy;
  const rowId = await appendFromForm(ctx, list._id, cells, createdBy, w.userId && g.sender ? g.sender : undefined);
  await ctx.db.insert("formReplies", { publicationId: p._id, userId: createdBy, ...(w.userId ? {} : { anon: true }), rowId, at: Date.now(), visitor: w.visitor });
  const fresh = (await ctx.db.get(p._id))!;
  await ctx.db.patch(p._id, { app: { ...fresh.app!, rows: fresh.app!.rows + 1 } });
  return { rowId };
}

async function visitorRows(ctx: Ctx, w: Who) {
  if (w.kind === "test") return w.test.events.filter((e: any) => e?.wrote).reduce((n: number, e: any) => n + e.wrote.length, 0);
  return (await ctx.db.query("formReplies").withIndex("by_pub_visitor", (q) => q.eq("publicationId", w.pub._id).eq("visitor", w.visitor)).collect()).length;
}

async function record(ctx: MutationCtx, w: Who, event: Record<string, unknown>) {
  if (w.kind !== "test") return;
  const t = (await ctx.db.get(w.test._id))!;
  if (t.events.length < 100) await ctx.db.patch(t._id, { events: [...t.events, { at: Date.now(), ...event }] });
}

function stats(list: Doc<"lists">, g: Grant, rows: Doc<"listRows">[]) {
  const cols = list.columns.filter((c) => c.type !== "person" && (!g.columns || g.columns.includes(c.key)));
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    const vals = rows.map((r) => r.cells[c.key]).filter((x) => x !== null && x !== undefined && x !== "");
    if (c.type === "number") {
      const ns = vals.map(Number).filter(Number.isFinite);
      const sum = ns.reduce((a, b) => a + b, 0);
      out[c.name] = { count: ns.length, sum, avg: ns.length ? Math.round((sum / ns.length) * 100) / 100 : null, min: ns.length ? Math.min(...ns) : null, max: ns.length ? Math.max(...ns) : null };
    } else if (c.type === "select" || c.type === "status" || c.type === "check") {
      const counts: Record<string, number> = {};
      for (const o of c.options ?? []) counts[o] = 0;
      for (const x of vals) counts[String(x)] = (counts[String(x)] ?? 0) + 1;
      out[c.name] = { count: vals.length, counts };
    } else if (c.type === "date") {
      const ds = vals.map(String).sort();
      out[c.name] = { count: ds.length, min: ds[0] ?? null, max: ds.at(-1) ?? null };
    } else out[c.name] = { count: vals.length };
  }
  return { rows: rows.length, columns: out };
}

/** POST /a/<slug|test>: append, mine, stats. Errors are messages the page (or the test) shows. */
export const apiData = internalMutation({
  args: { target: v.string(), token: v.string(), ip: v.string(), op: v.string(), list: v.optional(v.string()), row: v.optional(v.any()) },
  handler: async (ctx, a): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> => {
    const w = await authorize(ctx, a.target, a.token, a.ip, true);
    if (isErr(w)) return { ok: false, ...w };
    try {
      const g = grantOf(w, a.list);
      if (a.op === "append") {
        if (g.write !== "page") throw new OneBaseError(g.write === "handler" ? `«${a.list}» تُضاف إليها الصفوف من معالج الخادم فقط (onespace.call)` : `«${a.list}» لا تقبل الإضافة`);
        if (w.kind === "pub" && !w.signedIn && !(await ctx.components.limiter.limit({ name: "publicReplyPerPage", key: w.pub._id })).ok) return { ok: false, error: "طلبات كثيرة؛ حاول بعد دقيقة.", status: 429 };
        const r = await addRow(ctx, w, String(a.list), g, (a.row ?? {}) as Record<string, unknown>, "page");
        await record(ctx, w, { op: "append", list: a.list, ok: true, wrote: [r] });
        return { ok: true, value: { ok: true } };
      }
      if (a.op === "mine") {
        if (g.read !== "own") throw new OneBaseError(`«${a.list}» لا تسمح بقراءة الصفوف (read=${g.read})`);
        const list = await listFor(ctx, g);
        const keep = (cells: Record<string, unknown>) => Object.fromEntries(Object.entries(cells).filter(([k]) => k !== g.sender && list.columns.some((c) => c.key === k && c.type !== "person") && (!g.columns || g.columns.includes(k))));
        let rows: Record<string, unknown>[];
        if (w.kind === "test") {
          rows = w.test.events.flatMap((e: any) => (e?.wrote ?? []).filter((x: any) => x.list === a.list).map((x: any) => x.cells));
        } else {
          const mine = await ctx.db.query("formReplies").withIndex("by_pub_visitor", (q) => q.eq("publicationId", w.pub._id).eq("visitor", w.visitor)).collect();
          rows = [];
          for (const m of mine.slice(-200)) {
            const r = await ctx.db.get(m.rowId as Id<"listRows">);
            if (r && r.listId === list._id) rows.push(named(list, keep(r.cells)));
          }
        }
        await record(ctx, w, { op: "mine", list: a.list, ok: true, count: rows.length });
        return { ok: true, value: rows };
      }
      if (a.op === "stats") {
        if (g.read !== "aggregate") throw new OneBaseError(`«${a.list}» لا تسمح بالإحصاءات (read=${g.read})`);
        const list = await listFor(ctx, g);
        const rows = await ctx.db.query("listRows").withIndex("by_list", (q) => q.eq("listId", list._id)).collect();
        const value = stats(list, g, rows);
        await record(ctx, w, { op: "stats", list: a.list, ok: true });
        return { ok: true, value };
      }
      throw new OneBaseError(`عملية غير معروفة: ${a.op}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await record(ctx, w, { op: a.op, list: a.list, ok: false, error });
      return { ok: false, error, status: 400 };
    }
  },
});

/** POST /a/… op "call", step 1: who calls, and the handler's private files (server/ of the pinned version). */
export const handlerStart = internalMutation({
  args: { target: v.string(), token: v.string(), ip: v.string(), handler: v.string() },
  handler: async (ctx, a) => {
    const w = await authorize(ctx, a.target, a.token, a.ip, true);
    if (isErr(w)) return { ok: false as const, ...w };
    if (w.kind === "pub" && !w.signedIn && !(await ctx.components.limiter.limit({ name: "publicReplyPerPage", key: w.pub._id })).ok) return { ok: false as const, error: "طلبات كثيرة؛ حاول بعد دقيقة.", status: 429 };
    const app = w.kind === "test" ? await appVersion(ctx, w.test.artifactId, w.test.version) : await appVersion(ctx, w.pub.artifactId, w.pub.version);
    if (!app || !app.files[`server/${a.handler}.py`]) {
      const error = `لا يوجد معالج «${a.handler}» (server/${a.handler}.py). المعالجات: ${app ? handlersOf(app.files).join("، ") || "لا شيء" : "—"}`;
      await record(ctx, w, { op: "call", handler: a.handler, ok: false, error });
      return { ok: false as const, error, status: 404 };
    }
    const priv = Object.fromEntries(Object.entries(app.files).filter(([p]) => isPrivate(p)));
    return { ok: true as const, files: priv, visitor: { signedIn: w.signedIn, name: w.name, rows: await visitorRows(ctx, w) }, test: w.kind === "test" };
  },
});

/** Step 2: the handler's result. Its rows are written within the grants (all or none); the response goes back. */
export const handlerFinish = internalMutation({
  args: {
    target: v.string(),
    token: v.string(),
    handler: v.string(),
    payload: v.any(),
    outcome: v.union(
      v.object({ ok: v.literal(true), response: v.any(), rows: v.array(v.object({ list: v.string(), cells: v.record(v.string(), v.any()) })), durationMs: v.number(), stdout: v.string() }),
      v.object({ ok: v.literal(false), error: v.string(), trace: v.string(), durationMs: v.number() }),
    ),
  },
  handler: async (ctx, a): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> => {
    const w = await authorize(ctx, a.target, a.token, "", false);
    if (isErr(w)) return { ok: false, ...w };
    const clip = (x: unknown, n = 1500) => {
      const s = typeof x === "string" ? x : JSON.stringify(x ?? null);
      return s.length > n ? `${s.slice(0, n)}…` : s;
    };
    if (!a.outcome.ok) {
      await record(ctx, w, { op: "call", handler: a.handler, payload: clip(a.payload, 600), ok: false, error: a.outcome.error, trace: a.outcome.trace, ms: a.outcome.durationMs });
      // The visitor sees no trace; the test does.
      return { ok: false, error: w.kind === "test" ? `${a.outcome.error}\n${a.outcome.trace}` : "تعذّر إكمال الطلب.", status: 500 };
    }
    const out = a.outcome;
    try {
      // Check every row first, so a refused one writes nothing.
      for (const r of out.rows) {
        const g = grantOf(w, r.list);
        if (g.write === "none") throw new OneBaseError(`المعالج لا يملك الإضافة إلى «${r.list}» (write=none)`);
        grantedCells(await listFor(ctx, g), g, r.cells);
      }
      const wrote = [];
      for (const r of out.rows) wrote.push(await addRow(ctx, w, r.list, grantOf(w, r.list), r.cells, "handler"));
      await record(ctx, w, { op: "call", handler: a.handler, payload: clip(a.payload, 600), ok: true, response: clip(out.response), wrote, stdout: clip(out.stdout, 800), ms: out.durationMs });
      return { ok: true, value: out.response };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await record(ctx, w, { op: "call", handler: a.handler, payload: clip(a.payload, 600), ok: false, error: `صفوف المعالج رُفضت: ${error}`, response: clip(out.response) });
      return { ok: false, error: w.kind === "test" ? `صفوف المعالج رُفضت: ${error}` : "تعذّر إكمال الطلب.", status: 400 };
    }
  },
});

// ---------------------------------------------------------------- the side panel

/** The app panel: grants in words and handlers, for anyone who can read the app. */
export const info = query({
  args: { artifactId: v.string(), version: v.number() },
  handler: async (ctx, { artifactId, version }) => {
    const me = await requireActive(ctx);
    const art = await appOf(ctx, artifactId);
    await assertCan(ctx, me.userId, art.spaceId, "read");
    const app = await appVersion(ctx, art._id, version);
    return app ? { grants: await grantText(ctx, app.data), handlers: handlersOf(app.files) } : null;
  },
});

// ---------------------------------------------------------------- migration of plans/11 quiz forms

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The marking handler a migrated quiz gets: the same key, points and levels, as code the app owns. */
const MIGRATED_MARK_PY = `import json

def handle(request):
    key = json.load(open("key.json", encoding="utf-8"))
    answers = request.get("payload") or {}
    if key.get("onePerReader") and request["visitor"]["rows"] > 0:
        return {"response": {"error": "أرسلت إجاباتك من قبل. شكراً لك."}, "rows": []}
    score = sum(q["points"] for q in key["answers"] if answers.get(q["column"]) == q["correct"])
    total = sum(q["points"] for q in key["answers"])
    level = None
    for band in sorted(key["bands"], key=lambda b: -b["min"]):
        if score >= band["min"]:
            level = band["label"]
            break
    cells = {c: answers.get(c) for c in key["asked"] if answers.get(c) not in (None, "")}
    cells[key["scoreColumn"]] = score
    if key.get("levelColumn") and level:
        cells[key["levelColumn"]] = level
    shown = {"score": score, "max": total, "level": level} if key["showResult"] else {}
    return {"response": {"ok": True, "thanks": key["thanks"], **shown}, "rows": [{"list": "results", "cells": cells}]}
`;

const MIGRATED_JS = `const form = document.getElementById("quiz");
const out = document.getElementById("result");
const meta = onespace.json("questions.json");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const answers = {};
  for (const q of meta.questions) {
    const el = form.elements[q.id];
    const val = el ? (el.value || "") : "";
    if (q.required && !val) { out.textContent = "أكمل الحقول المطلوبة ثم أرسل."; return; }
    answers[q.name] = val;
  }
  form.querySelector("button").disabled = true;
  try {
    const r = await onespace.call("mark", answers);
    if (r.error) { out.textContent = r.error; return; }
    form.hidden = true;
    out.textContent = r.thanks + (r.score !== undefined ? " درجتك: " + r.score + " من " + r.max + (r.level ? " · المستوى: " + r.level : "") : "");
  } catch (err) {
    out.textContent = err.message;
    form.querySelector("button").disabled = false;
  }
});
`;

/** The files of a migrated quiz: the intro, the same questions as a form, and the key behind a handler. */
export function quizAppFiles(q: {
  title: string;
  introHtml: string;
  questions: { id: string; name: string; options: string[]; required: boolean }[];
  answers: { column: string; correct: string; points: number }[];
  bands: { min: number; label: string }[];
  scoreColumn: string;
  levelColumn?: string;
  showResult: boolean;
  onePerReader: boolean;
  thanks: string;
}): Record<string, string> {
  const field = (x: (typeof q.questions)[number]) =>
    `<label class="q"><span>${esc(x.name)}${x.required ? " *" : ""}</span>${
      x.options.length ? `<select name="${x.id}"><option value="">—</option>${x.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>` : `<textarea name="${x.id}"></textarea>`
    }</label>`;
  return {
    "index.html": `<!doctype html><html lang="ar" dir="rtl"><head><title>${esc(q.title)}</title><link rel="stylesheet" href="style.css"></head><body>${q.introHtml}<form id="quiz">${q.questions.map(field).join("")}<button type="submit">أرسل</button></form><p id="result"></p><script src="app.js"></script></body></html>`,
    "style.css": "body{font-family:system-ui,Tahoma,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;line-height:1.7}.q{display:block;margin:0 0 14px}.q span{display:block;font-weight:600}select,textarea{width:100%;padding:8px;font:inherit}button{padding:9px 20px;font:inherit}",
    "app.js": MIGRATED_JS,
    "questions.json": JSON.stringify({ questions: q.questions }),
    "server/mark.py": MIGRATED_MARK_PY,
    "server/key.json": JSON.stringify({
      answers: q.answers,
      bands: q.bands,
      asked: q.questions.map((x) => x.name),
      scoreColumn: q.scoreColumn,
      ...(q.levelColumn ? { levelColumn: q.levelColumn } : {}),
      showResult: q.showResult,
      onePerReader: q.onePerReader,
      thanks: q.thanks,
    }),
  };
}

/** One plans/11 quiz publication → an app with the same intro, questions, key and list (same slug). */
async function migrateOne(ctx: MutationCtx, p: Doc<"publications">) {
  const f = p.form!;
  const quiz = f.quiz as { answers: { key: string; correct: string; points: number }[]; scoreKey: string; levelKey?: string; bands: { min: number; label: string }[]; showResult: boolean };
  const list = await ctx.db.get(f.listId);
  const intro = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", p.artifactId).eq("version", p.version)).unique();
  const old = await ctx.db.get(p.artifactId);
  if (!list || !intro || !old) {
    await ctx.db.patch(p._id, { form: { ...f, quiz: undefined } });
    return;
  }
  const name = (k: string) => list.columns.find((c) => c.key === k)?.name ?? k;
  const asked = f.fields.map((x) => ({ ...list.columns.find((c) => c.key === x.key), required: x.required })).filter((c) => c.key && c.key !== quiz.scoreKey && c.key !== quiz.levelKey && c.type !== "person");
  const files = quizAppFiles({
    title: p.title,
    introHtml: old.kind === "html" ? intro.content : `<pre>${esc(intro.content)}</pre>`,
    questions: asked.map((c, i) => ({ id: `q${i + 1}`, name: c.name!, options: c.options ?? [], required: c.required })),
    answers: quiz.answers.map((x) => ({ column: name(x.key), correct: x.correct, points: x.points })),
    bands: quiz.bands,
    scoreColumn: name(quiz.scoreKey),
    ...(quiz.levelKey ? { levelColumn: name(quiz.levelKey) } : {}),
    showResult: quiz.showResult,
    onePerReader: f.onePerReader,
    thanks: f.thanks || "وصل ردك. شكراً لك.",
  });
  const grants: Record<string, Grant> = { results: { listId: list._id, write: "handler", read: "none", ...(f.senderKey ? { sender: f.senderKey } : {}) } };
  const artifactId = await insertArtifact(ctx, {
    spaceId: p.spaceId,
    ownerId: p.createdBy,
    kind: "app",
    title: p.title,
    content: serializeApp({ files, data: grants }),
    sources: [],
    classification: old.classification,
    originSpaceId: old.originSpaceId,
    via: "migrate-quiz",
  });
  // Earlier quiz replies count as this visitor's rows (once per reader keeps working).
  for (const r of await ctx.db.query("formReplies").withIndex("by_pub_user", (q) => q.eq("publicationId", p._id)).collect()) if (!r.anon && !r.visitor) await ctx.db.patch(r._id, { visitor: `u:${r.userId}` });
  await ctx.db.patch(p._id, { artifactId, version: 1, form: undefined, app: { grants, rows: f.replies }, updatedAt: Date.now() });
  await writeAudit(ctx, { userId: p.createdBy, action: "publish.migrate", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: { from: "quiz-form", artifactId } });
}

/** Cron: every remaining quiz publication becomes an app (a no-op once there are none). */
export const migrateQuizForms = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const p of await ctx.db.query("publications").collect()) {
      if (!p.form?.quiz || n >= 50) continue;
      await migrateOne(ctx, p);
      n++;
    }
    return n;
  },
});

