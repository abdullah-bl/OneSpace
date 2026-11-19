// The admin console's backends (model providers, data sources, overview) and global search.
// Fake model servers; a real SQLite file as the external database.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, FILE_NAMES, TASK_TITLES, type ActorKey, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { checkReadOnlySql, httpTarget } from "../onebase/lib/sourceQuery";
import { maskUrl } from "../onebase/dataSources";

let ai: FakeAI;
let ai2: FakeAI;
let s: Server;
let f: Fixture;
let dbPath: string;
let syncRoot: string;
let mcp: ReturnType<typeof Bun.serve>;
const mcpCalls: any[] = [];
const tok = (a: string) => (f.tokens as any)[a] as string;
const ACTIVE: ActorKey[] = ["admin", "mgr", "mem", "rdr", "out"];

beforeAll(async () => {
  ai = startFakeAI();
  ai2 = startFakeAI();
  dbPath = join(mkdtempSync(join(tmpdir(), "onespace-src-")), "hr.db");
  const db = new Database(dbPath);
  db.run("create table emp(id int, name text, dept text, leave int)");
  db.run("insert into emp values (1,'سارة-SRC41','المالية',12),(2,'خالد','الموارد',5),(3,'منى','المالية',20)");
  db.close();
  syncRoot = mkdtempSync(join(tmpdir(), "onespace-sync-"));
  mkdirSync(join(syncRoot, "hr", "sub"), { recursive: true });
  writeFileSync(join(syncRoot, "hr", "policy.txt"), "سياسة المزامنة SYNC-91");
  writeFileSync(join(syncRoot, "hr", "sub", "note.md"), "ملاحظة فرعية SYNC-92");
  writeFileSync(join(syncRoot, "hr", "skip.exe"), "binary");
  writeFileSync(join(syncRoot, "outside.txt"), "خارج المجلد SYNC-93");
  // A fake MCP server (Streamable HTTP, JSON replies).
  mcp = Bun.serve({
    port: 0,
    async fetch(req) {
      const m: any = await req.json();
      if (m.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: { "Mcp-Session-Id": "sess-1" } });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hr", version: "1" } });
      if (m.method === "tools/list") return reply({ tools: [{ name: "lookup_employee", description: "Find an employee", inputSchema: { type: "object", properties: { id: { type: "string" } } } }, { name: "delete_employee", description: "Deletes" }] });
      if (m.method === "tools/call") {
        mcpCalls.push({ ...m.params, session: req.headers.get("mcp-session-id") });
        return reply({ content: [{ type: "text", text: `موظف ${m.params.arguments?.id} MCP-77` }] });
      }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    },
  });
  s = await new Server(undefined, { ...aiEnv(ai), SYNC_ROOT: syncRoot }).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
  ai2?.stop();
  mcp?.stop(true);
});

async function ask(token: string, text: string) {
  const t = must(await s.call("mutation", "chat:createThread", {}, token));
  must(await s.call("mutation", "chat:send", { threadId: t, text }, token));
  for (let i = 0; i < 800; i++) {
    const r = must(await s.call("query", "chat:messages", { threadId: t }, token));
    if (!r.turn && r.messages.at(-1)?.role === "assistant") return { threadId: t, answer: r.messages.at(-1) };
    await Bun.sleep(25);
  }
  throw new Error("no answer");
}
/** The tool result the model got back for a marker in the question. */
function toolResultFor(fake: FakeAI, marker: string): string {
  const reqs = fake.requests.filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.messages ?? []).includes(marker));
  const msgs = reqs.flatMap((r) => r.body.messages as any[]).filter((m) => m.role === "tool");
  return msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}
const systemOf = (fake: FakeAI, marker: string) =>
  fake.requests
    .filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.messages ?? []).includes(marker))
    .map((r) => (r.body.messages as any[]).find((m) => m.role === "system")?.content ?? "")
    .join("\n");

