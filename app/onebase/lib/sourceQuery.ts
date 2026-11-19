// Running one read-only request against an external data source (dataSources.ts), from an action.
//
// Databases (Bun.SQL: postgres, mysql, sqlite): one SELECT/WITH statement only, checked here, then
// run inside a read-only transaction with a statement timeout and wrapped in an outer LIMIT, so
// even a statement that slips past the check can't write or run long. Use a database account
// with read-only grants as well: this is the second lock, not the only one.
// HTTP: GET only, under the base URL and the allowed path prefixes; the auth header is added here.
// Search: a SearxNG-style JSON endpoint (…/search?q=…&format=json) or any URL with {q}.
// MCP: a Model Context Protocol server over Streamable HTTP (JSON-RPC POST; JSON or SSE replies).
// Only the tools the admin listed may be called; MCP can't promise "read only", so the admin
// lists only tools that read.

import { SQL } from "bun";

export type SourceKind = "postgres" | "mysql" | "sqlite" | "http" | "search" | "mcp";
export type SourceSecret = { kind: SourceKind; url: string; headerName?: string; headerValue?: string; paths?: string[]; tools?: string[]; rowLimit: number };
export type SourceRequest = { sql?: string; path?: string; params?: Record<string, string>; query?: string; tool?: string; arguments?: Record<string, unknown> };
export type SourceAnswer = { columns?: string[]; rows?: Record<string, unknown>[]; text?: string; truncated: boolean };

export const TIMEOUT_MS = 15_000;
const MAX_TEXT = 60_000;
const WRITE_WORDS =
  /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|copy|call|exec|execute|attach|detach|pragma|vacuum|reindex|lock|into|outfile|dumpfile|nextval|setval|pg_sleep|sleep|benchmark|dblink|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|load_file)\b/i;

/** Comments and string literals removed, for checking only (the query runs as written). */
function skeleton(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

/** Throws with an Arabic reason unless `sql` is a single read-only SELECT. Returns it without a trailing ";". */
export function checkReadOnlySql(sql: string): string {
  const text = sql.trim().replace(/;\s*$/, "");
  if (!text) throw new Error("الاستعلام فارغ");
  if (text.length > 8000) throw new Error("الاستعلام أطول من المسموح");
  const sk = skeleton(text);
  if (sk.includes(";")) throw new Error("استعلام واحد فقط في كل مرة");
  if (!/^\s*(select|with)\b/i.test(sk)) throw new Error("القراءة فقط: يبدأ الاستعلام بـ SELECT أو WITH");
  const bad = sk.match(WRITE_WORDS);
  if (bad) throw new Error(`القراءة فقط: «${bad[0]}» غير مسموحة`);
  return text;
}

function connectUrl(kind: SourceKind, url: string): string {
  if (kind === "sqlite") {
    const path = url.replace(/^sqlite:\/\//, "").replace(/\?.*$/, "");
    return `sqlite://${path}?mode=ro`;
  }
  return url;
}

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} بايت>`;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 500);
  if (typeof v === "string" && v.length > 1000) return v.slice(0, 1000) + "…";
  return v;
}

async function runSql(src: SourceSecret, raw: string): Promise<SourceAnswer> {
  const q = checkReadOnlySql(raw);
  const limit = Math.max(1, Math.min(src.rowLimit, 1000));
  const db = new SQL(connectUrl(src.kind, src.url), { max: 1, idleTimeout: 5, connectionTimeout: 8 } as any);
  const wrapped = `SELECT * FROM (${q}) AS onespace_q LIMIT ${limit + 1}`;
  try {
    const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("تجاوز الاستعلام الوقت المسموح")), TIMEOUT_MS));
    const work = (async () => {
      if (src.kind === "sqlite") return await db.unsafe(wrapped);
      return await db.begin(async (tx: any) => {
        if (src.kind === "postgres") {
          await tx.unsafe("SET TRANSACTION READ ONLY");
          await tx.unsafe(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
        } else {
          await tx.unsafe(`SET SESSION max_execution_time = ${TIMEOUT_MS}`);
        }
        return await tx.unsafe(wrapped);
      });
    })();
    const rows = (await Promise.race([work, timer])) as Record<string, unknown>[];
    const list = [...rows].slice(0, limit).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
    return { columns: list[0] ? Object.keys(list[0]) : [], rows: list, truncated: rows.length > limit };
  } finally {
    db.close().catch(() => {});
  }
}

function headers(src: SourceSecret): Record<string, string> {
  return { Accept: "application/json, text/plain;q=0.8, */*;q=0.5", ...(src.headerName && src.headerValue ? { [src.headerName]: src.headerValue } : {}) };
}

async function readBody(res: Response): Promise<{ text: string; truncated: boolean }> {
  const body = await res.text();
  let text = body;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 1);
    } catch {}
  }
  return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

/** The full URL for a GET under the source's base, or an error if it leaves it. */
export function httpTarget(src: Pick<SourceSecret, "url" | "paths">, path = "", params: Record<string, string> = {}): string {
  const base = new URL(src.url.endsWith("/") ? src.url : src.url + "/");
  const rel = String(path).replace(/^\/+/, "");
  if (/^[a-z]+:/i.test(rel) || rel.includes("..") || rel.includes("\\")) throw new Error("مسار غير مسموح");
  const url = new URL(rel, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("مسار خارج عنوان المصدر");
  const sub = "/" + url.pathname.slice(base.pathname.length);
  if (src.paths?.length && !src.paths.some((p) => sub.startsWith("/" + p.replace(/^\/+/, "")))) throw new Error(`المسارات المسموحة: ${src.paths.join("، ")}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(String(k), String(v));
  return url.toString();
}

