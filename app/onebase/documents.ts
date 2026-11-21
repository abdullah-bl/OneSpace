// Official documents: draft -> approval by a space manager -> issue.
//
// - A draft is created from (approved template, record) only. Its data is copied from the
//   record by code, field by field through the template's binding; nothing a person or the
//   model types can reach the document. The agent's fill_template tool takes two ids and nothing else.
// - Approval is a separate act by a manager of the template's space, recorded (approvedBy/At).
// - Issue assigns a serial number, a verification code and the issue time once, renders the PDF
//   deterministically (pdf.ts) and stores its sha256. Rendering the same document again gives
//   the same bytes; drafting the same (template version, record, data) again returns the same
//   document instead of a second one.
// - Anyone can check a document: GET /verify?code=… or POST /verify with the PDF (http.ts).

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, requireActive, requireUserId, roleAllows, spaceRoleOf, type Actor } from "./access";
import { writeAudit } from "./audit";
import { requireActor } from "./artifacts";
import { identityOf, loadSet } from "./records";
import { sha256Hex } from "./recordSources";
import { loadTemplate, loadVersion, reservedValues } from "./templates";
import { isoDate, parseLayout, renderPdf, type RenderInput } from "./pdf";
import { DocxError, docxToPdf, fillDocx } from "./lib/docxTemplate";

type Ctx = QueryCtx | MutationCtx;
const TICKET_TTL_MS = 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function hashToken(token: string) {
  return sha256Hex(token);
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  return String(v);
}

async function loadDoc(ctx: Ctx, documentId: string) {
  const id = ctx.db.normalizeId("issuedDocuments", documentId);
  const d = id ? await ctx.db.get(id) : null;
  if (!d) throw new Denied();
  return d;
}

/** The subject of a document (matched by the account's admin-set identifier) may read it too. */
async function isSubject(ctx: Ctx, actor: Actor, d: Doc<"issuedDocuments">) {
  const ids = identityOf(actor.user);
  return d.workspaceId === actor.workspace._id && d.status === "issued" && ((d.subjectKind === "nationalId" && ids.nationalId === d.subjectRef) || (d.subjectKind === "employeeNo" && ids.employeeNo === d.subjectRef));
}

/**
 * Creates (or returns the existing) draft for an approved template and a record. The data comes
 * from the record through the template's binding; the caller supplies ids only.
 */
export async function requestDocument(ctx: MutationCtx, actor: Actor, templateId: string, recordId: string, opts: { scope: Set<string> | null; threadId?: string; via: string }) {
  const t = await loadTemplate(ctx, templateId);
  await assertCan(ctx, actor.userId, t.spaceId, "write");
  if (opts.scope && !opts.scope.has(t.spaceId)) throw new Denied();
  if (!t.approvedVersion) throw new OneBaseError("لا توجد نسخة معتمدة من هذا القالب");
  const tv = await loadVersion(ctx, t._id, t.approvedVersion);
  const rid = ctx.db.normalizeId("records", recordId);
  const record = rid ? await ctx.db.get(rid) : null;
  if (!record || record.recordSetId !== tv.dataBinding.recordSetId) throw new OneBaseError("السجل غير موجود في مجموعة السجلات المربوطة بالقالب");
  const set = await loadSet(ctx, record.recordSetId);
  await assertCan(ctx, actor.userId, set.spaceId, "read");
  if (record.version !== set.currentVersion) throw new OneBaseError("هذا السجل من نسخة استيراد قديمة");
  const data: Record<string, string> = {};
  for (const f of tv.fieldsSchema) data[f.key] = cellText(record.data[tv.dataBinding.fields[f.key]!]);
  const dataHash = sha256Hex(JSON.stringify(Object.keys(data).sort().map((k) => [k, data[k]])));
  const existing = (await ctx.db.query("issuedDocuments").withIndex("by_key", (q) => q.eq("templateId", t._id).eq("templateVersion", tv.version).eq("recordId", record._id).eq("dataHash", dataHash)).collect()).find((d) => d.status !== "rejected");
  if (existing) return { documentId: existing._id, status: existing.status, data: existing.data, existing: true, serial: existing.serial ?? null };
  const documentId = await ctx.db.insert("issuedDocuments", {
    workspaceId: actor.workspace._id,
    spaceId: t.spaceId,
    templateId: t._id,
    templateVersion: tv.version,
    recordSetId: set._id,
    recordId: record._id,
    recordVersion: record.version,
    subjectKind: set.subjectKind,
    subjectRef: record.subjectRef,
    data,
    dataHash,
    status: "draft",
    requestedBy: actor.userId,
    requestedAt: Date.now(),
    threadId: opts.threadId,
  });
  await writeAudit(ctx, { userId: actor.userId, action: "document.request", resourceType: "document", resourceId: documentId, spaceId: t.spaceId, detail: { name: t.name, templateVersion: tv.version, via: opts.via } });
  return { documentId, status: "draft" as const, data, existing: false, serial: null };
}