describe("read-only guards (unit)", () => {
  test("SQL: one SELECT only", () => {
    expect(checkReadOnlySql("select * from emp;")).toBe("select * from emp");
    expect(checkReadOnlySql("WITH x AS (select 1) select * from x")).toContain("WITH");
    expect(checkReadOnlySql("select 'drop table' as w")).toContain("drop");
    for (const bad of ["delete from emp", "select 1; drop table emp", "select * into t from emp", "update emp set leave=0", "with d as (delete from emp returning *) select * from d", "select pg_sleep(100)", "/* x */ insert into emp values (1)", ""])
      expect(() => checkReadOnlySql(bad)).toThrow();
  });
  test("HTTP: stays under the base URL and the allowed paths", () => {
    expect(httpTarget({ url: "https://hr.example/api", paths: ["employees"] }, "employees/7", { a: "1" })).toBe("https://hr.example/api/employees/7?a=1");
    for (const p of ["../admin", "payroll", "https://evil.example/x", "//evil.example/x", "employees\\..\\x"]) expect(() => httpTarget({ url: "https://hr.example/api", paths: ["employees"] }, p)).toThrow();
  });
  test("connection strings are masked", () => {
    expect(maskUrl("postgres://reader:s3cret@db:5432/hr")).not.toContain("s3cret");
    expect(maskUrl("https://x.example/search?api_key=s3cret&q=1")).not.toContain("s3cret");
  });
});

describe("model providers", () => {
  test("add, check, point the main role at it, and turns go there; the key is never returned", async () => {
    const id = must(await s.call("mutation", "providers:save", { name: "ثانٍ", baseUrl: ai2.url, apiKey: "sk-SECRET-PV1", enabled: true }, tok("admin")));
    const listed = must(await s.call("query", "providers:list", {}, tok("admin")));
    expect(JSON.stringify(listed)).not.toContain("sk-SECRET-PV1");
    expect(listed.providers[0].hasKey).toBe(true);
    expect(listed.env.main.configured).toBe(true);
    const r = must(await s.call("action", "providers:check", { providerId: id }, tok("admin")));
    expect(r.ok).toBe(true);
    expect(r.models).toContain("fake");
    // The model must be one the server listed.
    expect((await s.call("mutation", "providers:setRole", { role: "main", providerId: id, model: "nope" }, tok("admin"))).ok).toBe(false);
    must(await s.call("mutation", "providers:setRole", { role: "main", providerId: id, model: "fake" }, tok("admin")));
    // In use: can't be disabled or removed.
    expect((await s.call("mutation", "providers:remove", { providerId: id }, tok("admin"))).ok).toBe(false);
    expect((await s.call("mutation", "providers:save", { providerId: id, name: "ثانٍ", baseUrl: ai2.url, enabled: false }, tok("admin"))).ok).toBe(false);

    await Bun.sleep(5_100); // primeAi keeps the last copy for 5 s
    await ask(tok("mem"), "سؤال عبر المزوّد PRV-77");
    const viaSecond = ai2.requests.filter((x) => x.path === "/v1/chat/completions" && JSON.stringify(x.body).includes("PRV-77"));
    expect(viaSecond.length).toBeGreaterThan(0);
    expect(viaSecond.every((x) => x.body.model === "fake")).toBe(true);

    // Back to the environment.
    must(await s.call("mutation", "providers:setRole", { role: "main", providerId: null }, tok("admin")));
    must(await s.call("mutation", "providers:remove", { providerId: id }, tok("admin")));
    await Bun.sleep(5_100);
    await ask(tok("mem"), "سؤال بعد العودة PRV-78");
    expect(ai2.requests.some((x) => JSON.stringify(x.body).includes("PRV-78"))).toBe(false);
    expect(ai.requests.some((x) => JSON.stringify(x.body).includes("PRV-78"))).toBe(true);
  }, 90_000);

  test("bad addresses are refused", async () => {
    for (const baseUrl of ["file:///etc/passwd", "not a url", "http://user:pw@host/v1"]) expect((await s.call("mutation", "providers:save", { name: "x", baseUrl, enabled: true }, tok("admin"))).ok).toBe(false);
  });
});

