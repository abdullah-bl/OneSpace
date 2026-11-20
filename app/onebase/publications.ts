// «النشر» (plans/11, step 1): an output version at a fixed link, for the people of its space or the
// whole workspace. The page is served only from the content origin (PUBLISH_ORIGIN), a different
// origin from the app, under a sandbox CSP, so nothing on it runs with the reader's session.
//
// The reader's way in: the content origin has no session, so /p/<slug> there sends them to the app
// (#/open/<slug>), which checks access and issues a one-time ticket bound to that page and reader;
// the content origin trades it for a short cookie scoped to that page (publicationsHttp.ts).
//
// Who publishes: whoever can write in the output's space. A member's publication in a shared space
// waits for a manager; a manager's (and a personal space owner's) is live at once. A sensitive space
// or a sensitive output is never shown beyond its space.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, getWorkspace, requireActive, requireAdmin, roleAllows, spaceRoleOf } from "./access";
import { writeAudit } from "./audit";
import { appendFromForm, cleanListCells, ensureColumn, listPeople } from "./lists";
import { appPageFor, appVersion, checkGrantsForPublish, grantText, previewTest, publicAppToken } from "./apps";

type Ctx = QueryCtx | MutationCtx;
type Audience = "space" | "workspace" | "public";
const audienceV = v.union(v.literal("space"), v.literal("workspace"), v.literal("public"));

const TICKET_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 8 * 3_600_000;
const MAX_PER_ARTIFACT = 5;

export const hashToken = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
export const newToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const newSlug = () => newToken(9); // 12 url-safe characters