function shape(d: Doc<"issuedDocuments">, names: { template: string; requestedBy: string | null; approvedBy: string | null; issuedBy: string | null }) {
  return {
    _id: d._id,
    templateId: d.templateId,
    templateName: names.template,
    templateVersion: d.templateVersion,
    status: d.status,
    data: d.data,
    subjectRef: d.subjectRef,
    requestedAt: d.requestedAt,
    requestedByName: names.requestedBy,
    approvedByName: names.approvedBy,
    approvedAt: d.approvedAt ?? null,
    issuedByName: names.issuedBy,
    issuedAt: d.issuedAt ?? null,
    serial: d.serial ?? null,
    verifyCode: d.verifyCode ?? null,
    sha256: d.sha256 ?? null,
  };
}

// ---------- public ----------

export const list = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("issuedDocuments").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).order("desc").take(500);
    const cache = new Map<string, string | null>();
    const name = async (id: Id<"users"> | Id<"templates"> | undefined) => {
      if (!id) return null;
      if (!cache.has(id)) {
        const doc: any = await ctx.db.get(id as any);
        cache.set(id, doc?.name ?? doc?.email ?? null);
      }
      return cache.get(id)!;
    };
    const out = [];
    for (const d of rows) out.push(shape(d, { template: (await name(d.templateId)) ?? "", requestedBy: await name(d.requestedBy), approvedBy: await name(d.approvedBy), issuedBy: await name(d.issuedBy) }));
    return out;
  },
});

/** Drafts a document from the UI (members with write access to the template's space). */
export const request = mutation({
  args: { templateId: v.id("templates"), recordId: v.id("records") },
  handler: async (ctx, { templateId, recordId }) => {
    const me = await requireActive(ctx);
    return await requestDocument(ctx, me, templateId, recordId, { scope: null, via: "ui" });
  },
});

/** Human approval, by a manager of the template's space. Recorded in the document and the audit log. */
export const approve = mutation({
  args: { documentId: v.id("issuedDocuments") },
  handler: async (ctx, { documentId }) => {
    const me = await requireActive(ctx);
    const d = await loadDoc(ctx, documentId);
    await assertCan(ctx, me.userId, d.spaceId, "manage");
    if (d.status !== "draft") throw new OneBaseError("المستند ليس مسودة");
    await ctx.db.patch(d._id, { status: "approved", approvedBy: me.userId, approvedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "document.approve", resourceType: "document", resourceId: d._id, spaceId: d.spaceId, detail: { templateVersion: d.templateVersion } });
  },
});

export const reject = mutation({
  args: { documentId: v.id("issuedDocuments") },
  handler: async (ctx, { documentId }) => {
    const me = await requireActive(ctx);
    const d = await loadDoc(ctx, documentId);
    await assertCan(ctx, me.userId, d.spaceId, "manage");
    if (d.status !== "draft" && d.status !== "approved") throw new OneBaseError("لا يمكن رفض مستند صادر");
    await ctx.db.patch(d._id, { status: "rejected", rejectedBy: me.userId });
    await writeAudit(ctx, { userId: me.userId, action: "document.reject", resourceType: "document", resourceId: d._id, spaceId: d.spaceId });
  },
});

/** Issues an approved document: serial, verification code, deterministic PDF, sha256. */
export const issue = action({
  args: { documentId: v.id("issuedDocuments") },
  handler: async (ctx, { documentId }): Promise<{ serial: string; sha256: string; verifyCode: string }> => {
    const userId = await requireUserId(ctx);
    const prep: any = await ctx.runMutation(internal.documents.beginIssue, { userId, documentId });
    if (prep.done) return prep.done;
    const bytes = await renderFrom(ctx, prep);
    const sha256 = sha256Hex(bytes);
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const res: any = await ctx.runMutation(internal.documents.finishIssue, { userId, documentId, storageId, sha256, size: bytes.byteLength });
    if (res.duplicate) await ctx.storage.delete(storageId);
    return res.result;
  },
});

