// Structured records inside a space (trainees, courses, certificates…), imported from Excel by
// the space's manager, and two ways in:
//   - members of the records' space: query_records / records:rows (read access to the space);
//   - the subject: my_records / records:mine, matched on the national id or employee number the
//     workspace admin set on the account. Never by name, never by anything typed in a chat.
// Every import is a new dated version; queries read the current version only.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, readableSpaceIds, requireActive, requireUserId } from "./access";
import { writeAudit } from "./audit";
import { requireActor } from "./artifacts";
import { cellValue, columnDef, subjectKind } from "./outputsSchema";
import { excelSource, ImportError, inferColumns, keysFor, normalizeRef, ownerCandidates, sha256Hex, SOURCES, suggestUnique, validateRows, type ColumnDef, type InferredColumn, type RawTable } from "./recordSources";

type Ctx = QueryCtx | MutationCtx;
type Cell = string | number | boolean | null;

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

export async function loadSet(ctx: Ctx, recordSetId: string) {
  const id = ctx.db.normalizeId("recordSets", recordSetId);
  const set = id ? await ctx.db.get(id) : null;
  if (!set) throw new Denied();
  return set;
}

function shapeSet(s: Doc<"recordSets">) {
  return { _id: s._id, spaceId: s.spaceId, name: s.name, columns: s.columns, subjectColumn: s.subjectColumn, subjectKind: s.subjectKind, uniqueBy: s.uniqueBy, currentVersion: s.currentVersion };
}

/** The identifiers the workspace admin put on the account. The only identity my_records uses. */
export function identityOf(user: Doc<"users">): { nationalId: string | null; employeeNo: string | null } {
  return { nationalId: user.nationalId ? normalizeRef(user.nationalId) || null : null, employeeNo: user.employeeNo ? normalizeRef(user.employeeNo) || null : null };
}

async function currentRows(ctx: Ctx, set: Doc<"recordSets">) {
  if (set.currentVersion === 0) return [];
  return await ctx.db.query("records").withIndex("by_set_version", (q) => q.eq("recordSetId", set._id).eq("version", set.currentVersion)).collect();
}

function matches(data: Record<string, Cell>, filters: Record<string, unknown> | undefined, columns: ColumnDef[]) {
  if (!filters) return true;
  for (const [k, want] of Object.entries(filters)) {
    const col = columns.find((c) => c.key === k || c.header === k);
    if (!col) return false;
    const have = data[col.key];
    if (have === null || have === undefined) return false;
    if (typeof have === "string" && typeof want === "string") {
      if (!have.toLowerCase().includes(want.trim().toLowerCase())) return false;
    } else if (String(have) !== String(want)) return false;
  }
  return true;
}

export type QueryArgs = { recordSetId?: string; subjectRef?: string; filters?: Record<string, unknown>; limit?: number };

/**
 * The single query path for members of a records space (used by query_records and records:rows).
 * Only sets in spaces the user can read, and (for the agent) inside the turn's scope.
 */
export async function queryRecords(ctx: Ctx, userId: Id<"users">, args: QueryArgs, scope: Set<string> | null) {
  await requireActor(ctx, userId);
  const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200);
  let sets: Doc<"recordSets">[];
  if (args.recordSetId) {
    const set = await loadSet(ctx, args.recordSetId);
    await assertCan(ctx, userId, set.spaceId, "read");
    if (scope && !scope.has(set.spaceId)) throw new Denied();
    sets = [set];
  } else {
    sets = [];
    for (const spaceId of await readableSpaceIds(ctx, userId)) {
      if (scope && !scope.has(spaceId)) continue;
      sets.push(...(await ctx.db.query("recordSets").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect()));
    }
  }
  const subject = args.subjectRef ? normalizeRef(args.subjectRef) : null;
  const out: { recordSetId: Id<"recordSets">; setName: string; spaceId: Id<"spaces">; version: number; rows: { recordId: Id<"records">; rowNo: number; data: Record<string, Cell> }[]; total: number }[] = [];
  for (const set of sets) {
    let rows = await currentRows(ctx, set);
    if (subject) rows = rows.filter((r) => r.subjectRef === subject);
    rows = rows.filter((r) => matches(r.data, args.filters, set.columns));
    out.push({ recordSetId: set._id, setName: set.name, spaceId: set.spaceId, version: set.currentVersion, total: rows.length, rows: rows.slice(0, limit).map((r) => ({ recordId: r._id, rowNo: r.rowNo, data: r.data })) });
  }
  return { sets: out.map((o) => ({ ...o, columns: sets.find((s) => s._id === o.recordSetId)!.columns.map((c) => ({ key: c.key, header: c.header, type: c.type })) })) };
}

