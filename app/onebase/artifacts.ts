// Generated outputs ("artifacts") shown in the side panel: Markdown, HTML, tables. Versioned.
//
// Placement (plans/02 rule 4): an artifact is saved where its sources live.
//   - no sources ............................ personal space (or a writable space in scope)
//   - sources in one space X ................ X, or the personal space
//   - sources in several (non-sensitive) .... the personal space
//   - any source in a sensitive space S ..... S only, classification "sensitive"; it leaves S
//                                             only with a transfer approved by a manager of S.
//   - sensitive sources mixed with others ... refused
//   - anything saved in a sensitive space ... classified sensitive with that space as origin
// Content is returned by mutations (open/export) so opens of sensitive outputs are audited.

import { scheduleIngest } from "./ingest";
import { OneBaseError, v } from "onebase/values";
import ExcelJS from "exceljs";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, requireActive, requireUserId, roleAllows, spaceRoleOf, type Actor } from "./access";
import { writeAudit } from "./audit";
import { artifactKind, cellValue } from "./outputsSchema";
import { sha256Hex } from "./recordSources";
import { renderDocument, type DocFormat } from "./lib/docExport";

type Ctx = QueryCtx | MutationCtx;
export type ArtifactKind = "markdown" | "html" | "table";
export type SourceRef = { type: "file" | "recordSet" | "artifact"; id: string };
export type Source = SourceRef & { spaceId: Id<"spaces"> };

const MAX_CONTENT = 512 * 1024;
const MAX_TABLE_ROWS = 5000;

export const sourceRef = v.object({ type: v.union(v.literal("file"), v.literal("recordSet"), v.literal("artifact")), id: v.string() });
export const tableValue = v.object({ columns: v.array(v.string()), rows: v.array(v.array(cellValue)) });

export async function requireActor(ctx: Ctx, userId: Id<"users">): Promise<Actor> {
  const actor = await actorFor(ctx, userId);
  if (!actor) throw new OneBaseError("حسابك غير مفعّل في مساحة العمل");
  return actor;
}

export async function personalSpaceOf(ctx: Ctx, actor: Actor): Promise<Doc<"spaces">> {
  const own = await ctx.db.query("spaces").withIndex("by_owner", (q) => q.eq("ownerId", actor.userId)).collect();
  const space = own.find((s) => s.kind === "personal" && s.workspaceId === actor.workspace._id);
  if (!space) throw new OneBaseError("لا توجد مساحة خاصة لحسابك");
  return space;
}

/** Normalizes and checks content for a kind. Tables are stored as JSON {columns, rows}. */
export function normalizeContent(kind: ArtifactKind, content: unknown): string {
  if (kind === "table") {
    let t: any = content;
    if (typeof content === "string") {
      try {
        t = JSON.parse(content);
      } catch {
        throw new OneBaseError("الجدول يجب أن يكون {columns, rows}");
      }
    }
    if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) throw new OneBaseError("الجدول يجب أن يكون {columns, rows}");
    const columns = t.columns.map((c: unknown) => String(c ?? ""));
    if (columns.length === 0 || columns.length > 200) throw new OneBaseError("عدد أعمدة الجدول غير صالح");
    if (t.rows.length > MAX_TABLE_ROWS) throw new OneBaseError(`الجدول أكبر من ${MAX_TABLE_ROWS} صف`);
    const rows = t.rows.map((r: unknown) => {
      if (!Array.isArray(r)) throw new OneBaseError("كل صف في الجدول مصفوفة قيم");
      return columns.map((_: string, i: number) => {
        const c = r[i];
        return c === undefined || c === null ? null : typeof c === "number" || typeof c === "boolean" ? c : String(c);
      });
    });
    const s = JSON.stringify({ columns, rows });
    if (s.length > MAX_CONTENT) throw new OneBaseError("المخرج أكبر من الحد المسموح");
    return s;
  }
  if (typeof content !== "string") throw new OneBaseError("المحتوى يجب أن يكون نصاً");
  if (content.length > MAX_CONTENT) throw new OneBaseError("المخرج أكبر من الحد المسموح");
  return content;
}