const BATCH_MAX = 200;

/**
 * The current rows of a template's record set, each with the state of its document for the
 * approved version: none, draft, approved or issued. What «أصدر» works from, and how the page
 * knows how many rows still have no certificate (e.g. after an import). Members who can read
 * both the template's space and the set's.
 */
export const rowsForTemplate = query({
  args: { templateId: v.id("templates") },
  handler: async (ctx, { templateId }) => {
    const me = await requireActive(ctx);
    const t = await loadTemplate(ctx, templateId);
    await assertCan(ctx, me.userId, t.spaceId, "read");
    if (!t.approvedVersion) return { fields: [], rows: [], counts: { none: 0, draft: 0, approved: 0, issued: 0 } };
    const tv = await loadVersion(ctx, t._id, t.approvedVersion);
    const set = await loadSet(ctx, tv.dataBinding.recordSetId);
    await assertCan(ctx, me.userId, set.spaceId, "read");
    const records = set.currentVersion
      ? await ctx.db.query("records").withIndex("by_set_version", (q) => q.eq("recordSetId", set._id).eq("version", set.currentVersion)).collect()
      : [];
    const docs = (await ctx.db.query("issuedDocuments").withIndex("by_space", (q) => q.eq("spaceId", t.spaceId)).collect()).filter((d) => d.templateId === t._id && d.templateVersion === tv.version && d.status !== "rejected");
    // A record keeps its id across nothing: a re-import creates new rows. Match on the subject and the bound data too.
    const rank = { issued: 3, approved: 2, draft: 1 } as const;
    const counts = { none: 0, draft: 0, approved: 0, issued: 0 };
    const rows = records.map((r) => {
      const data: Record<string, string> = {};
      for (const f of tv.fieldsSchema) data[f.key] = cellText(r.data[tv.dataBinding.fields[f.key]!]);
      const mine = docs.filter((d) => d.recordId === r._id || (d.subjectRef === r.subjectRef && JSON.stringify(d.data) === JSON.stringify(data)));
      const best = mine.sort((a, b) => rank[b.status as keyof typeof rank] - rank[a.status as keyof typeof rank])[0];
      const status = (best?.status ?? "none") as keyof typeof counts;
      counts[status]++;
      return { recordId: r._id, rowNo: r.rowNo, subjectRef: r.subjectRef, data, status, documentId: best?._id ?? null, serial: best?.serial ?? null };
    });
    return { fields: tv.fieldsSchema, rows, counts };
  },
});

/** Drafts for many records at once (existing documents are returned, not duplicated). Writers of the template's space. */
export const requestMany = mutation({
  args: { templateId: v.id("templates"), recordIds: v.array(v.id("records")) },
  handler: async (ctx, { templateId, recordIds }) => {
    const me = await requireActive(ctx);
    if (recordIds.length > BATCH_MAX) throw new OneBaseError(`الحد ${BATCH_MAX} مستنداً في الدفعة الواحدة`);
    const out: { documentId: Id<"issuedDocuments">; status: string; existing: boolean }[] = [];
    for (const recordId of new Set(recordIds)) {
      const r = await requestDocument(ctx, me, templateId, recordId, { scope: null, via: "ui-batch" });
      out.push({ documentId: r.documentId, status: r.status, existing: r.existing });
    }
    return { documents: out, created: out.filter((d) => !d.existing).length };
  },
});

/**
 * Approval and issue in one act, for one document or a batch: a manager of the space approves
 * (recorded, audited, per document) and each is issued at once. Already-issued documents are
 * returned as they are; a document that can't be issued is reported and the rest go on.
 */
