// Ranking (المفاضلة): approved, versioned criteria; a pure ranking function (lib/ranking.ts);
// runs over an input snapshot stored with its hash; draft → human approval; approved runs are
// immutable and a correction is a new run; a justification page per student.
//
// Permissions (all through access.ts, in the space that owns the criteria):
//   read   → list/see criteria, runs, results and justification pages
//   write  → create/edit draft criteria, new criteria versions, create and re-run rankings
//   approve criteria and runs → the space's managers (or the owner of a personal space)

import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, requireActive, requireUserId } from "./access";
import { writeAudit } from "./audit";
import { snapshotSource } from "./schema";
import {
  canonicalJson,
  explainCriterion,
  FORMULA_TEXT,
  rank,
  RANKING_ALGORITHM,
  RankingInputError,
  sha256Hex,
  specOf,
  validateSpec,
  type RankedResult,
  type RankingSpec,
  type Row,
} from "./lib/ranking";
import { recordsToTable, type RecordRef, type RecordSet, type RecordSourceInfo } from "./lib/records";
import { parseTable, TableError } from "./lib/tabular";

const directionV = v.union(v.literal("desc"), v.literal("asc"));
const criterionV = v.object({ field: v.string(), label: v.string(), weight: v.number(), direction: directionV, min: v.number(), max: v.number() });
const tieBreakV = v.object({ field: v.string(), direction: directionV });
const specArgs = {
  name: v.string(),
  description: v.optional(v.string()),
  idField: v.string(),
  nameField: v.string(),
  criteria: v.array(criterionV),
  tieBreak: v.array(tieBreakV),
};

type Ctx = QueryCtx | MutationCtx;

/**
 * Who may approve criteria and runs: the space's managers, or the owner of a personal space
 * (their own data, nobody else is affected). Members and readers never approve.
 */
async function assertCanApprove(ctx: Ctx, userId: Id<"users">, spaceId: Id<"spaces">) {
  const { role } = await assertCan(ctx, userId, spaceId, "read");
  if (role !== "manager" && role !== "owner") throw new Denied();
}

async function load<T extends "rankingCriteria" | "rankingRuns">(ctx: Ctx, table: T, id: string): Promise<Doc<T>> {
  const nid = ctx.db.normalizeId(table, id);
  const doc = nid ? await ctx.db.get(nid) : null;
  if (!doc) throw new Denied();
  return doc as Doc<T>;
}

function cleanSpec(a: { name: string; description?: string; idField: string; nameField: string; criteria: RankingSpec["criteria"]; tieBreak: RankingSpec["tieBreak"] }) {
  const name = a.name.trim().slice(0, 200);
  if (!name) throw new OneBaseError("اسم المعايير مطلوب");
  if (a.criteria.length > 50 || a.tieBreak.length > 10) throw new OneBaseError("معايير كثيرة جداً");
  const spec = specOf({
    idField: a.idField.trim(),
    nameField: a.nameField.trim(),
    criteria: a.criteria.map((c) => ({ ...c, field: c.field.trim(), label: (c.label || c.field).trim() })),
    tieBreak: a.tieBreak.map((t) => ({ ...t, field: t.field.trim() })),
  });
  const errors = validateSpec(spec);
  if (errors.length) throw new OneBaseError(errors.join("؛ "));
  return { name, description: a.description?.trim() || undefined, ...spec, specHash: sha256Hex(canonicalJson(spec)) };
}

function criteriaView(c: Doc<"rankingCriteria">) {
  return {
    _id: c._id,
    spaceId: c.spaceId,
    seriesId: c.seriesId,
    version: c.version,
    name: c.name,
    description: c.description ?? null,
    idField: c.idField,
    nameField: c.nameField,
    criteria: c.criteria,
    tieBreak: c.tieBreak,
    status: c.status,
    specHash: c.specHash,
    createdAt: c.createdAt,
    approvedAt: c.approvedAt ?? null,
    totalWeight: c.criteria.reduce((a, x) => a + x.weight, 0),
  };
}

// ---------- criteria ----------

export const listCriteria = query({
  args: { spaceId: v.string() },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space } = await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("rankingCriteria").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect();
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : b.version - a.version)).map(criteriaView);
  },
});