/** Records whose subject is the user, across every record set of the workspace. Identity from the account only. */
export async function myRecords(ctx: Ctx, userId: Id<"users">) {
  const actor = await requireActor(ctx, userId);
  const ids = identityOf(actor.user);
  const out: { recordSetId: Id<"recordSets">; setName: string; columns: { key: string; header: string; type: string }[]; rows: { recordId: Id<"records">; data: Record<string, Cell> }[] }[] = [];
  const documents: { _id: Id<"issuedDocuments">; templateName: string; serial: string | null; issuedAt: number | null; verifyCode: string | null; sha256: string | null }[] = [];
  for (const [kind, ref] of [["nationalId", ids.nationalId], ["employeeNo", ids.employeeNo]] as const) {
    if (!ref) continue;
    const rows = await ctx.db.query("records").withIndex("by_subject", (q) => q.eq("subjectRef", ref)).collect();
    const bySet = new Map<string, typeof rows>();
    for (const r of rows) bySet.set(r.recordSetId, [...(bySet.get(r.recordSetId) ?? []), r]);
    for (const [setId, list] of bySet) {
      const set = await ctx.db.get(setId as Id<"recordSets">);
      if (!set || set.subjectKind !== kind || set.workspaceId !== actor.workspace._id) continue;
      const current = list.filter((r) => r.version === set.currentVersion);
      if (current.length === 0) continue;
      out.push({
        recordSetId: set._id,
        setName: set.name,
        columns: set.columns.map((c) => ({ key: c.key, header: c.header, type: c.type })),
        rows: current.map((r) => ({ recordId: r._id, data: r.data })),
      });
    }
    const docs = await ctx.db.query("issuedDocuments").withIndex("by_subject", (q) => q.eq("subjectRef", ref)).collect();
    for (const d of docs) {
      if (d.status !== "issued" || d.subjectKind !== kind || d.workspaceId !== actor.workspace._id) continue;
      const t = await ctx.db.get(d.templateId);
      documents.push({ _id: d._id, templateName: t?.name ?? "", serial: d.serial ?? null, issuedAt: d.issuedAt ?? null, verifyCode: d.verifyCode ?? null, sha256: d.sha256 ?? null });
    }
  }
  return { hasIdentity: Boolean(ids.nationalId || ids.employeeNo), sets: out, documents };
}

// ---------- public ----------

export const sets = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("recordSets").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
    return rows.map(shapeSet);
  },
});

export const imports = query({
  args: { recordSetId: v.id("recordSets") },
  handler: async (ctx, { recordSetId }) => {
    const me = await requireActive(ctx);
    const set = await loadSet(ctx, recordSetId);
    await assertCan(ctx, me.userId, set.spaceId, "read");
    const rows = await ctx.db.query("recordImports").withIndex("by_set_version", (q) => q.eq("recordSetId", set._id)).order("desc").collect();
    const out = [];
    for (const r of rows) {
      const u = await ctx.db.get(r.importedBy);
      out.push({ version: r.version, sourceKind: r.source.kind, sourceName: r.source.name, sha256: r.source.sha256, rowCount: r.rowCount, importedAt: r.importedAt, importedByName: u?.name ?? u?.email ?? null, current: r.version === set.currentVersion });
    }
    return out;
  },
});

/** Current rows of a set, for members of its space. */
export const rows = query({
  args: { recordSetId: v.id("recordSets"), limit: v.optional(v.number()) },
  handler: async (ctx, { recordSetId, limit }) => {
    const me = await requireActive(ctx);
    const r = await queryRecords(ctx, me.userId, { recordSetId, limit: limit ?? 200 }, null);
    return r.sets[0]!;
  },
});

