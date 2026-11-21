// Linking employees to their national id / employee number from a staff file (plans/17 §2),
// instead of typing each number on each account. The workspace admin uploads an Excel file
// (email + id columns); accounts are matched by email; the page shows what will change, what
// is already set, and what can't be done (no account, a number held by another account, the
// same number twice in the file) before anything is saved. Applying recomputes the plan inside
// one transaction and sets only the rows that are still clean. Empty cells never clear a
// number. Each changed account gets the same audit entry as admin:setIdentifiers.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, requireUserId } from "./access";
import { writeAudit } from "./audit";
import { assignIdentifiers } from "./identifiers";
import { excelSource, ImportError, inferColumns, normalizeRef, type RawTable } from "./recordSources";

type Ctx = QueryCtx | MutationCtx;
const ID_FIELDS = ["nationalId", "employeeNo"] as const;
type IdField = (typeof ID_FIELDS)[number];

export type Mapping = { email: string; nationalId: string | null; employeeNo: string | null };
type StaffRow = { rowNo: number; email: string; nationalId: string | null; employeeNo: string | null };
export type PlanRow = StaffRow & {
  status: "set" | "same" | "notFound" | "conflict" | "invalid";
  reason: string | null;
  userId: Id<"users"> | null;
  name: string | null;
  current: { nationalId: string | null; employeeNo: string | null } | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9]{1,32}$/;
const LABEL: Record<IdField, string> = { nationalId: "رقم الهوية", employeeNo: "الرقم الوظيفي" };

/** Best guess of which header holds what. The admin can change each one on the page. */
export function guessMapping(raw: RawTable): Mapping {
  const cols = inferColumns(raw);
  const emailish = (h: string) => raw.rows.filter((r) => typeof r.cells[h] === "string" && String(r.cells[h]).includes("@")).length;
  const email = [...raw.headers].sort((a, b) => emailish(b) - emailish(a))[0] ?? "";
  // Employee numbers are often short or alphanumeric (E-100): found by header. National ids by header, else any all-digits column.
  const others = raw.headers.filter((h) => h !== email);
  const employeeNo = others.find((h) => /الرقم الوظيفي|رقم وظيفي|وظيفي|employee|staff/i.test(h)) ?? null;
  const ids = cols.filter((c) => c.idLike && c.header !== email && c.header !== employeeNo).map((c) => c.header);
  const nationalId = others.find((h) => h !== employeeNo && /هوية|سجل مدني|إقامة|national/i.test(h)) ?? ids[0] ?? null;
  return { email: emailish(email) > 0 ? email : "", nationalId, employeeNo };
}

function rowsOf(raw: RawTable, m: Mapping): StaffRow[] {
  const cell = (r: RawTable["rows"][number], h: string | null) => {
    if (!h) return null;
    const s = normalizeRef(r.cells[h]);
    return s || null;
  };
  return raw.rows.map((r) => ({
    rowNo: r.rowNo,
    email: String(r.cells[m.email] ?? "").trim().toLowerCase(),
    nationalId: cell(r, m.nationalId),
    employeeNo: cell(r, m.employeeNo),
  }));
}

async function userByEmail(ctx: Ctx, email: string): Promise<Doc<"users"> | null> {
  const exact = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).first();
  if (exact) return exact;
  // Emails are stored as typed at sign-up: fall back to a case-insensitive scan.
  const all = await ctx.db.query("users").collect();
  return all.find((u) => (u.email ?? "").trim().toLowerCase() === email) ?? null;
}