/** Loads each source, checks the user can read it (and that it is in this turn's scope). */
export async function resolveSources(ctx: Ctx, actor: Actor, refs: SourceRef[], scope: Set<string> | null) {
  const out: Source[] = [];
  const sensitiveOrigins = new Set<Id<"spaces">>();
  for (const ref of refs.slice(0, 50)) {
    let spaceId: Id<"spaces"> | null = null;
    if (ref.type === "file") {
      const id = ctx.db.normalizeId("files", ref.id);
      const doc = id ? await ctx.db.get(id) : null;
      spaceId = doc?.spaceId ?? null;
    } else if (ref.type === "recordSet") {
      const id = ctx.db.normalizeId("recordSets", ref.id);
      const doc = id ? await ctx.db.get(id) : null;
      spaceId = doc?.spaceId ?? null;
    } else if (ref.type === "artifact") {
      const id = ctx.db.normalizeId("artifacts", ref.id);
      const doc = id ? await ctx.db.get(id) : null;
      spaceId = doc?.spaceId ?? null;
      if (doc?.classification === "sensitive" && doc.originSpaceId) sensitiveOrigins.add(doc.originSpaceId);
    }
    if (!spaceId) throw new Denied();
    await assertCan(ctx, actor.userId, spaceId, "read");
    if (scope && !scope.has(spaceId)) throw new Denied();
    if (!out.some((s) => s.type === ref.type && s.id === ref.id)) out.push({ type: ref.type, id: ref.id, spaceId });
  }
  return { sources: out, sensitiveOrigins };
}

/**
 * Where an artifact built on these sources may live. Throws if the requested space isn't allowed.
 * `managerMayExport`: a manager of the sensitive origin space may name another target directly
 * (the same thing as creating it in the origin and then `move`-ing it, which only they may do);
 * the output stays classified sensitive with that origin. Used by sandbox runs (analysis.ts).
 */
