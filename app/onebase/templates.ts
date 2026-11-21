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
import { defaultLayout, parseLayout, renderPdf } from "./pdf";
import { pdfPageToPng } from "./lib/rasterize";
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
  args: {
    title: v.string(),
    fields: v.array(v.object({ key: v.string(), label: v.string() })),
    style: v.optional(v.union(v.literal("classic"), v.literal("centered"), v.literal("blank"))),
    page: v.optional(v.object({ width: v.number(), height: v.number() })),
  },
  handler: async (ctx, { title, fields, style, page }) => {
    await requireActive(ctx);
    const size = page && page.width >= 50 && page.width <= 3000 && page.height >= 50 && page.height <= 3000 ? { width: Math.round(page.width), height: Math.round(page.height) } : undefined;
    return JSON.stringify(defaultLayout(title.slice(0, 200), fields.slice(0, 30), style ?? "classic", size), null, 2);
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
  /** With templateId and no backgroundFileId: the new version keeps the current version's background. */
  keepBackground: v.optional(v.boolean()),
};

/** Saves a new template (or a new version of one). Space managers only; the version starts unapproved. */
export const saveVersion = action({
  args: versionArgs,
  handler: async (ctx, args): Promise<{ templateId: Id<"templates">; version: number }> => {
    const userId = await requireUserId(ctx);
    const checked = await ctx.runQuery(internal.templates.checkVersion, { userId, ...args });
    let body: { storageId: Id<"_storage">; sha256: string } | undefined;
    let fresh = false;
    if (checked.backgroundStorageId) {
      const blob = await ctx.storage.get(checked.backgroundStorageId);
      if (!blob) throw new OneBaseError("تعذّر قراءة ملف الخلفية");
      const bytes = await backgroundPdf(new Uint8Array(await blob.arrayBuffer()), checked.backgroundMime);
      // A private copy: the template must not change or disappear if the file is edited or deleted.
      const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      body = { storageId, sha256: sha256Hex(bytes) };
      fresh = true;
    } else if (checked.kept) {
      body = checked.kept; // the current version's private copy, shared (it never changes)
    }
    try {
      return await ctx.runMutation(internal.templates.insertVersion, { userId, ...args, backgroundFileId: undefined, keepBackground: undefined, body });
    } catch (e) {
      if (body && fresh) await ctx.storage.delete(body.storageId);
      throw e;
    }
  },
});

const BACKGROUND_MIMES = ["application/pdf", "image/png", "image/jpeg"];

/**
 * A background as a one-page PDF: a PDF is checked and kept as is; a PNG/JPEG design becomes a
 * page of its proportions (842 pt on the long side, like A4). Deterministic: same image, same PDF.
 */
export async function backgroundPdf(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (mime === "application/pdf") {
    try {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      if (pdf.getPageCount() < 1) throw new Error();
    } catch {
      throw new OneBaseError("ملف الخلفية يجب أن يكون PDF صالحاً");
    }
    return bytes;
  }
  if (mime !== "image/png" && mime !== "image/jpeg") throw new OneBaseError("الخلفية تكون PDF أو صورة PNG أو JPG");
  const doc = await PDFDocument.create({ updateMetadata: false });
  let img;
  try {
    img = mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    throw new OneBaseError("تعذّر قراءة صورة الخلفية");
  }
  const long = 842;
  const landscape = img.width >= img.height;
  const width = Math.round(landscape ? long : (long * img.width) / img.height);
  const height = Math.round(landscape ? (long * img.height) / img.width : long);
  const page = doc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });
  return await doc.save({ useObjectStreams: false });
}

/** Where a version's (or a preview's) background comes from: a file of the space, or the template's current version. */
async function backgroundSource(ctx: Ctx, space: Doc<"spaces">, a: { templateId?: Id<"templates">; backgroundFileId?: Id<"files">; keepBackground?: boolean }) {
  if (a.backgroundFileId) {
    const file = await ctx.db.get(a.backgroundFileId);
    if (!file || file.spaceId !== space._id) throw new OneBaseError("ملف الخلفية يجب أن يكون من ملفات هذه المساحة");
    if (!BACKGROUND_MIMES.includes(file.mime)) throw new OneBaseError("الخلفية تكون PDF أو صورة PNG أو JPG");
    return { backgroundStorageId: file.storageId, backgroundMime: file.mime, kept: null };
  }
  if (a.keepBackground && a.templateId) {
    const t = await loadTemplate(ctx, a.templateId);
    const current = await loadVersion(ctx, t._id, t.currentVersion);
    if (current.bodyStorageId && current.bodySha256) return { backgroundStorageId: null, backgroundMime: "", kept: { storageId: current.bodyStorageId, sha256: current.bodySha256 } };
  }
  return { backgroundStorageId: null, backgroundMime: "", kept: null };
}

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
  handler: async (ctx, { userId, backgroundFileId, keepBackground, ...a }) => {
    const space = await validateVersion(ctx, userId, a);
    return await backgroundSource(ctx, space, { templateId: a.templateId, backgroundFileId, keepBackground });
  },
});