/** What applying the file would do, row by row, against the accounts as they are now. */
async function planFor(ctx: Ctx, teamId: Doc<"workspaces">["teamId"], rows: StaffRow[]): Promise<PlanRow[]> {
  const seenEmail = new Map<string, number>();
  const seenId: Record<IdField, Map<string, string>> = { nationalId: new Map(), employeeNo: new Map() };
  for (const r of rows) for (const f of ID_FIELDS) if (r[f]) {
    const prev = seenId[f].get(r[f]!);
    seenId[f].set(r[f]!, prev && prev !== r.email ? "*" : r.email);
  }
  const out: PlanRow[] = [];
  for (const r of rows) {
    const base = { ...r, userId: null, name: null, current: null };
    const fail = (status: PlanRow["status"], reason: string): PlanRow => ({ ...base, status, reason });
    if (!EMAIL_RE.test(r.email)) { out.push(fail("invalid", r.email ? "البريد غير صالح" : "البريد فارغ")); continue; }
    if (seenEmail.has(r.email)) { out.push(fail("invalid", `البريد مكرر مع الصف ${seenEmail.get(r.email)}`)); continue; }
    seenEmail.set(r.email, r.rowNo);
    if (!r.nationalId && !r.employeeNo) { out.push(fail("invalid", "لا رقم في هذا الصف")); continue; }
    const bad = ID_FIELDS.find((f) => r[f] && !ID_RE.test(r[f]!));
    if (bad) { out.push(fail("invalid", `${LABEL[bad]} غير صالح`)); continue; }
    const user = await userByEmail(ctx, r.email);
    const member = user ? (await (ctx as any).components.workspace.role({ teamId, userId: user._id })) !== null : false;
    if (!user || !member) { out.push(fail("notFound", "لا يوجد حساب مفعّل بهذا البريد")); continue; }
    const current = { nationalId: user.nationalId ? normalizeRef(user.nationalId) : null, employeeNo: user.employeeNo ? normalizeRef(user.employeeNo) : null };
    const found = { ...base, userId: user._id, name: user.name ?? null, current };
    let conflict: string | null = null;
    for (const f of ID_FIELDS) {
      const value = r[f];
      if (!value) continue;
      // A number twice in the file is ambiguous, except for the account that already holds it: the other row is then "held by another account".
      if (seenId[f].get(value) === "*" && current[f] !== value) { conflict = `${LABEL[f]} مكرر لأكثر من بريد في الملف`; break; }
      const taken = await ctx.db.query("users").withIndex(f === "nationalId" ? "by_nationalId" : "by_employeeNo", (q: any) => q.eq(f, value)).collect();
      if (taken.some((u) => u._id !== user._id)) { conflict = `${LABEL[f]} مسجّل لحساب آخر`; break; }
    }
    if (conflict) { out.push({ ...found, status: "conflict", reason: conflict }); continue; }
    const changes = ID_FIELDS.some((f) => r[f] && r[f] !== current[f]);
    out.push({ ...found, status: changes ? "set" : "same", reason: null });
  }
  return out;
}

async function requireAdminId(ctx: Ctx, userId: Id<"users">) {
  const actor = await actorFor(ctx, userId);
  if (!actor || actor.role !== "admin") throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
  return actor;
}