/** The content origin, e.g. https://p.example.gov.sa. Publishing is off without it (or if it is the app's own). */
export function publishOrigin(): string | null {
  const raw = process.env.PUBLISH_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const app = process.env.APP_ORIGIN?.trim();
    if (app && new URL(app).host === u.host) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Where the content origin sends a reader to sign in and get a ticket. */
export function appOrigin(): string | null {
  const raw = process.env.APP_ORIGIN?.trim();
  try {
    return raw ? new URL(raw).origin : null;
  } catch {
    return null;
  }
}

 /** The token the page's form posts: derived from the session, so it needs no extra storage per page load. */
const formTokenOf = (session: string) => hashToken(`form:${session}`);

const OFF = "النشر غير مفعّل على هذا الخادم: يحتاج PUBLISH_ORIGIN و APP_ORIGIN بنطاقين مختلفين.";

// ---------------------------------------------------------------- rules

async function artifactOf(ctx: Ctx, artifactId: string) {
  const id = ctx.db.normalizeId("artifacts", artifactId);
  const art = id ? await ctx.db.get(id) : null;
  if (!art) throw new Denied();
  return art;
}

/** A sensitive space, or an output built on one, stays inside its space. */
const sensitiveOf = (space: Doc<"spaces">, art: Doc<"artifacts">) => space.sensitive || art.classification === "sensitive";

/** Whether the admin allows pages for anyone with the link (off by default; turning it off closes them all). */
export async function publicAllowed(ctx: Ctx) {
  return (await getWorkspace(ctx))?.publicPublishing === true;
}

/** Who manages a publication: its creator, a manager of its space, or the personal space's owner. */
async function manages(ctx: Ctx, userId: Id<"users">, p: Doc<"publications">) {
  if (p.createdBy === userId) return true;
  const space = await ctx.db.get(p.spaceId);
  const role = space ? await spaceRoleOf(ctx, userId, space) : null;
  return role === "manager" || role === "owner";
}

async function pubOf(ctx: Ctx, publicationId: string) {
  const id = ctx.db.normalizeId("publications", publicationId);
  const p = id ? await ctx.db.get(id) : null;
  if (!p) throw new Denied();
  return p;
}

/**
 * Whether `userId` may read this publication right now: live, its output still there and in the same
 * space, and the reader allowed by the audience (the space's readers, or any active employee).
 */
export async function readerMay(ctx: Ctx, userId: Id<"users">, p: Doc<"publications">) {
  if (p.state !== "live") return false;
  const art = await ctx.db.get(p.artifactId);
  if (!art || art.spaceId !== p.spaceId) return false;
  const space = await ctx.db.get(p.spaceId);
  if (!space) return false;
  if (!(await actorFor(ctx, userId))) return false;
  if (p.audience === "workspace" && !sensitiveOf(space, art)) return true;
  if (p.audience === "public" && !sensitiveOf(space, art) && (await publicAllowed(ctx))) return true;
  return roleAllows(await spaceRoleOf(ctx, userId, space), "read");
}

/** A public page as anyone sees it: live, the policy on, its output still there and not sensitive. */
async function publicLive(ctx: Ctx, p: Doc<"publications">) {
  if (p.state !== "live" || p.audience !== "public" || !(await publicAllowed(ctx))) return false;
  const art = await ctx.db.get(p.artifactId);
  const space = await ctx.db.get(p.spaceId);
  return !!art && !!space && art.spaceId === p.spaceId && !sensitiveOf(space, art);
}

function shape(p: Doc<"publications">, current: number | null, origin: string | null, personal = false) {
  return {
    personal,
    _id: p._id,
    slug: p.slug,
    title: p.title,
    artifactId: p.artifactId,
    version: p.version,
    currentVersion: current,
    audience: p.audience,
    state: p.state,
    views: p.views,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    url: origin ? `${origin}/p/${p.slug}` : null,
    form: p.form
      ? {
          listId: p.form.listId,
          fields: p.form.fields,
          replies: p.form.replies,
          thanks: p.form.thanks ?? "",
          closesAt: p.form.closesAt ?? null,
          maxReplies: p.form.maxReplies ?? null,
          onePerReader: p.form.onePerReader,
          recordSender: !!p.form.senderKey,
        }
      : null,
    app: p.app ? { rows: p.app.rows } : null,
  };
}

/** The form's list title, for the publish box («يرسل الردود إلى …»); an app's grants in words. */
async function withListTitle<T extends { form: { listId: string } | null }>(ctx: Ctx, row: T, p?: Doc<"publications">) {
  const appGrants = p?.app ? await grantText(ctx, p.app.grants) : null;
  if (!row.form) return { ...row, listTitle: null as string | null, appGrants };
  const list = await ctx.db.get(row.form.listId as Id<"lists">);
  return { ...row, listTitle: list?.title ?? null, appGrants };
}

// ---------------------------------------------------------------- queries

/** The «انشر» dialog of an output: whether I may publish it, the audiences allowed, and its publications. */
export const forArtifact = query({
  args: { artifactId: v.string() },
  handler: async (ctx, { artifactId }) => {
    const me = await requireActive(ctx);
    const art = await artifactOf(ctx, artifactId);
    const { space, role } = await assertCan(ctx, me.userId, art.spaceId, "read");
    const rows = (await ctx.db.query("publications").withIndex("by_artifact", (q) => q.eq("artifactId", art._id)).collect()).filter((p) => p.state !== "revoked");
    const origin = publishOrigin();
    const out = [];
    for (const p of rows) if (p.createdBy === me.userId || (await manages(ctx, me.userId, p)) || p.state === "live") out.push(await withListTitle(ctx, { ...shape(p, art.currentVersion, origin, space.kind === "personal"), mine: await manages(ctx, me.userId, p) }, p));
    return {
      enabled: !!origin && !!appOrigin(),
      canPublish: roleAllows(role, "write"),
      needsApproval: space.kind === "shared" && role !== "manager",
      audiences: sensitiveOf(space, art) ? (["space"] as Audience[]) : ((await publicAllowed(ctx)) ? ["space", "workspace", "public"] : ["space", "workspace"]) as Audience[],
      spaceName: space.kind === "personal" ? "مساحتي" : space.name,
      personal: space.kind === "personal",
      publications: out,
      // An app (plans/13): what publishing its current version lets it do with lists.
      appGrants: art.kind === "app" ? await grantText(ctx, (await appVersion(ctx, art._id, art.currentVersion))?.data ?? {}) : null,
    };
  },
});

/** «منشوراتي»: what I published, and (for managers) what waits for my approval. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const origin = publishOrigin();
    const own = await ctx.db.query("publications").withIndex("by_creator", (q) => q.eq("createdBy", me.userId)).order("desc").take(200);
    const current = async (p: Doc<"publications">) => (await ctx.db.get(p.artifactId))?.currentVersion ?? null;
    const spaceName = async (p: Doc<"publications">) => {
      const s = await ctx.db.get(p.spaceId);
      return s ? (s.kind === "personal" ? "مساحتي" : s.name) : "";
    };
    const mineOut = [];
    for (const p of own) if (p.state !== "revoked") mineOut.push(await withListTitle(ctx, { ...shape(p, await current(p), origin, (await spaceName(p)) === "مساحتي"), spaceName: await spaceName(p) }, p));
    // Pending publications in spaces I manage.
    const pending = [];
    for (const m of await ctx.db.query("spaceMembers").withIndex("by_user", (q) => q.eq("userId", me.userId)).collect()) {
      if (m.role !== "manager") continue;
      const rows = await ctx.db.query("publications").withIndex("by_space", (q) => q.eq("spaceId", m.spaceId)).collect();
      for (const p of rows) {
        if (p.state !== "pending" || p.createdBy === me.userId) continue;
        const by = await ctx.db.get(p.createdBy);
        pending.push({ ...shape(p, await current(p), origin), spaceName: await spaceName(p), by: by?.name ?? by?.email ?? "", appGrants: p.app ? await grantText(ctx, p.app.grants) : null });
      }
    }
    return { enabled: !!origin && !!appOrigin(), mine: mineOut, pending };
  },
});

// ---------------------------------------------------------------- mutations

export const publish = mutation({
  args: { artifactId: v.string(), audience: audienceV },
  handler: async (ctx, { artifactId, audience }) => {
    const me = await requireActive(ctx);
    return publishArtifact(ctx, me.userId, artifactId, audience);
  },
});

/**
 * An app's grants for its publication, from the given version: its lists in its space, writable by
 * the publisher for writes (plans/13 §2). What the card showed is what goes live.
 */
async function appGrantsFor(ctx: MutationCtx, userId: Id<"users">, art: Doc<"artifacts">, version: number) {
  const app = await appVersion(ctx, art._id, version);
  if (!app) throw new OneBaseError("نسخة التطبيق غير موجودة");
  if (!app.files["index.html"]) throw new OneBaseError("التطبيق بلا index.html");
  await checkGrantsForPublish(ctx, userId, art.spaceId, app.data);
  return app.data;
}

async function publishArtifact(ctx: MutationCtx, userId: Id<"users">, artifactId: string, audience: Audience, scopeSpaceIds?: string[], pinned?: number) {
  {
    const me = { userId };
    if (!publishOrigin() || !appOrigin()) throw new OneBaseError(OFF);
    const art = await artifactOf(ctx, artifactId);
    if (scopeSpaceIds && !scopeSpaceIds.includes(art.spaceId)) throw new Denied();
    const { space, role } = await assertCan(ctx, me.userId, art.spaceId, "write");
    if (audience !== "space" && sensitiveOf(space, art)) throw new OneBaseError("مخرجات المساحات الحساسة لا تُنشر خارج مساحتها");
    if (audience === "public" && !(await publicAllowed(ctx))) throw new OneBaseError("النشر للعامة غير مسموح في مساحة العمل؛ يفعّله مدير المنصة من «نظرة عامة»");
    const existing = (await ctx.db.query("publications").withIndex("by_artifact", (q) => q.eq("artifactId", art._id)).collect()).filter((p) => p.state !== "revoked");
    if (existing.length >= MAX_PER_ARTIFACT) throw new OneBaseError(`الحد ${MAX_PER_ARTIFACT} روابط لكل مخرج`);
    const live = space.kind === "personal" || role === "manager";
    const version = pinned && pinned >= 1 && pinned <= art.currentVersion ? pinned : art.currentVersion;
    const grants = art.kind === "app" ? await appGrantsFor(ctx, me.userId, art, version) : null;
    const now = Date.now();
    let slug = newSlug();
    while (await ctx.db.query("publications").withIndex("by_slug", (q) => q.eq("slug", slug)).first()) slug = newSlug();
    const id = await ctx.db.insert("publications", {
      artifactId: art._id,
      version,
      slug,
      title: art.title,
      spaceId: space._id,
      audience,
      state: live ? "live" : "pending",
      createdBy: me.userId,
      ...(live ? { approvedBy: me.userId } : {}),
      views: 0,
      createdAt: now,
      updatedAt: now,
      ...(audience === "public" ? { formSecret: newToken() } : {}),
      ...(grants ? { app: { grants, rows: 0 } } : {}),
    });
    await writeAudit(ctx, { userId: me.userId, action: live ? "publish.create" : "publish.propose", resourceType: "publication", resourceId: id, spaceId: space._id, detail: { artifactId: art._id, version, audience, ...(grants ? { grants: Object.keys(grants).join(",") } : {}) } });
    return { id, state: live ? ("live" as const) : ("pending" as const), url: `${publishOrigin()}/p/${slug}`, spaceId: space._id as string };
  }
}

/** «حدّث المنشور»: show the output's current version. A member's update in a shared space waits for a manager again. */
export const update = mutation({
  args: { publicationId: v.string() },
  handler: async (ctx, { publicationId }) => {
    const me = await requireActive(ctx);
    const p = await pubOf(ctx, publicationId);
    if (p.state === "revoked" || !(await manages(ctx, me.userId, p))) throw new Denied();
    const art = await artifactOf(ctx, p.artifactId);
    if (art.spaceId !== p.spaceId) throw new OneBaseError("نُقل المخرج إلى مساحة أخرى؛ انشره من جديد");
    const { space, role } = await assertCan(ctx, me.userId, art.spaceId, "write");
    const live = space.kind === "personal" || role === "manager";
    const grants = art.kind === "app" ? await appGrantsFor(ctx, me.userId, art, art.currentVersion) : null;
    await ctx.db.patch(p._id, { version: art.currentVersion, title: art.title, state: live ? p.state : "pending", updatedAt: Date.now(), ...(grants ? { app: { grants, rows: p.app?.rows ?? 0 } } : {}) });
    await writeAudit(ctx, { userId: me.userId, action: "publish.update", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: { version: art.currentVersion } });
  },
});

export const review = mutation({
  args: { publicationId: v.string(), approve: v.boolean() },
  handler: async (ctx, { publicationId, approve }) => {
    const me = await requireActive(ctx);
    const p = await pubOf(ctx, publicationId);
    const space = await ctx.db.get(p.spaceId);
    if (!space || (await spaceRoleOf(ctx, me.userId, space)) !== "manager") throw new Denied();
    if (p.state !== "pending") throw new OneBaseError("ليس بانتظار الاعتماد");
    const now = Date.now();
    await ctx.db.patch(p._id, approve ? { state: "live", approvedBy: me.userId, updatedAt: now } : { state: "revoked", revokedAt: now, updatedAt: now });
    await writeAudit(ctx, { userId: me.userId, action: approve ? "publish.approve" : "publish.reject", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: {} });
  },
});

export const revoke = mutation({
  args: { publicationId: v.string() },
  handler: async (ctx, { publicationId }) => {
    const me = await requireActive(ctx);
    const p = await pubOf(ctx, publicationId);
    if (p.state === "revoked" || !(await manages(ctx, me.userId, p))) throw new Denied();
    await revokeRow(ctx, me.userId, p, "user");
  },
});

async function revokeRow(ctx: MutationCtx, userId: Id<"users">, p: Doc<"publications">, via: string) {
  const now = Date.now();
  await ctx.db.patch(p._id, { state: "revoked", revokedAt: now, updatedAt: now });
  for (const s of await ctx.db.query("publicationSessions").withIndex("by_expiry", (q) => q.gt("expiresAt", now)).collect()) if (s.publicationId === p._id) await ctx.db.delete(s._id);
  await writeAudit(ctx, { userId, action: "publish.revoke", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: via === "user" ? {} : { via } });
}

/** A deleted output takes its publications down (artifacts.deleteArtifactRows). */
export async function revokeForArtifact(ctx: MutationCtx, userId: Id<"users">, artifactId: Id<"artifacts">) {
  for (const p of await ctx.db.query("publications").withIndex("by_artifact", (q) => q.eq("artifactId", artifactId)).collect()) if (p.state !== "revoked") await revokeRow(ctx, userId, p, "artifact-deleted");
}

/**
 * #/open/<slug> in the app: the signed-in reader asks for a one-time ticket to that page. Missing,
 * forbidden and revoked pages answer alike.
 */
export const openTicket = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const me = await requireActive(ctx);
    const origin = publishOrigin();
    if (!origin) throw new Denied();
    const p = await ctx.db.query("publications").withIndex("by_slug", (q) => q.eq("slug", slug)).first();
    if (!p || !(await readerMay(ctx, me.userId, p))) throw new Denied();
    const token = newToken();
    await ctx.db.insert("publicationTickets", { tokenHash: hashToken(token), publicationId: p._id, userId: me.userId, expiresAt: Date.now() + TICKET_TTL_MS });
    return `${origin}/p/${p.slug}?t=${encodeURIComponent(token)}`;
  },
});