describe("data sources", () => {
  let sourceId: string;
  const SOURCE = () => ({ name: "الموارد البشرية", kind: "sqlite", description: "الموظفون وأقسامهم وأرصدة إجازاتهم", url: `sqlite://${dbPath}`, schemaHint: "", rowLimit: 2, visibility: { kind: "spaces", spaceIds: [f.spaces.S_plain] }, enabled: true });

  test("create, check fills the structure, list never shows secrets", async () => {
    sourceId = must(await s.call("mutation", "dataSources:save", SOURCE(), tok("admin")));
    const r = must(await s.call("action", "dataSources:check", { sourceId }, tok("admin")));
    expect(r.ok).toBe(true);
    expect(r.schemaHint).toContain("emp(");
    const pg = must(await s.call("mutation", "dataSources:save", { ...SOURCE(), name: "مالية", kind: "postgres", url: "postgres://reader:PG-SECRET-9@127.0.0.1:1/x", visibility: { kind: "workspace", spaceIds: [] } }, tok("admin")));
    const list = must(await s.call("query", "dataSources:list", {}, tok("admin")));
    expect(JSON.stringify(list)).not.toContain("PG-SECRET-9");
    expect(list.sources.find((x: any) => x._id === sourceId).schemaHint).toContain("emp(");
    // Unreachable server: a clean error, no connection string.
    const bad = must(await s.call("action", "dataSources:check", { sourceId: pg }, tok("admin")));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("PG-SECRET-9");
    must(await s.call("mutation", "dataSources:remove", { sourceId: pg }, tok("admin")));
  }, 30_000);

  /** The fake model follows CALL_TOOL in its system prompt: a source's description is one place it lands. */
  async function instruct(id: string, base: ReturnType<typeof SOURCE>, marker: string, args: Record<string, string>) {
    must(await s.call("mutation", "dataSources:save", { ...base, sourceId: id, url: "", description: `${base.description} ${marker} CALL_TOOL query_source ${JSON.stringify(args)}` }, tok("admin")));
  }

  test("an employee who may see it gets rows through query_source, read only, audited", async () => {
    await instruct(sourceId, SOURCE(), "SRC-Q1", { source: sourceId, sql: "select name, dept, leave from emp order by id" });
    await ask(tok("mem"), "كم رصيد الإجازات؟ SRC-Q1");
    expect(systemOf(ai, "SRC-Q1")).toContain("الموارد البشرية");
    const out = toolResultFor(ai, "SRC-Q1");
    expect(out).toContain("سارة-SRC41");
    expect(out).toContain("وهناك المزيد"); // rowLimit 2 of 3
    expect(out).not.toContain(dbPath);
    // Writes are refused before reaching the database.
    await instruct(sourceId, SOURCE(), "SRC-Q2", { source: sourceId, sql: "delete from emp" });
    await ask(tok("mem"), "SRC-Q2");
    expect(toolResultFor(ai, "SRC-Q2")).toContain("القراءة فقط");
    const db = new Database(dbPath, { readonly: true });
    expect((db.query("select count(*) n from emp").get() as any).n).toBe(3);
    db.close();
    const audit = must(await s.call("query", "audit:list", {}, tok("admin"))) as any[];
    expect(audit.filter((x) => x.action === "source.query").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("visibility and level both gate it, whatever the model asks for", async () => {
    // A source everyone sees, whose description makes the model reach for the restricted one.
    const decoyBase = { ...SOURCE(), name: "عام", description: "مصدر عام", visibility: { kind: "workspace", spaceIds: [] } };
    const decoy = must(await s.call("mutation", "dataSources:save", decoyBase, tok("admin")));
    await instruct(decoy, decoyBase, "SRC-Q3", { source: sourceId, sql: "select * from emp" });
    // out isn't in S_plain: the restricted source isn't listed and the call is refused.
    await ask(tok("out"), "SRC-Q3");
    expect(systemOf(ai, "SRC-Q3")).not.toContain("الموارد البشرية");
    const refused = toolResultFor(ai, "SRC-Q3");
    expect(refused).toContain("لا يوجد مصدر");
    expect(refused).not.toContain("سارة-SRC41");
    // mem on a level that allows only the decoy: refused too.
    const lvl = must(await s.call("mutation", "levels:save", { name: "مصدر واحد", description: "", model: "main", deep: false, tools: null, sources: [decoy], subagents: 0, dailyQuestions: 0 }, tok("admin")));
    must(await s.call("mutation", "levels:assign", { userId: f.ids.mem, levelId: lvl }, tok("admin")));
    await instruct(decoy, decoyBase, "SRC-Q4", { source: sourceId, sql: "select * from emp" });
    await ask(tok("mem"), "SRC-Q4");
    expect(toolResultFor(ai, "SRC-Q4")).toContain("لا يوجد مصدر");
    // Listing it on the level lets it through.
    must(await s.call("mutation", "levels:save", { levelId: lvl, name: "مصدر واحد", description: "", model: "main", deep: false, tools: null, sources: [decoy, sourceId], subagents: 0, dailyQuestions: 0 }, tok("admin")));
    await instruct(decoy, decoyBase, "SRC-Q5", { source: sourceId, sql: "select * from emp" });
    await ask(tok("mem"), "SRC-Q5");
    expect(toolResultFor(ai, "SRC-Q5")).toContain("سارة-SRC41");
    // Disabled: gone for everyone.
    must(await s.call("mutation", "dataSources:save", { ...SOURCE(), sourceId, url: "", enabled: false }, tok("admin")));
    await instruct(decoy, decoyBase, "SRC-Q6", { source: sourceId, sql: "select * from emp" });
    await ask(tok("mem"), "SRC-Q6");
    expect(toolResultFor(ai, "SRC-Q6")).toContain("لا يوجد مصدر");
    // A level without the tool: no sources in the prompt at all.
    must(await s.call("mutation", "levels:save", { levelId: lvl, name: "مصدر واحد", description: "", model: "main", deep: false, tools: ["search_documents"], sources: null, subagents: 0, dailyQuestions: 0 }, tok("admin")));
    await instruct(decoy, decoyBase, "SRC-Q7", { source: decoy, sql: "select 1 as x" });
    await ask(tok("mem"), "SRC-Q7 سؤال");
    expect(systemOf(ai, "SRC-Q7")).not.toContain("query_source");
    must(await s.call("mutation", "levels:remove", { levelId: lvl }, tok("admin")));
    must(await s.call("mutation", "dataSources:remove", { sourceId: decoy }, tok("admin")));
  }, 90_000);
});

describe("global search and overview", () => {
  test("palette finds only what the caller can read", async () => {
    const mem = must(await s.call("query", "palette:find", { q: FILE_NAMES.S_sens.slice(0, 8) }, tok("mem")));
    expect(mem.files.some((x: any) => x.name === FILE_NAMES.S_sens)).toBe(true);
    const out = must(await s.call("query", "palette:find", { q: FILE_NAMES.S_sens.slice(0, 8) }, tok("out")));
    expect(out.files.length).toBe(0);
    const tasks = must(await s.call("query", "palette:find", { q: TASK_TITLES.S_plain }, tok("out")));
    expect(tasks.tasks.length).toBe(0);
    expect(must(await s.call("query", "palette:find", { q: TASK_TITLES.S_plain }, tok("mem"))).tasks.length).toBe(1);
    // Arabic normalization: hamza/taa marbuta variants match.
    expect(must(await s.call("query", "palette:find", { q: "سياسه الاجازات" }, tok("out"))).files.some((x: any) => x.name === FILE_NAMES.S_every)).toBe(true);
  });

  test("overview counts", async () => {
    const o = must(await s.call("query", "admin:overview", {}, tok("admin")));
    expect(o.users.active).toBeGreaterThanOrEqual(5);
    expect(o.users.pending).toBeGreaterThanOrEqual(1);
    expect(o.spaces.total).toBe(3);
  });
});

describe("أعمالي (artifacts:mine)", () => {
  test("only my outputs, only in spaces I can still read; search reaches the content", async () => {
    const doc = must(await s.call("mutation", "artifacts:create", { title: "تقرير الربع WRK-1", kind: "markdown", content: "# ملخص\nالميزانية التشغيلية WRK-INNER-7 تجاوزت الخطة", spaceId: f.spaces.S_plain }, tok("mem")));
    must(await s.call("mutation", "artifacts:create", { title: "chart-WRK.png", kind: "markdown", content: "![x](data:image/png;base64,AAAA)", spaceId: f.spaces.P_mem }, tok("mem")));
    must(await s.call("mutation", "artifacts:create", { title: "جدول-WRK", kind: "table", content: JSON.stringify({ columns: ["a"], rows: [[1]] }), spaceId: f.spaces.S_plain }, tok("mgr")));
    const mine = must(await s.call("query", "artifacts:mine", {}, tok("mem")));
    expect(mine.map((a: any) => a.title)).toContain("تقرير الربع WRK-1");
    expect(mine.map((a: any) => a.title)).not.toContain("جدول-WRK"); // mgr's, not mine
    expect(mine.find((a: any) => a.title === "chart-WRK.png").kind).toBe("image");
    const hit = must(await s.call("query", "artifacts:mine", { q: "wrk-inner-7" }, tok("mem")));
    expect(hit.map((a: any) => a._id)).toEqual([doc.artifactId]);
    expect(hit[0].snippet).toContain("WRK-INNER-7");
    expect(must(await s.call("query", "artifacts:mine", { kind: "image" }, tok("mem"))).every((a: any) => a.kind === "image")).toBe(true);
    expect(must(await s.call("query", "artifacts:mine", { q: "WRK" }, tok("out"))).length).toBe(0);
    // Removed from the space: gone from «أعمالي» too.
    must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_plain, userId: f.ids.mem }, tok("mgr")));
    expect(must(await s.call("query", "artifacts:mine", { q: "WRK-1" }, tok("mem"))).length).toBe(0);
    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.mem, role: "member" }, tok("mgr")));
    for (const a of ACTORS) expect((await s.call("query", "artifacts:mine", {}, tok(a))).ok).toBe(ACTIVE.includes(a));
  });
});