export const createCriteria = mutation({
  args: { spaceId: v.string(), ...specArgs },
  handler: async (ctx, { spaceId, ...a }) => {
    const me = await requireActive(ctx);
    const { space } = await assertCan(ctx, me.userId, spaceId, "write");
    const spec = cleanSpec(a);
    const id = await ctx.db.insert("rankingCriteria", { spaceId: space._id, seriesId: crypto.randomUUID(), version: 1, ...spec, status: "draft", createdBy: me.userId, createdAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "ranking.criteria.create", resourceType: "rankingCriteria", resourceId: id, spaceId: space._id, detail: { name: spec.name, version: 1 } });
    return id;
  },
});

/** Edits a draft. Approved versions never change. */
export const updateCriteria = mutation({
  args: { criteriaId: v.string(), ...specArgs },
  handler: async (ctx, { criteriaId, ...a }) => {
    const me = await requireActive(ctx);
    const c = await load(ctx, "rankingCriteria", criteriaId);
    await assertCan(ctx, me.userId, c.spaceId, "write");
    if (c.status !== "draft") throw new OneBaseError("المعايير المعتمدة لا تُعدَّل: أنشئ نسخة جديدة");
    const spec = cleanSpec(a);
    await ctx.db.patch(c._id, spec);
    await writeAudit(ctx, { userId: me.userId, action: "ranking.criteria.update", resourceType: "rankingCriteria", resourceId: c._id, spaceId: c.spaceId, detail: { name: spec.name, version: c.version } });
  },
});

/** Starts the next version of a criteria set as a draft copy. */
export const newCriteriaVersion = mutation({
  args: { criteriaId: v.string() },
  handler: async (ctx, { criteriaId }) => {
    const me = await requireActive(ctx);
    const c = await load(ctx, "rankingCriteria", criteriaId);
    await assertCan(ctx, me.userId, c.spaceId, "write");
    const series = await ctx.db.query("rankingCriteria").withIndex("by_series", (q) => q.eq("seriesId", c.seriesId)).collect();
    const draft = series.find((x) => x.status === "draft");
    if (draft) return draft._id;
    const version = Math.max(...series.map((x) => x.version)) + 1;
    const { _id, _creationTime, approvedAt, approvedBy, ...rest } = c;
    const id = await ctx.db.insert("rankingCriteria", { ...rest, version, status: "draft", createdBy: me.userId, createdAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "ranking.criteria.version", resourceType: "rankingCriteria", resourceId: id, spaceId: c.spaceId, detail: { name: c.name, version } });
    return id;
  },
});

export const approveCriteria = mutation({
  args: { criteriaId: v.string() },
  handler: async (ctx, { criteriaId }) => {
    const me = await requireActive(ctx);
    const c = await load(ctx, "rankingCriteria", criteriaId);
    await assertCanApprove(ctx, me.userId, c.spaceId);
    if (c.status !== "draft") throw new OneBaseError("هذه النسخة معتمدة مسبقاً");
    const errors = validateSpec(c);
    if (errors.length) throw new OneBaseError(errors.join("؛ "));
    await ctx.db.patch(c._id, { status: "approved", approvedBy: me.userId, approvedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "ranking.criteria.approve", resourceType: "rankingCriteria", resourceId: c._id, spaceId: c.spaceId, detail: { name: c.name, version: c.version, specHash: c.specHash } });
  },
});

// ---------- input records ----------

/** Checks the user may read the file and that it lives in the ranking's space; returns where its bytes are. */
export const fileForRanking = internalQuery({
  args: { userId: v.id("users"), fileId: v.string(), spaceId: v.id("spaces") },
  handler: async (ctx, { userId, fileId, spaceId }) => {
    const id = ctx.db.normalizeId("files", fileId);
    const file = id ? await ctx.db.get(id) : null;
    if (!file || file.status !== "active") throw new Denied();
    await assertCan(ctx, userId, file.spaceId, "read");
    if (file.spaceId !== spaceId) throw new OneBaseError("ملف البيانات يجب أن يكون في مساحة المعايير نفسها");
    return { storageId: file.storageId, name: file.name, mime: file.mime, version: file.version, sha256: file.sha256, fileId: file._id as string };
  },
});

/**
 * Checks the user may read the record set and that it lives in the ranking's space (same rule as
 * a file); returns the rows of one import version (the current one unless `version` is given).
 */
