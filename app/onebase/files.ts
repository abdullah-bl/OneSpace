// Files live in exactly one space and inherit its permissions. Raw storage ids and
// /api/storage URLs never reach the client: onebase serves /api/storage/<id> to anyone holding
// the id (no auth check), so downloads go through the /download HTTP route (http.ts), which
// re-checks access with assertCan before streaming the bytes.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { assertCan, Denied, requireActive, type Actor } from "./access";
import { writeAudit } from "./audit";
import { moveIndex, scheduleIngest, unindexFile } from "./ingest";

const TICKET_TTL_MS = 60_000;

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

async function personalSpaceId(ctx: MutationCtx, me: Actor): Promise<Id<"spaces">> {
  const own = await ctx.db.query("spaces").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).collect();
  const space = own.find((s) => s.kind === "personal" && s.workspaceId === me.workspace._id);
  if (!space) throw new OneBaseError("لا توجد مساحة خاصة لحسابك");
  return space._id;
}

async function loadFile(ctx: MutationCtx | any, fileId: string): Promise<Doc<"files">> {
  const id = ctx.db.normalizeId("files", fileId);
  const file = id ? await ctx.db.get(id) : null;
  if (!file) throw new Denied();
  return file;
}

/** Throws unless a client-supplied storage id is a real upload that no file uses yet (no claiming other people's bytes). */
async function claimStorage(ctx: MutationCtx, storageId: Id<"_storage">) {
  const meta = await ctx.storage.getMetadata(storageId);
  if (!meta) throw new OneBaseError("لم يكتمل رفع الملف");
  const usedByFile = await ctx.db.query("files").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  const usedByVersion = await ctx.db.query("fileVersions").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  if (usedByFile || usedByVersion) throw new Denied();
  return meta;
}

/** Deletes stored bytes once no file or version points at them (copies share bytes). */
async function releaseStorage(ctx: MutationCtx, storageId: Id<"_storage">) {
  const usedByFile = await ctx.db.query("files").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  const usedByVersion = await ctx.db.query("fileVersions").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  if (!usedByFile && !usedByVersion) await ctx.storage.delete(storageId);
}

