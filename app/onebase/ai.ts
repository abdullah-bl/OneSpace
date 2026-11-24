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
//   LLM_DECIDE_BASE_URL, LLM_DECIDE_MODEL         decision model (plans/12): small JSON decisions; unset → fast
//   LLM_DECIDE_TIMEOUT_MS=1500                    a decision slower than this falls back to code
//
// Plain helpers (chat, embed, rerank, ocr, health) are called from actions; the exported
// functions below are the rag embedder and the health check the UI shows.

import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { actorFor, requireUserId } from "./access";
import { cutText, fitJson, isTooLong, learnLimit, limitFor, MIN_INPUT_CHARS } from "./lib/inputLimit";

export type Role = "main" | "fast" | "decide";

const env = (k: string) => {
  const val = process.env[k]?.trim();
  return val ? val : undefined;
};

/** maxInputChars: the longest input the role took when it was tried (lib/inputLimit.ts); unset = not measured. */
export type Target = { baseUrl?: string; model: string; apiKey?: string; provider?: string; maxInputChars?: number };
export type RoleName = "main" | "fast" | "vision" | "decide";
/** The embedding model. `dimensions` is fixed by the rag index (EMBED_DIMENSIONS when it was mounted). */
export type EmbedTarget = { baseUrl?: string; model: string; apiKey?: string; dimensions: number; queryPrefix: string; docPrefix: string; sendDimensions?: boolean; maxInputChars?: number };
/** Which decisions (plans/12) run; off (or a failed call) returns that decision to code. Missing = on. */
export type DecisionSwitches = { route?: boolean; cite?: boolean; guard?: boolean };
export type Overrides = Partial<Record<RoleName, Target>> & { embed?: EmbedTarget; decisions?: DecisionSwitches };

/** Vector size of the rag index: fixed when the docs component is mounted (components.ts). */
export const INDEX_DIMENSIONS = Number(process.env.EMBED_DIMENSIONS || 768);
/** embeddinggemma's task prefixes (model card). Other models get none unless the env sets them. */
export const GEMMA_PREFIXES = { queryPrefix: "task: search result | query: ", docPrefix: "title: {title} | text: " };

// Roles an admin pointed at a provider (providers.ts), loaded per action by primeAi(). Each
// action process keeps the last copy for a few seconds; unset roles use the environment.
let overrides: Overrides = {};
let primedAt = 0;

export function setAiOverrides(o: Overrides) {
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
    // Unset: the fast model's (shown as «مثل النموذج السريع»; aiConfig follows the admin's fast choice too).
    decide: env("LLM_DECIDE_BASE_URL")
      ? { baseUrl: env("LLM_DECIDE_BASE_URL"), model: env("LLM_DECIDE_MODEL") ?? "default", apiKey: env("LLM_DECIDE_API_KEY") ?? env("LLM_API_KEY") }
      : { baseUrl: env("LLM_FAST_BASE_URL") ?? main.baseUrl, model: env("LLM_DECIDE_MODEL") ?? (env("LLM_FAST_BASE_URL") ? (env("LLM_FAST_MODEL") ?? "default") : (env("LLM_FAST_MODEL") ?? main.model)), apiKey: env("LLM_API_KEY") },
  };
}

/** True when the environment names its own decision server (else decide follows fast). */
export const decideFromEnv = () => !!env("LLM_DECIDE_BASE_URL");

export function envEmbed(): EmbedTarget {
  return {
    baseUrl: env("EMBED_BASE_URL"),
    model: env("EMBED_MODEL") ?? "default",
    dimensions: INDEX_DIMENSIONS,
    // empty string turns a prefix off
    queryPrefix: process.env.EMBED_QUERY_PREFIX ?? GEMMA_PREFIXES.queryPrefix,
    docPrefix: process.env.EMBED_DOC_PREFIX ?? GEMMA_PREFIXES.docPrefix,
    apiKey: env("EMBED_API_KEY") ?? env("LLM_API_KEY"),
  };
}

