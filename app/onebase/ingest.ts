// File ingestion (plans/03-rag.md §1–2), as a durable workflow:
//   begin → (scanned PDF pages: plan, then read by the vision model in batches, each page saved as
//   it is read) → extract + normalize + chunk (action) → commit chunks to the index → wait for the
//   embeddings → ready. Every step is journaled, so a restart continues where it stopped; the saved
//   pages (ocrPages) also make a retry or a re-index of the same version skip what was read.
//
// The index follows the file system (§2):
//   - namespace = the file's space (the permission boundary), key = file id
//   - a new version re-ingests and `replace`s the entry: the old chunks serve until the new are ready
//   - delete → removed from the index in the same mutation; move → out of the old namespace at once,
//     re-embedded into the new one
// Space membership needs nothing here: search reads readableSpaceIds at question time.

import { defineWorkflow } from "onebase/components/workflow";
import { v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, Denied, requireActive } from "./access";
import { aiConfig, embedConfigFromDb, ensureEmbeddingIndex, ocr, primeAi } from "./ai";
import { shadowText } from "./lib/arabic";
import { chunkBlocks } from "./lib/chunk";
import { extract, ocrPdfPages, scannedPdfPages } from "./lib/extract";

const MAX_CHUNKS = 5000;

/**
 * Scanned-page OCR: at most OCR_MAX_PAGES pages per file, OCR_BATCH_PAGES per workflow step (a
 * step must finish within the workflow timeout, 15 min), OCR_CONCURRENCY requests at a time.
 */
function ocrSettings() {
  const n = (name: string, def: number, min: number) => Math.max(min, Math.floor(Number(process.env[name] || def)) || def);
  return { maxPages: n("OCR_MAX_PAGES", 1000, 1), batch: n("OCR_BATCH_PAGES", 8, 1), concurrency: n("OCR_CONCURRENCY", 4, 1) };
}

export function textHash(text: string) {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex").slice(0, 20);
}

async function indexRow(ctx: { db: QueryCtx["db"] }, fileId: Id<"files">) {
  return await ctx.db.query("fileIndex").withIndex("by_file", (q) => q.eq("fileId", fileId)).unique();
}

async function setState(ctx: MutationCtx, file: Doc<"files">, patch: Partial<Doc<"fileIndex">> & { state: Doc<"fileIndex">["state"] }) {
  const row = await indexRow(ctx, file._id);
  const now = Date.now();
  if (row) await ctx.db.patch(row._id, { ...patch, updatedAt: now });
  else await ctx.db.insert("fileIndex", { fileId: file._id, spaceId: file.spaceId, version: file.version, ocr: false, ...patch, updatedAt: now });
  const ingest = patch.state === "skipped" ? "ready" : patch.state;
  if (file.ingest !== ingest) await ctx.db.patch(file._id, { ingest });
}

// ---------------------------------------------------------------- hooks called from files.ts