export async function place(
  ctx: Ctx,
  actor: Actor,
  sources: Source[],
  sensitiveOrigins: Set<Id<"spaces">>,
  requested: Id<"spaces"> | string | undefined,
  scope: Set<string> | null,
  opts: { managerMayExport?: boolean } = {},
) {
  const personal = await personalSpaceOf(ctx, actor);
  const spaceIds = [...new Set(sources.map((s) => s.spaceId))];
  const spaces = (await Promise.all(spaceIds.map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"spaces">[];
  const sensitive = new Set<Id<"spaces">>([...spaces.filter((s) => s.sensitive).map((s) => s._id), ...sensitiveOrigins]);
  const req = requested ? ctx.db.normalizeId("spaces", requested as string) : null;
  if (requested && !req) throw new Denied();

  let target: Id<"spaces">;
  let classification: "normal" | "sensitive" = "normal";
  let originSpaceId: Id<"spaces"> | undefined;
  if (sensitive.size > 1) throw new OneBaseError("لا يمكن بناء مخرج واحد على أكثر من مساحة حسّاسة");
  if (sensitive.size === 1) {
    const S = [...sensitive][0]!;
    if (spaceIds.some((id) => id !== S)) throw new OneBaseError("لا يُدمج محتوى مساحة حسّاسة مع مصادر من مساحات أخرى في مخرج واحد");
    target = req ?? S;
    if (target !== S) {
      const origin = await ctx.db.get(S);
      const manages = opts.managerMayExport && origin ? roleAllows(await spaceRoleOf(ctx, actor.userId, origin, actor), "manage") : false;
      if (!manages) throw new OneBaseError("المخرج المبني على مساحة حسّاسة يُحفظ فيها، ونقله يحتاج موافقة مديرها");
    }
    classification = "sensitive";
    originSpaceId = S;
  } else if (spaceIds.length === 1) {
    const X = spaceIds[0]!;
    const xSpace = spaces[0]!;
    const canWriteX = roleAllows(await spaceRoleOf(ctx, actor.userId, xSpace, actor), "write");
    target = req ?? (canWriteX ? X : personal._id);
    if (target !== X && target !== personal._id) throw new OneBaseError("المخرج يُحفظ في مساحة مصادره أو في مساحتك الخاصة");
  } else if (spaceIds.length > 1) {
    target = req ?? personal._id;
    if (target !== personal._id) throw new OneBaseError("مخرج من مصادر في عدة مساحات يُحفظ في مساحتك الخاصة");
  } else {
    target = req ?? personal._id;
  }
  const { space } = await assertCan(ctx, actor.userId, target, "write");
  if (scope && space.kind !== "personal" && !scope.has(space._id)) throw new Denied();
  // Anything saved in a sensitive space is treated as built on it, whatever its listed sources.
  if (space.sensitive) {
    classification = "sensitive";
    originSpaceId = space._id;
  }
  return { space, classification, originSpaceId };
}

export type CreateInput = { title: string; kind: ArtifactKind; content: unknown; sources?: SourceRef[]; spaceId?: string; runId?: string };

export async function createArtifact(ctx: MutationCtx, actor: Actor, input: CreateInput, opts: { scope: Set<string> | null; threadId?: string; via: string }) {
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new OneBaseError("اكتب عنواناً للمخرج");
  if (!["markdown", "html", "table"].includes(input.kind)) throw new OneBaseError("نوع المخرج غير معروف");
  const content = normalizeContent(input.kind, input.content);
  const { sources, sensitiveOrigins } = await resolveSources(ctx, actor, input.sources ?? [], opts.scope);
  const { space, classification, originSpaceId } = await place(ctx, actor, sources, sensitiveOrigins, input.spaceId, opts.scope);
  const artifactId = await insertArtifact(ctx, {
    spaceId: space._id,
    ownerId: actor.userId,
    kind: input.kind,
    title,
    content,
    sources,
    classification,
    originSpaceId,
    threadId: opts.threadId,
    runId: input.runId,
    via: opts.via,
  });
  return { artifactId, spaceId: space._id, classification, version: 1 };
}

/**
 * Inserts version 1 of an artifact whose placement and classification were already decided by
 * `place()` (createArtifact, or analysis:begin for sandbox runs) and whose content went through
 * normalizeContent. Audited as artifact.create.
 */
export async function insertArtifact(
  ctx: MutationCtx,
  a: {
    spaceId: Id<"spaces">;
    ownerId: Id<"users">;
    kind: ArtifactKind;
    title: string;
    content: string;
    sources: Source[];
    classification: "normal" | "sensitive";
    originSpaceId?: Id<"spaces">;
    threadId?: string;
    runId?: string;
    via: string;
  },
) {
  const now = Date.now();
  const artifactId = await ctx.db.insert("artifacts", {
    spaceId: a.spaceId,
    ownerId: a.ownerId,
    kind: a.kind,
    title: a.title,
    currentVersion: 1,
    sourceThreadId: a.threadId,
    sources: a.sources,
    classification: a.classification,
    originSpaceId: a.originSpaceId,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("artifactVersions", { artifactId, version: 1, content: a.content, sha256: sha256Hex(a.content), size: a.content.length, createdBy: a.ownerId, createdAt: now, runId: a.runId });
  await writeAudit(ctx, {
    userId: a.ownerId,
    action: "artifact.create",
    resourceType: "artifact",
    resourceId: artifactId,
    spaceId: a.spaceId,
    detail: { name: a.title, kind: a.kind, classification: a.classification, via: a.via, ...(a.runId ? { runId: a.runId } : {}) },
  });
  return artifactId;
}

export type UpdateInput = { artifactId: string; content: unknown; title?: string; note?: string; sources?: SourceRef[]; runId?: string };

export async function updateArtifact(ctx: MutationCtx, actor: Actor, input: UpdateInput, opts: { scope: Set<string> | null; via: string }) {
  const id = ctx.db.normalizeId("artifacts", input.artifactId);
  const art = id ? await ctx.db.get(id) : null;
  if (!art) throw new Denied();
  const { space } = await assertCan(ctx, actor.userId, art.spaceId, "write");
  if (opts.scope && space.kind !== "personal" && !opts.scope.has(space._id)) throw new Denied();
  const content = normalizeContent(art.kind, input.content);
  let sources = art.sources;
  let classification = art.classification;
  let originSpaceId = art.originSpaceId;
  if (input.sources?.length) {
    const added = await resolveSources(ctx, actor, input.sources, opts.scope);
    const merged = [...art.sources];
    for (const s of added.sources) if (!merged.some((m) => m.type === s.type && m.id === s.id)) merged.push(s);
    const origins = new Set(added.sensitiveOrigins);
    if (art.originSpaceId) origins.add(art.originSpaceId);
    // The artifact stays where it is; the merged sources must still allow that.
    const placed = await place(ctx, actor, merged, origins, art.spaceId, opts.scope);
    sources = merged;
    classification = placed.classification === "sensitive" ? "sensitive" : art.classification;
    originSpaceId = placed.originSpaceId ?? art.originSpaceId;
  }
  const version = art.currentVersion + 1;
  const now = Date.now();
  const title = input.title?.trim() ? input.title.trim().slice(0, 200) : art.title;
  await ctx.db.insert("artifactVersions", { artifactId: art._id, version, content, sha256: sha256Hex(content), size: content.length, createdBy: actor.userId, createdAt: now, runId: input.runId, note: input.note?.slice(0, 500) });
  await ctx.db.patch(art._id, { currentVersion: version, updatedAt: now, title, sources, classification, originSpaceId });
  await writeAudit(ctx, { userId: actor.userId, action: "artifact.update", resourceType: "artifact", resourceId: art._id, spaceId: art.spaceId, detail: { name: title, version, via: opts.via } });
  return { artifactId: art._id, spaceId: art.spaceId, version };
}

async function loadReadable(ctx: Ctx, userId: Id<"users">, artifactId: string) {
  const id = ctx.db.normalizeId("artifacts", artifactId);
  const art = id ? await ctx.db.get(id) : null;
  if (!art) throw new Denied();
  const { space, role } = await assertCan(ctx, userId, art.spaceId, "read");
  return { art, space, role };
}

async function openFor(ctx: MutationCtx, userId: Id<"users">, artifactId: string, version: number | undefined, action: string) {
  const { art, space } = await loadReadable(ctx, userId, artifactId);
  const ver = version ?? art.currentVersion;
  const row = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", art._id).eq("version", ver)).unique();
  if (!row) throw new Denied();
  if (space.sensitive || art.classification === "sensitive") {
    await writeAudit(ctx, { userId, action, resourceType: "artifact", resourceId: art._id, spaceId: space._id, detail: { name: art.title, version: ver } });
  }
  return { _id: art._id, title: art.title, kind: art.kind, version: ver, currentVersion: art.currentVersion, content: row.content, sha256: row.sha256, classification: art.classification };
}

function shape(a: Doc<"artifacts">) {
  return { _id: a._id, title: a.title, kind: a.kind, spaceId: a.spaceId, currentVersion: a.currentVersion, classification: a.classification, updatedAt: a.updatedAt, sourceCount: a.sources.length, ownerId: a.ownerId };
}

// ---------- public ----------

export const list = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("artifacts").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(shape);
  },
});

export const versions = query({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const me = await requireActive(ctx);
    const { art } = await loadReadable(ctx, me.userId, artifactId);
    const rows = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", art._id)).order("desc").collect();
    return { artifact: shape(art), versions: rows.map((r) => ({ version: r.version, sha256: r.sha256, size: r.size, createdAt: r.createdAt, note: r.note ?? null, runId: r.runId ?? null })) };
  },
});