/** "بياناتي": the signed-in user's own records and issued documents. No identity argument. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    return await myRecords(ctx, me.userId);
  },
});

type SetDef = { name: string; columns: ColumnDef[]; subjectColumn: string; subjectKind: "nationalId" | "employeeNo"; uniqueBy?: string[] };

/** Checks a definition and inserts the set (version 0). The caller has checked "manage" on the space. */
async function insertSet(ctx: MutationCtx, userId: Id<"users">, workspaceId: Id<"workspaces">, spaceId: Id<"spaces">, def: SetDef) {
  const space = await ctx.db.get(spaceId);
  if (!space || space.kind !== "shared") throw new OneBaseError("السجلات تكون في مساحة مشتركة");
  const clean = def.name.trim();
  if (!clean) throw new OneBaseError("اكتب اسماً لمجموعة السجلات");
  const { columns, subjectColumn } = def;
  if (columns.length === 0 || columns.length > 100) throw new OneBaseError("عرّف عموداً واحداً على الأقل");
  const keys = new Set<string>();
  const headers = new Set<string>();
  for (const c of columns) {
    if (!KEY_RE.test(c.key)) throw new OneBaseError(`مفتاح العمود "${c.key}" غير صالح (حروف لاتينية وأرقام و _)`);
    if (!c.header.trim()) throw new OneBaseError("لكل عمود عنوان كما في ملف Excel");
    if (keys.has(c.key) || headers.has(c.header.trim())) throw new OneBaseError(`عمود مكرر: ${c.header}`);
    keys.add(c.key);
    headers.add(c.header.trim());
  }
  if (!keys.has(subjectColumn)) throw new OneBaseError("اختر عمود رقم الهوية أو الرقم الوظيفي");
  const unique = def.uniqueBy?.length ? def.uniqueBy : [subjectColumn];
  for (const k of unique) if (!keys.has(k)) throw new OneBaseError(`عمود منع التكرار غير معروف: ${k}`);
  const id = await ctx.db.insert("recordSets", {
    workspaceId,
    spaceId,
    name: clean,
    columns: columns.map((c) => ({ ...c, header: c.header.trim(), required: c.required || c.key === subjectColumn })),
    subjectColumn,
    subjectKind: def.subjectKind,
    uniqueBy: unique,
    currentVersion: 0,
    createdBy: userId,
    createdAt: Date.now(),
  });
  await writeAudit(ctx, { userId, action: "records.set_create", resourceType: "recordSet", resourceId: id, spaceId, detail: { name: clean, columns: columns.length } });
  return id;
}

/** Defines a record set (its columns) in a shared space. Space managers only. */
export const createSet = mutation({
  args: { spaceId: v.id("spaces"), name: v.string(), columns: v.array(columnDef), subjectColumn: v.string(), subjectKind, uniqueBy: v.optional(v.array(v.string())) },
  handler: async (ctx, { spaceId, ...def }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "manage");
    return await insertSet(ctx, me.userId, me.workspace._id, spaceId, def);
  },
});

