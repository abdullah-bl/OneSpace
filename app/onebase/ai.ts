// Model access over any OpenAI-compatible server (llama-server, vLLM, ollama). Everything comes
// from the environment (plans/01-architecture.md), read on every call so `onebase env set`
// takes effect without a restart:
//
//   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL          main model: chat, tools, OCR (vision)
//   LLM_FAST_BASE_URL, LLM_FAST_MODEL             light model: query rewriting, titles
//   EMBED_BASE_URL, EMBED_MODEL, EMBED_DIMENSIONS embeddings (dimensions fixed when rag is mounted)
//   RERANK_BASE_URL, RERANK_MODEL                 reranker (optional: disabled when unset)
//   EMBED_QUERY_PREFIX, EMBED_DOC_PREFIX          embeddinggemma task prefixes (defaults below)
//   LLM_ANSWER_MAX_TOKENS=8192                    token budget of an agent step (tool-call code + answer)
//   LLM_THINKING=1                                let Qwen think before answering (slower)
//   VISION_BASE_URL, VISION_MODEL                 OCR model if not the main one
//
// Plain helpers (chat, embed, rerank, ocr, health) are called from actions; the exported
// functions below are the rag embedder and the health check the UI shows.

import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { actorFor, requireUserId } from "./access";

export type Role = "main" | "fast";

const env = (k: string) => {
  const val = process.env[k]?.trim();
  return val ? val : undefined;
};

export type Target = { baseUrl?: string; model: string; apiKey?: string };
export type RoleName = "main" | "fast" | "vision";

// Roles an admin pointed at a provider (providers.ts), loaded per action by primeAi(). Each
// action process keeps the last copy for a few seconds; unset roles use the environment.
let overrides: Partial<Record<RoleName, Target>> = {};
let primedAt = 0;

export function setAiOverrides(o: Partial<Record<RoleName, Target>>) {
  overrides = o;
  primedAt = Date.now();
}

/** Loads the admin's provider choices; call at the start of an action that talks to a model. */
export async function primeAi(ctx: { runQuery: any }) {
  if (Date.now() - primedAt < 5_000) return;
  try {
    setAiOverrides(await ctx.runQuery(internal.providers.resolved, {}));
  } catch {
    // keep the last known (or the environment)
  }
}

/** The models from the environment alone (shown as «إعدادات الخادم» on the providers page). */
export function envTargets(): Record<RoleName, Target> {
  const main = { baseUrl: env("LLM_BASE_URL"), model: env("LLM_MODEL") ?? "default", apiKey: env("LLM_API_KEY") };
  return {
    main,
    fast: { baseUrl: env("LLM_FAST_BASE_URL") ?? main.baseUrl, model: env("LLM_FAST_BASE_URL") ? (env("LLM_FAST_MODEL") ?? "default") : (env("LLM_FAST_MODEL") ?? main.model), apiKey: env("LLM_API_KEY") },
    vision: { baseUrl: env("VISION_BASE_URL") ?? main.baseUrl, model: env("VISION_MODEL") ?? main.model, apiKey: env("LLM_API_KEY") },
  };
}

export function aiConfig() {
  const base = envTargets();
  const main = overrides.main ?? base.main;
  return {
    main,
    fast: overrides.fast ?? base.fast,
    vision: overrides.vision ?? base.vision,
    embed: {
      baseUrl: env("EMBED_BASE_URL"),
      model: env("EMBED_MODEL") ?? "default",
      dimensions: Number(env("EMBED_DIMENSIONS") ?? 768),
      // embeddinggemma's task prefixes (model card); empty string turns a prefix off.
      queryPrefix: process.env.EMBED_QUERY_PREFIX ?? "task: search result | query: ",
      docPrefix: process.env.EMBED_DOC_PREFIX ?? "title: {title} | text: ",
      apiKey: env("EMBED_API_KEY") ?? env("LLM_API_KEY"),
    },
    rerank: { baseUrl: env("RERANK_BASE_URL"), model: env("RERANK_MODEL") ?? "default", apiKey: env("RERANK_API_KEY") ?? env("LLM_API_KEY") },
    thinking: env("LLM_THINKING") === "1",
    answerMaxTokens: Math.max(500, Number(env("LLM_ANSWER_MAX_TOKENS") ?? 8192)),
    gpuSlots: Math.max(1, Number(env("GPU_SLOTS") ?? 4)),
  };
}