/**
 * The embedding model as stored now (for mutations, which can't prime): the admin's choice
 * (aiSettings "roles".embed and its provider), else the environment.
 */
export async function embedConfigFromDb(db: any): Promise<EmbedTarget> {
  const row = await db.query("aiSettings").withIndex("by_key", (q: any) => q.eq("key", "roles")).unique();
  const c = (row?.value as any)?.embed;
  if (c) {
    const p = await db.get(c.providerId);
    if (p?.enabled) return { baseUrl: p.baseUrl, model: c.model, apiKey: p.apiKey, dimensions: INDEX_DIMENSIONS, queryPrefix: c.queryPrefix ?? "", docPrefix: c.docPrefix ?? "", sendDimensions: !!c.sendDimensions, ...(c.maxInputChars ? { maxInputChars: c.maxInputChars } : {}) };
  }
  return envEmbed();
}

export function aiConfig() {
  const base = envTargets();
  const main = overrides.main ?? base.main;
  const fast = overrides.fast ?? base.fast;
  return {
    main,
    fast,
    decide: overrides.decide ?? (decideFromEnv() || env("LLM_DECIDE_MODEL") ? base.decide : fast),
    decisions: { route: overrides.decisions?.route !== false, cite: overrides.decisions?.cite !== false, guard: overrides.decisions?.guard !== false },
    decideTimeoutMs: Math.max(200, Number(env("LLM_DECIDE_TIMEOUT_MS") ?? 1500)),
    vision: overrides.vision ?? base.vision,
    embed: overrides.embed ?? envEmbed(),
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
  /** "required": the model must call one of `tools` (sent as tool_choice; dropped if the server refuses it). */
  toolChoice?: "auto" | "required";
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
  /** Count this call's tokens (usage.ts): who it was for and why. Recording never fails the call. */
  track?: UsageTrack;
};

export type UsagePurpose = "answer" | "part" | "route" | "plan" | "rewrite" | "summary" | "title" | "memory" | "skill_draft" | "agent_draft" | DecisionKindPurpose;
export type DecisionKind = "route" | "cite" | "guard";
type DecisionKindPurpose = `decide:${DecisionKind}`;
export type UsageTrack = { ctx: { runMutation: any }; purpose: UsagePurpose; userId?: string; turnId?: string };

/** The server couldn't parse the model's tool call (usually cut off by max_tokens mid-JSON). */
export class ToolCallCutError extends Error {}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { __invalid: raw };
  }
}

function targetOf(cfg: ReturnType<typeof aiConfig>, role: Role | undefined): Target {
  return role === "fast" ? cfg.fast : role === "decide" ? cfg.decide : cfg.main;
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.track) return chatOnce(opts);
  const cfg = aiConfig();
  const target = targetOf(cfg, opts.role);
  const started = Date.now();
  const note = async (usage: ChatResult["usage"], ok: boolean) => {
    try {
      await opts.track!.ctx.runMutation(internal.usage.record, {
        model: target.model,
        provider: target.provider ?? "إعدادات الخادم",
        role: opts.role ?? "main",
        purpose: opts.track!.purpose,
        ...(opts.track!.userId ? { userId: opts.track!.userId } : {}),
        ...(opts.track!.turnId ? { turnId: opts.track!.turnId } : {}),
        prompt: usage?.prompt ?? 0,
        completion: usage?.completion ?? 0,
        counted: !!usage,
        ms: Date.now() - started,
        ok,
      });
    } catch (e) {
      console.error("usage: not recorded", e instanceof Error ? e.message : e);
    }
  };
  try {
    const r = await chatOnce(opts);
    await note(r.usage, true);
    return r;
  } catch (e) {
    await note(null, false);
    throw e;
  }
}