export const approveAndIssue = action({
  args: { documentIds: v.array(v.id("issuedDocuments")) },
  handler: async (ctx, { documentIds }): Promise<{ issued: { documentId: string; serial: string; verifyCode: string }[]; failed: { documentId: string; error: string }[] }> => {
    const userId = await requireUserId(ctx);
    if (documentIds.length > BATCH_MAX) throw new OneBaseError(`الحد ${BATCH_MAX} مستنداً في الدفعة الواحدة`);
    // Every document must be in a space the caller manages, checked before anything is approved.
    await ctx.runQuery(internal.documents.checkManagesAll, { userId, documentIds });
    const issued: { documentId: string; serial: string; verifyCode: string }[] = [];
    const failed: { documentId: string; error: string }[] = [];
    for (const documentId of new Set(documentIds)) {
      try {
        await ctx.runMutation(internal.documents.approveAsManager, { userId, documentId });
        const prep: any = await ctx.runMutation(internal.documents.beginIssue, { userId, documentId });
        let result: { serial: string; verifyCode: string };
        if (prep.done) result = prep.done;
        else {
          const bytes = await renderFrom(ctx, prep);
          const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
          const res: any = await ctx.runMutation(internal.documents.finishIssue, { userId, documentId, storageId, sha256: sha256Hex(bytes), size: bytes.byteLength });
          if (res.duplicate) await ctx.storage.delete(storageId);
          result = res.result;
        }
        issued.push({ documentId, serial: result.serial, verifyCode: result.verifyCode });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        failed.push({ documentId, error: m.replace(/^.*Uncaught (OneBaseError: )?/, "").replace(/^\[.*?\]\s*/, "").split("\n")[0]! });
      }
    }
    return { issued, failed };
  },
});

async function renderFrom(
  ctx: { storage: { get(id: Id<"_storage">): Promise<Blob | null> } },
  prep: { layout: string; fieldKeys: string[]; docxStorageId?: Id<"_storage"> | null; fieldLabels?: Record<string, string>; bodyStorageId: Id<"_storage"> | null; data: Record<string, string>; serial: string; verifyCode: string; issuedAt: number; title: string },
) {
  if (prep.docxStorageId) {
    // Word template (plans/17 §3): variables filled by code, LibreOffice makes the PDF.
    const blob = await ctx.storage.get(prep.docxStorageId);
    if (!blob) throw new OneBaseError("ملف القالب مفقود");
    const values = reservedValues(prep.serial, prep.verifyCode, isoDate(prep.issuedAt));
    for (const [key, label] of Object.entries(prep.fieldLabels ?? {})) values[label] = prep.data[key] ?? "";
    try {
      return await docxToPdf(await fillDocx(new Uint8Array(await blob.arrayBuffer()), values));
    } catch (e) {
      throw new OneBaseError(e instanceof DocxError ? e.message : "تعذّر إنشاء ملف PDF من قالب وورد");
    }
  }
  let background: Uint8Array | null = null;
  if (prep.bodyStorageId) {
    const blob = await ctx.storage.get(prep.bodyStorageId);
    if (!blob) throw new OneBaseError("ملف خلفية القالب مفقود");
    background = new Uint8Array(await blob.arrayBuffer());
  }
  const input: RenderInput = { layout: parseLayout(prep.layout, prep.fieldKeys), background, data: prep.data, serial: prep.serial, verifyCode: prep.verifyCode, issuedAt: prep.issuedAt, title: prep.title };
  return await renderPdf(input);
}

/**
 * Renders an issued document again from its stored inputs and compares with the stored sha256.
 * Members of the space only. Proves the file can be reproduced byte for byte.
 */
export const reproduce = action({
  args: { documentId: v.id("issuedDocuments") },
  handler: async (ctx, { documentId }): Promise<{ sha256: string; stored: string; identical: boolean }> => {
    const userId = await requireUserId(ctx);
    const prep: any = await ctx.runQuery(internal.documents.renderInputFor, { userId, documentId });
    // LibreOffice doesn't write the same bytes twice: a Word certificate is verified by its stored file and sha256.
    if (prep.docxStorageId) throw new OneBaseError("إعادة التوليد حرفياً متاحة لقوالب التخطيط فقط. شهادات قوالب وورد يُتحقق منها بملفها المحفوظ وبصمته");
    const bytes = await renderFrom(ctx, prep);
    const sha256 = sha256Hex(bytes);
    return { sha256, stored: prep.sha256, identical: sha256 === prep.sha256 };
  },
});

/** A one-time link to the PDF (60 s), for members of the space and for the document's subject. */
export const requestDownload = mutation({
  args: { documentId: v.id("issuedDocuments") },
  handler: async (ctx, { documentId }) => {
    const me = await requireActive(ctx);
    const d = await loadDoc(ctx, documentId);
    await authorizeRead(ctx, me, d);
    if (d.status !== "issued" || !d.storageId) throw new OneBaseError("المستند لم يصدر بعد");
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await ctx.db.insert("documentTickets", { tokenHash: hashToken(token), userId: me.userId, documentId: d._id, expiresAt: Date.now() + TICKET_TTL_MS });
    return `/document?t=${token}`;
  },
});

