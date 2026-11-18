// Official document templates: written and approved by people (a space's managers), never by
// the model. A version = fixed layout JSON (+ optional fixed background PDF, kept as a private
// copy) + fields schema + binding of each field to a column of a record set in the same space.
// Every save is a new version; documents can only be drafted from the approved version.

import { OneBaseError, v } from "onebase/values";
import { PDFDocument } from "pdf-lib";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, requireActive, requireUserId } from "./access";
import { writeAudit } from "./audit";
import { requireActor } from "./artifacts";
import { defaultLayout, parseLayout } from "./pdf";
import { sha256Hex } from "./recordSources";

type Ctx = QueryCtx | MutationCtx;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

export async function loadTemplate(ctx: Ctx, templateId: string) {
  const id = ctx.db.normalizeId("templates", templateId);
  const t = id ? await ctx.db.get(id) : null;
  if (!t) throw new Denied();
  return t;
}

export async function loadVersion(ctx: Ctx, templateId: Id<"templates">, version: number) {
  const row = await ctx.db.query("templateVersions").withIndex("by_template_version", (q) => q.eq("templateId", templateId).eq("version", version)).unique();
  if (!row) throw new Denied();
  return row;
}

function shapeVersion(r: Doc<"templateVersions">) {
  return {
    version: r.version,
    layout: r.layout,
    hasBackground: Boolean(r.bodyStorageId),
    bodySha256: r.bodySha256 ?? null,
    fieldsSchema: r.fieldsSchema,
    dataBinding: r.dataBinding,
    sha256: r.sha256,
    createdAt: r.createdAt,
    approvedAt: r.approvedAt ?? null,
    approved: Boolean(r.approvedBy),
  };
}

export const list = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("templates").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
    const out = [];
    for (const t of rows) {
      const approved = t.approvedVersion ? await loadVersion(ctx, t._id, t.approvedVersion) : null;
      out.push({ _id: t._id, name: t.name, kind: t.kind, currentVersion: t.currentVersion, approvedVersion: t.approvedVersion ?? null, fieldsSchema: approved?.fieldsSchema ?? null, recordSetId: approved?.dataBinding.recordSetId ?? null });
    }
    return out;
  },
});

export const versions = query({
  args: { templateId: v.id("templates") },
  handler: async (ctx, { templateId }) => {
    const me = await requireActive(ctx);
    const t = await loadTemplate(ctx, templateId);
    await assertCan(ctx, me.userId, t.spaceId, "read");
    const rows = await ctx.db.query("templateVersions").withIndex("by_template_version", (q) => q.eq("templateId", t._id)).order("desc").collect();
    return { template: { _id: t._id, name: t.name, currentVersion: t.currentVersion, approvedVersion: t.approvedVersion ?? null }, versions: rows.map(shapeVersion) };
  },
});

/** A starting layout for the given fields (for the template editor). */
export const suggestLayout = query({
  args: { title: v.string(), fields: v.array(v.object({ key: v.string(), label: v.string() })) },
  handler: async (ctx, { title, fields }) => {
    await requireActive(ctx);
    return JSON.stringify(defaultLayout(title.slice(0, 200), fields.slice(0, 30)), null, 2);
  },
});

const versionArgs = {
  spaceId: v.id("spaces"),
  templateId: v.optional(v.id("templates")),
  name: v.string(),
  layout: v.string(),
  fieldsSchema: v.array(v.object({ key: v.string(), label: v.string() })),
  dataBinding: v.object({ recordSetId: v.id("recordSets"), fields: v.record(v.string(), v.string()) }),
  backgroundFileId: v.optional(v.id("files")),
};

/** Saves a new template (or a new version of one). Space managers only; the version starts unapproved. */
export const saveVersion = action({
  args: versionArgs,
  handler: async (ctx, args): Promise<{ templateId: Id<"templates">; version: number }> => {
    const userId = await requireUserId(ctx);
    const checked = await ctx.runQuery(internal.templates.checkVersion, { userId, ...args });
    let body: { storageId: Id<"_storage">; sha256: string } | undefined;
    if (checked.backgroundStorageId) {
      const blob = await ctx.storage.get(checked.backgroundStorageId);
      if (!blob) throw new OneBaseError("تعذّر قراءة ملف الخلفية");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
        if (pdf.getPageCount() < 1) throw new Error();
      } catch {
        throw new OneBaseError("ملف الخلفية يجب أن يكون PDF صالحاً");
      }
      // A private copy: the template must not change or disappear if the file is edited or deleted.
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "application/pdf" }));
      body = { storageId, sha256: sha256Hex(bytes) };
    }
    try {
      return await ctx.runMutation(internal.templates.insertVersion, { userId, ...args, backgroundFileId: undefined, body });
    } catch (e) {
      if (body) await ctx.storage.delete(body.storageId);
      throw e;
    }
  },
});