/** Queues (re-)ingestion of a file's current version. Never throws: problems show as the file's ingest state. */
export async function scheduleIngest(ctx: MutationCtx, fileId: Id<"files">) {
  const file = await ctx.db.get(fileId);
  if (!file) return;
  const row = await indexRow(ctx, fileId);
  const base = { version: file.version, spaceId: file.spaceId, error: undefined, note: undefined, step: undefined };
  if (!(await embedConfigFromDb(ctx.db)).baseUrl) {
    await setState(ctx, file, { ...base, state: "failed", error: "الفهرسة غير مفعّلة: خادم التضمين غير مضبوط" });
    return;
  }
  try {
    await ensureEmbeddingIndex(ctx);
  } catch (err) {
    await setState(ctx, file, { ...base, state: "failed", error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (row?.workflowId && (row.state === "pending" || row.state === "processing")) await ctx.components.ingest.cancel({ id: row.workflowId });
  await setState(ctx, file, { ...base, state: "pending" });
  const workflowId = await ctx.components.ingest.start({ fn: internal.ingest.flow, args: { fileId, version: file.version } });
  const after = await indexRow(ctx, fileId);
  if (after) await ctx.db.patch(after._id, { workflowId });
}

/** Removes a file from the index (file deleted). Runs inside the delete mutation. */
export async function unindexFile(ctx: MutationCtx, file: Doc<"files">) {
  const row = await indexRow(ctx, file._id);
  if (row?.workflowId && (row.state === "pending" || row.state === "processing")) await ctx.components.ingest.cancel({ id: row.workflowId });
  if (row?.entryId) await ctx.components.docs.delete({ entryId: row.entryId });
  for (const c of await ctx.db.query("chunks").withIndex("by_file", (q) => q.eq("fileId", file._id)).collect()) await ctx.db.delete(c._id);
  for (const p of await ctx.db.query("ocrPages").withIndex("by_file_version_page", (q) => q.eq("fileId", file._id)).collect()) await ctx.db.delete(p._id);
  if (row) await ctx.db.delete(row._id);
}

/** A file moved to another space: out of the old namespace now, re-embedded into the new one. */
export async function moveIndex(ctx: MutationCtx, fileId: Id<"files">) {
  const file = await ctx.db.get(fileId);
  const row = await indexRow(ctx, fileId);
  if (!file || !row) return;
  if (row.entryId) await ctx.components.docs.delete({ entryId: row.entryId });
  if (row.state === "pending" || row.state === "processing") {
    // Moved mid-ingest: start over in the new space (keyword rows go too, so nothing serves from the old one).
    for (const c of await ctx.db.query("chunks").withIndex("by_file", (q) => q.eq("fileId", fileId)).collect()) await ctx.db.delete(c._id);
    await ctx.db.patch(row._id, { spaceId: file.spaceId, entryId: undefined });
    await scheduleIngest(ctx, fileId);
    return;
  }
  const rows = await ctx.db.query("chunks").withIndex("by_file", (q) => q.eq("fileId", fileId)).collect();
  for (const c of rows) await ctx.db.patch(c._id, { spaceId: file.spaceId });
  let entryId: string | undefined;
  if (rows.length && row.state === "ready") {
    ({ entryId } = await ctx.components.docs.add({ namespace: file.spaceId, key: fileId, title: file.name, metadata: { fileId, version: row.version }, chunks: rows.map((c) => c.text) }));
  }
  await ctx.db.patch(row._id, { spaceId: file.spaceId, entryId, updatedAt: Date.now() });
}

// ---------------------------------------------------------------- the workflow

export const flow = defineWorkflow({
  run: async (step, args: { fileId: Id<"files">; version: number }) => {
    const go = await step.runMutation(internal.ingest.begin, args);
    if (!go) return "stale";
    // (typed by hand: the workflow and the actions live in one module, which TS can't infer through)
    const ingest = internal.ingest as any;
    // Scanned PDF pages: read in batches, one journaled step each (the batches come from the
    // journal too, so a replay lines up even if the settings changed meanwhile).
    const plan: { batches: number[][] } = (await step.runAction(ingest.planOcr, args)) as any;
    for (const pages of plan.batches) {
      const r: { done?: string } = (await step.runAction(ingest.ocrBatch, { ...args, pages })) as any;
      if (r.done) return r.done;
    }
    const res: { ok: boolean; error?: string; done?: string } = (await step.runAction((internal.ingest as any).extractFile, args)) as any;
    if (!res.ok) {
      await step.runMutation(internal.ingest.fail, { ...args, error: res.error ?? "فشل الاستخراج" });
      return "failed";
    }
    if (res.done) return res.done;
    // Embedding runs in the rag component's background job; wait for it.
    for (let i = 0; i < 200; i++) {
      const st = await step.runQuery(internal.ingest.embedState, args);
      if (st.state === "ready") {
        await step.runMutation(internal.ingest.markReady, args);
        return "ready";
      }
      if (st.state === "gone") return "stale";
      if (st.state === "failed") {
        await step.runMutation(internal.ingest.fail, { ...args, error: `فشل التضمين: ${st.error ?? ""}` });
        return "failed";
      }
      await step.sleep(Math.min(250 * 2 ** Math.min(i, 5), 10_000));
    }
    await step.runMutation(internal.ingest.fail, { ...args, error: "انتهت مهلة التضمين" });
    return "failed";
  },
});

const fileArgs = { fileId: v.id("files"), version: v.number() };

async function current(ctx: { db: QueryCtx["db"] }, fileId: Id<"files">, version: number) {
  const file = await ctx.db.get(fileId);
  return file && file.version === version ? file : null;
}

export const begin = internalMutation({
  args: fileArgs,
  handler: async (ctx, { fileId, version }) => {
    const file = await current(ctx, fileId, version);
    if (!file) return false;
    await setState(ctx, file, { state: "processing", step: "extract", version, ocrDone: undefined, ocrTotal: undefined });
    return true;
  },
});

async function fileBytes(ctx: { runQuery: any; storage: { get(id: any): Promise<Blob | null> } }, fileId: Id<"files">, version: number) {
  const meta: { storageId: string; name: string; mime: string } | null = await ctx.runQuery(internal.ingest.fileForIngest, { fileId, version });
  if (!meta) return null;
  const blob = await ctx.storage.get(meta.storageId);
  return { ...meta, bytes: blob ? new Uint8Array(await blob.arrayBuffer()) : null };
}

/** Which scanned pages still need the vision model, split into batches. Never fails: problems surface in extractFile. */
export const planOcr = internalAction({
  args: fileArgs,
  handler: async (ctx, { fileId, version }): Promise<{ batches: number[][] }> => {
    await primeAi(ctx);
    try {
      if (!aiConfig().vision.baseUrl) return { batches: [] };
      const f = await fileBytes(ctx, fileId, version);
      if (!f?.bytes) return { batches: [] };
      const { scanned } = await scannedPdfPages(f.bytes, f.name, f.mime);
      if (!scanned.length) return { batches: [] };
      const set = ocrSettings();
      const wanted = scanned.slice(0, set.maxPages);
      const done: number[] = await ctx.runMutation(internal.ingest.ocrStart, { fileId, version, total: wanted.length });
      const have = new Set(done);
      const todo = wanted.filter((p) => !have.has(p));
      const batches: number[][] = [];
      for (let i = 0; i < todo.length; i += set.batch) batches.push(todo.slice(i, i + set.batch));
      return { batches };
    } catch {
      return { batches: [] };
    }
  },
});

/** Starts the progress count and drops pages saved for other versions. Returns the pages already read. */
export const ocrStart = internalMutation({
  args: { ...fileArgs, total: v.number() },
  handler: async (ctx, { fileId, version, total }): Promise<number[]> => {
    const file = await current(ctx, fileId, version);
    if (!file) return [];
    const done: number[] = [];
    for (const p of await ctx.db.query("ocrPages").withIndex("by_file_version_page", (q) => q.eq("fileId", fileId)).collect()) {
      if (p.version === version) done.push(p.page);
      else await ctx.db.delete(p._id);
    }
    const row = await indexRow(ctx, fileId);
    if (row) await ctx.db.patch(row._id, { step: "ocr", ocrTotal: total, ocrDone: Math.min(done.length, total), updatedAt: Date.now() });
    return done;
  },
});

/** Reads one batch of scanned pages, saving each as it comes. Pages that fail twice are left out (noted on the file). */
export const ocrBatch = internalAction({
  args: { ...fileArgs, pages: v.array(v.number()) },
  handler: async (ctx, { fileId, version, pages }): Promise<{ done?: string; failed?: number }> => {
    await primeAi(ctx);
    try {
      const f = await fileBytes(ctx, fileId, version);
      if (!f) return { done: "stale" };
      if (!f.bytes) return {};
      const { failed } = await ocrPdfPages(f.bytes, pages, (url) => ocr(url), {
        concurrency: ocrSettings().concurrency,
        onPage: async (page, text) => {
          await ctx.runMutation(internal.ingest.saveOcrPage, { fileId, version, page, text });
        },
      });
      return { failed: failed.length };
    } catch {
      return {};
    }
  },
});

export const saveOcrPage = internalMutation({
  args: { ...fileArgs, page: v.number(), text: v.string() },
  handler: async (ctx, { fileId, version, page, text }) => {
    if (!(await current(ctx, fileId, version))) return;
    const old = await ctx.db
      .query("ocrPages")
      .withIndex("by_file_version_page", (q) => q.eq("fileId", fileId).eq("version", version).eq("page", page))
      .unique();
    if (old) {
      await ctx.db.patch(old._id, { text });
      return;
    }
    await ctx.db.insert("ocrPages", { fileId, version, page, text });
    const row = await indexRow(ctx, fileId);
    if (row) await ctx.db.patch(row._id, { ocrDone: (row.ocrDone ?? 0) + 1, updatedAt: Date.now() });
  },
});

export const ocrTexts = internalQuery({
  args: fileArgs,
  handler: async (ctx, { fileId, version }) => {
    const rows = await ctx.db.query("ocrPages").withIndex("by_file_version_page", (q) => q.eq("fileId", fileId).eq("version", version)).collect();
    return rows.map((r) => ({ page: r.page, text: r.text }));
  },
});

export const fileForIngest = internalQuery({
  args: fileArgs,
  handler: async (ctx, { fileId, version }) => {
    const file = await current(ctx, fileId, version);
    return file ? { storageId: file.storageId, name: file.name, mime: file.mime } : null;
  },
});

export const extractFile = internalAction({
  args: fileArgs,
  handler: async (ctx, { fileId, version }): Promise<{ ok: boolean; error?: string; done?: string }> => {
    await primeAi(ctx);
    try {
      const meta = await ctx.runQuery(internal.ingest.fileForIngest, { fileId, version });
      if (!meta) return { ok: true, done: "stale" };
      const blob = await ctx.storage.get(meta.storageId);
      if (!blob) return { ok: false, error: "الملف غير موجود في التخزين" };
      const cfg = aiConfig();
      const read: { page: number; text: string }[] = await ctx.runQuery(internal.ingest.ocrTexts, { fileId, version });
      const ex = await extract(new Uint8Array(await blob.arrayBuffer()), meta.name, meta.mime, {
        ocr: cfg.vision.baseUrl ? (url) => ocr(url) : null,
        maxOcrPages: ocrSettings().maxPages,
        // A PDF's scanned pages were read by the ocrBatch steps; only images are read here.
        ocrDone: new Map(read.map((r) => [r.page, r.text])),
      });
      const title = meta.name.replace(/\.[a-z0-9]+$/i, "");
      const chunks = chunkBlocks(title, ex.blocks).slice(0, MAX_CHUNKS);
      const done = await ctx.runMutation(internal.ingest.commit, {
        fileId,
        version,
        kind: ex.kind,
        pages: ex.pages,
        ocrPages: ex.ocrPages.length,
        note: ex.note,
        chunks: chunks.map((c) => ({ ordinal: c.ordinal, text: c.text, shadow: shadowText(c.text), hash: textHash(c.text), section: c.section, page: c.page, pageEnd: c.pageEnd })),
      });
      return { ok: true, done: done ?? undefined };
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
    }
  },
});

/** Writes the chunks (keyword index) and hands them to rag (vectors). Returns a final state, or null to wait for embeddings. */
export const commit = internalMutation({
  args: {
    ...fileArgs,
    kind: v.string(),
    pages: v.optional(v.number()),
    ocrPages: v.number(),
    note: v.optional(v.string()),
    chunks: v.array(
      v.object({ ordinal: v.number(), text: v.string(), shadow: v.string(), hash: v.string(), section: v.optional(v.string()), page: v.optional(v.number()), pageEnd: v.optional(v.number()) }),
    ),
  },
  handler: async (ctx, a): Promise<string | null> => {
    const file = await current(ctx, a.fileId, a.version);
    if (!file) return "stale";
    const row = await indexRow(ctx, file._id);
    for (const c of await ctx.db.query("chunks").withIndex("by_file", (q) => q.eq("fileId", file._id)).collect()) await ctx.db.delete(c._id);
    const details = { kind: a.kind, pages: a.pages, ocr: a.ocrPages > 0, ocrPages: a.ocrPages || undefined, note: a.note, chunks: a.chunks.length };
    if (a.chunks.length === 0) {
      if (row?.entryId) await ctx.components.docs.delete({ entryId: row.entryId });
      const skipped = a.kind === "unsupported";
      await setState(ctx, file, { ...details, entryId: undefined, state: skipped ? "skipped" : "failed", step: undefined, error: skipped ? undefined : (a.note ?? "لم يُستخرج أي نص من الملف") });
      return skipped ? "skipped" : "failed";
    }
    for (const c of a.chunks) await ctx.db.insert("chunks", { ...c, fileId: file._id, spaceId: file.spaceId, version: file.version });
    const content = { title: file.name, metadata: { fileId: file._id, version: file.version }, chunks: a.chunks.map((c) => c.text) };
    let entryId: string;
    const existing = row?.entryId ? await ctx.components.docs.status({ entryId: row.entryId }) : null;
    if (existing && existing.namespace === file.spaceId) ({ entryId } = await ctx.components.docs.replace({ entryId: existing.id, ...content }));
    else {
      if (existing) await ctx.components.docs.delete({ entryId: existing.id });
      ({ entryId } = await ctx.components.docs.add({ namespace: file.spaceId, ...content }));
    }
    await setState(ctx, file, { ...details, entryId, state: "processing", step: "embed" });
    return null;
  },
});

export const embedState = internalQuery({
  args: fileArgs,
  handler: async (ctx, { fileId, version }): Promise<{ state: "ready" | "pending" | "failed" | "gone"; error?: string }> => {
    const row = await ctx.db.query("fileIndex").withIndex("by_file", (q) => q.eq("fileId", fileId)).unique();
    if (!row || row.version !== version || !row.entryId) return { state: "gone" };
    const st = await ctx.components.docs.status({ entryId: row.entryId });
    if (!st) return { state: "gone" };
    if (st.state === "ready") return { state: "ready" };
    if (st.state === "errored" && st.attempts >= 5) return { state: "failed", error: st.error ?? undefined };
    return { state: "pending" };
  },
});

export const markReady = internalMutation({
  args: fileArgs,
  handler: async (ctx, { fileId, version }) => {
    const file = await current(ctx, fileId, version);
    if (!file) return;
    await setState(ctx, file, { state: "ready", step: undefined, error: undefined });
    // plans/12: screen the first chunks for text aimed at the assistant (a badge, never a block).
    await ctx.scheduler.runAfter(0, internal.decisions.guardFile, { fileId, version });
  },
});

export const fail = internalMutation({
  args: { ...fileArgs, error: v.string() },
  handler: async (ctx, { fileId, version, error }) => {
    const file = await current(ctx, fileId, version);
    if (file) await setState(ctx, file, { state: "failed", step: undefined, error });
  },
});

/** Re-ingests every file (after an embedding model change: run ai:repinEmbedding first). Admin key only. */
export const reindexAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const files = await ctx.db.query("files").collect();
    for (const f of files) if (f.status === "active") await scheduleIngest(ctx, f._id);
    return files.length;
  },
});