function headers(apiKey?: string) {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function post(url: string, body: unknown, apiKey?: string, timeoutMs = 600_000, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { method: "POST", headers: headers(apiKey), body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  return res;
}

async function postJson(url: string, body: unknown, apiKey?: string, timeoutMs?: number): Promise<any> {
  const res = await post(url, body, apiKey, timeoutMs);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

// ---------------------------------------------------------------- chat

export type ChatMsg =
  | { role: "system" | "user"; content: string | any[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: unknown; rawArgs: string };
export type ChatResult = { text: string; toolCalls: ToolCall[]; usage: { prompt: number; completion: number } | null; finishReason: string | null };

export type ChatOptions = {
  role?: Role;
  messages: ChatMsg[];
  tools?: ToolSpec[];
  /** Constrain the answer to this JSON schema (llama.cpp/vLLM `response_format`); falls back to plain JSON mode if refused. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /** Called with each piece of answer text as it streams. */
  onDelta?: (text: string) => void | Promise<void>;
  /** «إيقاف»: aborting it stops generation on the model server too (the connection closes). */
  signal?: AbortSignal;
  /** Let the model reason before answering (per call; the default is LLM_THINKING). The reasoning stays hidden. */
  thinking?: boolean;
  /** Called once when the model starts reasoning (streaming only). */
  onThinking?: () => void | Promise<void>;
};

/** The server couldn't parse the model's tool call (usually cut off by max_tokens mid-JSON). */
export class ToolCallCutError extends Error {}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { __invalid: raw };
  }
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const cfg = aiConfig();
  const target = opts.role === "fast" ? cfg.fast : cfg.main;
  if (!target.baseUrl) throw new OneBaseError("نموذج المحادثة غير مضبوط (LLM_BASE_URL)");
  const stream = !!opts.onDelta;
  const body: Record<string, unknown> = {
    model: target.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1500,
    temperature: opts.temperature ?? 0.3,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    chat_template_kwargs: { enable_thinking: opts.thinking ?? cfg.thinking },
  };
  if (opts.tools?.length) body.tools = opts.tools.map((t) => ({ type: "function", function: t }));
  if (opts.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: opts.jsonSchema, strict: true } };

  let res = await post(`${target.baseUrl}/chat/completions`, body, target.apiKey, undefined, opts.signal);
  if (!res.ok && opts.jsonSchema && res.status === 400) {
    body.response_format = { type: "json_object" };
    res = await post(`${target.baseUrl}/chat/completions`, body, target.apiKey, undefined, opts.signal);
  }
  if (!res.ok) {
    const err = (await res.text()).slice(0, 300);
    if (res.status === 500 && /Failed to parse tool call/i.test(err)) throw new ToolCallCutError("كان استدعاء الأداة أطول من المسموح فانقطع قبل أن يكتمل. جرّب طلباً أبسط أو قسّمه إلى خطوات.");
    throw new Error(`النموذج رفض الطلب (HTTP ${res.status}): ${err}`);
  }

  if (!stream) {
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((c: any, i: number) => ({ id: c.id ?? `call_${i}`, name: c.function?.name ?? "", rawArgs: c.function?.arguments ?? "", args: parseArgs(c.function?.arguments ?? "") })),
      usage: data.usage ? { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 } : null,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
    };
  }

  let text = "";
  let usage: ChatResult["usage"] = null;
  let finishReason: string | null = null;
  const calls: { id: string; name: string; rawArgs: string }[] = [];
  let thinkingSeen = false;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let ev: any;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ev.usage) usage = { prompt: ev.usage.prompt_tokens ?? 0, completion: ev.usage.completion_tokens ?? 0 };
      for (const ch of ev.choices ?? []) {
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta ?? {};
        if (!thinkingSeen && typeof d.reasoning_content === "string" && d.reasoning_content) {
          thinkingSeen = true;
          await opts.onThinking?.();
        }
        if (typeof d.content === "string" && d.content) {
          text += d.content;
          await opts.onDelta!(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          calls[i] ??= { id: tc.id ?? `call_${i}`, name: "", rawArgs: "" };
          if (tc.id) calls[i]!.id = tc.id;
          if (tc.function?.name) calls[i]!.name += tc.function.name;
          if (tc.function?.arguments) calls[i]!.rawArgs += tc.function.arguments;
        }
      }
    }
  }
  return { text, toolCalls: calls.filter(Boolean).map((c) => ({ ...c, args: parseArgs(c.rawArgs) })), usage, finishReason };
}

