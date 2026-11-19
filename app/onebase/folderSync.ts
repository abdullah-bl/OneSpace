// Folder sync (plans/08 §C, "shared folders synced on a schedule"): copies a folder on the server
// (typically a network share mounted under SYNC_ROOT, e.g. SharePoint/SMB through a mount) into a
// shared space, so its documents can be searched and cited without uploading them by hand.
//
// - Only under SYNC_ROOT (unset = the feature is off). Paths are resolved with realpath, so ".."
//   and symlinks can't reach outside it.
// - Files are added as the person who set up the sync, who must be able to write the space now;
//   the space's own permissions decide who reads them (the share's permissions are not mirrored:
//   pick a space whose members may see the whole folder).
// - New files are added, changed ones become a new version, removed ones stay (nothing is deleted).
// - Every run is audited; at most MAX_CHANGES files are copied per run, the rest wait for the next.

import { OneBaseError, v } from "onebase/values";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { actorFor, assertCan, requireAdmin, requireUserId } from "./access";
import { writeAudit } from "./audit";
import { scheduleIngest } from "./ingest";

const DEFAULT_EXT = ["pdf", "docx", "doc", "xlsx", "xls", "csv", "pptx", "txt", "md", "html", "png", "jpg", "jpeg"];
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CHANGES = 200;
const MAX_ENTRIES = 20_000;
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
};

export const syncRoot = () => process.env.SYNC_ROOT?.trim() || null;

/** The absolute folder for a relative path, or an error if it leaves SYNC_ROOT. */
export async function resolveFolder(rel: string): Promise<string> {
  const root = syncRoot();
  if (!root) throw new OneBaseError("مزامنة المجلدات غير مفعّلة: اضبط SYNC_ROOT في إعدادات الخادم");
  const realRoot = await realpath(root);
  const clean = String(rel).replace(/^[\\/]+/, "");
  if (clean.split(/[\\/]/).includes("..")) throw new OneBaseError("مسار غير مسموح");
  let full: string;
  try {
    full = await realpath(join(realRoot, clean));
  } catch {
    throw new OneBaseError("المجلد غير موجود");
  }
  if (full !== realRoot && !full.startsWith(realRoot + sep)) throw new OneBaseError("المسار خارج مجلد المزامنة");
  if (!(await stat(full)).isDirectory()) throw new OneBaseError("المسار ليس مجلداً");
  return full;
}

// ---------------------------------------------------------------- admin

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const rows = await ctx.db.query("folderSyncs").collect();
    const out = [];
    for (const r of rows) {
      const space = await ctx.db.get(r.spaceId);
      const files = await ctx.db.query("syncedFiles").withIndex("by_sync_path", (q) => q.eq("syncId", r._id)).collect();
      out.push({ ...r, spaceName: space?.name ?? "—", files: files.length, mine: r.createdBy === me.userId });
    }
    return { syncs: out, root: syncRoot(), defaultExtensions: DEFAULT_EXT };
  },
});

export const save = mutation({
  args: { syncId: v.optional(v.string()), spaceId: v.string(), path: v.string(), extensions: v.array(v.string()), recursive: v.boolean(), intervalMinutes: v.number(), enabled: v.boolean() },
  handler: async (ctx, a) => {
    const me = await requireAdmin(ctx);
    if (!syncRoot()) throw new OneBaseError("مزامنة المجلدات غير مفعّلة: اضبط SYNC_ROOT في إعدادات الخادم");
    const { space } = await assertCan(ctx, me.userId, a.spaceId, "write");
    if (space.kind !== "shared") throw new OneBaseError("اختر مساحة مشتركة");
    const path = a.path.trim().replace(/^[\\/]+/, "");
    if (path.split(/[\\/]/).includes("..")) throw new OneBaseError("مسار غير مسموح");
    const extensions = [...new Set(a.extensions.map((e) => e.trim().toLowerCase().replace(/^\./, "")).filter((e) => /^[a-z0-9]{1,8}$/.test(e)))];
    const row = {
      spaceId: space._id,
      path,
      extensions,
      recursive: a.recursive,
      intervalMinutes: Math.min(Math.max(Math.round(a.intervalMinutes) || 60, 15), 7 * 24 * 60),
      enabled: a.enabled,
    };
    if (a.syncId) {
      const id = ctx.db.normalizeId("folderSyncs", a.syncId);
      const cur = id ? await ctx.db.get(id) : null;
      if (!cur) throw new OneBaseError("المزامنة غير موجودة");
      await ctx.db.patch(cur._id, { ...row, createdBy: me.userId, nextRunAt: Date.now() });
      await writeAudit(ctx, { userId: me.userId, action: "sync.update", resourceType: "folderSync", resourceId: cur._id, spaceId: space._id, detail: { path, enabled: a.enabled } });
      return cur._id;
    }
    const id = await ctx.db.insert("folderSyncs", { ...row, createdBy: me.userId, nextRunAt: Date.now(), createdAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "sync.create", resourceType: "folderSync", resourceId: id, spaceId: space._id, detail: { path } });
    return id;
  },
});