async function chatOnce(opts: ChatOptions): Promise<ChatResult> {
  const cfg = aiConfig();
  const target = targetOf(cfg, opts.role);
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
    // Hosted routers (OpenRouter) ignore chat_template_kwargs; without this a reasoning model spends
    // max_tokens on hidden reasoning and the answer (often JSON) is cut off. llama.cpp ignores it.
    ...((opts.thinking ?? cfg.thinking) ? {} : { reasoning: { enabled: false } }),
  };
  if (opts.tools?.length) body.tools = opts.tools.map((t) => ({ type: "function", function: t }));
  if (opts.tools?.length && opts.toolChoice) body.tool_choice = opts.toolChoice;
  if (opts.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: opts.jsonSchema, strict: true } };

  let res = await post(`${target.baseUrl}/chat/completions`, body, target.apiKey, undefined, opts.signal);
  if (!res.ok && res.status === 400 && body.reasoning) {
    // A model that must reason refuses the switch: ask again without it.
    delete body.reasoning;
    res = await post(`${target.baseUrl}/chat/completions`, body, target.apiKey, undefined, opts.signal);
  }
  if (!res.ok && res.status === 400 && body.tool_choice) {
    // A server that doesn't support tool_choice: the same request without it.
    delete body.tool_choice;
    res = await post(`${target.baseUrl}/chat/completions`, body, target.apiKey, undefined, opts.signal);
  }
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

// ---------------------------------------------------------------- decisions (plans/12)

/**
 * Checks a parsed value against the small JSON schemas decisions use (object, array, string,
 * number, integer, boolean, enum, required, additionalProperties: false, minItems, maxItems). Anything the
 * model invents outside the schema makes the whole decision invalid, never half-applied.
 */
export function matchesSchema(value: unknown, schema: Record<string, any>): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const props: Record<string, any> = schema.properties ?? {};
      for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) return false;
      for (const [k, x] of Object.entries(value)) {
        if (!Object.hasOwn(props, k)) {
          if (schema.additionalProperties === false) return false;
          continue;
        }
        if (!matchesSchema(x, props[k])) return false;
      }
      return true;
    }
    case "array":
      return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems) && (schema.minItems === undefined || value.length >= schema.minItems) && value.every((x) => matchesSchema(x, schema.items ?? {}));
    case "string":
      return typeof value === "string" && (schema.maxLength === undefined || value.length <= schema.maxLength);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

/** One logged decision (turns.decisions): what was asked, what came back, or why code decided. */
export type DecisionLog = { kind: DecisionKind; ms: number; ok: boolean; why?: "off" | "timeout" | "error" | "invalid"; out?: unknown };

/**
 * A small decision (plans/12) by the `decide` model: `{ role: "decide", temperature: 0, jsonSchema }`.
 * Returns the parsed value, or null on anything else (switched off, timeout, HTTP error, JSON that
 * doesn't match the schema): null means the caller does what the code did before. Never throws.
 * A decision can make a turn stricter or cheaper; the callers never let it grant anything.
 */
