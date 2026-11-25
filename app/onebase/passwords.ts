// Passwords set from the app rather than by signing up: the admin's temporary password for an
// employee (new or forgotten), an employee changing their own, and the first admin's password when
// sign-up is closed. Hashing runs in actions (ctx.auth.setPassword); the checks and the audit
// entries run in mutations around it.

import { getAuthUserId } from "onebase/server";
import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { Denied, requireAdmin, statusOf } from "./access";
import { writeAudit } from "./audit";

const MIN_LENGTH = 8;
// No 0/O, 1/l/I: the admin reads it out or types it into a message.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 12 random characters (≈69 bits), from the system's secure random source. */
export function temporaryPassword(length = 12): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length); // reject the bias at the top of the byte range
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(ALPHABET[b % ALPHABET.length]!);
    }
  }
  return out.join("");
}

/** Hashing errors from onebase (no password sign-in, too many wrong answers) in the app's words. */
function arabic(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Too many wrong passwords/i.test(msg)) throw new OneBaseError("محاولات خاطئة كثيرة. حاول بعد ساعة.");
  if (/password\(\)|needs password/i.test(msg)) throw new OneBaseError("الدخول بكلمة مرور غير مفعّل على هذا الخادم؛ يدخل الموظفون بحساب الجهة.");
  throw err;
}

export const canIssue = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await requireAdmin(ctx);
    if (userId === me.userId) throw new OneBaseError("غيّر كلمة مرورك من قائمتك: «تغيير كلمة المرور»");
    const user = await ctx.db.get(userId);
    if (!user) throw new Denied();
    if (statusOf(user) === "disabled") throw new OneBaseError("الحساب معطّل؛ أعد تفعيله أولاً");
    if (!user.email) throw new OneBaseError("لا بريد لهذا الحساب");
    return null;
  },
});

export const recordIssue = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await requireAdmin(ctx);
    await ctx.db.patch(userId, { mustChangePassword: true });
    await writeAudit(ctx, { userId: me.userId, action: "user.password_issue", resourceType: "user", resourceId: userId });
  },
});

/**
 * A temporary password for an employee, shown once to the admin. Their other sessions end, and
 * the app asks them for a new password at the next sign-in. Admin only.
 */
export const issue = action({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ password: string }> => {
    await ctx.runQuery(internal.passwords.canIssue, { userId });
    const password = temporaryPassword();
    await ctx.auth.setPassword(userId, password).catch(arabic);
    await ctx.runMutation(internal.passwords.recordIssue, { userId });
    return { password };
  },
});

export const recordChange = internalMutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Denied();
    await ctx.db.patch(userId, { mustChangePassword: false });
    await writeAudit(ctx, { userId, action: "user.password_change", resourceType: "user", resourceId: userId });
  },
});

/** The signed-in user's own password, after checking the current one. This session stays signed in. */
export const change = action({
  args: { current: v.string(), next: v.string() },
  handler: async (ctx, { current, next }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new OneBaseError("سجّل الدخول أولاً");
    if (next.length < MIN_LENGTH) throw new OneBaseError(`كلمة المرور الجديدة ${MIN_LENGTH} أحرف على الأقل`);
    if (next === current) throw new OneBaseError("اختر كلمة مرور غير الحالية");
    const ok = await ctx.auth.verifyPassword(userId, current).catch(arabic);
    if (!ok) throw new OneBaseError("كلمة المرور الحالية غير صحيحة");
    await ctx.auth.setPassword(userId, next).catch(arabic);
    await ctx.runMutation(internal.passwords.recordChange, {});
  },
});

/**
 * The first admin (scripts/bootstrap-admin.ts, admin key only). Makes the account when sign-up is
 * closed and returns a temporary password for it; an account that already exists keeps its own.
 */
export const bootstrap = internalAction({
  args: { email: v.string(), workspaceName: v.optional(v.string()), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ userId: string; password: string | null }> => {
    const r: { userId: any; created: boolean } = await ctx.runMutation(internal.admin.bootstrap, { ...args, create: true });
    if (!r.created) return { userId: r.userId, password: null };
    const password = temporaryPassword();
    try {
      await ctx.auth.setPassword(r.userId, password);
    } catch {
      return { userId: r.userId, password: null }; // SSO only: the admin signs in with the organization account
    }
    await ctx.runMutation(internal.passwords.markTemporary, { userId: r.userId });
    return { userId: r.userId, password };
  },
});

export const markTemporary = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await ctx.db.patch(userId, { mustChangePassword: true });
  },
});