/** The content of one version. A mutation so that opening a sensitive output is audited. */
export const open = mutation({
  args: { artifactId: v.id("artifacts"), version: v.optional(v.number()) },
  handler: async (ctx, { artifactId, version }) => {
    const me = await requireActive(ctx);
    return await openFor(ctx, me.userId, artifactId, version, "artifact.open");
  },
});

/** Creates an artifact from the UI (e.g. "save as output"). The agent uses the create_artifact tool. */
export const create = mutation({
  args: { title: v.string(), kind: artifactKind, content: v.string(), sources: v.optional(v.array(sourceRef)), spaceId: v.optional(v.id("spaces")) },
  handler: async (ctx, args) => {
    const me = await requireActive(ctx);
    return await createArtifact(ctx, me, args, { scope: null, via: "ui" });
  },
});

export const remove = mutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const me = await requireActive(ctx);
    const art = await ctx.db.get(artifactId);
    if (!art) throw new Denied();
    await assertCan(ctx, me.userId, art.spaceId, "write");
    await deleteArtifactRows(ctx, me.userId, art, "user");
  },
});

/** Deletes an artifact with its versions and transfers. Callers check write access first. */
export async function deleteArtifactRows(ctx: MutationCtx, userId: Id<"users">, art: Doc<"artifacts">, via: string) {
  for (const row of await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", art._id)).collect()) await ctx.db.delete(row._id);
  for (const t of await ctx.db.query("artifactTransfers").withIndex("by_artifact", (q) => q.eq("artifactId", art._id)).collect()) await ctx.db.delete(t._id);
  await ctx.db.delete(art._id);
  await writeAudit(ctx, { userId, action: "artifact.delete", resourceType: "artifact", resourceId: art._id, spaceId: art.spaceId, detail: { name: art.title, ...(via !== "user" ? { via } : {}) } });
}

async function doMove(ctx: MutationCtx, userId: Id<"users">, art: Doc<"artifacts">, to: Id<"spaces">, via: string) {
  await ctx.db.patch(art._id, { spaceId: to, updatedAt: Date.now() });
  const detail = { name: art.title, from: art.spaceId, to, via };
  await writeAudit(ctx, { userId, action: "artifact.move_out", resourceType: "artifact", resourceId: art._id, spaceId: art.spaceId, detail });
  await writeAudit(ctx, { userId, action: "artifact.move_in", resourceType: "artifact", resourceId: art._id, spaceId: to, detail });
}

/**
 * Moves an artifact. Write on both sides; a sensitive-sourced artifact leaves its origin space
 * only when the mover manages that space (otherwise: requestTransfer).
 */
export const move = mutation({
  args: { artifactId: v.id("artifacts"), toSpaceId: v.id("spaces") },
  handler: async (ctx, { artifactId, toSpaceId }) => {
    const me = await requireActive(ctx);
    const art = await ctx.db.get(artifactId);
    if (!art) throw new Denied();
    await assertCan(ctx, me.userId, art.spaceId, "write");
    const { space: dst } = await assertCan(ctx, me.userId, toSpaceId, "write");
    if (dst._id === art.spaceId) throw new OneBaseError("المخرج في هذه المساحة أصلاً");
    if (art.classification === "sensitive" && art.originSpaceId && dst._id !== art.originSpaceId) {
      const role = await spaceRoleOf(ctx, me.userId, (await ctx.db.get(art.originSpaceId))!, me);
      if (!roleAllows(role, "manage")) throw new OneBaseError("هذا المخرج مبني على مساحة حسّاسة: اطلب موافقة مديرها على النقل");
    }
    await doMove(ctx, me.userId, art, dst._id, "direct");
  },
});

export const requestTransfer = mutation({
  args: { artifactId: v.id("artifacts"), toSpaceId: v.id("spaces") },
  handler: async (ctx, { artifactId, toSpaceId }) => {
    const me = await requireActive(ctx);
    const art = await ctx.db.get(artifactId);
    if (!art) throw new Denied();
    await assertCan(ctx, me.userId, art.spaceId, "write");
    const { space: dst } = await assertCan(ctx, me.userId, toSpaceId, "write");
    if (art.classification !== "sensitive" || !art.originSpaceId) throw new OneBaseError("هذا المخرج لا يحتاج موافقة: انقله مباشرة");
    if (dst._id === art.spaceId) throw new OneBaseError("المخرج في هذه المساحة أصلاً");
    const id = await ctx.db.insert("artifactTransfers", { artifactId: art._id, fromSpaceId: art.originSpaceId, toSpaceId: dst._id, requestedBy: me.userId, requestedAt: Date.now(), status: "pending" });
    await writeAudit(ctx, { userId: me.userId, action: "artifact.transfer_request", resourceType: "artifact", resourceId: art._id, spaceId: art.originSpaceId, detail: { name: art.title, to: dst._id } });
    return id;
  },
});

/** Pending transfer requests out of a sensitive space, for its managers. */
export const transfers = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "manage");
    const rows = await ctx.db.query("artifactTransfers").withIndex("by_from_status", (q) => q.eq("fromSpaceId", spaceId).eq("status", "pending")).collect();
    const out = [];
    for (const r of rows) {
      const art = await ctx.db.get(r.artifactId);
      const to = await ctx.db.get(r.toSpaceId);
      const who = await ctx.db.get(r.requestedBy);
      out.push({ _id: r._id, artifactTitle: art?.title ?? "", toSpaceName: to?.kind === "personal" ? `المساحة الخاصة لـ ${who?.name ?? who?.email ?? ""}` : (to?.name ?? ""), requestedByName: who?.name ?? who?.email ?? "", requestedAt: r.requestedAt });
    }
    return out;
  },
});