describe("pinned chats", () => {
  test("a pinned chat comes first; only its owner can pin it", async () => {
    const old = must(await s.call("mutation", "chat:createThread", { title: "قديمة-PIN" }, tok("mem")));
    await Bun.sleep(5);
    must(await s.call("mutation", "chat:createThread", { title: "أحدث-PIN" }, tok("mem")));
    must(await s.call("mutation", "chat:setPinned", { threadId: old, pinned: true }, tok("mem")));
    const list = must(await s.call("query", "chat:threads", {}, tok("mem")));
    expect(list[0]).toMatchObject({ threadId: old, pinned: true });
    expect((await s.call("mutation", "chat:setPinned", { threadId: old, pinned: false }, tok("mgr"))).ok).toBe(false);
    must(await s.call("mutation", "chat:setPinned", { threadId: old, pinned: false }, tok("mem")));
    expect(must(await s.call("query", "chat:threads", {}, tok("mem")))[0].threadId).not.toBe(old);
    for (const a of ACTORS) if (a !== "mem") expect((await s.call("mutation", "chat:setPinned", { threadId: old, pinned: true }, tok(a))).ok).toBe(false);
  });
});

describe("permission matrix: providers, data sources, overview, palette", () => {
  test("admin-only functions refuse everyone else; palette: active members", async () => {
    const pid = must(await s.call("mutation", "providers:save", { name: "مصفوفة", baseUrl: ai2.url, enabled: true }, tok("admin")));
    const sid = must(await s.call("mutation", "dataSources:save", { name: "مصفوفة", kind: "sqlite", description: "x", url: `sqlite://${dbPath}`, schemaHint: "", rowLimit: 5, visibility: { kind: "workspace", spaceIds: [] }, enabled: true }, tok("admin")));
    for (const a of ACTORS) {
      const admin = a === "admin";
      expect((await s.call("query", "palette:find", { q: "مساحة" }, tok(a))).ok).toBe(ACTIVE.includes(a));
      expect((await s.call("query", "admin:overview", {}, tok(a))).ok).toBe(admin);
      expect((await s.call("query", "providers:list", {}, tok(a))).ok).toBe(admin);
      expect((await s.call("query", "dataSources:list", {}, tok(a))).ok).toBe(admin);
      if (admin) continue;
      expect((await s.call("mutation", "providers:save", { name: "x", baseUrl: ai2.url, enabled: true }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "providers:save", { providerId: pid, name: "x", baseUrl: "http://evil.example/v1", enabled: true }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "providers:setRole", { role: "main", providerId: pid, model: "fake" }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "providers:remove", { providerId: pid }, tok(a))).ok).toBe(false);
      expect((await s.call("action", "providers:check", { providerId: pid }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "dataSources:save", { name: "x", kind: "sqlite", description: "x", url: "sqlite:///etc/x.db", schemaHint: "", rowLimit: 5, visibility: { kind: "workspace", spaceIds: [] }, enabled: true }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "dataSources:remove", { sourceId: sid }, tok(a))).ok).toBe(false);
      expect((await s.call("action", "dataSources:check", { sourceId: sid }, tok(a))).ok).toBe(false);
    }
    must(await s.call("mutation", "providers:remove", { providerId: pid }, tok("admin")));
    must(await s.call("mutation", "dataSources:remove", { sourceId: sid }, tok("admin")));
  }, 60_000);
});