function cleanName(name: string) {
  const n = name.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 255);
  if (!n) throw new OneBaseError("اسم الملف فارغ");
  return n;
}

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireActive(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Registers an upload. Without spaceId it goes to the uploader's personal space. The same bytes
 * already in that space (same sha256, still active) are not stored or indexed again: the existing
 * file is returned and the new upload's bytes are dropped. Measured on the demo: one PDF attached
 * in two chats became two files of 321 indexed passages each, and search showed every passage twice.
 * Another space keeps its own copy (its readers differ).
 */
async function addFile(ctx: MutationCtx, me: Awaited<ReturnType<typeof requireActive>>, { storageId, name, spaceId }: { storageId: Id<"_storage">; name: string; spaceId?: Id<"spaces"> }) {
  const target = spaceId ?? (await personalSpaceId(ctx, me));
  const { space } = await assertCan(ctx, me.userId, target, "write");
  const meta = await claimStorage(ctx, storageId);
  const fileName = cleanName(name);
  if (meta.sha256) {
    const same = (await ctx.db.query("files").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect()).find((f) => f.status === "active" && f.sha256 === meta.sha256);
    if (same) {
      await ctx.storage.delete(storageId);
      await writeAudit(ctx, { userId: me.userId, action: "file.upload_same", resourceType: "file", resourceId: same._id, spaceId: space._id, detail: { fileName, existing: same.name } });
      return { fileId: same._id, reused: true, name: same.name };
    }
  }
  const now = Date.now();
  const mime = meta.contentType || "application/octet-stream";
  const fileId = await ctx.db.insert("files", {
    spaceId: space._id,
    storageId,
    name: fileName,
    mime,
    size: meta.size,
    sha256: meta.sha256 ?? null,
    version: 1,
    uploadedBy: me.userId,
    ingest: "pending",
    status: "active",
    updatedAt: now,
  });
  await ctx.db.insert("fileVersions", { fileId, version: 1, storageId, name: fileName, mime, size: meta.size, sha256: meta.sha256 ?? null, uploadedBy: me.userId, uploadedAt: now });
  await writeAudit(ctx, { userId: me.userId, action: "file.upload", resourceType: "file", resourceId: fileId, spaceId: space._id, detail: { fileName, size: meta.size } });
  await scheduleIngest(ctx, fileId);
  return { fileId, reused: false, name: fileName };
}

const uploadArgs = { storageId: v.id("_storage"), name: v.string(), spaceId: v.optional(v.id("spaces")) };

/** Registers an upload; returns the file's id (an identical file already in the space is reused). */
export const create = mutation({
  args: uploadArgs,
  handler: async (ctx, a) => (await addFile(ctx, await requireActive(ctx), a)).fileId,
});

/** The same, and says whether the file was already there (and under which name), for the screen to tell. */
export const upload = mutation({
  args: uploadArgs,
  handler: async (ctx, a) => await addFile(ctx, await requireActive(ctx), a),
});

/** Uploads a new version of an existing file; older versions stay downloadable. */
export const uploadVersion = mutation({
  args: { fileId: v.id("files"), storageId: v.id("_storage"), name: v.optional(v.string()) },
  handler: async (ctx, { fileId, storageId, name }) => {
    const me = await requireActive(ctx);
    const file = await loadFile(ctx, fileId);
    await assertCan(ctx, me.userId, file.spaceId, "write");
    const meta = await claimStorage(ctx, storageId);
    // The same bytes as the current version: no new version, nothing indexed again.
    if (meta.sha256 && meta.sha256 === file.sha256) {
      await ctx.storage.delete(storageId);
      return file.version;
    }
    const version = file.version + 1;
    const fileName = name ? cleanName(name) : file.name;
    const mime = meta.contentType || "application/octet-stream";
    const now = Date.now();
    await ctx.db.insert("fileVersions", { fileId, version, storageId, name: fileName, mime, size: meta.size, sha256: meta.sha256 ?? null, uploadedBy: me.userId, uploadedAt: now });
    await ctx.db.patch(fileId, { storageId, name: fileName, mime, size: meta.size, sha256: meta.sha256 ?? null, version, uploadedBy: me.userId, updatedAt: now, ingest: "pending" });
    await writeAudit(ctx, { userId: me.userId, action: "file.version", resourceType: "file", resourceId: fileId, spaceId: file.spaceId, detail: { fileName, version } });
    await scheduleIngest(ctx, fileId);
    return version;
  },
});

/** For each content (sha256) in a space, its first uploaded active file: the one a duplicate repeats. */
function firstOfEach(rows: Doc<"files">[]) {
  const first = new Map<string, Doc<"files">>();
  for (const f of [...rows].filter((x) => x.status === "active" && x.sha256).sort((a, b) => a._creationTime - b._creationTime)) if (!first.has(f.sha256!)) first.set(f.sha256!, f);
  return first;
}

/**
 * «احذف النسخ المكررة»: deletes every active file in the space whose content repeats an earlier
 * one, keeping the first. Same rights as deleting a file (write in the space). Returns how many went.
 */
export const removeDuplicates = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "write");
    const rows = await ctx.db.query("files").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
    const first = firstOfEach(rows);
    let removed = 0;
    for (const f of rows) {
      if (f.status !== "active" || !f.sha256 || first.get(f.sha256)?._id === f._id) continue;
      await deleteFileRows(ctx, me.userId, f, "duplicate");
      removed++;
    }
    return removed;
  },
});