export const remove = mutation({
  args: { syncId: v.string() },
  handler: async (ctx, { syncId }) => {
    const me = await requireAdmin(ctx);
    const id = ctx.db.normalizeId("folderSyncs", syncId);
    const cur = id ? await ctx.db.get(id) : null;
    if (!cur) return;
    for (const f of await ctx.db.query("syncedFiles").withIndex("by_sync_path", (q) => q.eq("syncId", cur._id)).collect()) await ctx.db.delete(f._id);
    await ctx.db.delete(cur._id);
    // The files it added stay in the space.
    await writeAudit(ctx, { userId: me.userId, action: "sync.delete", resourceType: "folderSync", resourceId: cur._id, spaceId: cur.spaceId, detail: { path: cur.path } });
  },
});

/** «زامن الآن». */
export const runNow = action({
  args: { syncId: v.string() },
  handler: async (ctx, { syncId }) => {
    const userId = await requireUserId(ctx);
    if (!(await ctx.runQuery(internal.folderSync.isAdmin, { userId }))) throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
    return await runSync(ctx, syncId as Id<"folderSyncs">);
  },
});

/** What's under SYNC_ROOT, to pick a folder (admin). */
export const browse = action({
  args: { path: v.string() },
  handler: async (ctx, { path }) => {
    const userId = await requireUserId(ctx);
    if (!(await ctx.runQuery(internal.folderSync.isAdmin, { userId }))) throw new OneBaseError("هذا الإجراء لمدير مساحة العمل فقط");
    const full = await resolveFolder(path);
    const entries = await readdir(full, { withFileTypes: true });
    return {
      path: relative(await realpath(syncRoot()!), full),
      folders: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort().slice(0, 200),
      files: entries.filter((e) => e.isFile()).length,
    };
  },
});

export const isAdmin = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => (await actorFor(ctx, userId))?.role === "admin",
});

// ---------------------------------------------------------------- running

export const due = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("folderSyncs").withIndex("by_due", (q) => q.eq("enabled", true).lte("nextRunAt", Date.now())).take(5)).map((r) => r._id),
});

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!syncRoot()) return;
    for (const id of await ctx.runQuery(internal.folderSync.due, {})) await runSync(ctx, id);
  },
});

/** Claims a run (no two at once) and returns what it needs, or null. */
export const begin = internalMutation({
  args: { syncId: v.id("folderSyncs") },
  handler: async (ctx, { syncId }) => {
    const s = await ctx.db.get(syncId);
    if (!s || (s.running && s.lastRun && Date.now() - s.lastRun.at < 30 * 60_000)) return null;
    // The person it runs as must still be able to write the space.
    try {
      await assertCan(ctx, s.createdBy, s.spaceId, "write");
    } catch {
      await ctx.db.patch(syncId, { nextRunAt: Date.now() + s.intervalMinutes * 60_000, lastRun: { at: Date.now(), added: 0, updated: 0, unchanged: 0, skipped: 0, error: "من أعدّ المزامنة لم يعد يملك الكتابة في المساحة" } });
      return null;
    }
    await ctx.db.patch(syncId, { running: true });
    const known = await ctx.db.query("syncedFiles").withIndex("by_sync_path", (q) => q.eq("syncId", syncId)).collect();
    return { path: s.path, extensions: s.extensions.length ? s.extensions : DEFAULT_EXT, recursive: s.recursive, known: known.map((k) => ({ relPath: k.relPath, size: k.size, mtime: k.mtime, sha256: k.sha256 })) };
  },
});