export const decideTransfer = mutation({
  args: { transferId: v.id("artifactTransfers"), approve: v.boolean() },
  handler: async (ctx, { transferId, approve }) => {
    const me = await requireActive(ctx);
    const t = await ctx.db.get(transferId);
    if (!t) throw new Denied();
    await assertCan(ctx, me.userId, t.fromSpaceId, "manage");
    if (t.status !== "pending") throw new OneBaseError("تم البت في هذا الطلب");
    const art = await ctx.db.get(t.artifactId);
    if (!art) throw new Denied();
    await ctx.db.patch(t._id, { status: approve ? "approved" : "rejected", decidedBy: me.userId, decidedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: approve ? "artifact.transfer_approve" : "artifact.transfer_reject", resourceType: "artifact", resourceId: art._id, spaceId: t.fromSpaceId, detail: { name: art.title, to: t.toSpaceId } });
    if (approve) {
      // The requester must still be able to write there at the moment of the move.
      const requester = await actorFor(ctx, t.requestedBy);
      if (!requester) throw new OneBaseError("صاحب الطلب لم يعد مفعّلاً");
      await assertCan(ctx, t.requestedBy, t.toSpaceId, "write");
      await doMove(ctx, me.userId, art, t.toSpaceId, "approved_transfer");
    }
  },
});