// ---------------------------------------------------------------- the content origin (publicationsHttp.ts)

/** A ticket for this page → a session token (the cookie). One use; bound to the page and the reader. */
export const redeemTicket = internalMutation({
  args: { slug: v.string(), token: v.string() },
  handler: async (ctx, { slug, token }) => {
    const t = await ctx.db.query("publicationTickets").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(token))).unique();
    if (!t) return null;
    await ctx.db.delete(t._id);
    if (t.expiresAt < Date.now()) return null;
    const p = await ctx.db.get(t.publicationId);
    if (!p || p.slug !== slug || !(await readerMay(ctx, t.userId, p))) return null;
    const session = newToken();
    await ctx.db.insert("publicationSessions", { tokenHash: hashToken(session), formTokenHash: hashToken(formTokenOf(session)), publicationId: p._id, userId: t.userId, expiresAt: Date.now() + SESSION_TTL_MS });
    return { session, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
  },
});

/** The page for a session cookie: access is checked again on every load; counts a view. */
export const pageForSession = internalMutation({
  args: { slug: v.string(), session: v.string(), preview: v.optional(v.boolean()) },
  handler: async (ctx, { slug, session, preview }) => {
    const s = await ctx.db.query("publicationSessions").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(session))).unique();
    if (!s || s.expiresAt < Date.now()) return null;
    const p = await ctx.db.get(s.publicationId);
    if (!p || p.slug !== slug || !(await readerMay(ctx, s.userId, p))) return null;
    const ver = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", p.artifactId).eq("version", p.version)).unique();
    const art = await ctx.db.get(p.artifactId);
    if (!ver || !art) return null;
    // «جرّب»: whoever manages the page sees the form open, and a reply saves nothing (submitForm).
    const previewing = !!preview && (await manages(ctx, s.userId, p));
    if (!previewing) await ctx.db.patch(p._id, { views: p.views + 1 });
    const space = await ctx.db.get(p.spaceId);
    if (art.kind === "app") {
      // An app (plans/13): its page parts and a token for its API. «جرّبها» runs it as a test (dry-run).
      const user = await ctx.db.get(s.userId);
      const name = user?.name ?? user?.email ?? null;
      const test = previewing ? await previewTest(ctx, s.userId, p) : null;
      const app = await appPageFor(ctx, p, { token: test ? test.token : formTokenOf(session), signedIn: true, name });
      if (!app) return null;
      return { title: p.title, kind: art.kind, content: "", spaceName: space?.kind === "personal" ? "" : (space?.name ?? ""), app: { ...app, test: !!test } };
    }
    const form = await formView(ctx, p, s.userId, formTokenOf(session));
    return {
      title: p.title,
      kind: art.kind,
      content: ver.content,
      spaceName: space?.kind === "personal" ? "" : (space?.name ?? ""),
      form: form && previewing ? { ...form, state: "open", preview: true } : form,
    };
  },
});