export async function decide<T>(
  kind: DecisionKind,
  messages: ChatMsg[],
  schema: Record<string, unknown>,
  opts: { track?: Omit<UsageTrack, "purpose">; maxTokens?: number; timeoutMs?: number; log?: (l: DecisionLog) => void; typed?: TypedAsk<T> } = {},
): Promise<T | null> {
  const cfg = aiConfig();
  const started = Date.now();
  const done = (l: Omit<DecisionLog, "kind" | "ms">) => opts.log?.({ kind, ms: Date.now() - started, ...l });
  if (!cfg.decisions[kind] || !cfg.decide.baseUrl) {
    done({ ok: false, why: "off" });
    return null;
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? cfg.decideTimeoutMs);
  try {
    // A native decision model (llama.cpp `/v1/systemone`) answers typed questions, not chat.
    if (await isDecisionModel(cfg.decide)) {
      if (!opts.typed) {
        done({ ok: false, why: "error" });
        return null;
      }
      const value = await askTyped(cfg.decide, kind, opts.typed, signal, opts.track);
      if (value === null || !matchesSchema(value, schema)) {
        done({ ok: false, why: "invalid" });
        return null;
      }
      done({ ok: true, out: value });
      return value;
    }
    const r = await chat({
      role: "decide",
      temperature: 0,
      thinking: false,
      maxTokens: opts.maxTokens ?? 80,
      jsonSchema: schema,
      // A small decision model may take less than the passages we have: fitted, like the typed path.
      messages: fitJson(messages, limitFor(cfg.decide.baseUrl, cfg.decide.model, cfg.decide.maxInputChars)),
      signal,
      ...(opts.track ? { track: { ...opts.track, purpose: `decide:${kind}` as const } } : {}),
    });
    let value: unknown;
    try {
      value = JSON.parse(r.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      done({ ok: false, why: "invalid" });
      return null;
    }
    if (!matchesSchema(value, schema)) {
      done({ ok: false, why: "invalid" });
      return null;
    }
    done({ ok: true, out: value });
    return value as T;
  } catch (e) {
    // Refused for length on the chat path: the next decision sends half (the typed path retries itself).
    const msg = e instanceof Error ? e.message : String(e);
    const status = Number(/HTTP (\d{3})/.exec(msg)?.[1] ?? 0);
    if (status && isTooLong(status, msg)) learnLimit(cfg.decide.baseUrl, cfg.decide.model, JSON.stringify(fitJson(messages, limitFor(cfg.decide.baseUrl, cfg.decide.model, cfg.decide.maxInputChars))).length);
    done({ ok: false, why: signal.aborted ? "timeout" : "error" });
    return null;
  }
}

// ---------------------------------------------------------------- native decision models

/**
 * A decision as typed questions for a native decision model (llama.cpp `POST /v1/systemone`,
 * the TypeSafe API): `noul` (probability of true), `choice` (one option) or `score`. Such a model
 * reads a `state` and answers each question in one forward pass; it writes no text, so `map`
 * turns the answers into the same value the chat path returns (or null).
 */
export type TypedQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
export type TypedAnswers = Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number>; score?: number; confidence?: number }>;
export type TypedAsk<T> = { state: unknown; questions: Record<string, TypedQuestion>; map: (a: TypedAnswers) => T | null };

const kindCache = new Map<string, { decisions: boolean; at: number }>();

/** True when the server lists this model as one that outputs decisions, not text (cached 10 min). */
export async function isDecisionModel(t: Target): Promise<boolean> {
  if (!t.baseUrl) return false;
  const key = `${t.baseUrl}|${t.model}`;
  const hit = kindCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.decisions;
  let decisions = false;
  try {
    const r = await fetch(`${t.baseUrl}/models`, { headers: headers(t.apiKey), signal: AbortSignal.timeout(3000) });
    const data: any = r.ok ? await r.json() : null;
    const m = ((data?.data ?? []) as any[]).find((x) => x?.id === t.model || (x?.aliases ?? []).includes(t.model));
    const out: string[] = m?.architecture?.output_modalities ?? [];
    decisions = out.includes("decisions") && !out.includes("text");
  } catch {
    // unknown: treat it as a chat model (the old path)
  }
  kindCache.set(key, { decisions, at: Date.now() });
  return decisions;
}