export const insertVersion = internalMutation({
  args: { userId: v.id("users"), ...versionArgs, body: v.optional(v.object({ storageId: v.id("_storage"), sha256: v.string() })) },
  handler: async (ctx, { userId, backgroundFileId: _ignored, keepBackground: _kept, body, ...a }) => {
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

const SAMPLE = { serial: "OS-0000-000000", verifyCode: "XXXX-XXXX-XXXX" };

/**
 * The template editor's view of a design: the background alone (layout with no elements) or the
 * certificate as it will print, rendered by the same code as issuing (pdf.ts) with a real row
 * of the record set and a sample serial and code, as a PNG. Writes nothing. Space managers only.
 */
export const preview = action({
  args: {
    spaceId: v.id("spaces"),
    templateId: v.optional(v.id("templates")),
    backgroundFileId: v.optional(v.id("files")),
    keepBackground: v.optional(v.boolean()),
    layout: v.string(),
    fieldsSchema: v.array(v.object({ key: v.string(), label: v.string() })),
    dataBinding: v.optional(v.object({ recordSetId: v.id("recordSets"), fields: v.record(v.string(), v.string()) })),
  },
  handler: async (ctx, args): Promise<{ image: string | null; page: { width: number; height: number }; sample: Record<string, string>; error: string | null }> => {
    const userId = await requireUserId(ctx);
    const inp = await ctx.runQuery(internal.templates.previewInputs, { userId, ...args });
    let background: Uint8Array | null = null;
    if (inp.kept) {
      const blob = await ctx.storage.get(inp.kept.storageId);
      if (blob) background = new Uint8Array(await blob.arrayBuffer());
    } else if (inp.backgroundStorageId) {
      const blob = await ctx.storage.get(inp.backgroundStorageId);
      if (!blob) throw new OneBaseError("تعذّر قراءة ملف الخلفية");
      background = await backgroundPdf(new Uint8Array(await blob.arrayBuffer()), inp.backgroundMime);
    }
    let layout;
    try {
      layout = parseLayout(args.layout, args.fieldsSchema.map((f) => f.key));
    } catch (e) {
      return { image: null, page: { width: 842, height: 595 }, sample: inp.sample, error: e instanceof Error ? e.message : String(e) };
    }
    const bytes = await renderPdf({ layout, background, data: inp.sample, ...SAMPLE, issuedAt: Date.now(), title: "preview" });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const { width, height } = doc.getPage(0).getSize();
    const png = await pdfPageToPng(bytes);
    return { image: png ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : null, page: { width, height }, sample: inp.sample, error: png ? null : "تعذّر عرض المعاينة على الخادم" };
  },
});

export const previewInputs = internalQuery({
  args: {
    userId: v.id("users"),
    spaceId: v.id("spaces"),
    templateId: v.optional(v.id("templates")),
    backgroundFileId: v.optional(v.id("files")),
    keepBackground: v.optional(v.boolean()),
    layout: v.string(),
    fieldsSchema: v.array(v.object({ key: v.string(), label: v.string() })),
    dataBinding: v.optional(v.object({ recordSetId: v.id("recordSets"), fields: v.record(v.string(), v.string()) })),
  },
  handler: async (ctx, { userId, spaceId, templateId, backgroundFileId, keepBackground, fieldsSchema, dataBinding }) => {
    await requireActor(ctx, userId);
    const { space } = await assertCan(ctx, userId, spaceId, "manage");
    if (templateId && (await loadTemplate(ctx, templateId)).spaceId !== space._id) throw new Denied();
    const src = await backgroundSource(ctx, space, { templateId, backgroundFileId, keepBackground });
    // A real row: the first of the bound record set's current version, through the binding.
    const sample: Record<string, string> = {};
    for (const f of fieldsSchema) sample[f.key] = f.label;
    if (dataBinding) {
      const set = await ctx.db.get(dataBinding.recordSetId);
      if (!set || set.spaceId !== space._id) throw new OneBaseError("مجموعة السجلات يجب أن تكون في مساحة القالب");
      const row = set.currentVersion
        ? await ctx.db.query("records").withIndex("by_set_version", (q) => q.eq("recordSetId", set._id).eq("version", set.currentVersion)).first()
        : null;
      if (row) for (const f of fieldsSchema) {
        const v = row.data[dataBinding.fields[f.key] ?? ""];
        if (v !== null && v !== undefined) sample[f.key] = typeof v === "boolean" ? (v ? "نعم" : "لا") : String(v);
      }
    }
    return { ...src, sample };
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