export const list = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("files").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
    const names = new Map<string, string | null>();
    const out = [];
    const first = firstOfEach(rows);
    for (const f of rows.filter((f) => f.status === "active").sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!names.has(f.uploadedBy)) {
        const u = await ctx.db.get(f.uploadedBy);
        names.set(f.uploadedBy, u?.name ?? u?.email ?? null);
      }
      const orig = f.sha256 ? first.get(f.sha256) : undefined;
      out.push({ _id: f._id, name: f.name, mime: f.mime, size: f.size, version: f.version, updatedAt: f.updatedAt, uploadedByName: names.get(f.uploadedBy) ?? null, duplicateOf: orig && orig._id !== f._id ? orig.name : null });
    }
    return out;
  },
});

export const versions = query({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const me = await requireActive(ctx);
    const file = await loadFile(ctx, fileId);
    await assertCan(ctx, me.userId, file.spaceId, "read");
    const rows = await ctx.db.query("fileVersions").withIndex("by_file_version", (q) => q.eq("fileId", file._id)).order("desc").collect();
    return rows.map((r) => ({ version: r.version, name: r.name, size: r.size, mime: r.mime, uploadedAt: r.uploadedAt }));
  },
});

export const remove = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const me = await requireActive(ctx);
    const file = await loadFile(ctx, fileId);
    await assertCan(ctx, me.userId, file.spaceId, "write");
    await deleteFileRows(ctx, me.userId, file, "user");
  },
});

/** Deletes a file with its versions, index and stored bytes. Callers check write access first. */
export async function deleteFileRows(ctx: MutationCtx, userId: Id<"users">, file: Doc<"files">, via: string) {
  const versions = await ctx.db.query("fileVersions").withIndex("by_file_version", (q) => q.eq("fileId", file._id)).collect();
  const storageIds = new Set<Id<"_storage">>([file.storageId, ...versions.map((v) => v.storageId)]);
  await unindexFile(ctx, file);
  for (const row of versions) await ctx.db.delete(row._id);
  await ctx.db.delete(file._id);
  for (const s of storageIds) await releaseStorage(ctx, s);
  await writeAudit(ctx, { userId, action: "file.delete", resourceType: "file", resourceId: file._id, spaceId: file.spaceId, detail: { fileName: file.name, ...(via !== "user" ? { via } : {}) } });
}

/** Leaving a sensitive space needs its manager; other moves need write on both sides. */
async function checkTransfer(ctx: MutationCtx, me: Actor, file: Doc<"files">, toSpaceId: Id<"spaces">, sourceAction: "read" | "write") {
  const src = await assertCan(ctx, me.userId, file.spaceId, sourceAction);
  const dst = await assertCan(ctx, me.userId, toSpaceId, "write");
  if (src.space._id === dst.space._id) throw new OneBaseError("الملف في هذه المساحة أصلاً");
  if (src.space.sensitive) await assertCan(ctx, me.userId, file.spaceId, "manage");
  return { src: src.space, dst: dst.space };
}

/** Moves a file (with all its versions) to another space. */
export const move = mutation({
  args: { fileId: v.id("files"), toSpaceId: v.id("spaces") },
  handler: async (ctx, { fileId, toSpaceId }) => {
    const me = await requireActive(ctx);
    const file = await loadFile(ctx, fileId);
    const { src, dst } = await checkTransfer(ctx, me, file, toSpaceId, "write");
    await ctx.db.patch(file._id, { spaceId: dst._id, updatedAt: Date.now() });
    await moveIndex(ctx, file._id);
    const detail = { fileName: file.name, from: src._id, to: dst._id };
    await writeAudit(ctx, { userId: me.userId, action: "file.move_out", resourceType: "file", resourceId: file._id, spaceId: src._id, detail });
    await writeAudit(ctx, { userId: me.userId, action: "file.move_in", resourceType: "file", resourceId: file._id, spaceId: dst._id, detail });
  },
});