async function askTyped<T>(t: Target, kind: DecisionKind, ask: TypedAsk<T>, signal: AbortSignal, track?: Omit<UsageTrack, "purpose">): Promise<T | null> {
  const started = Date.now();
  let ok = false;
  let inputTokens = 0;
  try {
    // The state fitted to what the server takes (lib/inputLimit.ts); refused for length, once more at half.
    const send = (max: number) => post(`${t.baseUrl}/systemone`, { model: t.model, state: fitJson(ask.state, max), questions: ask.questions }, t.apiKey, undefined, signal);
    let res = await send(limitFor(t.baseUrl, t.model, t.maxInputChars));
    if (!res.ok) {
      const body = await res.text();
      if (!isTooLong(res.status, body)) throw new Error(`systemone HTTP ${res.status}`);
      res = await send(learnLimit(t.baseUrl, t.model, JSON.stringify(fitJson(ask.state, limitFor(t.baseUrl, t.model, t.maxInputChars))).length));
      if (!res.ok) throw new Error(`systemone HTTP ${res.status}`);
    }
    const data: any = await res.json();
    inputTokens = data?.usage?.input_tokens ?? 0;
    ok = true;
    return ask.map((data?.answers ?? {}) as TypedAnswers);
  } finally {
    if (track) {
      try {
        await track.ctx.runMutation(internal.usage.record, {
          model: t.model,
          provider: t.provider ?? "إعدادات الخادم",
          role: "decide",
          purpose: `decide:${kind}`,
          ...(track.userId ? { userId: track.userId } : {}),
          ...(track.turnId ? { turnId: track.turnId } : {}),
          prompt: inputTokens,
          completion: 0,
          counted: ok,
          ms: Date.now() - started,
          ok,
        });
      } catch (e) {
        console.error("usage: not recorded", e instanceof Error ? e.message : e);
      }
    }
  }
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
    out.push(...(await embedBatch(cfg, texts.slice(i, i + 64).map((t) => withPrefix(prefix, t, kind)))));
  }
  return out;
}

/**
 * One batch, fitted to the server (lib/inputLimit.ts): each text cut to the known limit; a refusal
 * for length halves the batch, then the text, and remembers the smaller limit. A text that is
 * still refused at the minimum fails the call. The cut text is only what is embedded: the chunk
 * keeps its full text for reading and keyword search.
 */
async function embedBatch(cfg: EmbedTarget, batch: string[]): Promise<number[][]> {
  const limit = limitFor(cfg.baseUrl, cfg.model, cfg.maxInputChars);
  const input = batch.map((t) => cutText(t, limit));
  const res = await post(`${cfg.baseUrl}/embeddings`, { model: cfg.model, input, ...(cfg.sendDimensions ? { dimensions: cfg.dimensions } : {}) }, cfg.apiKey);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (isTooLong(res.status, body)) {
      if (input.length > 1) {
        const half = Math.ceil(input.length / 2);
        return [...(await embedBatch(cfg, batch.slice(0, half))), ...(await embedBatch(cfg, batch.slice(half)))];
      }
      const size = input[0]!.length;
      if (size > MIN_INPUT_CHARS) {
        learnLimit(cfg.baseUrl, cfg.model, size);
        return await embedBatch(cfg, batch);
      }
    }
    throw new Error(`${cfg.baseUrl}/embeddings → HTTP ${res.status}: ${body}`);
  }
  const data: any = await res.json();
  const rows = [...(data.data ?? [])].sort((a: any, b: any) => a.index - b.index);
  if (rows.length !== input.length) throw new Error(`خادم التضمين أعاد ${rows.length} متجهاً لـ${input.length} نصاً`);
  return rows.map((r: any) => {
    if (!Array.isArray(r.embedding) || r.embedding.length !== cfg.dimensions) {
      throw new Error(`بُعد التضمين ${r.embedding?.length} لا يطابق EMBED_DIMENSIONS=${cfg.dimensions}`);
    }
    return r.embedding as number[];
  });
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
      reasoning: { enabled: false },
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
export function embeddingSignature(e: EmbedTarget = aiConfig().embed) {
  return { model: e.model, dimensions: e.dimensions, queryPrefix: e.queryPrefix, docPrefix: e.docPrefix };
}

export const MISMATCH = "نموذج التضمين الحالي لا يطابق النموذج الذي بُني به الفهرس. يلزم إعادة الفهرسة الكاملة قبل التشغيل.";

/** Registers the rag embedder and pins the embedding model on first use; throws if the model changed since. */
export async function ensureEmbeddingIndex(ctx: MutationCtx) {
  const sig = embeddingSignature(await embedConfigFromDb(ctx.db));
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
    return embeddingSignature(await embedConfigFromDb(ctx.db));
  },
});

/** The rag component's embedder. Queries arrive marked with QUERY_MARK and get the query prefix. */
export const embedForIndex = internalAction({
  args: { texts: v.array(v.string()) },
  handler: async (ctx, { texts }) => {
    await primeAi(ctx);
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