export const recordsForRanking = internalQuery({
  args: { userId: v.id("users"), recordSetId: v.string(), spaceId: v.id("spaces"), version: v.optional(v.number()) },
  handler: async (ctx, { userId, recordSetId, spaceId, version }) => {
    const id = ctx.db.normalizeId("recordSets", recordSetId);
    const set = id ? await ctx.db.get(id) : null;
    if (!set) throw new Denied();
    await assertCan(ctx, userId, set.spaceId, "read");
    if (set.spaceId !== spaceId) throw new OneBaseError("مجموعة السجلات يجب أن تكون في مساحة المعايير نفسها");
    const ver = version ?? set.currentVersion;
    if (set.currentVersion === 0) throw new OneBaseError("لم تُستورد أي سجلات في هذه المجموعة بعد");
    if (!Number.isInteger(ver) || ver < 1 || ver > set.currentVersion) throw new OneBaseError("نسخة السجلات غير موجودة");
    const imp = await ctx.db.query("recordImports").withIndex("by_set_version", (q) => q.eq("recordSetId", set._id).eq("version", ver)).unique();
    const rows = await ctx.db.query("records").withIndex("by_set_version", (q) => q.eq("recordSetId", set._id).eq("version", ver)).collect();
    return {
      recordSetId: set._id as string,
      name: set.name,
      version: ver,
      sha256: imp?.source.sha256 ?? null,
      columns: set.columns.map((c) => ({ key: c.key, header: c.header })),
      rows: rows.map((r) => ({ rowNo: r.rowNo, data: r.data })),
    };
  },
});

/** Loads a RecordSet for a reference. One implementation per source kind; both go through access.ts and the same-space rule. */
async function loadRecords(ctx: any, userId: Id<"users">, spaceId: Id<"spaces">, ref: RecordRef): Promise<RecordSet> {
  if (ref.kind === "records") {
    const r = await ctx.runQuery(internal.ranking.recordsForRanking, { userId, recordSetId: ref.recordSetId, spaceId, version: ref.version });
    const table = recordsToTable(r.columns, r.rows);
    const source: RecordSourceInfo = { kind: "records", recordSetId: r.recordSetId, version: r.version, name: r.name, sha256: r.sha256 };
    return { ...table, source };
  }
  if (ref.kind !== "file") throw new OneBaseError("مصدر بيانات غير معروف");
  const f = await ctx.runQuery(internal.ranking.fileForRanking, { userId, fileId: ref.fileId, spaceId });
  const blob: Blob | null = await ctx.storage.get(f.storageId);
  if (!blob) throw new Denied();
  try {
    const table = parseTable(new Uint8Array(await blob.arrayBuffer()), f.name, f.mime);
    const source: RecordSourceInfo = { kind: "file", fileId: f.fileId, version: f.version, name: f.name, sha256: f.sha256 };
    return { ...table, source };
  } catch (e) {
    if (e instanceof TableError) throw new OneBaseError(e.message);
    throw e;
  }
}

function checkFields(spec: RankingSpec, fields: string[]) {
  const have = new Set(fields);
  const need = [spec.idField, spec.nameField, ...spec.criteria.map((c) => c.field), ...spec.tieBreak.map((t) => t.field)];
  const missing = [...new Set(need.filter((f) => !have.has(f)))];
  if (missing.length) throw new OneBaseError(`أعمدة غير موجودة في البيانات: ${missing.join("، ")}`);
}

function compute(spec: RankingSpec, rows: Row[]): { results: RankedResult[]; resultsHash: string } {
  try {
    const results = rank(spec, rows);
    return { results, resultsHash: sha256Hex(canonicalJson(results)) };
  } catch (e) {
    if (e instanceof RankingInputError) throw new OneBaseError(e.message);
    throw e;
  }
}

// ---------- runs ----------

export const prepareRun = internalQuery({
  args: { userId: v.id("users"), criteriaId: v.string() },
  handler: async (ctx, { userId, criteriaId }) => {
    const c = await load(ctx, "rankingCriteria", criteriaId);
    await assertCan(ctx, userId, c.spaceId, "write");
    if (c.status !== "approved") throw new OneBaseError("اعتمد المعايير قبل تشغيل المفاضلة");
    return { criteriaId: c._id, spaceId: c.spaceId, version: c.version, specHash: c.specHash, spec: specOf(c) };
  },
});

