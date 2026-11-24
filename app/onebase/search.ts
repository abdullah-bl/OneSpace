// Document search (plans/03-rag.md §2–3), always as a user and always filtered BEFORE retrieval:
// the spaces searched are readableSpaceIds(user) ∩ the requested scope, recomputed here on every
// call, so a removed member stops seeing a space on their very next question. Each space is its
// own rag namespace (vectors) and its own filter value in the keyword index (chunks.shadow), so
// chunks from other spaces never enter the candidate lists at all.
//
//   question → [vector per space] + [keyword per space] → Reciprocal Rank Fusion → rerank top 30 → top k

import { v } from "onebase/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalQuery, type ActionCtx } from "./_generated/server";
import { readableSpaceIds } from "./access";
import { assertIndexMatches, QUERY_MARK, rerank, primeAi } from "./ai";
import { keywordQuery } from "./lib/arabic";
import { textHash } from "./ingest";

export type Hit = {
  fileId: string;
  fileName: string;
  spaceId: string;
  text: string;
  section?: string;
  page?: number;
  pageEnd?: number;
  ordinal?: number;
  /** RRF score (vector + keyword). */
  fused: number;
  /** Reranker relevance (0..1) when a reranker is configured. */
  rerank?: number;
  /** plans/12 guard: the file was flagged at indexing (text aimed at the assistant). */
  steering?: boolean;
};

export type SearchResult = { hits: Hit[]; candidates: Hit[]; reranked: boolean; spaces: string[] };

const RRF_K = 60;

/** The spaces and files a search may touch right now: readable ∩ requested (∩ the file's space for a file scope). */
export const allowedScope = internalQuery({
  args: { userId: v.id("users"), spaceIds: v.array(v.string()), fileIds: v.optional(v.array(v.string())) },
  handler: async (ctx, { userId, spaceIds, fileIds }) => {
    const readable = new Set<string>(await readableSpaceIds(ctx, userId));
    let spaces = [...new Set(spaceIds)].filter((s) => readable.has(s));
    let files: string[] | null = null;
    if (fileIds) {
      files = [];
      const fileSpaces = new Set<string>();
      for (const raw of fileIds) {
        const id = ctx.db.normalizeId("files", raw);
        const f = id ? await ctx.db.get(id) : null;
        if (f && f.status === "active" && spaces.includes(f.spaceId)) {
          files.push(f._id);
          fileSpaces.add(f.spaceId);
        }
      }
      spaces = spaces.filter((s) => fileSpaces.has(s));
    }
    return { spaces, files };
  },
});

export const keywordSearch = internalQuery({
  args: { spaceId: v.id("spaces"), q: v.string(), fileId: v.optional(v.id("files")), limit: v.number() },
  handler: async (ctx, { spaceId, q, fileId, limit }) => {
    const rows = await ctx.db
      .query("chunks")
      .withSearchIndex("search_shadow", (s) => (fileId ? s.search("shadow", q).eq("spaceId", spaceId).eq("fileId", fileId) : s.search("shadow", q).eq("spaceId", spaceId)))
      .take(limit);
    return rows.map((r) => ({ fileId: r.fileId as string, text: r.text }));
  },
});

/** Current file + chunk details for candidate hits; drops what was deleted, moved, superseded or is out of scope. */
export const resolve = internalQuery({
  args: { items: v.array(v.object({ fileId: v.string(), hash: v.string() })), spaces: v.array(v.string()) },
  handler: async (ctx, { items, spaces }) => {
    const allowed = new Set(spaces);
    const files = new Map<string, { name: string; spaceId: string; steering?: true } | null>();
    const out: ({ fileName: string; spaceId: string; section?: string; page?: number; pageEnd?: number; ordinal?: number; steering?: true } | null)[] = [];
    for (const it of items) {
      if (!files.has(it.fileId)) {
        const id = ctx.db.normalizeId("files", it.fileId);
        const f = id ? await ctx.db.get(id) : null;
        const flagged = f ? !!(await ctx.db.query("fileIndex").withIndex("by_file", (q) => q.eq("fileId", f._id)).unique())?.steering : false;
        files.set(it.fileId, f && f.status === "active" && allowed.has(f.spaceId) ? { name: f.name, spaceId: f.spaceId, ...(flagged ? { steering: true as const } : {}) } : null);
      }
      const f = files.get(it.fileId);
      if (!f) {
        out.push(null);
        continue;
      }
      const c = await ctx.db
        .query("chunks")
        .withIndex("by_file_hash", (q) => q.eq("fileId", it.fileId as Id<"files">).eq("hash", it.hash))
        .first();
      // No chunk row: a vector hit from the previous version still serving while the new one embeds.
      const flag = f.steering ? { steering: true as const } : {};
      out.push(c && c.spaceId === f.spaceId ? { fileName: f.name, spaceId: f.spaceId, section: c.section, page: c.page, pageEnd: c.pageEnd, ordinal: c.ordinal, ...flag } : c ? null : { fileName: f.name, spaceId: f.spaceId, ...flag });
    }
    return out;
  },
});

/**
 * Searches the documents `userId` may read, within `spaceIds` (and `fileIds`, if given).
 * Never trusts its caller's scope: it is intersected with the user's readable spaces here.
 */