export const purgeTickets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const t of await ctx.db.query("publicationTickets").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(500)) await ctx.db.delete(t._id);
    for (const t of await ctx.db.query("publicationSessions").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(500)) await ctx.db.delete(t._id);
  },
});

// ---------------------------------------------------------------- forms (plans/11 step 2)

const THANKS_MAX = 500;
const REPLIES_PER_MINUTE = 10;
const DEFAULT_THANKS = "وصل ردك. شكراً لك.";

type FormState = "open" | "closed" | "full" | "answered";

/** Why a form takes no reply now (closed, full, already answered), or "open". */
async function formState(ctx: Ctx, p: Doc<"publications">, userId: Id<"users"> | null): Promise<FormState> {
  const f = p.form!;
  if (f.closesAt && f.closesAt < Date.now()) return "closed";
  if (f.maxReplies && f.replies >= f.maxReplies) return "full";
  if (!userId) return "open"; // an anonymous reader (public page): «once» is the browser's cookie (publicationsHttp.ts)
  if (f.onePerReader && (await ctx.db.query("formReplies").withIndex("by_pub_user", (q) => q.eq("publicationId", p._id).eq("userId", userId)).first())) return "answered";
  return "open";
}

/** What the content origin renders under the page: the fields (from the list's columns), the state, the token. */
async function formView(ctx: Ctx, p: Doc<"publications">, userId: Id<"users"> | null, token: string) {
  if (!p.form) return null;
  const list = await ctx.db.get(p.form.listId);
  if (!list) return null;
  const fields = p.form.fields
    .map((f) => ({ ...list.columns.find((c) => c.key === f.key), required: f.required }))
    .filter((c): c is (typeof list.columns)[number] & { required: boolean } => !!c.key && c.type !== "person");
  return { fields, state: await formState(ctx, p, userId), token, thanks: p.form.thanks || DEFAULT_THANKS };
}