/**
 * Indexes files that were saved without it (rendered documents and analysis outputs, before they
 * scheduled their own ingestion). Admin key only; safe to run again.
 */
export const ingestMissing = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const f of await ctx.db.query("files").collect()) {
      if (f.status !== "active" || f.ingest !== "pending" || (await indexRow(ctx, f._id))) continue;
      await scheduleIngest(ctx, f._id);
      n++;
    }
    return n;
  },
});

// ---------------------------------------------------------------- public

const STATE_LABEL: Record<string, string> = { pending: "بانتظار المعالجة", processing: "قيد المعالجة", ready: "جاهز", failed: "فشل", skipped: "لا يُفهرس" };

/** Ingest state of every file in a space, for the file list (readers of the space). */
export const statuses = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    await assertCan(ctx, me.userId, spaceId, "read");
    const files = await ctx.db.query("files").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
    const out = [];
    for (const f of files) {
      const row = await indexRow(ctx, f._id);
      const state = row?.state ?? f.ingest;
      out.push({
        fileId: f._id,
        state,
        label:
          state === "processing" && row?.step === "embed"
            ? "قيد التضمين"
            : state === "processing" && row?.step === "ocr" && row.ocrTotal
              ? `قراءة الصفحات الممسوحة ${row.ocrDone ?? 0}/${row.ocrTotal}`
              : STATE_LABEL[state] ?? state,
        ocrProgress: row?.step === "ocr" && row.ocrTotal ? { done: row.ocrDone ?? 0, total: row.ocrTotal } : null,
        error: row?.error ?? null,
        note: row?.note ?? null,
        kind: row?.kind ?? null,
        ocr: row?.ocr ?? false,
        pages: row?.pages ?? null,
        chunks: row?.chunks ?? null,
        // plans/12: «فيه نص موجّه للمساعد» (only for the version it was found in)
        steering: row?.steering && row.guardedVersion === f.version ? row.steering.quote : null,
      });
    }
    return out;
  },
});

/** "إعادة المحاولة" on a failed file (anyone who can write in its space). */
export const retry = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const me = await requireActive(ctx);
    const file = await ctx.db.get(fileId);
    if (!file) throw new Denied();
    await assertCan(ctx, me.userId, file.spaceId, "write");
    await scheduleIngest(ctx, fileId);
  },
});