// ---------------------------------------------------------------- embeddings

/** Marks a text handed to the rag embedder as a search query (vs. a document chunk). */
export const QUERY_MARK = "\u0001query\u0001";

/**
 * Applies the task prefix. `{title}` in the document prefix is the document name taken from the
 * chunk's context line `[name | section | p]` (embeddinggemma: "title: … | text: …"), or "none".
 */
export function withPrefix(prefix: string, text: string, kind: "query" | "document") {
  if (kind === "query" || !prefix.includes("{title}")) return prefix + text;
  const title = /^\[([^|\]\n]+)/.exec(text)?.[1]?.trim() || "none";
  return prefix.replace("{title}", title) + text;
}

export async function embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
  const cfg = aiConfig().embed;
  if (!cfg.baseUrl) throw new OneBaseError("خادم التضمين غير مضبوط (EMBED_BASE_URL)");
  const prefix = kind === "query" ? cfg.queryPrefix : cfg.docPrefix;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64).map((t) => withPrefix(prefix, t, kind));
    const data = await postJson(`${cfg.baseUrl}/embeddings`, { model: cfg.model, input: batch }, cfg.apiKey);
    const rows = [...(data.data ?? [])].sort((a: any, b: any) => a.index - b.index);
    if (rows.length !== batch.length) throw new Error(`خادم التضمين أعاد ${rows.length} متجهاً لـ${batch.length} نصاً`);
    for (const r of rows) {
      if (!Array.isArray(r.embedding) || r.embedding.length !== cfg.dimensions) {
        throw new Error(`بُعد التضمين ${r.embedding?.length} لا يطابق EMBED_DIMENSIONS=${cfg.dimensions}`);
      }
      out.push(r.embedding);
    }
  }
  return out;
}

// ---------------------------------------------------------------- rerank

export function rerankEnabled() {
  return !!aiConfig().rerank.baseUrl;
}

/** Relevance score per document (same order), or null when no reranker is configured. */
export async function rerank(query: string, documents: string[]): Promise<number[] | null> {
  const cfg = aiConfig().rerank;
  if (!cfg.baseUrl || documents.length === 0) return null;
  const data = await postJson(`${cfg.baseUrl}/rerank`, { model: cfg.model, query, documents, top_n: documents.length }, cfg.apiKey, 120_000);
  const scores = new Array<number>(documents.length).fill(0);
  for (const r of data.results ?? data.data ?? []) scores[r.index] = r.relevance_score ?? r.score ?? 0;
  return scores;
}

// ---------------------------------------------------------------- OCR

const OCR_PROMPT =
  "هذه صورة صفحة من مستند ممسوح ضوئياً. انسخ نصها كما هو بالضبط بصيغة Markdown: العناوين بـ#، والجداول بصيغة | |. " +
  "لا تترجم ولا تلخّص ولا تضف أي شرح. إن كانت الصفحة فارغة فأعد سطراً فارغاً.";

export async function ocr(imageDataUrl: string): Promise<string> {
  const cfg = aiConfig().vision;
  if (!cfg.baseUrl) throw new OneBaseError("نموذج الرؤية غير مضبوط");
  const data = await postJson(
    `${cfg.baseUrl}/chat/completions`,
    {
      model: cfg.model,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: OCR_PROMPT }] }],
      max_tokens: 4096,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    },
    cfg.apiKey,
  );
  return String(data.choices?.[0]?.message?.content ?? "");
}

// ---------------------------------------------------------------- health

export type Health = Record<"main" | "fast" | "embed" | "rerank", "ok" | "down" | "off">;