export const applyFile = internalMutation({
  args: { syncId: v.id("folderSyncs"), relPath: v.string(), storageId: v.id("_storage"), size: v.number(), mtime: v.number(), sha256: v.string() },
  handler: async (ctx, a) => {
    const s = await ctx.db.get(a.syncId);
    if (!s) return "gone";
    const name = a.relPath.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, "_").slice(0, 255);
    const ext = name.toLowerCase().split(".").pop() ?? "";
    const mime = MIME[ext] ?? "application/octet-stream";
    const now = Date.now();
    const seen = await ctx.db.query("syncedFiles").withIndex("by_sync_path", (q) => q.eq("syncId", a.syncId).eq("relPath", a.relPath)).unique();
    const file = seen ? await ctx.db.get(seen.fileId) : null;
    if (seen && file && file.spaceId === s.spaceId) {
      if (seen.sha256 === a.sha256) {
        await ctx.db.patch(seen._id, { size: a.size, mtime: a.mtime });
        await ctx.storage.delete(a.storageId);
        return "unchanged";
      }
      const version = file.version + 1;
      await ctx.db.insert("fileVersions", { fileId: file._id, version, storageId: a.storageId, name, mime, size: a.size, sha256: a.sha256, uploadedBy: s.createdBy, uploadedAt: now });
      await ctx.db.patch(file._id, { storageId: a.storageId, name, mime, size: a.size, sha256: a.sha256, version, uploadedBy: s.createdBy, updatedAt: now, ingest: "pending" });
      await ctx.db.patch(seen._id, { size: a.size, mtime: a.mtime, sha256: a.sha256 });
      await scheduleIngest(ctx, file._id);
      return "updated";
    }
    // New (or its earlier copy was deleted / moved out of the space): add it.
    const fileId = await ctx.db.insert("files", { spaceId: s.spaceId, storageId: a.storageId, name, mime, size: a.size, sha256: a.sha256, version: 1, uploadedBy: s.createdBy, ingest: "pending", status: "active", updatedAt: now });
    await ctx.db.insert("fileVersions", { fileId, version: 1, storageId: a.storageId, name, mime, size: a.size, sha256: a.sha256, uploadedBy: s.createdBy, uploadedAt: now });
    if (seen) await ctx.db.patch(seen._id, { fileId, size: a.size, mtime: a.mtime, sha256: a.sha256 });
    else await ctx.db.insert("syncedFiles", { syncId: a.syncId, relPath: a.relPath, fileId, size: a.size, mtime: a.mtime, sha256: a.sha256 });
    await scheduleIngest(ctx, fileId);
    return "added";
  },
});

export const finish = internalMutation({
  args: { syncId: v.id("folderSyncs"), added: v.number(), updated: v.number(), unchanged: v.number(), skipped: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, { syncId, ...r }) => {
    const s = await ctx.db.get(syncId);
    if (!s) return;
    await ctx.db.patch(syncId, { running: false, lastRun: { at: Date.now(), ...r }, nextRunAt: Date.now() + s.intervalMinutes * 60_000 });
    if (r.added || r.updated || r.error)
      await writeAudit(ctx, { userId: s.createdBy, action: "sync.run", resourceType: "folderSync", resourceId: syncId, spaceId: s.spaceId, detail: { path: s.path, added: r.added, updated: r.updated, skipped: r.skipped, error: r.error ?? null } });
  },
});

async function runSync(ctx: { runQuery: any; runMutation: any; storage: any }, syncId: Id<"folderSyncs">) {
  const job = await ctx.runMutation(internal.folderSync.begin, { syncId });
  if (!job) return { started: false };
  const counts = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  let error: string | undefined;
  try {
    const root = await resolveFolder(job.path);
    const known = new Map<string, { size: number; mtime: number }>(job.known.map((k: any) => [k.relPath, k]));
    const exts = new Set<string>(job.extensions);
    let changes = 0;
    let seen = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (++seen > MAX_ENTRIES || changes >= MAX_CHANGES) return;
        if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (job.recursive) await walk(full);
          continue;
        }
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        const ext = e.name.toLowerCase().split(".").pop() ?? "";
        if (!exts.has(ext)) continue;
        let real: string;
        try {
          real = await realpath(full);
        } catch {
          continue;
        }
        if (!real.startsWith(root + sep)) {
          counts.skipped++;
          continue;
        }
        const st = await stat(real);
        if (!st.isFile()) continue;
        if (st.size > MAX_FILE_BYTES || st.size === 0) {
          counts.skipped++;
          continue;
        }
        const rel = relative(root, full);
        const k = known.get(rel);
        if (k && k.size === st.size && k.mtime === Math.floor(st.mtimeMs)) {
          counts.unchanged++;
          continue;
        }
        const bytes = await readFile(real);
        const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const storageId = await ctx.storage.store(new Blob([bytes]));
        const r = await ctx.runMutation(internal.folderSync.applyFile, { syncId, relPath: rel, storageId, size: st.size, mtime: Math.floor(st.mtimeMs), sha256 });
        if (r === "added") counts.added++, changes++;
        else if (r === "updated") counts.updated++, changes++;
        else counts.unchanged++;
      }
    };
    await walk(root);
  } catch (e) {
    error = e instanceof OneBaseError ? e.message : "تعذّرت قراءة المجلد";
  }
  await ctx.runMutation(internal.folderSync.finish, { syncId, ...counts, ...(error ? { error } : {}) });
  return { started: true, ...counts, error };
}