async function validateVersion(ctx: Ctx, userId: Id<"users">, a: { spaceId: Id<"spaces">; templateId?: Id<"templates">; name: string; layout: string; fieldsSchema: { key: string; label: string }[]; dataBinding: { recordSetId: Id<"recordSets">; fields: Record<string, string> } }) {
  await requireActor(ctx, userId);
  const { space } = await assertCan(ctx, userId, a.spaceId, "manage");
  if (space.kind !== "shared") throw new OneBaseError("القوالب تكون في مساحة مشتركة");
  if (a.templateId) {
    const t = await loadTemplate(ctx, a.templateId);
    if (t.spaceId !== space._id) throw new Denied();
  }
  if (!a.name.trim()) throw new OneBaseError("اكتب اسماً للقالب");
  if (a.fieldsSchema.length === 0 || a.fieldsSchema.length > 30) throw new OneBaseError("عرّف حقلاً واحداً على الأقل");
  const keys = new Set<string>();
  for (const f of a.fieldsSchema) {
    if (!KEY_RE.test(f.key) || keys.has(f.key)) throw new OneBaseError(`مفتاح حقل غير صالح أو مكرر: ${f.key}`);
    keys.add(f.key);
  }
  const set = await ctx.db.get(a.dataBinding.recordSetId);
  if (!set || set.spaceId !== space._id) throw new OneBaseError("مجموعة السجلات يجب أن تكون في مساحة القالب");
  for (const f of a.fieldsSchema) {
    const col = a.dataBinding.fields[f.key];
    if (!col || !set.columns.some((c) => c.key === col)) throw new OneBaseError(`الحقل "${f.label}" غير مربوط بعمود من السجلات`);
  }
  for (const k of Object.keys(a.dataBinding.fields)) if (!keys.has(k)) throw new OneBaseError(`ربط لحقل غير معرّف: ${k}`);
  try {
    parseLayout(a.layout, [...keys]);
  } catch (e) {
    throw new OneBaseError(e instanceof Error ? e.message : String(e));
  }
  return space;
}

export const checkVersion = internalQuery({
  args: { userId: v.id("users"), ...versionArgs },
  handler: async (ctx, { userId, backgroundFileId, ...a }) => {
    const space = await validateVersion(ctx, userId, a);
    let backgroundStorageId: Id<"_storage"> | null = null;
    if (backgroundFileId) {
      const file = await ctx.db.get(backgroundFileId);
      if (!file || file.spaceId !== space._id) throw new OneBaseError("ملف الخلفية يجب أن يكون من ملفات هذه المساحة");
      backgroundStorageId = file.storageId;
    }
    return { backgroundStorageId };
  },
});

export const insertVersion = internalMutation({
  args: { userId: v.id("users"), ...versionArgs, body: v.optional(v.object({ storageId: v.id("_storage"), sha256: v.string() })) },
  handler: async (ctx, { userId, backgroundFileId: _ignored, body, ...a }) => {
    const space = await validateVersion(ctx, userId, a);
    const actor = (await requireActor(ctx, userId))!;
    const now = Date.now();
    let templateId = a.templateId;
    let version = 1;
    if (templateId) {
      const t = (await ctx.db.get(templateId))!;
      version = t.currentVersion + 1;
      await ctx.db.patch(templateId, { currentVersion: version, name: a.name.trim() });
    } else {
      templateId = await ctx.db.insert("templates", { workspaceId: actor.workspace._id, spaceId: space._id, name: a.name.trim(), kind: "certificate", currentVersion: 1, createdBy: userId, createdAt: now });
    }
    const definition = JSON.stringify({ layout: a.layout, fieldsSchema: a.fieldsSchema, dataBinding: a.dataBinding, body: body?.sha256 ?? null });
    await ctx.db.insert("templateVersions", {
      templateId,
      version,
      layout: a.layout,
      bodyStorageId: body?.storageId,
      bodySha256: body?.sha256,
      fieldsSchema: a.fieldsSchema,
      dataBinding: a.dataBinding,
      sha256: sha256Hex(definition),
      createdBy: userId,
      createdAt: now,
    });
    await writeAudit(ctx, { userId, action: "template.version", resourceType: "template", resourceId: templateId, spaceId: space._id, detail: { name: a.name.trim(), version } });
    return { templateId, version };
  },
});

/** Approves one version for use. Space managers only; recorded with who and when. */
export const approveVersion = mutation({
  args: { templateId: v.id("templates"), version: v.number() },
  handler: async (ctx, { templateId, version }) => {
    const me = await requireActive(ctx);
    const t = await loadTemplate(ctx, templateId);
    await assertCan(ctx, me.userId, t.spaceId, "manage");
    const row = await loadVersion(ctx, t._id, version);
    if (!row.approvedBy) await ctx.db.patch(row._id, { approvedBy: me.userId, approvedAt: Date.now() });
    await ctx.db.patch(t._id, { approvedVersion: version });
    await writeAudit(ctx, { userId: me.userId, action: "template.approve", resourceType: "template", resourceId: t._id, spaceId: t.spaceId, detail: { name: t.name, version } });
  },
});