export async function health(): Promise<Health> {
  const cfg = aiConfig();
  const probe = async (base?: string, key?: string): Promise<"ok" | "down" | "off"> => {
    if (!base) return "off";
    try {
      const r = await fetch(`${base}/models`, { headers: headers(key), signal: AbortSignal.timeout(3000) });
      return r.ok ? "ok" : "down";
    } catch {
      return "down";
    }
  };
  const [main, fast, emb, rr] = await Promise.all([
    probe(cfg.main.baseUrl, cfg.main.apiKey),
    probe(cfg.fast.baseUrl, cfg.fast.apiKey),
    probe(cfg.embed.baseUrl, cfg.embed.apiKey),
    probe(cfg.rerank.baseUrl, cfg.rerank.apiKey),
  ]);
  return { main, fast, embed: emb, rerank: rr };
}

// ---------------------------------------------------------------- the embedding index guard

/** What the index was built with. Stored once; a different model or size afterwards means a full re-index. */
export function embeddingSignature() {
  const e = aiConfig().embed;
  return { model: e.model, dimensions: e.dimensions, queryPrefix: e.queryPrefix, docPrefix: e.docPrefix };
}

export const MISMATCH = "نموذج التضمين الحالي لا يطابق النموذج الذي بُني به الفهرس. يلزم إعادة الفهرسة الكاملة قبل التشغيل.";

/** Registers the rag embedder and pins the embedding model on first use; throws if the model changed since. */
export async function ensureEmbeddingIndex(ctx: MutationCtx) {
  const sig = embeddingSignature();
  const row = await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "embedding")).unique();
  if (!row) {
    await ctx.components.docs.setEmbedder({ embed: internal.ai.embedForIndex });
    await ctx.db.insert("aiSettings", { key: "embedding", value: sig, updatedAt: Date.now() });
    return;
  }
  const v = row.value as typeof sig;
  if (v.model !== sig.model || v.dimensions !== sig.dimensions || v.queryPrefix !== sig.queryPrefix || v.docPrefix !== sig.docPrefix) {
    throw new OneBaseError(MISMATCH);
  }
}

/** The pinned signature, for actions (which can't read the db) to compare against the environment. */
export const indexSignature = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "embedding")).unique())?.value ?? null,
});

/** Throws unless the index was built with the configured embedding model (for actions). False: nothing indexed yet. */
export async function assertIndexMatches(ctx: { runQuery: any }): Promise<boolean> {
  const pinned = (await ctx.runQuery(internal.ai.indexSignature, {})) as ReturnType<typeof embeddingSignature> | null;
  if (!pinned) return false;
  const sig = embeddingSignature();
  if (pinned.model !== sig.model || pinned.dimensions !== sig.dimensions || pinned.queryPrefix !== sig.queryPrefix || pinned.docPrefix !== sig.docPrefix) {
    throw new OneBaseError(MISMATCH);
  }
  return true;
}

/**
 * Re-pins the embedding model after an admin decided to re-index (plans/05: "أعد الفهرسة").
 * Internal: run with the admin key; then call ingest:reindexAll.
 */
export const repinEmbedding = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("aiSettings").withIndex("by_key", (q) => q.eq("key", "embedding")).unique();
    if (row) await ctx.db.delete(row._id);
    await ensureEmbeddingIndex(ctx);
    return embeddingSignature();
  },
});

/** The rag component's embedder. Queries arrive marked with QUERY_MARK and get the query prefix. */
export const embedForIndex = internalAction({
  args: { texts: v.array(v.string()) },
  handler: async (_ctx, { texts }) => {
    const queries = texts.map((t) => t.startsWith(QUERY_MARK));
    if (queries.every(Boolean)) return await embed(texts.map((t) => t.slice(QUERY_MARK.length)), "query");
    if (!queries.some(Boolean)) return await embed(texts, "document");
    const out: number[][] = [];
    for (const t of texts) out.push(...(await embed([t.startsWith(QUERY_MARK) ? t.slice(QUERY_MARK.length) : t], t.startsWith(QUERY_MARK) ? "query" : "document")));
    return out;
  },
});

export const isActive = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => !!(await actorFor(ctx, userId)),
});

/** Model servers' state for the status dot in the chat screen (plans/05 idea 11). Active members only. */
export const status = action({
  args: {},
  handler: async (ctx): Promise<Health & { rerankEnabled: boolean }> => {
    const userId = await requireUserId(ctx);
    await primeAi(ctx);
    if (!(await ctx.runQuery(internal.ai.isActive, { userId }))) throw new OneBaseError("حسابك غير مفعّل في مساحة العمل");
    return { ...(await health()), rerankEnabled: rerankEnabled() };
  },
});