/** The lists a publication's form may write to: those of its own space. */
export const formOptions = query({
  args: { publicationId: v.string() },
  handler: async (ctx, { publicationId }) => {
    const me = await requireActive(ctx);
    const p = await pubOf(ctx, publicationId);
    if (!(await manages(ctx, me.userId, p))) throw new Denied();
    const lists = await ctx.db.query("lists").withIndex("by_space", (q) => q.eq("spaceId", p.spaceId)).order("desc").collect();
    return lists.map((l) => ({ _id: l._id, title: l.title, columns: l.columns.filter((c) => c.type !== "person").map((c) => ({ key: c.key, name: c.name, type: c.type, options: c.options ?? [] })) }));
  },
});

const formInput = v.object({
  listId: v.string(),
  fields: v.array(v.object({ key: v.string(), required: v.boolean() })),
  recordSender: v.boolean(),
  thanks: v.optional(v.string()),
  closesAt: v.optional(v.number()),
  maxReplies: v.optional(v.number()),
  onePerReader: v.boolean(),
});

/** Attach, change or remove (form: null) a publication's form. The list must be in its space, and writable by me. */
export const setForm = mutation({
  args: { publicationId: v.string(), form: v.union(formInput, v.null()) },
  handler: async (ctx, { publicationId, form }) => {
    const me = await requireActive(ctx);
    const p = await pubOf(ctx, publicationId);
    if (p.state === "revoked" || !(await manages(ctx, me.userId, p))) throw new Denied();
    if (p.app) throw new OneBaseError("التطبيق يكتب في قوائمه بنفسه؛ النموذج للصفحات فقط");
    if (!form) {
      await ctx.db.patch(p._id, { form: undefined, updatedAt: Date.now() });
      await writeAudit(ctx, { userId: me.userId, action: "publish.form", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: { removed: true } });
      return;
    }
    await ctx.db.patch(p._id, { form: await cleanForm(ctx, me.userId, p, form), updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "publish.form", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: { listId: form.listId, fields: form.fields.length } });
  },
});

type FormInput = { listId: string; fields: { key: string; required: boolean }[]; recordSender: boolean; thanks?: string; closesAt?: number; maxReplies?: number; onePerReader: boolean };