export const prepareRerun = internalQuery({
  args: { userId: v.id("users"), rankingRunId: v.string(), criteriaId: v.optional(v.string()) },
  handler: async (ctx, { userId, rankingRunId, criteriaId }) => {
    const run = await load(ctx, "rankingRuns", rankingRunId);
    await assertCan(ctx, userId, run.spaceId, "write");
    const c = await load(ctx, "rankingCriteria", criteriaId ?? run.criteriaId);
    const old = await ctx.db.get(run.criteriaId);
    if (c.spaceId !== run.spaceId || !old || c.seriesId !== old.seriesId) throw new OneBaseError("المعايير يجب أن تكون نسخة من معايير التشغيل الأصلي");
    if (c.status !== "approved") throw new OneBaseError("اعتمد المعايير قبل تشغيل المفاضلة");
    const snap = await ctx.db.get(run.snapshotId);
    if (!snap) throw new Denied();
    return {
      criteriaId: c._id,
      spaceId: c.spaceId,
      version: c.version,
      specHash: c.specHash,
      spec: specOf(c),
      snapshot: { id: snap._id, storageId: snap.storageId, sha256: snap.sha256 },
      correctsRunId: run._id,
    };
  },
});

const resultV = v.object({
  key: v.string(),
  name: v.string(),
  rank: v.number(),
  total: v.number(),
  breakdown: v.array(
    v.object({
      field: v.string(),
      label: v.string(),
      weight: v.number(),
      direction: directionV,
      min: v.number(),
      max: v.number(),
      raw: v.union(v.string(), v.number(), v.null()),
      value: v.union(v.number(), v.null()),
      normalized: v.number(),
      points: v.number(),
      missing: v.boolean(),
      clamped: v.boolean(),
    }),
  ),
  tieBreak: v.array(v.object({ field: v.string(), direction: directionV, value: v.union(v.number(), v.null()) })),
});

export const saveRun = internalMutation({
  args: {
    userId: v.id("users"),
    criteriaId: v.id("rankingCriteria"),
    specHash: v.string(),
    snapshot: v.union(
      v.object({ existingId: v.id("rankingSnapshots") }),
      v.object({
        storageId: v.id("_storage"),
        sha256: v.string(),
        size: v.number(),
        fields: v.array(v.string()),
        rowCount: v.number(),
        source: snapshotSource,
      }),
    ),
    results: v.array(resultV),
    resultsHash: v.string(),
    correctsRunId: v.optional(v.id("rankingRuns")),
  },
  handler: async (ctx, a) => {
    const c = await ctx.db.get(a.criteriaId);
    if (!c || c.status !== "approved" || c.specHash !== a.specHash) throw new OneBaseError("تغيّرت المعايير أثناء الحساب، أعد المحاولة");
    await assertCan(ctx, a.userId, c.spaceId, "write");
    const now = Date.now();
    let snap: Doc<"rankingSnapshots">;
    if ("existingId" in a.snapshot) {
      const s = await ctx.db.get(a.snapshot.existingId);
      if (!s || s.spaceId !== c.spaceId) throw new Denied();
      snap = s;
    } else {
      const id = await ctx.db.insert("rankingSnapshots", {
        spaceId: c.spaceId,
        source: a.snapshot.source,
        storageId: a.snapshot.storageId,
        sha256: a.snapshot.sha256,
        fields: a.snapshot.fields,
        rowCount: a.snapshot.rowCount,
        createdBy: a.userId,
        createdAt: now,
      });
      snap = (await ctx.db.get(id))!;
    }
    const rankingRunId = await ctx.db.insert("rankingRuns", {
      spaceId: c.spaceId,
      criteriaId: c._id,
      criteriaVersion: c.version,
      criteriaHash: c.specHash,
      snapshotId: snap._id,
      snapshotHash: snap.sha256,
      resultsHash: a.resultsHash,
      algorithm: RANKING_ALGORITHM,
      count: a.results.length,
      status: "draft",
      correctsRunId: a.correctsRunId,
      createdBy: a.userId,
      createdAt: now,
    });
    for (const r of a.results) await ctx.db.insert("rankingResults", { rankingRunId, ...r });
    const runId = await ctx.db.insert("runs", {
      kind: "ranking",
      userId: a.userId,
      spaceId: c.spaceId,
      status: "done",
      codeHash: sha256Hex(RANKING_ALGORITHM),
      // A file source names its file; a records source has no file (the snapshot keeps the set id + version).
      inputs: [
        snap.source.kind === "file"
          ? { fileId: snap.source.fileId, name: snap.source.name, sha256: snap.sha256, size: snap.rowCount, spaceId: c.spaceId }
          : { name: `${snap.source.name} (v${snap.source.version})`, sha256: snap.sha256, size: snap.rowCount, spaceId: c.spaceId },
      ],
      outputs: [],
      exit: { code: 0, timedOut: false, oomKilled: false, durationMs: 0, outputTruncated: false },
      rankingRunId,
      createdAt: now,
      finishedAt: now,
    });
    await writeAudit(ctx, {
      userId: a.userId,
      action: "ranking.run",
      resourceType: "rankingRun",
      resourceId: rankingRunId,
      spaceId: c.spaceId,
      detail: { name: c.name, criteriaVersion: c.version, snapshotHash: snap.sha256, resultsHash: a.resultsHash, count: a.results.length, runId, corrects: a.correctsRunId ?? null },
    });
    return rankingRunId;
  },
});