async function runHttp(src: SourceSecret, req: SourceRequest): Promise<SourceAnswer> {
  const res = await fetch(httpTarget(src, req.path, req.params), { method: "GET", headers: headers(src), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ردّ النظام بـ HTTP ${res.status}`);
  return await readBody(res);
}

async function runSearch(src: SourceSecret, query: string): Promise<SourceAnswer> {
  const q = query.trim().slice(0, 400);
  if (!q) throw new Error("اكتب ما تبحث عنه");
  let url: string;
  if (src.url.includes("{q}")) url = src.url.replace("{q}", encodeURIComponent(q));
  else {
    const u = new URL(src.url);
    u.searchParams.set("q", q);
    if (!u.searchParams.has("format")) u.searchParams.set("format", "json");
    url = u.toString();
  }
  const res = await fetch(url, { headers: headers(src), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ردّ محرك البحث بـ HTTP ${res.status}`);
  const data: any = await res.json().catch(() => null);
  const items: any[] = data?.results ?? data?.items ?? data?.hits ?? [];
  if (!Array.isArray(items)) return await readBody(res);
  const limit = Math.max(1, Math.min(src.rowLimit, 20));
  const rows = items.slice(0, limit).map((r) => ({ title: plain(r.title ?? r.name ?? ""), url: plain(r.url ?? r.link ?? ""), snippet: plain(r.content ?? r.snippet ?? r.description ?? "") }));
  return { columns: ["title", "url", "snippet"], rows, truncated: items.length > limit };
}

// ---------------------------------------------------------------- MCP (Streamable HTTP)

type McpTool = { name: string; description?: string; inputSchema?: unknown };

/** One JSON-RPC exchange; reads a JSON body or the first matching `data:` line of an SSE stream. */
async function rpc(src: SourceSecret, session: { id?: string }, method: string, params: unknown, id: number | null): Promise<any> {
  const res = await fetch(src.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
      ...(src.headerName && src.headerValue ? { [src.headerName]: src.headerValue } : {}),
    },
    body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session.id = sid;
  if (id === null) return null;
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "رفض خادم MCP الدخول" : `ردّ خادم MCP بـ HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let msg: any = null;
  if (type.includes("event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const m = JSON.parse(line.slice(5).trim());
        if (m?.id === id) msg = m;
      } catch {}
    }
  } else msg = JSON.parse(text);
  if (!msg) throw new Error("رد غير مفهوم من خادم MCP");
  if (msg.error) throw new Error(`خادم MCP: ${String(msg.error.message ?? "خطأ").slice(0, 200)}`);
  return msg.result;
}

async function mcpSession(src: SourceSecret) {
  const session: { id?: string } = {};
  await rpc(src, session, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "onespace", version: "1" } }, 1);
  await rpc(src, session, "notifications/initialized", {}, null).catch(() => {});
  return session;
}

export async function listMcpTools(src: SourceSecret): Promise<McpTool[]> {
  const session = await mcpSession(src);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await rpc(src, session, "tools/list", cursor ? { cursor } : {}, 2 + page);
    tools.push(...((r?.tools ?? []) as McpTool[]));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

async function runMcp(src: SourceSecret, req: SourceRequest): Promise<SourceAnswer> {
  const name = String(req.tool ?? "");
  if (!name) throw new Error("هذا المصدر خادم MCP: أرسل tool و arguments");
  if (!src.tools?.includes(name)) throw new Error(`الأداة «${name}» غير مسموحة. المسموحة: ${src.tools?.join("، ") || "لا شيء"}`);
  const session = await mcpSession(src);
  const r = await rpc(src, session, "tools/call", { name, arguments: req.arguments ?? {} }, 9);
  const parts: string[] = [];
  for (const c of (r?.content ?? []) as any[]) {
    if (c?.type === "text") parts.push(String(c.text));
    else if (c?.type === "resource" && c.resource?.text) parts.push(String(c.resource.text));
    else if (c?.type) parts.push(`<${c.type}>`);
  }
  if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 1));
  const text = parts.join("\n\n");
  if (r?.isError) throw new Error(`فشلت أداة MCP: ${text.slice(0, 300)}`);
  return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

export async function runSource(src: SourceSecret, req: SourceRequest): Promise<SourceAnswer> {
  if (src.kind === "mcp") return await runMcp(src, req);
  if (src.kind === "http") return await runHttp(src, req);
  if (src.kind === "search") return await runSearch(src, req.query ?? "");
  if (!req.sql) throw new Error("هذا المصدر قاعدة بيانات: أرسل sql");
  return await runSql(src, req.sql);
}

/** «افحص»: connects and describes what's there (tables and columns, or the first response). */
export async function describeSource(src: SourceSecret): Promise<string> {
  if (src.kind === "mcp") {
    const tools = await listMcpTools(src);
    return tools.map((t) => `${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 300)}${t.inputSchema ? `\n  args: ${JSON.stringify((t.inputSchema as any)?.properties ?? {}).slice(0, 400)}` : ""}`).join("\n") || "لا أدوات";
  }
  if (src.kind === "http") {
    const r = await runHttp(src, { path: src.paths?.[0] ?? "" });
    return `GET ${src.paths?.length ? src.paths.join("، ") : "/"}\nمثال من الرد:\n${(r.text ?? "").slice(0, 1200)}`;
  }
  if (src.kind === "search") {
    await runSearch(src, "test");
    return "بحث نصي: أرسل query.";
  }
  const sql =
    src.kind === "sqlite"
      ? "SELECT m.name AS t, p.name AS c, p.type AS ty FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid"
      : src.kind === "postgres"
        ? "SELECT table_schema || '.' || table_name AS t, column_name AS c, data_type AS ty FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position"
        : "SELECT table_name AS t, column_name AS c, data_type AS ty FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position";
  const db = new SQL(connectUrl(src.kind, src.url), { max: 1, idleTimeout: 5, connectionTimeout: 8 } as any);
  try {
    const rows = (await Promise.race([db.unsafe(sql), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("لا رد خلال الوقت المسموح")), TIMEOUT_MS))])) as { t: string; c: string; ty: string }[];
    const tables = new Map<string, string[]>();
    for (const r of rows) tables.set(r.t, [...(tables.get(r.t) ?? []), `${r.c} ${String(r.ty).toLowerCase()}`]);
    return [...tables].slice(0, 60).map(([t, cols]) => `${t}(${cols.slice(0, 40).join(", ")})`).join("\n") || "لا جداول";
  } finally {
    db.close().catch(() => {});
  }
}