async function cleanForm(ctx: MutationCtx, userId: Id<"users">, p: Doc<"publications">, form: FormInput) {
  const lid = ctx.db.normalizeId("lists", form.listId);
  const list = lid ? await ctx.db.get(lid) : null;
  if (!list || list.spaceId !== p.spaceId) throw new OneBaseError("اختر قائمة من مساحة المنشور نفسها");
  await assertCan(ctx, userId, list.spaceId, "write");
  const seen = new Set<string>();
  const fields = form.fields.filter((f) => {
    const col = list.columns.find((c) => c.key === f.key);
    if (!col || col.type === "person" || seen.has(f.key)) return false;
    seen.add(f.key);
    return true;
  });
  if (!fields.length) throw new OneBaseError("اختر حقلاً واحداً على الأقل");
  const senderKey = form.recordSender ? await ensureColumn(ctx, list, "المرسل", "person") : undefined;
  return {
    listId: list._id,
    fields,
    ...(senderKey ? { senderKey } : {}),
    ...(form.thanks?.trim() ? { thanks: form.thanks.trim().slice(0, THANKS_MAX) } : {}),
    ...(form.closesAt ? { closesAt: form.closesAt } : {}),
    ...(form.maxReplies && form.maxReplies > 0 ? { maxReplies: Math.min(Math.round(form.maxReplies), 100_000) } : {}),
    onePerReader: form.onePerReader,
    replies: p.form?.listId === list._id ? p.form.replies : 0,
  };
}

