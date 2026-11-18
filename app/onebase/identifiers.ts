// National id / employee number on accounts. Only the workspace admin sets them (admin.ts);
// my_records and "بياناتي" match records on them and on nothing else. Each number belongs to
// at most one account, or a person could see someone else's records.

import { OneBaseError } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { normalizeRef } from "./recordSources";

export async function assignIdentifiers(ctx: MutationCtx, userId: Id<"users">, ids: { nationalId?: string | null; employeeNo?: string | null }) {
  const patch: { nationalId?: string; employeeNo?: string } = {};
  for (const field of ["nationalId", "employeeNo"] as const) {
    const raw = ids[field];
    if (raw === undefined) continue;
    const value = raw === null ? "" : normalizeRef(raw);
    if (value && !/^[A-Za-z0-9]{1,32}$/.test(value)) throw new OneBaseError(field === "nationalId" ? "رقم الهوية غير صالح" : "الرقم الوظيفي غير صالح");
    if (value) {
      const taken = await ctx.db.query("users").withIndex(field === "nationalId" ? "by_nationalId" : "by_employeeNo", (q: any) => q.eq(field, value)).collect();
      if (taken.some((u) => u._id !== userId)) throw new OneBaseError(field === "nationalId" ? "رقم الهوية مسجّل لحساب آخر" : "الرقم الوظيفي مسجّل لحساب آخر");
    }
    patch[field] = value || undefined;
  }
  if (Object.keys(patch).length) await ctx.db.patch(userId, patch);
  return patch;
}