function decode(base64: string): Uint8Array {
  if (base64.length > 15 * 1024 * 1024) throw new OneBaseError("الملف أكبر من 10 م.ب");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

async function parseFor(set: ReturnType<typeof shapeSet>, kind: string, input: unknown) {
  const source = SOURCES[kind];
  if (!source) throw new OneBaseError("مصدر غير معروف");
  let raw: RawTable;
  try {
    raw = await source.read(input);
    return { raw, rows: validateRows(set, raw), errors: [] as string[] };
  } catch (e) {
    if (e instanceof ImportError) return { raw: null, rows: null, errors: e.errors };
    throw e;
  }
}

/** Validates an Excel file against the set and returns a preview. Writes nothing. Managers only. */
export const previewImport = action({
  args: { recordSetId: v.id("recordSets"), fileName: v.string(), dataBase64: v.string() },
  handler: async (ctx, { recordSetId, dataBase64 }): Promise<{ ok: boolean; errors: string[]; rowCount: number; columns: { key: string; header: string }[]; sample: Record<string, Cell>[] }> => {
    const userId = await requireUserId(ctx);
    const set = await ctx.runQuery(internal.records.setForManager, { userId, recordSetId });
    const parsed = await parseFor(set, "excel", { bytes: decode(dataBase64) });
    return {
      ok: parsed.errors.length === 0,
      errors: parsed.errors,
      rowCount: parsed.rows?.length ?? 0,
      columns: set.columns.map((c) => ({ key: c.key, header: c.header })),
      sample: (parsed.rows ?? []).slice(0, 20).map((r) => r.data),
    };
  },
});

/** Validates again and imports every row as a new version, or nothing at all. Managers only. */
export const commitImport = action({
  args: { recordSetId: v.id("recordSets"), fileName: v.string(), dataBase64: v.string() },
  handler: async (ctx, { recordSetId, fileName, dataBase64 }): Promise<{ version: number; rowCount: number }> => {
    const userId = await requireUserId(ctx);
    const set = await ctx.runQuery(internal.records.setForManager, { userId, recordSetId });
    const bytes = decode(dataBase64);
    const parsed = await parseFor(set, "excel", { bytes });
    if (parsed.errors.length) throw new OneBaseError("رُفض الملف ولم يُستورد أي صف:\n" + parsed.errors.join("\n"));
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    try {
      return await ctx.runMutation(internal.records.insertImport, {
        userId,
        recordSetId,
        source: { kind: "excel", name: fileName.slice(0, 255), sha256: sha256Hex(bytes), storageId },
        rows: parsed.rows!,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});

type Analysis = {
  ok: boolean;
  errors: string[];
  name: string;
  rowCount: number;
  columns: InferredColumn[];
  owner: { header: string; kind: "nationalId" | "employeeNo"; matched: number; distinct: number } | null;
  uniqueBy: string[];
};

/**
 * Starting from a file: reads it and guesses a record set (columns and types, the owner column,
 * how many of its ids match accounts, uniqueness). Writes nothing; the manager chooses on the
 * page, then createFromFile. Managers of a shared space only. Only counts of matching accounts
 * are returned, never who they are.
 */
export const analyzeFile = action({
  args: { spaceId: v.id("spaces"), fileName: v.string(), dataBase64: v.string() },
  handler: async (ctx, { spaceId, fileName, dataBase64 }): Promise<Analysis> => {
    const userId = await requireUserId(ctx);
    await ctx.runQuery(internal.records.sharedSpaceForManager, { userId, spaceId });
    const name = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 100);
    let raw: RawTable;
    try {
      raw = await excelSource.read({ bytes: decode(dataBase64) });
      if (raw.headers.length === 0) throw new ImportError(["الصف الأول في الملف فارغ: يجب أن يحوي عناوين الأعمدة"]);
      if (raw.rows.length === 0) throw new ImportError(["الملف لا يحوي أي صف بيانات"]);
    } catch (e) {
      if (e instanceof ImportError) return { ok: false, errors: e.errors, name, rowCount: 0, columns: [], owner: null, uniqueBy: [] };
      throw e;
    }
    const columns = inferColumns(raw);
    let owner: Analysis["owner"] = null;
    for (const header of ownerCandidates(columns).slice(0, 3)) {
      const refs = [...new Set(raw.rows.map((r) => normalizeRef(r.cells[header])).filter(Boolean))].slice(0, 2000);
      const m: { nationalId: number; employeeNo: number } = await ctx.runQuery(internal.records.identityMatches, { userId, refs });
      const kind = m.employeeNo > m.nationalId || (m.nationalId === 0 && /وظيفي|employee/i.test(header)) ? "employeeNo" : "nationalId";
      const cand = { header, kind, matched: m[kind], distinct: refs.length } as const;
      if (!owner || cand.matched > owner.matched) owner = cand;
    }
    const chosen = columns.map((c) => c.header);
    return { ok: true, errors: [], name, rowCount: raw.rows.length, columns, owner, uniqueBy: owner ? suggestUnique(raw, chosen, owner.header) : [] };
  },
});

const chosenColumn = v.object({ header: v.string(), type: v.union(v.literal("text"), v.literal("number"), v.literal("date"), v.literal("boolean")), required: v.boolean() });

/**
 * Creates a record set from the columns the manager chose in a file, and imports that file as
 * version 1, in one transaction. Keys are generated. If any row fails, nothing is created and
 * every error comes back (ok: false), not thrown, so the page can list them.
 */
export const createFromFile = action({
  args: {
    spaceId: v.id("spaces"),
    name: v.string(),
    fileName: v.string(),
    dataBase64: v.string(),
    columns: v.array(chosenColumn),
    ownerHeader: v.string(),
    ownerKind: subjectKind,
    uniqueBy: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; recordSetId: Id<"recordSets">; version: number; rowCount: number } | { ok: false; errors: string[] }> => {
    const userId = await requireUserId(ctx);
    await ctx.runQuery(internal.records.sharedSpaceForManager, { userId, spaceId: args.spaceId });
    const headers = args.columns.map((c) => c.header.trim());
    if (new Set(headers).size !== headers.length) throw new OneBaseError("عمود مكرر في الاختيار");
    if (!headers.includes(args.ownerHeader.trim())) return { ok: false, errors: ["اعتمد عمود صاحب السجل (رقم الهوية أو الرقم الوظيفي)"] };
    const keys = keysFor(headers);
    const columns: ColumnDef[] = args.columns.map((c) => ({ key: keys.get(c.header.trim())!, header: c.header.trim(), type: c.type, required: c.required }));
    const subjectColumn = keys.get(args.ownerHeader.trim())!;
    const uniqueBy = [...new Set(args.uniqueBy.map((h) => keys.get(h.trim())).filter((k): k is string => Boolean(k)))];
    if (!uniqueBy.includes(subjectColumn)) uniqueBy.unshift(subjectColumn);
    const def = { columns, subjectColumn, uniqueBy };
    const bytes = decode(args.dataBase64);
    let rows;
    try {
      rows = validateRows(def, await excelSource.read({ bytes }));
    } catch (e) {
      if (e instanceof ImportError) return { ok: false, errors: e.errors };
      throw e;
    }
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    try {
      const r = await ctx.runMutation(internal.records.createWithImport, {
        userId,
        spaceId: args.spaceId,
        def: { name: args.name, columns, subjectColumn, subjectKind: args.ownerKind, uniqueBy },
        source: { kind: "excel", name: args.fileName.slice(0, 255), sha256: sha256Hex(bytes), storageId },
        rows,
      });
      return { ok: true, ...r };
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});

// ---------- internal ----------

export const setForManager = internalQuery({
  args: { userId: v.id("users"), recordSetId: v.string() },
  handler: async (ctx, { userId, recordSetId }) => {
    await requireActor(ctx, userId);
    const set = await loadSet(ctx, recordSetId);
    await assertCan(ctx, userId, set.spaceId, "manage");
    return shapeSet(set);
  },
});

/** All rows in one transaction: if anything fails, no row of this import exists. */
export const insertImport = internalMutation({
  args: {
    userId: v.id("users"),
    recordSetId: v.id("recordSets"),
    source: v.object({ kind: v.string(), name: v.string(), sha256: v.string(), storageId: v.optional(v.id("_storage")) }),
    rows: v.array(v.object({ rowNo: v.number(), subjectRef: v.string(), data: v.record(v.string(), cellValue) })),
  },
  handler: async (ctx, { userId, recordSetId, source, rows }) => {
    await requireActor(ctx, userId);
    const set = await loadSet(ctx, recordSetId);
    await assertCan(ctx, userId, set.spaceId, "manage");
    return await writeImport(ctx, userId, set, source, rows);
  },
});

type ImportSource = { kind: string; name: string; sha256: string; storageId?: Id<"_storage"> };
type ImportRow = { rowNo: number; subjectRef: string; data: Record<string, Cell> };

/** Writes every row as the set's next version. Validates once more inside the transaction (the action may be stale). */
async function writeImport(ctx: MutationCtx, userId: Id<"users">, set: Doc<"recordSets">, source: ImportSource, rows: ImportRow[]) {
  const again = validateRows(set, { headers: set.columns.map((c) => c.header), rows: rows.map((r) => ({ rowNo: r.rowNo, cells: Object.fromEntries(set.columns.map((c) => [c.header, r.data[c.key]])) })) });
  const version = set.currentVersion + 1;
  for (const r of again) await ctx.db.insert("records", { recordSetId: set._id, spaceId: set.spaceId, version, rowNo: r.rowNo, subjectRef: r.subjectRef, data: r.data });
  await ctx.db.insert("recordImports", { recordSetId: set._id, spaceId: set.spaceId, version, source, rowCount: again.length, importedBy: userId, importedAt: Date.now() });
  await ctx.db.patch(set._id, { currentVersion: version });
  await writeAudit(ctx, { userId, action: "records.import", resourceType: "recordSet", resourceId: set._id, spaceId: set.spaceId, detail: { name: set.name, version, rows: again.length, source: source.kind, fileName: source.name } });
  return { version, rowCount: again.length };
}

/** query_records: members of the records' space only; sensitive spaces are audited. */
export const queryForUser = internalMutation({
  args: { userId: v.id("users"), scopeSpaceIds: v.array(v.string()), recordSetId: v.optional(v.string()), subjectRef: v.optional(v.string()), filters: v.optional(v.record(v.string(), v.any())), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, scopeSpaceIds, ...args }) => {
    const res = await queryRecords(ctx, userId, args, new Set(scopeSpaceIds));
    for (const s of res.sets) {
      const space = await ctx.db.get(s.spaceId);
      if (space?.sensitive) await writeAudit(ctx, { userId, action: "records.query", resourceType: "recordSet", resourceId: s.recordSetId, spaceId: s.spaceId, detail: { name: s.setName, rows: s.rows.length, via: "agent" } });
    }
    return res;
  },
});

/** my_records: identity comes from the userId the server passes in (the session), nothing else. */
export const mineForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) => myRecords(ctx, userId),
});

export const sharedSpaceForManager = internalQuery({
  args: { userId: v.id("users"), spaceId: v.id("spaces") },
  handler: async (ctx, { userId, spaceId }) => {
    await requireActor(ctx, userId);
    const { space } = await assertCan(ctx, userId, spaceId, "manage");
    if (space.kind !== "shared") throw new OneBaseError("السجلات تكون في مساحة مشتركة");
    return null;
  },
});

/** How many of these ids belong to accounts of the caller's workspace, per kind. Counts only. */
export const identityMatches = internalQuery({
  args: { userId: v.id("users"), refs: v.array(v.string()) },
  handler: async (ctx, { userId, refs }) => {
    const actor = await requireActor(ctx, userId);
    const out = { nationalId: 0, employeeNo: 0 };
    for (const ref of refs.slice(0, 2000)) {
      for (const kind of ["nationalId", "employeeNo"] as const) {
        const users = await ctx.db.query("users").withIndex(kind === "nationalId" ? "by_nationalId" : "by_employeeNo", (q: any) => q.eq(kind, ref)).collect();
        for (const u of users) if ((await ctx.components.workspace.role({ teamId: actor.workspace.teamId, userId: u._id })) !== null) { out[kind]++; break; }
      }
    }
    return out;
  },
});

/** The set and its first version in one transaction: a file that fails leaves no empty set behind. */
export const createWithImport = internalMutation({
  args: {
    userId: v.id("users"),
    spaceId: v.id("spaces"),
    def: v.object({ name: v.string(), columns: v.array(columnDef), subjectColumn: v.string(), subjectKind, uniqueBy: v.array(v.string()) }),
    source: v.object({ kind: v.string(), name: v.string(), sha256: v.string(), storageId: v.optional(v.id("_storage")) }),
    rows: v.array(v.object({ rowNo: v.number(), subjectRef: v.string(), data: v.record(v.string(), cellValue) })),
  },
  handler: async (ctx, { userId, spaceId, def, source, rows }) => {
    const actor = await requireActor(ctx, userId);
    await assertCan(ctx, userId, spaceId, "manage");
    const id = await insertSet(ctx, userId, actor.workspace._id, spaceId, def);
    const set = (await ctx.db.get(id))!;
    const r = await writeImport(ctx, userId, set, source, rows);
    return { recordSetId: id, ...r };
  },
});