export async function searchDocuments(
  ctx: ActionCtx,
  opts: { userId: Id<"users">; spaceIds: string[]; fileIds?: string[]; query: string; limit?: number; candidates?: number },
): Promise<SearchResult> {
  const indexed = await assertIndexMatches(ctx);
  if (!indexed) return { hits: [], candidates: [], reranked: false, spaces: [] };
  const limit = opts.limit ?? 8;
  const pool = opts.candidates ?? 30;
  const scope = await ctx.runQuery(internal.search.allowedScope, { userId: opts.userId, spaceIds: opts.spaceIds, fileIds: opts.fileIds });
  if (!scope.spaces.length || !opts.query.trim()) return { hits: [], candidates: [], reranked: false, spaces: scope.spaces };
  const fileSet = scope.files ? new Set(scope.files) : null;
  const kw = keywordQuery(opts.query);

  type Cand = { fileId: string; text: string };
  const vectorHits: (Cand & { score: number })[] = [];
  const textLists: Cand[][] = [];
  await Promise.all(
    scope.spaces.map(async (spaceId) => {
      const vec = await ctx.components.docs.search({ namespace: spaceId, query: QUERY_MARK + opts.query, limit: pool, mode: "vector" });
      for (const h of vec) {
        const fileId = String((h.metadata as any)?.fileId ?? "");
        if (!fileId || (fileSet && !fileSet.has(fileId))) continue;
        vectorHits.push({ fileId, text: h.text, score: h.score ?? 0 });
      }
      if (kw) {
        const files = fileSet ? [...fileSet] : [undefined];
        for (const fileId of files) {
          textLists.push(await ctx.runQuery(internal.search.keywordSearch, { spaceId: spaceId as Id<"spaces">, q: kw, fileId: fileId as Id<"files"> | undefined, limit: pool }));
        }
      }
    }),
  );

  // Reciprocal Rank Fusion: vector hits ranked by cosine across spaces; keyword lists by their own rank.
  const fused = new Map<string, Cand & { fused: number }>();
  const add = (c: Cand, rank: number) => {
    const key = `${c.fileId}:${textHash(c.text)}`;
    const cur = fused.get(key) ?? { ...c, fused: 0 };
    cur.fused += 1 / (RRF_K + rank);
    fused.set(key, cur);
  };
  vectorHits.sort((a, b) => b.score - a.score).forEach((c, i) => add(c, i + 1));
  for (const list of textLists) list.forEach((c, i) => add(c, i + 1));
  let ranked = [...fused.values()].sort((a, b) => b.fused - a.fused).slice(0, pool * 2);

  const details = await ctx.runQuery(internal.search.resolve, { items: ranked.map((c) => ({ fileId: c.fileId, hash: textHash(c.text) })), spaces: scope.spaces });
  let hits: Hit[] = [];
  ranked.forEach((c, i) => {
    const d = details[i];
    if (d) hits.push({ fileId: c.fileId, text: c.text, fused: c.fused, ...d });
  });
  // The same passage from identical files (one file uploaded twice, or copied to another space the
  // asker also reads) counts once: the best-ranked copy stays. Compared without the context line
  // («[name | section | p]»), so a copy under another name is caught too.
  const seenBody = new Set<string>();
  hits = hits.filter((h) => {
    const body = textHash(h.text.replace(/^\[[^\]\n]*\]\s*/, "").replace(/\s+/g, " ").trim());
    if (seenBody.has(body)) return false;
    seenBody.add(body);
    return true;
  });
  hits = hits.slice(0, pool);
  const candidates = hits.slice();

  let reranked = false;
  try {
    const scores = await rerank(opts.query, hits.map((h) => h.text));
    if (scores) {
      hits.forEach((h, i) => (h.rerank = scores[i]));
      hits.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0));
      reranked = true;
    }
  } catch (err) {
    console.warn("rerank failed, using fused order:", err);
  }
  return { hits: hits.slice(0, limit), candidates, reranked, spaces: scope.spaces };
}

/** Retrieval only, for the evaluation script (Recall@10). Internal: admin key. */
export const debugSearch = internalAction({
  args: { userId: v.id("users"), query: v.string(), spaceIds: v.optional(v.array(v.string())), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, query, spaceIds, limit }) => {
    await primeAi(ctx);
    const spaces = spaceIds ?? (await ctx.runQuery(internal.search.readable, { userId }));
    const r = await searchDocuments(ctx, { userId, spaceIds: spaces, query, limit: limit ?? 10 });
    const view = (h: Hit) => ({ fileId: h.fileId, fileName: h.fileName, section: h.section ?? null, page: h.page ?? null, text: h.text, fused: h.fused, rerank: h.rerank ?? null });
    return { hits: r.hits.map(view), candidates: r.candidates.map(view), reranked: r.reranked };
  },
});

/** A file's chunks in order, for read_file: only if the user can read its space now and it is inside the turn's scope. */
export const fileChunks = internalQuery({
  args: { userId: v.id("users"), fileId: v.string(), scopeSpaceIds: v.array(v.string()), scopeFileIds: v.optional(v.array(v.string())) },
  handler: async (ctx, { userId, fileId, scopeSpaceIds, scopeFileIds }) => {
    const id = ctx.db.normalizeId("files", fileId);
    const file = id ? await ctx.db.get(id) : null;
    if (!file || file.status !== "active") return null;
    if (!scopeSpaceIds.includes(file.spaceId)) return null;
    if (scopeFileIds && !scopeFileIds.includes(file._id)) return null;
    const readable = await readableSpaceIds(ctx, userId);
    if (!readable.includes(file.spaceId)) return null;
    const rows = await ctx.db.query("chunks").withIndex("by_file", (q) => q.eq("fileId", file._id)).collect();
    const steering = !!(await ctx.db.query("fileIndex").withIndex("by_file", (q) => q.eq("fileId", file._id)).unique())?.steering;
    return { fileId: file._id as string, name: file.name, spaceId: file.spaceId as string, steering, chunks: rows.map((r) => ({ text: r.text, section: r.section, page: r.page, pageEnd: r.pageEnd })) };
  },
});

export const readable = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => (await readableSpaceIds(ctx, userId)) as string[],
});