/** «نموذج ملاحظات»: a new list (التقييم 1–5, التعليق, المرسل) in the page's space, attached as its form. */
export const addFeedbackForm = mutation({
  args: { publicationId: v.string() },
  handler: async (ctx, { publicationId }) => {
    const me = await requireActive(ctx);
    const p = await pubOf(ctx, publicationId);
    if (p.state === "revoked" || !(await manages(ctx, me.userId, p))) throw new Denied();
    if (p.app) throw new OneBaseError("التطبيق يكتب في قوائمه بنفسه؛ النموذج للصفحات فقط");
    await assertCan(ctx, me.userId, p.spaceId, "write");
    const now = Date.now();
    const listId = await ctx.db.insert("lists", {
      spaceId: p.spaceId,
      ownerId: me.userId,
      title: `ملاحظات: ${p.title}`.slice(0, 120),
      description: "ردود نموذج الملاحظات المنشور مع الصفحة.",
      columns: [
        { key: "c1", name: "التقييم", type: "select", options: ["5 ممتاز", "4 جيد جداً", "3 جيد", "2 مقبول", "1 ضعيف"] },
        { key: "c2", name: "التعليق", type: "text" },
        { key: "c3", name: "المرسل", type: "person" },
      ],
      view: "table",
      nextKey: 4,
      rowCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, { userId: me.userId, action: "list.create", resourceType: "list", resourceId: listId, spaceId: p.spaceId, detail: { via: "feedback-form" } });
    await ctx.db.patch(p._id, {
      form: { listId, fields: [{ key: "c1", required: true }, { key: "c2", required: false }], senderKey: "c3", thanks: "شكراً على ملاحظاتك.", onePerReader: true, replies: 0 },
      updatedAt: now,
    });
    await writeAudit(ctx, { userId: me.userId, action: "publish.form", resourceType: "publication", resourceId: p._id, spaceId: p.spaceId, detail: { listId, preset: "feedback" } });
    return listId;
  },
});

/**
 * A reply's cells from the posted values: required fields, the same checks as the list page (types,
 * options, masking). An error code when it can't be taken.
 */
async function buildReply(ctx: MutationCtx, p: Doc<"publications">, values: Record<string, string>) {
  const form = p.form!;
  const list = await ctx.db.get(form.listId);
  if (!list) return "expired";
  const cells: Record<string, unknown> = {};
  for (const f of form.fields) {
    const col = list.columns.find((c) => c.key === f.key);
    if (!col || col.type === "person") continue;
    const raw = (values[f.key] ?? "").trim();
    if (f.required && !raw && col.type !== "check") return "required";
    cells[f.key] = col.type === "check" ? raw === "1" : raw || null;
  }
  try {
    // The reader needs no access to the list's space.
    cleanListCells(list.columns, cells, await listPeople(ctx, (await ctx.db.get(list.spaceId))!), false);
  } catch {
    return "invalid";
  }
  return { listId: list._id, cells };
}

/**
 * POST /f/<slug> (publicationsHttp.ts): the reader of an open page sends the form. The token comes from
 * the page (bound to the reader's session); access, the form's limits and each cell are checked here.
 * Returns an error code for the page to explain, or null when the row was added.
 */

export const submitForm = internalMutation({
  args: { slug: v.string(), token: v.string(), values: v.record(v.string(), v.string()), preview: v.optional(v.boolean()) },
  handler: async (ctx, { slug, token, values, preview }): Promise<string | null | { previewed: true }> => {
    const s = await ctx.db.query("publicationSessions").withIndex("by_form_hash", (q) => q.eq("formTokenHash", hashToken(token))).unique();
    if (!s || s.expiresAt < Date.now()) return "expired";
    const p = await ctx.db.get(s.publicationId);
    if (!p || p.slug !== slug || !p.form || !(await readerMay(ctx, s.userId, p))) return "expired";
    // A preview by whoever manages the page: checked like a reply, saved nowhere.
    const previewing = !!preview && (await manages(ctx, s.userId, p));
    const state = previewing ? "open" : await formState(ctx, p, s.userId);
    if (state !== "open") return state;
    const recent = await ctx.db.query("formReplies").withIndex("by_pub_user", (q) => q.eq("publicationId", p._id).eq("userId", s.userId).gt("at", Date.now() - 60_000)).collect();
    if (recent.length >= REPLIES_PER_MINUTE) return "busy";
    const built = await buildReply(ctx, p, values);
    if (typeof built === "string") return built;
    if (previewing) return { previewed: true as const };
    const rowId = await appendFromForm(ctx, built.listId, built.cells, s.userId, p.form.senderKey);
    await ctx.db.insert("formReplies", { publicationId: p._id, userId: s.userId, rowId, at: Date.now() });
    await ctx.db.patch(p._id, { form: { ...p.form, replies: p.form.replies + 1 } });
    return null;
  },
});

// ---------------------------------------------------------------- the assistant (tools/publish_output.ts)

/** «1) I ___ a student.» ≈ «I ___ a student» ≈ «i ___ a student:». */
const normName = (s: string) =>
  s
    .trim()
    .replace(/^\s*(?:س|q)?\s*\d+\s*[).:\-–]\s*/i, "")
    .replace(/[\s.:؟?!،,]+$/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

/** A column by its name as the model wrote it: exact, by key, then ignoring numbering and punctuation, then a unique partial match. */
export function findColumn<C extends { key: string; name: string }>(columns: C[], name: string): C | undefined {
  const n = name.trim();
  const exact = columns.find((c) => c.name === n) ?? columns.find((c) => c.key === n);
  if (exact) return exact;
  const want = normName(n);
  if (!want) return undefined;
  const same = columns.filter((c) => normName(c.name) === want);
  if (same.length === 1) return same[0];
  const part = columns.filter((c) => normName(c.name).includes(want) || want.includes(normName(c.name)));
  return part.length === 1 ? part[0] : undefined;
}

/**
 * publish_output: publish an output of this turn's scope at its pinned version (the card's), optionally
 * with a plain form bound to a list of the same space (columns by their names). An app publishes with
 * the grants of that version, which the card listed. Always a card first (tiers.ts default).
 */
export const publishFromTool = internalMutation({
  args: {
    userId: v.id("users"),
    scopeSpaceIds: v.array(v.string()),
    artifactId: v.string(),
    audience: audienceV,
    version: v.optional(v.number()),
    form: v.optional(
      v.object({
        listId: v.string(),
        questions: v.optional(v.array(v.string())),
        required: v.optional(v.boolean()),
        onePerReader: v.optional(v.boolean()),
        thanks: v.optional(v.string()),
      }),
    ),
  },
  // Errors are thrown, not returned: the whole publish (with its form) rolls back.
  handler: async (ctx, a) => {
    const r = await publishArtifact(ctx, a.userId, a.artifactId, a.audience, a.scopeSpaceIds, a.version);
    const p = (await ctx.db.get(r.id))!;
    let note = "";
    if (p.app) {
      if (a.form) throw new OneBaseError("التطبيق يكتب في قوائمه بنفسه (data في write_app)؛ لا تُرفق له form");
      const lines = await grantText(ctx, p.app.grants);
      note = lines.length ? ` صلاحيات التطبيق: ${lines.join("؛ ")}.` : " التطبيق لا يكتب في أي قائمة.";
    } else if (a.form) {
      const lid = ctx.db.normalizeId("lists", a.form.listId);
      const list = lid ? await ctx.db.get(lid) : null;
      if (!list) throw new OneBaseError("لا توجد قائمة بهذا المعرّف");
      const asked = (a.form.questions?.length ? a.form.questions.map((n) => findColumn(list.columns, n)) : list.columns).filter((c): c is (typeof list.columns)[number] => !!c && c.type !== "person");
      if (!asked.length) throw new OneBaseError("لم أجد أعمدة النموذج في القائمة");
      const form = await cleanForm(ctx, a.userId, p, {
        listId: list._id,
        fields: asked.map((c) => ({ key: c.key, required: a.form!.required ?? true })),
        recordSender: true,
        onePerReader: a.form.onePerReader ?? true,
        ...(a.form.thanks ? { thanks: a.form.thanks } : {}),
      });
      await ctx.db.patch(r.id, { form });
      note = ` مع نموذج تُحفظ ردوده في «${list.title}».`;
    }
    return { url: r.url, state: r.state, spaceId: r.spaceId, note, version: p.version };
  },
});

/** publish_output's card: what will be published (pinned version) and, for an app, its grants in words. */
export const publishPreview = internalQuery({
  args: { userId: v.id("users"), artifactId: v.string() },
  handler: async (ctx, { userId, artifactId }) => {
    const id = ctx.db.normalizeId("artifacts", artifactId);
    const art = id ? await ctx.db.get(id) : null;
    if (!art) return null;
    try {
      await assertCan(ctx, userId, art.spaceId, "read");
    } catch {
      return null;
    }
    const app = art.kind === "app" ? await appVersion(ctx, art._id, art.currentVersion) : null;
    return { version: art.currentVersion, title: art.title, kind: art.kind, grants: app ? await grantText(ctx, app.data) : null };
  },
});

// ---------------------------------------------------------------- public pages (plans/11 step 3)

/** «نظرة عامة»: the policy and how many public pages are live. */
export const publicPolicy = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const live = (await ctx.db.query("publications").collect()).filter((p) => p.audience === "public" && p.state === "live").length;
    return { allowed: await publicAllowed(ctx), live };
  },
});