async function authorizeRead(ctx: Ctx, actor: Actor, d: Doc<"issuedDocuments">) {
  const space = await ctx.db.get(d.spaceId);
  const role = space ? await spaceRoleOf(ctx, actor.userId, space, actor) : null;
  if (roleAllows(role, "read")) return space!;
  if (await isSubject(ctx, actor, d)) return space!;
  throw new Denied();
}

/** Public verification by code: no sign-in, minimal facts (no personal data beyond what's printed on the document's face is returned). */
export const verify = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    return await verifyByCode(ctx, code);
  },
});

export async function verifyByCode(ctx: Ctx, code: string) {
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 12) return { valid: false as const };
  const formatted = `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
  const d = await ctx.db.query("issuedDocuments").withIndex("by_code", (q) => q.eq("verifyCode", formatted)).unique();
  if (!d || d.status !== "issued") return { valid: false as const };
  return publicFacts(ctx, d);
}

async function publicFacts(ctx: Ctx, d: Doc<"issuedDocuments">) {
  const t = await ctx.db.get(d.templateId);
  return { valid: true as const, serial: d.serial!, templateName: t?.name ?? "", issuedAt: d.issuedAt!, sha256: d.sha256!, verifyCode: d.verifyCode! };
}

// ---------- internal ----------

export const requestForUser = internalMutation({
  args: { userId: v.id("users"), scopeSpaceIds: v.array(v.string()), templateId: v.string(), recordId: v.string(), threadId: v.optional(v.string()) },
  handler: async (ctx, { userId, scopeSpaceIds, templateId, recordId, threadId }) => {
    const actor = await requireActor(ctx, userId);
    return await requestDocument(ctx, actor, templateId, recordId, { scope: new Set(scopeSpaceIds), threadId, via: "agent" });
  },
});

async function prepFor(ctx: Ctx, d: Doc<"issuedDocuments">) {
  const t = await ctx.db.get(d.templateId);
  if (!t) throw new Denied();
  const tv = await loadVersion(ctx, t._id, d.templateVersion);
  return {
    layout: tv.layout,
    fieldKeys: tv.fieldsSchema.map((f) => f.key),
    // A Word template: the file, and each field's variable name (its label) for filling.
    docxStorageId: tv.docxStorageId ?? null,
    fieldLabels: Object.fromEntries(tv.fieldsSchema.map((f) => [f.key, f.label])),
    bodyStorageId: tv.bodyStorageId ?? null,
    data: d.data,
    serial: d.serial!,
    verifyCode: d.verifyCode!,
    issuedAt: d.issuedAt!,
    title: `${t.name} ${d.serial}`,
  };
}

export const checkManagesAll = internalQuery({
  args: { userId: v.id("users"), documentIds: v.array(v.id("issuedDocuments")) },
  handler: async (ctx, { userId, documentIds }) => {
    await requireActor(ctx, userId);
    for (const id of documentIds) {
      const d = await loadDoc(ctx, id);
      await assertCan(ctx, userId, d.spaceId, "manage");
    }
    return null;
  },
});

/** Approves a draft as part of approveAndIssue. Managers only; an approved or issued document passes through unchanged. */
export const approveAsManager = internalMutation({
  args: { userId: v.id("users"), documentId: v.id("issuedDocuments") },
  handler: async (ctx, { userId, documentId }) => {
    await requireActor(ctx, userId);
    const d = await loadDoc(ctx, documentId);
    await assertCan(ctx, userId, d.spaceId, "manage");
    if (d.status === "approved" || d.status === "issued") return;
    if (d.status !== "draft") throw new OneBaseError("المستند مرفوض");
    await ctx.db.patch(d._id, { status: "approved", approvedBy: userId, approvedAt: Date.now() });
    await writeAudit(ctx, { userId, action: "document.approve", resourceType: "document", resourceId: d._id, spaceId: d.spaceId, detail: { templateVersion: d.templateVersion, with: "issue" } });
  },
});

/** Checks the issuer, then fixes serial, verification code and issue time (once). */
export const beginIssue = internalMutation({
  args: { userId: v.id("users"), documentId: v.id("issuedDocuments") },
  handler: async (ctx, { userId, documentId }) => {
    const actor = await requireActor(ctx, userId);
    const d = await loadDoc(ctx, documentId);
    const { role } = await assertCan(ctx, userId, d.spaceId, "write");
    // The requester or a manager issues; either way only after a recorded human approval.
    if (d.requestedBy !== userId && !roleAllows(role, "manage")) throw new Denied();
    if (d.status === "issued") return { done: { serial: d.serial!, sha256: d.sha256!, verifyCode: d.verifyCode! } };
    if (d.status !== "approved" || !d.approvedBy) throw new OneBaseError("لا يصدر مستند رسمي بلا اعتماد مدير المساحة");
    if (!d.serial) {
      const last = await ctx.db.query("issuedDocuments").withIndex("by_serialNo").order("desc").first();
      const serialNo = (last?.serialNo ?? 0) + 1;
      const issuedAt = Date.now();
      const serial = `OS-${new Date(issuedAt).getUTCFullYear()}-${String(serialNo).padStart(6, "0")}`;
      let code = newCode();
      while (await ctx.db.query("issuedDocuments").withIndex("by_code", (q) => q.eq("verifyCode", code)).first()) code = newCode();
      await ctx.db.patch(d._id, { serial, serialNo, verifyCode: code, issuedAt });
      Object.assign(d, { serial, serialNo, verifyCode: code, issuedAt });
    }
    void actor;
    return await prepFor(ctx, d);
  },
});

export const finishIssue = internalMutation({
  args: { userId: v.id("users"), documentId: v.id("issuedDocuments"), storageId: v.id("_storage"), sha256: v.string(), size: v.number() },
  handler: async (ctx, { userId, documentId, storageId, sha256, size }) => {
    const d = await loadDoc(ctx, documentId);
    if (d.status === "issued") return { duplicate: true, result: { serial: d.serial!, sha256: d.sha256!, verifyCode: d.verifyCode! } };
    if (d.status !== "approved" || !d.approvedBy) throw new OneBaseError("لا يصدر مستند رسمي بلا اعتماد مدير المساحة");
    await ctx.db.patch(d._id, { status: "issued", issuedBy: userId, sha256, storageId, size });
    await writeAudit(ctx, { userId, action: "document.issue", resourceType: "document", resourceId: d._id, spaceId: d.spaceId, detail: { serial: d.serial!, sha256, approvedBy: d.approvedBy } });
    return { duplicate: false, result: { serial: d.serial!, sha256, verifyCode: d.verifyCode! } };
  },
});

export const renderInputFor = internalQuery({
  args: { userId: v.id("users"), documentId: v.id("issuedDocuments") },
  handler: async (ctx, { userId, documentId }) => {
    await requireActor(ctx, userId);
    const d = await loadDoc(ctx, documentId);
    await assertCan(ctx, userId, d.spaceId, "read");
    if (d.status !== "issued") throw new OneBaseError("المستند لم يصدر بعد");
    return { ...(await prepFor(ctx, d)), sha256: d.sha256! };
  },
});

/** Used by GET /document: consumes the ticket, re-checks access, audits. */
export const redeemTicket = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const ticket = await ctx.db.query("documentTickets").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(token))).unique();
    if (!ticket) return null;
    await ctx.db.delete(ticket._id);
    if (ticket.expiresAt < Date.now()) return null;
    const actor = await requireActor(ctx, ticket.userId).catch(() => null);
    if (!actor) return null;
    const d = await ctx.db.get(ticket.documentId);
    if (!d || d.status !== "issued" || !d.storageId) return null;
    try {
      await authorizeRead(ctx, actor, d);
    } catch {
      return null;
    }
    await writeAudit(ctx, { userId: actor.userId, action: "document.download", resourceType: "document", resourceId: d._id, spaceId: d.spaceId, detail: { serial: d.serial ?? null } });
    return { storageId: d.storageId, name: `${d.serial}.pdf` };
  },
});

/** Used by POST /verify: is this exact file one we issued? */
export const verifyBySha = internalQuery({
  args: { sha256: v.string() },
  handler: async (ctx, { sha256 }) => {
    const d = await ctx.db.query("issuedDocuments").withIndex("by_sha256", (q) => q.eq("sha256", sha256)).first();
    if (!d || d.status !== "issued") return { valid: false as const };
    return await publicFacts(ctx, d);
  },
});

export const verifyByCodeInternal = internalQuery({
  args: { code: v.string() },
  handler: (ctx, { code }) => verifyByCode(ctx, code),
});

export const purgeTickets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("documentTickets").withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now())).take(500);
    for (const t of old) await ctx.db.delete(t._id);
  },
});