describe("tools page, team levels, MCP, folder sync", () => {
  test("tools overview lists every tool with its agents and levels", async () => {
    const t = must(await s.call("query", "toolsAdmin:overview", {}, tok("admin")));
    const names = t.map((x: any) => x.name);
    expect(names).toContain("query_source");
    expect(names).toContain("run_analysis");
    expect(t.find((x: any) => x.name === "run_analysis").writes).toBe(true);
  });

  test("team level: members of the space get it; an own level wins; the most generous team wins", async () => {
    const team = must(await s.call("mutation", "levels:save", { name: "فريق-TL", description: "", model: "fast", deep: false, tools: null, sources: null, spaceIds: [f.spaces.S_plain], subagents: 0, dailyQuestions: 7 }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mem"))).name).toBe("فريق-TL");
    expect(must(await s.call("query", "levels:mine", {}, tok("out"))).name).not.toBe("فريق-TL"); // not in S_plain
    const big = must(await s.call("mutation", "levels:save", { name: "فريق-كبير", description: "", model: "main", deep: true, tools: null, sources: null, spaceIds: [f.spaces.S_sens], subagents: 0, dailyQuestions: 0 }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mem"))).name).toBe("فريق-كبير");
    const own = must(await s.call("mutation", "levels:save", { name: "خاص-TL", description: "", model: "fast", deep: false, tools: null, sources: null, subagents: 0, dailyQuestions: 3 }, tok("admin")));
    must(await s.call("mutation", "levels:assign", { userId: f.ids.mem, levelId: own }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mem"))).name).toBe("خاص-TL");
    const list = must(await s.call("query", "levels:list", {}, tok("admin")));
    expect(list.users.find((u: any) => u._id === f.ids.mem).effective.via).toBe("own");
    expect(list.users.find((u: any) => u._id === f.ids.rdr).effective.via).toBe("team");
    // A personal space is not a team.
    expect((await s.call("mutation", "levels:save", { name: "x-TL", description: "", model: "main", deep: false, tools: null, sources: null, spaceIds: [f.spaces.P_mem], subagents: 0, dailyQuestions: 0 }, tok("admin"))).ok).toBe(false);
    for (const id of [team, big, own]) must(await s.call("mutation", "levels:remove", { levelId: id }, tok("admin")));
  });

  test("MCP source: check lists its tools; only allowed tools are called", async () => {
    const base = { name: "نظام MCP", kind: "mcp", description: "موظفون عبر MCP", url: `http://127.0.0.1:${mcp.port}/mcp`, headerName: "Authorization", headerValue: "Bearer MCP-SECRET-5", schemaHint: "", rowLimit: 50, visibility: { kind: "workspace", spaceIds: [] }, enabled: true, tools: ["lookup_employee"] };
    const id = must(await s.call("mutation", "dataSources:save", base, tok("admin")));
    const r = must(await s.call("action", "dataSources:check", { sourceId: id }, tok("admin")));
    expect(r.ok).toBe(true);
    expect(r.tools).toEqual(["lookup_employee", "delete_employee"]);
    expect(JSON.stringify(must(await s.call("query", "dataSources:list", {}, tok("admin"))))).not.toContain("MCP-SECRET-5");
    const say = async (marker: string, args: object) =>
      must(await s.call("mutation", "dataSources:save", { ...base, sourceId: id, url: "", headerValue: "", description: `موظفون عبر MCP ${marker} CALL_TOOL query_source ${JSON.stringify({ source: id, ...args })}` }, tok("admin")));
    await say("MCP-Q1", { tool: "lookup_employee", arguments: { id: "E7" } });
    await ask(tok("mem"), "MCP-Q1");
    expect(toolResultFor(ai, "MCP-Q1")).toContain("موظف E7 MCP-77");
    expect(mcpCalls.at(-1)).toMatchObject({ name: "lookup_employee", session: "sess-1" });
    const before = mcpCalls.length;
    await say("MCP-Q2", { tool: "delete_employee", arguments: { id: "E7" } });
    await ask(tok("mem"), "MCP-Q2");
    expect(toolResultFor(ai, "MCP-Q2")).toContain("غير مسموحة");
    expect(mcpCalls.length).toBe(before);
    must(await s.call("mutation", "dataSources:remove", { sourceId: id }, tok("admin")));
  }, 60_000);

  test("folder sync: copies under SYNC_ROOT only, versions changes, never escapes", async () => {
    // mgr writes S_plain but isn't an admin; the admin isn't a member of S_plain: make admin a member.
    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.admin, role: "member" }, tok("mgr")));
    symlinkSync(join(syncRoot, "outside.txt"), join(syncRoot, "hr", "link.txt"));
    expect((await s.call("mutation", "folderSync:save", { spaceId: f.spaces.S_plain, path: "../etc", extensions: [], recursive: true, intervalMinutes: 60, enabled: true }, tok("admin"))).ok).toBe(false);
    const b = must(await s.call("action", "folderSync:browse", { path: "" }, tok("admin")));
    expect(b.folders).toContain("hr");
    expect((await s.call("action", "folderSync:browse", { path: "../../" }, tok("admin"))).ok).toBe(false);
    const id = must(await s.call("mutation", "folderSync:save", { spaceId: f.spaces.S_plain, path: "hr", extensions: [], recursive: true, intervalMinutes: 60, enabled: true }, tok("admin")));
    const r1 = must(await s.call("action", "folderSync:runNow", { syncId: id }, tok("admin")));
    expect(r1).toMatchObject({ started: true, added: 2 }); // policy.txt + sub/note.md; .exe ignored
    const names = must(await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, tok("mem"))).map((x: any) => x.name);
    expect(names).toContain("policy.txt");
    expect(names).toContain("note.md");
    expect(names).not.toContain("link.txt"); // symlink to a file outside the folder: skipped
    expect(names).not.toContain("outside.txt");
    // Unchanged: nothing new. Changed: a new version.
    expect(must(await s.call("action", "folderSync:runNow", { syncId: id }, tok("admin")))).toMatchObject({ added: 0, updated: 0 });
    await Bun.sleep(20);
    writeFileSync(join(syncRoot, "hr", "policy.txt"), "سياسة معدّلة SYNC-94");
    expect(must(await s.call("action", "folderSync:runNow", { syncId: id }, tok("admin")))).toMatchObject({ updated: 1 });
    const policy = must(await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, tok("mem"))).find((x: any) => x.name === "policy.txt");
    expect(policy.version).toBe(2);
    must(await s.call("mutation", "folderSync:remove", { syncId: id }, tok("admin")));
    // Files stay after the sync is removed.
    expect(must(await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, tok("mem"))).some((x: any) => x.name === "policy.txt")).toBe(true);
  }, 60_000);

  test("permission matrix: tools overview and folder sync are admin only", async () => {
    for (const a of ACTORS) {
      if (a === "admin") continue;
      expect((await s.call("query", "toolsAdmin:overview", {}, tok(a))).ok).toBe(false);
      expect((await s.call("query", "folderSync:list", {}, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "folderSync:save", { spaceId: f.spaces.S_plain, path: "hr", extensions: [], recursive: true, intervalMinutes: 60, enabled: true }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "folderSync:remove", { syncId: "x" }, tok(a))).ok).toBe(false);
      expect((await s.call("action", "folderSync:runNow", { syncId: "x" }, tok(a))).ok).toBe(false);
      expect((await s.call("action", "folderSync:browse", { path: "" }, tok(a))).ok).toBe(false);
    }
  }, 60_000);
});