export const setPublicPolicy = mutation({
  args: { allowed: v.boolean() },
  handler: async (ctx, { allowed }) => {
    const me = await requireAdmin(ctx);
    await ctx.db.patch(me.workspace._id, { publicPublishing: allowed });
    await writeAudit(ctx, { userId: me.userId, action: "publish.policy", resourceType: "workspace", resourceId: me.workspace._id, detail: { publicPublishing: allowed } });
  },
});

const HOUR = 3_600_000;
/** A public page's form token: from the page's secret and the hour, so it needs no session (valid ~1–2 h). */
const publicToken = (p: Doc<"publications">, hour = Math.floor(Date.now() / HOUR)) => hashToken(`${p.formSecret ?? p._id}:${hour}`);

/** GET /p/<slug> with no session: a public page for anyone, rate-limited per client address. */
export const publicPage = internalMutation({
  args: { slug: v.string(), ip: v.string() },
  handler: async (ctx, { slug, ip }) => {
    const p = await ctx.db.query("publications").withIndex("by_slug", (q) => q.eq("slug", slug)).first();
    if (!p || !(await publicLive(ctx, p))) return null;
    const { ok } = await ctx.components.limiter.limit({ name: "publicView", key: ip });
    if (!ok) return { busy: true as const };
    const ver = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", p.artifactId).eq("version", p.version)).unique();
    const art = await ctx.db.get(p.artifactId);
    if (!ver || !art) return null;
    await ctx.db.patch(p._id, { views: p.views + 1 });
    const space = await ctx.db.get(p.spaceId);
    const spaceName = space?.kind === "personal" ? "" : (space?.name ?? "");
    if (art.kind === "app") {
      // An anonymous visitor: a key for this page load, inside a token from the page's secret (apps.ts).
      const app = await appPageFor(ctx, p, { token: publicAppToken(p), signedIn: false, name: null });
      return app ? { title: p.title, kind: art.kind, content: "", spaceName, app: { ...app, test: false } } : null;
    }
    return { title: p.title, kind: art.kind, content: ver.content, spaceName, form: await formView(ctx, p, null, publicToken(p)) };
  },
});

/**
 * POST /f/<slug> on a public page: an anonymous reply. Limits per client address and per page;
 * the row is added as the publisher (nobody signed in), with no sender. `done`: the browser already
 * sent one (cookie) and the form takes one per reader.
 */
export const submitPublicForm = internalMutation({
  args: { slug: v.string(), token: v.string(), values: v.record(v.string(), v.string()), ip: v.string(), done: v.boolean() },
  handler: async (ctx, { slug, token, values, ip, done }): Promise<string | null> => {
    const p = await ctx.db.query("publications").withIndex("by_slug", (q) => q.eq("slug", slug)).first();
    if (!p || !p.form || !(await publicLive(ctx, p))) return "gone";
    const hour = Math.floor(Date.now() / HOUR);
    if (token !== publicToken(p, hour) && token !== publicToken(p, hour - 1)) return "stale";
    const state = await formState(ctx, p, null);
    if (state !== "open") return state;
    if (done && p.form.onePerReader) return "answered";
    if (!(await ctx.components.limiter.limit({ name: "publicReply", key: ip })).ok) return "busy";
    if (!(await ctx.components.limiter.limit({ name: "publicReplyPerPage", key: p._id })).ok) return "busy";
    const built = await buildReply(ctx, p, values);
    if (typeof built === "string") return built;
    const rowId = await appendFromForm(ctx, built.listId, built.cells, p.createdBy);
    await ctx.db.insert("formReplies", { publicationId: p._id, userId: p.createdBy, anon: true, rowId, at: Date.now() });
    await ctx.db.patch(p._id, { form: { ...p.form, replies: p.form.replies + 1 } });
    return null;
  },
});