/** Copies the current version into another space as a new file (the bytes are shared, not duplicated). */
export const copy = mutation({
  args: { fileId: v.id("files"), toSpaceId: v.id("spaces") },
  handler: async (ctx, { fileId, toSpaceId }) => {
    const me = await requireActive(ctx);
    const file = await loadFile(ctx, fileId);
    const { src, dst } = await checkTransfer(ctx, me, file, toSpaceId, "read");
    const now = Date.now();
    const newId = await ctx.db.insert("files", {
      spaceId: dst._id,
      storageId: file.storageId,
      name: file.name,
      mime: file.mime,
      size: file.size,
      sha256: file.sha256,
      version: 1,
      uploadedBy: me.userId,
      ingest: "pending",
      status: "active",
      updatedAt: now,
    });
    await ctx.db.insert("fileVersions", { fileId: newId, version: 1, storageId: file.storageId, name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, uploadedBy: me.userId, uploadedAt: now });
    const detail = { fileName: file.name, from: src._id, to: dst._id, copyId: newId };
    await writeAudit(ctx, { userId: me.userId, action: "file.copy_out", resourceType: "file", resourceId: file._id, spaceId: src._id, detail });
    await writeAudit(ctx, { userId: me.userId, action: "file.copy_in", resourceType: "file", resourceId: newId, spaceId: dst._id, detail });
    await scheduleIngest(ctx, newId);
    return newId;
  },
});

/** Issues a one-time download link (valid 60 s). The link is checked again when it is used. */
export const requestDownload = mutation({
  args: { fileId: v.id("files"), version: v.optional(v.number()), inline: v.optional(v.boolean()) },
  handler: async (ctx, { fileId, version, inline }) => {
    const me = await requireActive(ctx);
    const file = await loadFile(ctx, fileId);
    await assertCan(ctx, me.userId, file.spaceId, "read");
    const token = newToken();
    await ctx.db.insert("downloadTickets", { tokenHash: hashToken(token), userId: me.userId, fileId: file._id, version, inline: inline ?? false, expiresAt: Date.now() + TICKET_TTL_MS });
    return `/download?t=${token}`;
  },
});

/** Access check + audit for one download. Internal: called by the /download route with the session's user. */
async function authorize(ctx: MutationCtx, userId: Id<"users">, fileId: string, version: number | undefined, inline: boolean, via: string) {
  const file = await loadFile(ctx, fileId);
  const { space } = await assertCan(ctx, userId, file.spaceId, "read");
  let target: { storageId: Id<"_storage">; name: string; mime: string; size: number; version: number } = file;
  if (version !== undefined && version !== file.version) {
    const row = await ctx.db.query("fileVersions").withIndex("by_file_version", (q) => q.eq("fileId", file._id).eq("version", version)).unique();
    if (!row) throw new Denied();
    target = row;
  }
  if (space.sensitive) {
    await writeAudit(ctx, {
      userId,
      action: inline ? "file.open" : "file.download",
      resourceType: "file",
      resourceId: file._id,
      spaceId: space._id,
      detail: { fileName: target.name, version: target.version, via },
    });
  }
  return { storageId: target.storageId, name: target.name, mime: target.mime, size: target.size, inline };
}

export const authorizeDownload = internalMutation({
  args: { userId: v.id("users"), fileId: v.string(), version: v.optional(v.number()), inline: v.boolean() },
  handler: (ctx, { userId, fileId, version, inline }) => authorize(ctx, userId, fileId, version, inline, "session"),
});

export const redeemTicket = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const ticket = await ctx.db.query("downloadTickets").withIndex("by_hash", (q) => q.eq("tokenHash", hashToken(token))).unique();
    if (!ticket) return null;
    await ctx.db.delete(ticket._id); // one use only
    if (ticket.expiresAt < Date.now()) return null;
    return await authorize(ctx, ticket.userId, ticket.fileId, ticket.version, ticket.inline, "ticket");
  },
});

export const purgeTickets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("downloadTickets").withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now())).take(500);
    for (const t of old) await ctx.db.delete(t._id);
  },
});