function decode(base64: string) {
  if (base64.length > 15 * 1024 * 1024) throw new OneBaseError("الملف أكبر من 10 م.ب");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

const mappingArg = v.object({ email: v.string(), nationalId: v.union(v.string(), v.null()), employeeNo: v.union(v.string(), v.null()) });
const rowArg = v.object({ rowNo: v.number(), email: v.string(), nationalId: v.union(v.string(), v.null()), employeeNo: v.union(v.string(), v.null()) });

type Analysis = { ok: boolean; errors: string[]; headers: string[]; mapping: Mapping; rows: PlanRow[]; counts: Record<PlanRow["status"], number> };

async function readStaff(dataBase64: string): Promise<RawTable> {
  const raw = await excelSource.read({ bytes: decode(dataBase64) });
  if (raw.rows.length === 0) throw new ImportError(["الملف لا يحوي أي صف بيانات"]);
  return raw;
}

function checkMapping(raw: RawTable, m: Mapping) {
  const errors: string[] = [];
  if (!m.email || !raw.headers.includes(m.email)) errors.push("اختر عمود البريد");
  for (const f of ID_FIELDS) if (m[f] && !raw.headers.includes(m[f]!)) errors.push(`العمود "${m[f]}" غير موجود في الملف`);
  if (!m.nationalId && !m.employeeNo) errors.push("اختر عمود رقم الهوية أو الرقم الوظيفي");
  if (m.nationalId && m.nationalId === m.employeeNo) errors.push("اختر عمودين مختلفين للرقمين");
  return errors;
}

const countOf = (rows: PlanRow[]) => {
  const c = { set: 0, same: 0, notFound: 0, conflict: 0, invalid: 0 };
  for (const r of rows) c[r.status]++;
  return c;
};

/** Reads a staff file and shows what applying it would do. Writes nothing. Workspace admin only. */
export const analyze = action({
  args: { dataBase64: v.string(), mapping: v.optional(mappingArg) },
  handler: async (ctx, { dataBase64, mapping }): Promise<Analysis> => {
    const userId = await requireUserId(ctx);
    await ctx.runQuery(internal.staffFile.checkAdmin, { userId });
    const empty = { headers: [], mapping: { email: "", nationalId: null, employeeNo: null }, rows: [], counts: countOf([]) };
    let raw: RawTable;
    try {
      raw = await readStaff(dataBase64);
    } catch (e) {
      if (e instanceof ImportError) return { ok: false, errors: e.errors, ...empty };
      throw e;
    }
    const m = mapping ?? guessMapping(raw);
    const errors = checkMapping(raw, m);
    if (errors.length) return { ok: false, errors, ...empty, headers: raw.headers, mapping: m };
    const rows: PlanRow[] = await ctx.runQuery(internal.staffFile.plan, { userId, rows: rowsOf(raw, m) });
    return { ok: true, errors: [], headers: raw.headers, mapping: m, rows, counts: countOf(rows) };
  },
});

/** Sets the numbers of every row that is still clean, in one transaction. Workspace admin only. */
export const apply = action({
  args: { dataBase64: v.string(), mapping: mappingArg, fileName: v.string() },
  handler: async (ctx, { dataBase64, mapping, fileName }): Promise<{ set: number; unchanged: number; skipped: number }> => {
    const userId = await requireUserId(ctx);
    await ctx.runQuery(internal.staffFile.checkAdmin, { userId });
    let raw: RawTable;
    try {
      raw = await readStaff(dataBase64);
    } catch (e) {
      if (e instanceof ImportError) throw new OneBaseError(e.errors.join("\n"));
      throw e;
    }
    const errors = checkMapping(raw, mapping);
    if (errors.length) throw new OneBaseError(errors.join("\n"));
    return await ctx.runMutation(internal.staffFile.applyRows, { userId, rows: rowsOf(raw, mapping), fileName: fileName.slice(0, 255) });
  },
});

export const checkAdmin = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireAdminId(ctx, userId);
    return null;
  },
});

export const plan = internalQuery({
  args: { userId: v.id("users"), rows: v.array(rowArg) },
  handler: async (ctx, { userId, rows }) => {
    const actor = await requireAdminId(ctx, userId);
    return await planFor(ctx, actor.workspace.teamId, rows);
  },
});

export const applyRows = internalMutation({
  args: { userId: v.id("users"), rows: v.array(rowArg), fileName: v.string() },
  handler: async (ctx, { userId, rows, fileName }) => {
    const actor = await requireAdminId(ctx, userId);
    const planned = await planFor(ctx, actor.workspace.teamId, rows);
    let set = 0;
    for (const r of planned) {
      if (r.status !== "set" || !r.userId) continue;
      const ids: { nationalId?: string; employeeNo?: string } = {};
      for (const f of ID_FIELDS) if (r[f]) ids[f] = r[f]!;
      const patch = await assignIdentifiers(ctx, r.userId, ids);
      await writeAudit(ctx, {
        userId,
        action: "user.identifiers",
        resourceType: "user",
        resourceId: r.userId,
        detail: { nationalId: "nationalId" in patch ? "set" : null, employeeNo: "employeeNo" in patch ? "set" : null, via: "file", fileName },
      });
      set++;
    }
    const unchanged = planned.filter((r) => r.status === "same").length;
    return { set, unchanged, skipped: planned.length - set - unchanged };
  },
});