/**
 * Ranks the rows of a CSV/XLSX file, or of an imported record set (one import version, the
 * current one by default), in the criteria's space with an approved criteria version. Result: a draft run.
 */
export const createRun = action({
  args: { criteriaId: v.string(), fileId: v.optional(v.string()), recordSetId: v.optional(v.string()), recordVersion: v.optional(v.number()) },
  handler: async (ctx, { criteriaId, fileId, recordSetId, recordVersion }): Promise<string> => {
    const userId = await requireUserId(ctx);
    if (!fileId === !recordSetId) throw new OneBaseError("اختر مصدر البيانات: ملفاً أو مجموعة سجلات");
    const prep = await ctx.runQuery(internal.ranking.prepareRun, { userId, criteriaId });
    const ref: RecordRef = recordSetId ? { kind: "records", recordSetId, version: recordVersion } : { kind: "file", fileId: fileId! };
    const records = await loadRecords(ctx, userId, prep.spaceId, ref);
    checkFields(prep.spec, records.fields);
    const snapshotJson = canonicalJson({ fields: records.fields, rows: records.rows });
    const sha256 = sha256Hex(snapshotJson);
    const { results, resultsHash } = compute(prep.spec, records.rows);
    const storageId = await ctx.storage.store(new Blob([snapshotJson], { type: "application/json" }));
    try {
      return await ctx.runMutation(internal.ranking.saveRun, {
        userId,
        criteriaId: prep.criteriaId,
        specHash: prep.specHash,
        snapshot: { storageId, sha256, size: snapshotJson.length, fields: records.fields, rowCount: records.rows.length, source: records.source },
        results,
        resultsHash,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});

/**
 * Runs the ranking again on the exact snapshot of an earlier run (verified by hash), optionally
 * with a newer approved version of the same criteria. Always a new draft run; the old one is untouched.
 */
export const rerun = action({
  args: { rankingRunId: v.string(), criteriaId: v.optional(v.string()) },
  handler: async (ctx, { rankingRunId, criteriaId }): Promise<string> => {
    const userId = await requireUserId(ctx);
    const prep = await ctx.runQuery(internal.ranking.prepareRerun, { userId, rankingRunId, criteriaId });
    const blob = await ctx.storage.get(prep.snapshot.storageId);
    if (!blob) throw new OneBaseError("لقطة البيانات مفقودة");
    const text = await blob.text();
    if (sha256Hex(text) !== prep.snapshot.sha256) throw new OneBaseError("بصمة لقطة البيانات لا تطابق: لن تُعاد المفاضلة");
    const snap = JSON.parse(text) as { fields: string[]; rows: Row[] };
    checkFields(prep.spec, snap.fields);
    const { results, resultsHash } = compute(prep.spec, snap.rows);
    return await ctx.runMutation(internal.ranking.saveRun, {
      userId,
      criteriaId: prep.criteriaId,
      specHash: prep.specHash,
      snapshot: { existingId: prep.snapshot.id },
      results,
      resultsHash,
      correctsRunId: prep.correctsRunId,
    });
  },
});

async function runView(ctx: Ctx, run: Doc<"rankingRuns">) {
  const c = await ctx.db.get(run.criteriaId);
  const snap = await ctx.db.get(run.snapshotId);
  const approver = run.approvedBy ? await ctx.db.get(run.approvedBy) : null;
  const creator = await ctx.db.get(run.createdBy);
  return {
    _id: run._id,
    spaceId: run.spaceId,
    status: run.status,
    criteriaId: run.criteriaId,
    criteriaName: c?.name ?? "",
    criteriaVersion: run.criteriaVersion,
    criteriaHash: run.criteriaHash,
    snapshotHash: run.snapshotHash,
    resultsHash: run.resultsHash,
    algorithm: run.algorithm,
    count: run.count,
    source: snap
      ? {
          kind: snap.source.kind,
          name: snap.source.name,
          version: snap.source.version,
          fileId: snap.source.kind === "file" ? snap.source.fileId : null,
          recordSetId: snap.source.kind === "records" ? snap.source.recordSetId : null,
        }
      : null,
    correctsRunId: run.correctsRunId ?? null,
    createdAt: run.createdAt,
    createdByName: creator?.name ?? creator?.email ?? null,
    approvedAt: run.approvedAt ?? null,
    approvedByName: approver ? (approver.name ?? approver.email ?? null) : null,
  };
}

export const listRuns = query({
  args: { spaceId: v.string() },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space } = await assertCan(ctx, me.userId, spaceId, "read");
    const runs = await ctx.db.query("rankingRuns").withIndex("by_space", (q) => q.eq("spaceId", space._id)).order("desc").take(100);
    return await Promise.all(runs.map((r) => runView(ctx, r)));
  },
});

export const getRun = query({
  args: { rankingRunId: v.string() },
  handler: async (ctx, { rankingRunId }) => {
    const me = await requireActive(ctx);
    const run = await load(ctx, "rankingRuns", rankingRunId);
    await assertCan(ctx, me.userId, run.spaceId, "read");
    const results = await ctx.db.query("rankingResults").withIndex("by_run_rank", (q) => q.eq("rankingRunId", run._id)).take(10_000);
    return {
      ...(await runView(ctx, run)),
      results: results.map((r) => ({ key: r.key, name: r.name, rank: r.rank, total: r.total, points: r.breakdown.map((b) => b.points) })),
      criteria: results[0]?.breakdown.map((b) => ({ field: b.field, label: b.label, weight: b.weight })) ?? [],
    };
  },
});

/** Human approval by a manager of the space. After this the run never changes. */
export const approveRun = mutation({
  args: { rankingRunId: v.string() },
  handler: async (ctx, { rankingRunId }) => {
    const me = await requireActive(ctx);
    const run = await load(ctx, "rankingRuns", rankingRunId);
    await assertCanApprove(ctx, me.userId, run.spaceId);
    if (run.status !== "draft") throw new OneBaseError("المفاضلة معتمدة ولا تُعدَّل: أي تصحيح تشغيل جديد");
    await ctx.db.patch(run._id, { status: "approved", approvedBy: me.userId, approvedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "ranking.approve", resourceType: "rankingRun", resourceId: run._id, spaceId: run.spaceId, detail: { resultsHash: run.resultsHash, snapshotHash: run.snapshotHash, criteriaVersion: run.criteriaVersion } });
  },
});

/** The justification page for one student: their data, the formula, their points per criterion, their rank. */
export const justification = query({
  args: { rankingRunId: v.string(), key: v.string() },
  handler: async (ctx, { rankingRunId, key }) => {
    const me = await requireActive(ctx);
    const run = await load(ctx, "rankingRuns", rankingRunId);
    await assertCan(ctx, me.userId, run.spaceId, "read");
    const r = await ctx.db.query("rankingResults").withIndex("by_run_key", (q) => q.eq("rankingRunId", run._id).eq("key", key)).unique();
    if (!r) throw new Denied();
    const c = await ctx.db.get(run.criteriaId);
    const sameRank = await ctx.db.query("rankingResults").withIndex("by_run_rank", (q) => q.eq("rankingRunId", run._id).eq("rank", r.rank)).take(1000);
    return {
      run: await runView(ctx, run),
      student: { key: r.key, name: r.name, rank: r.rank, of: run.count, total: r.total, maxTotal: r.breakdown.reduce((a, b) => a + b.weight, 0), sharedWith: sameRank.length - 1 },
      data: [
        { field: c?.idField ?? "", value: r.key },
        { field: c?.nameField ?? "", value: r.name },
        ...r.breakdown.map((b) => ({ field: b.field, value: b.raw })),
        ...r.tieBreak.filter((t) => !r.breakdown.some((b) => b.field === t.field)).map((t) => ({ field: t.field, value: t.value })),
      ],
      formula: FORMULA_TEXT,
      breakdown: r.breakdown.map((b) => ({ ...b, explanation: explainCriterion(b) })),
      totalLine: `${r.breakdown.map((b) => b.points).join(" + ")} = ${r.total}`,
      tieBreak: r.tieBreak,
    };
  },
});