function csvCell(c: unknown) {
  if (c === null || c === undefined) return "";
  const s = String(c);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exports a table artifact as CSV (UTF-8 with BOM, opens in Excel) or XLSX. Audited for sensitive outputs. */
export const exportTable = action({
  args: { artifactId: v.id("artifacts"), version: v.optional(v.number()), format: v.union(v.literal("csv"), v.literal("xlsx")) },
  handler: async (ctx, { artifactId, version, format }): Promise<{ fileName: string; mime: string; base64: string }> => {
    const userId = await requireUserId(ctx);
    const art: any = await ctx.runMutation(internal.artifacts.openForExport, { userId, artifactId, version, format });
    if (art.kind !== "table") throw new OneBaseError("التصدير للجداول فقط");
    const t = JSON.parse(art.content) as { columns: string[]; rows: unknown[][] };
    const base = art.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100) || "table";
    if (format === "csv") {
      const text = "﻿" + [t.columns, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
      return { fileName: `${base}.csv`, mime: "text/csv", base64: Buffer.from(text, "utf8").toString("base64") };
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1", { views: [{ rightToLeft: true }] });
    ws.addRow(t.columns).font = { bold: true };
    for (const r of t.rows) ws.addRow(r as any[]);
    const buf = await wb.xlsx.writeBuffer();
    return { fileName: `${base}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: Buffer.from(buf as ArrayBuffer).toString("base64") };
  },
});

/** Downloads an output as Word, PDF or PowerPoint (rendered in the sandbox). Audited for sensitive outputs. */
export const exportDocument = action({
  args: { artifactId: v.id("artifacts"), version: v.optional(v.number()), format: v.union(v.literal("docx"), v.literal("pdf"), v.literal("pptx")) },
  handler: async (ctx, { artifactId, version, format }): Promise<{ fileName: string; mime: string; base64: string }> => {
    const userId = await requireUserId(ctx);
    const art: any = await ctx.runMutation(internal.artifacts.openForExport, { userId, artifactId, version, format });
    const out = await renderDocument(art, format as DocFormat);
    return { fileName: out.fileName, mime: out.mime, base64: Buffer.from(out.bytes).toString("base64") };
  },
});

/** "تعديل": saves my edit of a Markdown/HTML output as a new version (write access to its space). */
export const edit = mutation({
  args: { artifactId: v.id("artifacts"), content: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { artifactId, content, note }) => {
    const me = await requireActive(ctx);
    const actor = await requireActor(ctx, me.userId);
    const art = await ctx.db.get(artifactId);
    if (!art) throw new Denied();
    await assertCan(ctx, me.userId, art.spaceId, "write");
    if (art.kind === "table") throw new OneBaseError("لا يُعدَّل الجدول نصياً؛ صدّره إلى Excel أو اطلب تعديله من الوكيل");
    return await updateArtifact(ctx, actor, { artifactId, content, note }, { scope: null, via: "user" });
  },
});


// ---------- internal (agent tools and actions; identity passed in by trusted server code) ----------

export const openForExport = internalMutation({
  args: {
    userId: v.id("users"),
    artifactId: v.string(),
    version: v.optional(v.number()),
    format: v.string(),
    scopeSpaceIds: v.optional(v.array(v.string())),
    /** The caller will save the result in the output's space (export_document): check that first. */
    requireWrite: v.optional(v.boolean()),
  },
  handler: async (ctx, { userId, artifactId, version, scopeSpaceIds, requireWrite }) => {
    await requireActor(ctx, userId);
    if (scopeSpaceIds || requireWrite) {
      const { art, space } = await loadReadable(ctx, userId, artifactId);
      // An agent: only outputs in its turn's scope (or the user's personal space), like updates.
      if (scopeSpaceIds && space.kind !== "personal" && !scopeSpaceIds.includes(space._id)) throw new Denied();
      if (requireWrite) await assertCan(ctx, userId, art.spaceId, "write");
    }
    return await openFor(ctx, userId, artifactId, version, "artifact.export");
  },
});

/**
 * Saves a rendered document (Word/PDF/PowerPoint of an output) as a file in the output's own space,
 * so it follows that space's permissions and sensitivity. Needs write access there.
 */
export const saveRenderedFile = internalMutation({
  args: { userId: v.id("users"), artifactId: v.id("artifacts"), storageId: v.id("_storage"), name: v.string(), mime: v.string(), size: v.number(), sha256: v.string(), format: v.string(), via: v.string() },
  handler: async (ctx, a) => {
    await requireActor(ctx, a.userId);
    const art = await ctx.db.get(a.artifactId);
    if (!art) throw new Denied();
    try {
      await assertCan(ctx, a.userId, art.spaceId, "write");
    } catch {
      await ctx.storage.delete(a.storageId);
      throw new OneBaseError("لا تملك صلاحية حفظ ملف في مساحة هذا المخرج. نزّله من لوحة المخرج بدلاً من ذلك.");
    }
    const now = Date.now();
    const fileId = await ctx.db.insert("files", {
      spaceId: art.spaceId,
      storageId: a.storageId,
      name: a.name,
      mime: a.mime,
      size: a.size,
      sha256: a.sha256,
      version: 1,
      uploadedBy: a.userId,
      ingest: "pending",
      status: "active",
      updatedAt: now,
    });
    await ctx.db.insert("fileVersions", { fileId, version: 1, storageId: a.storageId, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, uploadedBy: a.userId, uploadedAt: now });
    // Like an upload: index it, so the assistant can read and search the documents it made.
    await scheduleIngest(ctx, fileId);
    await writeAudit(ctx, {
      userId: a.userId,
      action: "file.upload",
      resourceType: "file",
      resourceId: fileId,
      spaceId: art.spaceId,
      detail: { fileName: a.name, size: a.size, via: a.via, artifactId: art._id, version: art.currentVersion, format: a.format },
    });
    return { fileId, spaceId: art.spaceId };
  },
});

export const createForUser = internalMutation({
  args: {
    userId: v.id("users"),
    scopeSpaceIds: v.array(v.string()),
    threadId: v.optional(v.string()),
    title: v.string(),
    kind: artifactKind,
    content: v.any(),
    sources: v.optional(v.array(sourceRef)),
    spaceId: v.optional(v.string()),
  },
  handler: async (ctx, { userId, scopeSpaceIds, threadId, ...input }) => {
    const actor = await requireActor(ctx, userId);
    return await createArtifact(ctx, actor, input, { scope: new Set(scopeSpaceIds), threadId, via: "agent" });
  },
});

export const updateForUser = internalMutation({
  args: {
    userId: v.id("users"),
    scopeSpaceIds: v.array(v.string()),
    artifactId: v.string(),
    content: v.any(),
    title: v.optional(v.string()),
    note: v.optional(v.string()),
    sources: v.optional(v.array(sourceRef)),
  },
  handler: async (ctx, { userId, scopeSpaceIds, ...input }) => {
    const actor = await requireActor(ctx, userId);
    return await updateArtifact(ctx, actor, input, { scope: new Set(scopeSpaceIds), via: "agent" });
  },
});
