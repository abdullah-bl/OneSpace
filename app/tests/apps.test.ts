// Apps (plans/13): the bundle and its CSP, files and grants, the data API's rules (append / own /
// aggregate / handler rows, the sender set by the server), private server/ files never reaching a
// browser, test links that write nothing, test_app in a real headless browser, skills that keep an
// app, the quiz migration's handler, and the permission matrix of apps:* functions.
// Handlers need the sandbox (Docker + image) and test_app needs Chrome: those tests skip without them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, expectedAllowed, SPACES, type ActorKey, type Fixture, type SpaceKey } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { sandboxAvailable, startRunner, type Runner } from "./sandbox";
import { applyFiles, appWarnings, bundlePage, grantLines, serverDataCopies, sha256b64 } from "../onebase/lib/appFiles";
import { runHandler } from "../onebase/lib/appHandler";
import { findBrowser } from "../onebase/lib/browserTest";
import { quizAppFiles } from "../onebase/apps";
import { findColumn } from "../onebase/publications";
import { makingRequest } from "../onebase/chat";

// ---------------------------------------------------------------- pure parts

describe("files and the page bundle", () => {
  test("paths: relative, no .., server/ files flat; null deletes; limits", () => {
    for (const bad of ["../x.js", "/etc/passwd", "server/a/b.py", "a b.js", "x/"]) expect(() => applyFiles({}, { [bad]: "1" })).toThrow();
    const f = applyFiles({ "a.js": "1", "b.js": "2" }, { "./c.js": "3", "a.js": null });
    expect(Object.keys(f)).toEqual(["b.js", "c.js"]);
    expect(() => applyFiles({}, Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}.js`, "x"])))).toThrow();
    expect(() => applyFiles({}, { "big.js": "x".repeat(600_000) })).toThrow();
  });

  test("index.html as one document: local js/css inlined, server/ never, scripts run only by hash", () => {
    const files = {
      "index.html": `<html><head><meta http-equiv="refresh" content="0;url=http://evil.test"><link rel="stylesheet" href="s.css"><link rel="stylesheet" href="server/key.json"></head><body><h1>APP</h1><script src="app.js" defer></script><script src="server/mark.py"></script><script src="https://cdn.test/x.js"></script><img src="logo.svg"></body></html>`,
      "s.css": "h1{color:red}",
      "app.js": "document.title='ok';</script><b>",
      "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "data/q.json": "[1]",
      "server/key.json": "SECRETKEY-77",
      "server/mark.py": "SECRETCODE-88",
    };
    const api = "http://127.0.0.1:9/a/abcdefghijkl";
    const { html, csp } = bundlePage(files, { api, token: "TOK", visitor: { signedIn: false, name: null }, lists: {} }, { title: "t", footer: "f", origin: "http://127.0.0.1:9" });
    expect(html).not.toContain("SECRETKEY-77");
    expect(html).not.toContain("SECRETCODE-88");
    expect(html).not.toContain("evil.test");
    expect(html).toContain("<style>h1{color:red}</style>");
    expect(html).toContain("document.title='ok';<\\/script><b>");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain('"data/q.json":"[1]"');
    expect(csp).toContain(`connect-src ${api}`);
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline' 'sha");
    // Every inline script (ours and the app's) is listed by hash; nothing else may run.
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1]!));
    expect(inline.length).toBe(2);
    for (const m of inline) expect(csp).toContain(`'sha256-${sha256b64(m[2]!)}'`);
    expect(csp).not.toMatch(/script-src[^;]*cdn\.test/);
  });

  test("warnings: an answer key in a public file, inline handlers, fetch, storage", () => {
    const w = appWarnings({ files: { "index.html": '<button onclick="go()">x</button>', "data/q.json": '[{"q":"1","correct":"b"}]', "app.js": "fetch('x');localStorage.a=1" }, data: {} });
    expect(w.join("\n")).toContain("data/q.json");
    expect(w.join("\n")).toContain("onclick");
    expect(w.join("\n")).toContain("fetch");
    expect(w.join("\n")).toContain("localStorage");
  });

  test("server data copied into a public file is reported (a key next to the questions); the questions alone are fine", () => {
    const server = 'QUESTIONS = [\n  {"q": "She ___ to work.", "o": ["go", "goes"], "a": 1},\n  {"q": "I ___ here.", "o": ["am", "is"], "a": 0},\n]\n';
    const leaky = { "app.js": 'const QS=[{q:"She ___ to work.",o:["go","goes"],a:1},{q:"I ___ here.",o:["am","is"],a:0}];', "server/mark.py": server };
    const lines = serverDataCopies(leaky);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("2 سجلاً بالحقول: q، o، a؛ منها «a»");
    // The questions repeated next to a separate key (ids, texts, options): what a page shows, not a leak.
    expect(serverDataCopies({ "data/q.json": '{"questions":[{"id": 1, "stem": "She ___", "options": ["go","goes"]}]}', "server/key.json": '{"questions":[{"id": 1, "stem": "She ___", "options": ["go","goes"]}], "answers": {"1": 1}}' })).toEqual([]);
    expect(serverDataCopies({ ...leaky, "app.js": 'const QS=[{q:"She ___ to work.",o:["go","goes"]},{q:"I ___ here.",o:["am","is"]}];' })).toEqual([]);
    expect(serverDataCopies({ "data/q.json": '[{"q":"x","o":["a","b"]}]', "server/key.json": '{"answers": {"x": "a"}, "pass": 5}' })).toEqual([]);
  });

  test("grants in words, for the publish card", () => {
    const lines = grantLines(
      { results: { listId: "L1", write: "handler", read: "none", columns: ["c2"], sender: "c9" }, votes: { listId: "L2", write: "page", read: "aggregate" }, idle: { listId: "L2", write: "none", read: "none" } },
      new Map([["L1", { title: "نتائج", columns: [{ key: "c2", name: "الدرجة" }, { key: "c9", name: "المرسل" }] }], ["L2", { title: "تصويت", columns: [] }]]),
    );
    expect(lines).toEqual(["«نتائج»: يضيف صفوفاً عبر منطق الخادم فقط (الأعمدة: الدرجة) · يسجّل في «المرسل» من أرسل إن كان مسجّل الدخول", "«تصويت»: يضيف صفوفاً من الصفحة، ويقرأ إحصاءات مجمّعة (أعداد ومتوسطات، دون صفوف)"]);
  });

  test("columns are found the way the model names them; making something new doesn't pre-search files", () => {
    const cols = [{ key: "c1", name: "اسم الطالب" }, { key: "c2", name: "1) I ___ a student." }];
    expect(findColumn(cols, "I ___ a student.")?.key).toBe("c2");
    expect(findColumn(cols, "c1")?.key).toBe("c1");
    expect(findColumn(cols, "غير موجود")).toBeUndefined();
    for (const q of ["سوي لي صفحة فيها اختبار تحديد مستوى", "اكتب خطاب شكر"]) expect(makingRequest(q)).toBe(true);
    for (const q of ["سو لي اختبار من ملف التدريب", "لخص الملف"]) expect(makingRequest(q)).toBe(false);
  });
});

// ---------------------------------------------------------------- against a real server

let ai: FakeAI;
let s: Server;
let f: Fixture;
let runner: Runner | null = null;
let hasSandbox = false;
const hasBrowser = !!findBrowser();
const PORT = 20000 + Math.floor(Math.random() * 20000);
const ORIGIN = `http://127.0.0.1:${PORT}`; // the content origin
const APPHOST = `http://localhost:${PORT}`; // the app
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;
const owner = (sp: SpaceKey) => (sp === "P_mem" ? "mem" : "mgr");
const tool = (userId: string, name: string, args: any, extra: { threadId?: string; scopeSpaceIds?: string[] } = {}) => s.adminRun("toolHarness:run", { userId, name, args, ...extra });

/** A small app: a page that appends a vote, and a handler that marks against a private key. */
const QUIZ_FILES = {
  "index.html": `<!doctype html><html lang="ar" dir="rtl"><head><link rel="stylesheet" href="style.css"></head><body><h1>اختبار صغير APPPAGE-1</h1>
<label>الاسم <input id="name"></label>
<label>س1 <select id="q1"><option value="">—</option><option>am</option><option>is</option><option>are</option></select></label>
<button id="send">أرسل</button><p id="out"></p><script src="app.js"></script></body></html>`,
  "style.css": "body{font-family:system-ui}",
  "app.js": `const qs = onespace.json("data/questions.json");
document.getElementById("send").addEventListener("click", async () => {
  try {
    const r = await onespace.call("mark", { name: document.getElementById("name").value, answers: { q1: document.getElementById("q1").value } });
    document.getElementById("out").textContent = "درجتك " + r.score + " من " + r.max + " (" + qs.length + ")";
  } catch (e) { document.getElementById("out").textContent = "خطأ: " + e.message; }
});`,
  "data/questions.json": '[{"id":"q1","text":"I ___ a student"}]',
  "server/key.json": '{"q1":"is","secret":"KEYSECRET-31"}',
  "server/mark.py": `import json
def handle(request):
    key = json.load(open("key.json", encoding="utf-8"))
    p = request["payload"] or {}
    answers = p.get("answers", {})
    score = sum(1 for q, a in key.items() if q != "secret" and answers.get(q) == a)
    return {"response": {"score": score, "max": 1, "seen": request["visitor"]["rows"]}, "rows": [{"list": "results", "cells": {"الاسم": p.get("name") or "؟", "الدرجة": score}}]}
`,
};

/** Per space: a results list (handler writes), a votes list (the page appends, aggregate reads), an app. */
const setup = {} as Record<SpaceKey, { results: string; votes: string; app: string }>;

beforeAll(async () => {
  hasSandbox = await sandboxAvailable();
  if (hasSandbox) runner = await startRunner();
  ai = startFakeAI();
  s = await new Server(undefined, { ...aiEnv(ai), PUBLISH_ORIGIN: ORIGIN, APP_ORIGIN: APPHOST }).start(PORT);
  f = await buildFixture(s);
  for (const sp of SPACES) {
    const t = tok(owner(sp))!;
    const results = must(await s.call("mutation", "lists:create", { spaceId: f.spaces[sp], title: `نتائج ${sp}`, columns: [{ name: "الاسم", type: "text" }, { name: "الدرجة", type: "number" }, { name: "المرسل", type: "person" }] }, t));
    const votes = must(await s.call("mutation", "lists:create", { spaceId: f.spaces[sp], title: `تصويت ${sp}`, columns: [{ name: "الاختيار", type: "select", options: ["أ", "ب"] }, { name: "ملاحظة", type: "text" }] }, t));
    const r = await tool(f.ids[owner(sp)]!, "write_app", { title: `تطبيق ${sp}`, files: QUIZ_FILES, data: { results: { listId: results, write: "handler", read: "own", columns: ["الاسم", "الدرجة"], sender: "المرسل" }, votes: { listId: votes, write: "page", read: "aggregate", columns: ["الاختيار"] } } });
    setup[sp] = { results, votes, app: /appId=([A-Za-z0-9_-]+)/.exec(must(r).content)![1]! };
  }
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
  await runner?.stop();
});

/** A content-origin request (its own host), never following redirects. */
const page = (path: string, cookie?: string, ip = "127.0.0.1") => fetch(`${ORIGIN}${path}`, { redirect: "manual", headers: { "X-Forwarded-For": ip, ...(cookie ? { Cookie: cookie } : {}) } });
const api = (target: string, body: Record<string, unknown>, ip = "127.0.0.1", base = ORIGIN) =>
  fetch(`${base}/a/${target}`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Forwarded-For": ip }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, cors: r.headers.get("access-control-allow-origin"), ...((await r.json().catch(() => ({}))) as any) }));
const tokenOf = (html: string) => /"t":"([^"]+)"/.exec(html)![1]!;

async function openAs(a: ActorKey, slug: string) {
  const r = must(await s.call("mutation", "publications:openTicket", { slug }, tok(a)));
  const u = new URL(r);
  const res = await page(`${u.pathname}${u.search}`);
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("write_app, read_app and grants", () => {
  test("an app is an output with files; read_app shows them with its grants", async () => {
    const r = must(await tool(f.ids.mgr!, "read_app", { appId: setup.S_every.app }));
    expect(r.content).toContain("server/mark.py (خاص بالخادم)");
    expect(r.content).toContain("write=handler read=own");
    const one = must(await tool(f.ids.mgr!, "read_app", { appId: setup.S_every.app, path: "server/key.json" }));
    expect(one.content).toContain("KEYSECRET-31");
  });

  test("a new version changes only the files given; null deletes; undo points at the previous version", async () => {
    const r = must(await tool(f.ids.mgr!, "write_app", { appId: setup.S_plain.app, files: { "extra.js": "1", "style.css": null } }));
    expect(r.content).toContain("النسخة 2");
    expect(r.undo.restore.version).toBe(1);
    const files = must(await tool(f.ids.mgr!, "read_app", { appId: setup.S_plain.app })).content;
    expect(files).toContain("extra.js");
    expect(files).not.toContain("===== style.css");
    expect(files).toContain("===== server/mark.py");
  });

  test("grants: lists of the app's own space, known columns, a person column for the sender, at most 5", async () => {
    const other = (await tool(f.ids.mgr!, "write_app", { appId: setup.S_every.app, files: {}, data: { x: { listId: setup.S_plain.results, write: "page" } } })) as Result;
    expect(other.ok).toBe(false);
    expect((other as any).error).toContain("مساحة أخرى");
    const col = (await tool(f.ids.mgr!, "write_app", { appId: setup.S_every.app, files: {}, data: { x: { listId: setup.S_every.results, write: "page", columns: ["لا يوجد"] } } })) as Result;
    expect((col as any).error).toContain("لا يوجد عمود");
    const sender = (await tool(f.ids.mgr!, "write_app", { appId: setup.S_every.app, files: {}, data: { x: { listId: setup.S_every.results, write: "page", sender: "الاسم" } } })) as Result;
    expect((sender as any).error).toContain("person");
    const alias = (await tool(f.ids.mgr!, "write_app", { appId: setup.S_every.app, files: {}, data: { "bad alias": { listId: setup.S_every.results } } })) as Result;
    expect(alias.ok).toBe(false);
  });

  test("someone who can't write the space can't change its app; a reader can read it", async () => {
    expect((await tool(f.ids.rdr!, "write_app", { appId: setup.S_every.app, files: { "x.js": "1" } })).ok).toBe(false);
    expect(must(await tool(f.ids.rdr!, "read_app", { appId: setup.S_every.app })).content).toContain("index.html");
    expect(must(await tool(f.ids.out!, "read_app", { appId: setup.S_plain.app })).content).toContain("لا تملك");
  });

  test("tiers: an app in my personal space runs at once, in a shared space it is a card", async () => {
    const tier = (userId: string, args: any) => s.adminRun("tiers:resolve", { userId, tool: "write_app", args, scopeSpaceIds: Object.values(f.spaces) });
    expect(must(await tier(f.ids.mem!, { appId: setup.P_mem.app }))).toBe(1);
    expect(must(await tier(f.ids.mgr!, { appId: setup.S_every.app }))).toBe(2);
    expect(must(await tier(f.ids.mgr!, { appId: setup.S_sens.app }))).toBe(3);
    expect(must(await tier(f.ids.mgr!, { files: {}, data: { r: { listId: setup.S_every.results } } }))).toBe(2);
  });
});

describe("permission matrix: apps:*", () => {
  const OPS: { name: string; need: "read" | "write"; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> }[] = [
    { name: "apps:info", need: "read", run: (a, sp) => s.call("query", "apps:info", { artifactId: setup[sp].app, version: 1 }, tok(a)) },
    { name: "apps:testLink", need: "write", run: (a, sp) => s.call("mutation", "apps:testLink", { artifactId: setup[sp].app }, tok(a)) },
  ];
  for (const op of OPS)
    for (const sp of SPACES)
      for (const a of ACTORS) {
        const allowed = expectedAllowed(a, sp, op.need);
        test(`${op.name} | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
          const r = await op.run(a, sp);
          expect(r.ok).toBe(allowed);
          if (!r.ok) expect(r.error).not.toContain("KEYSECRET");
        });
      }
});

describe("a published app: the page and its data API", () => {
  let slug: string;
  let pubId: string;
  test("publishing pins the version and copies its grants; the box lists them first", async () => {
    const box = must(await s.call("query", "publications:forArtifact", { artifactId: setup.S_every.app }, tok("mgr")));
    expect(box.appGrants.join("\n")).toContain("يضيف صفوفاً عبر منطق الخادم فقط");
    const r = must(await s.call("mutation", "publications:publish", { artifactId: setup.S_every.app, audience: "workspace" }, tok("mgr")));
    slug = r.url.split("/p/")[1];
    pubId = r.id;
    const mine = must(await s.call("query", "publications:mine", {}, tok("mgr"))).mine.find((p: any) => p._id === pubId);
    expect(mine.app).toEqual({ rows: 0 });
    expect(mine.appGrants.length).toBe(2);
    // A plain form can't be attached to an app.
    expect((await s.call("mutation", "publications:addFeedbackForm", { publicationId: pubId }, tok("mgr"))).ok).toBe(false);
  });

  test("the page: bundled, server/ files absent, CSP by hash with its own API only; not on the app's host", async () => {
    const cookie = await openAs("out", slug);
    const res = await page(`/p/${slug}`, cookie);
    const html = await res.text();
    expect(html).toContain("APPPAGE-1");
    expect(html).not.toContain("KEYSECRET-31");
    expect(html).not.toContain("def handle");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`connect-src ${ORIGIN}/a/${slug}`);
    expect(csp).toMatch(/script-src 'sha256-[^;]+'/);
    expect(csp).not.toContain("unsafe-inline' 'sha");
    // No URL serves a private file.
    for (const p of [`/p/${slug}/server/key.json`, `/p/${slug}/key.json`, `/t/server/key.json`]) expect(await (await page(p, cookie)).text()).not.toContain("KEYSECRET");
    expect((await fetch(`${APPHOST}/p/${slug}`, { redirect: "manual" })).status).toBe(404);
    expect((await api(slug, { t: tokenOf(html), op: "stats", list: "votes" }, "127.0.0.1", APPHOST)).status).toBe(404);
  });

  test("append: only on a write=page list, granted columns only, never the sender; stats are counts, never rows", async () => {
    const t = tokenOf(await (await page(`/p/${slug}`, await openAs("out", slug))).text());
    const ok = await api(slug, { t, op: "append", list: "votes", row: { "الاختيار": "ب" } });
    expect([ok.status, ok.ok, ok.cors]).toEqual([200, true, "*"]);
    expect((await api(slug, { t, op: "append", list: "votes", row: { "ملاحظة": "x" } })).error).toContain("ليس من أعمدة");
    expect((await api(slug, { t, op: "append", list: "votes", row: { "الاختيار": "ج" } })).ok).toBe(false);
    expect((await api(slug, { t, op: "append", list: "results", row: { "الدرجة": 99 } })).error).toContain("معالج الخادم فقط");
    expect((await api(slug, { t, op: "append", list: "nope", row: {} })).ok).toBe(false);
    const st = await api(slug, { t, op: "stats", list: "votes" });
    expect(st.value).toEqual({ rows: 1, columns: { "الاختيار": { count: 1, counts: { "أ": 0, "ب": 1 } } } });
    expect((await api(slug, { t, op: "mine", list: "votes" })).error).toContain("لا تسمح");
    expect((await api(slug, { t, op: "stats", list: "results" })).error).toContain("لا تسمح");
    // A made-up token, and another page's token.
    expect((await api(slug, { t: "x".repeat(40), op: "stats", list: "votes" })).status).toBe(401);
  });

  test("the handler marks with the private key; its row carries the signed-in sender; mine is the visitor's own", async () => {
    if (!hasSandbox) return console.warn("skipped: no sandbox");
    const tOut = tokenOf(await (await page(`/p/${slug}`, await openAs("out", slug))).text());
    const r = await api(slug, { t: tOut, op: "call", handler: "mark", payload: { name: "خارجي", answers: { q1: "is" } } });
    if (!r.ok) console.log("HANDLER ERROR", r.status, r.error);
    // seen: rows this visitor already added through this page (their vote above).
    expect([r.ok, r.value]).toEqual([true, { score: 1, max: 1, seen: 1 }]);
    const again = await api(slug, { t: tOut, op: "call", handler: "mark", payload: { name: "خارجي", answers: { q1: "am" } } });
    expect(again.value.seen).toBe(2);
    const g = must(await s.call("query", "lists:get", { listId: setup.S_every.results }, tok("mgr")));
    const k = Object.fromEntries(g.list.columns.map((c: any) => [c.name, c.key]));
    const rows = g.rows.filter((x: any) => x.cells[k["الاسم"]] === "خارجي");
    expect(rows.map((x: any) => x.cells[k["الدرجة"]]).sort()).toEqual([0, 1]);
    expect(rows.every((x: any) => x.cells[k["المرسل"]] === f.ids.out)).toBe(true);
    // Another reader sees none of those as their own.
    const tRdr = tokenOf(await (await page(`/p/${slug}`, await openAs("rdr", slug))).text());
    expect((await api(slug, { t: tRdr, op: "mine", list: "results" })).value).toEqual([]);
    expect((await api(slug, { t: tOut, op: "mine", list: "results" })).value.map((x: any) => x["الدرجة"]).sort()).toEqual([0, 1]);
    // A handler that doesn't exist, or that fails: the visitor sees no trace.
    expect((await api(slug, { t: tOut, op: "call", handler: "nope", payload: null })).status).toBe(404);
    const pubs = must(await s.call("query", "publications:mine", {}, tok("mgr"))).mine.find((p: any) => p._id === pubId);
    expect(pubs.app.rows).toBe(3); // the vote, and two marked answers
  }, 60_000);

  test("rows a handler returns outside its grants are refused, all of them", async () => {
    if (!hasSandbox) return console.warn("skipped: no sandbox");
    must(await tool(f.ids.mgr!, "write_app", { appId: setup.S_every.app, files: { "server/bad.py": 'def handle(request):\n    return {"response": 1, "rows": [{"list": "results", "cells": {"الاسم": "ok"}}, {"list": "votes", "cells": {"ملاحظة": "x"}}]}\n', "server/boom.py": "def handle(request):\n    raise ValueError('TRACE-55')\n" } }));
    must(await s.call("mutation", "publications:update", { publicationId: pubId }, tok("mgr")));
    const t = tokenOf(await (await page(`/p/${slug}`, await openAs("out", slug))).text());
    const before = must(await s.call("query", "lists:get", { listId: setup.S_every.results }, tok("mgr"))).rows.length;
    const bad = await api(slug, { t, op: "call", handler: "bad", payload: null });
    expect([bad.ok, bad.error]).toEqual([false, "تعذّر إكمال الطلب."]);
    expect(must(await s.call("query", "lists:get", { listId: setup.S_every.results }, tok("mgr"))).rows.length).toBe(before);
    const boom = await api(slug, { t, op: "call", handler: "boom", payload: null });
    expect(boom.error).toBe("تعذّر إكمال الطلب.");
    expect(JSON.stringify(boom)).not.toContain("TRACE-55");
  }, 60_000);

  test("revoking closes the API at once", async () => {
    const t = tokenOf(await (await page(`/p/${slug}`, await openAs("out", slug))).text());
    must(await s.call("mutation", "publications:revoke", { publicationId: pubId }, tok("mgr")));
    expect((await api(slug, { t, op: "stats", list: "votes" })).status).toBe(401);
  });
});

describe("a public app", () => {
  let slug: string;
  test("anonymous visitors: a token per page load; own rows are that load's; rate limits per address", async () => {
    must(await s.call("mutation", "publications:setPublicPolicy", { allowed: true }, tok("admin")));
    const r = must(await s.call("mutation", "publications:publish", { artifactId: setup.S_plain.app, audience: "public" }, tok("mgr")));
    slug = r.url.split("/p/")[1];
    const html = await (await page(`/p/${slug}`, undefined, "10.1.0.1")).text();
    expect(html).toContain('"signedIn":false');
    const t1 = tokenOf(html);
    const t2 = tokenOf(await (await page(`/p/${slug}`, undefined, "10.1.0.1")).text());
    expect(t1).not.toBe(t2);
    const forged = t1.replace(/\.[^.]+$/, ".0123456789abcdef0123456789abcdef");
    expect((await api(slug, { t: forged, op: "stats", list: "votes" }, "10.1.0.2")).status).toBe(401);
    expect((await api(slug, { t: t1, op: "append", list: "votes", row: { "الاختيار": "أ" } }, "10.1.0.3")).ok).toBe(true);
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push((await api(slug, { t: t1, op: "stats", list: "votes" }, "10.1.0.9")).status);
    expect(codes).toContain(429);
    must(await s.call("mutation", "publications:setPublicPolicy", { allowed: false }, tok("admin")));
    expect((await api(slug, { t: t1, op: "stats", list: "votes" }, "10.1.0.4")).status).toBe(401);
  });

  test("own rows on a public page are that page load's", async () => {
    if (!hasSandbox) return console.warn("skipped: no sandbox");
    must(await s.call("mutation", "publications:setPublicPolicy", { allowed: true }, tok("admin")));
    try {
      const t1 = tokenOf(await (await page(`/p/${slug}`, undefined, "10.2.0.1")).text());
      const t2 = tokenOf(await (await page(`/p/${slug}`, undefined, "10.2.0.2")).text());
      expect((await api(slug, { t: t1, op: "call", handler: "mark", payload: { name: "زائر1", answers: { q1: "is" } } }, "10.2.0.1")).ok).toBe(true);
      expect((await api(slug, { t: t1, op: "mine", list: "results" }, "10.2.0.1")).value).toEqual([{ "الاسم": "زائر1", "الدرجة": 1 }]);
      expect((await api(slug, { t: t2, op: "mine", list: "results" }, "10.2.0.2")).value).toEqual([]);
    } finally {
      must(await s.call("mutation", "publications:setPublicPolicy", { allowed: false }, tok("admin")));
    }
  }, 60_000);
});

describe("test links and test_app", () => {
  test("a test link serves the draft; writes are dry-run and recorded; it closes after", async () => {
    const url = must(await s.call("mutation", "apps:testLink", { artifactId: setup.P_mem.app }, tok("mem")));
    expect(url.startsWith(`${ORIGIN}/t/`)).toBe(true);
    const res = await fetch(url);
    const html = await res.text();
    expect(html).toContain("تجربة: ما يُرسل هنا لا يُحفظ");
    expect(html).not.toContain("KEYSECRET");
    expect(res.headers.get("content-security-policy")).toContain(`connect-src ${ORIGIN}/a/test`);
    const t = tokenOf(html);
    expect((await api("test", { t, op: "append", list: "votes", row: { "الاختيار": "أ" } })).ok).toBe(true);
    expect(must(await s.call("query", "lists:get", { listId: setup.P_mem.votes }, tok("mem"))).rows.length).toBe(0);
    const events = must(await s.adminRun("apps:finishTest", { token: new URL(url).pathname.slice(3) }));
    expect(events[0].wrote[0]).toMatchObject({ test: true, list: "votes", cells: { "الاختيار": "أ" } });
    expect((await fetch(url)).status).toBe(410);
    // The test link is only on the content origin.
    expect((await fetch(url.replace(ORIGIN, APPHOST))).status).toBe(404);
  });

  test("test_app: a headless browser fills, submits, reads the handler's answer; the list is untouched", async () => {
    if (!hasSandbox || !hasBrowser) return console.warn("skipped: needs the sandbox and Chrome");
    const before = must(await s.call("query", "lists:get", { listId: setup.P_mem.results }, tok("mem"))).rows.length;
    const r = must(
      await tool(f.ids.mem!, "test_app", {
        appId: setup.P_mem.app,
        steps: [
          { do: "fill", selector: "#name", value: "مجرّب" },
          { do: "select", selector: "#q1", value: "is" },
          { do: "click", text: "أرسل" },
          { do: "expect", text: "درجتك 1 من 1 (1)" },
        ],
      }),
    );
    expect(r.content).toContain("✅ نجحت التجربة");
    expect(r.content).toContain("سيُضاف إلى «results» (تجربة، لم يُحفظ)");
    expect(r.content).toContain("مجرّب");
    expect(must(await s.call("query", "lists:get", { listId: setup.P_mem.results }, tok("mem"))).rows.length).toBe(before);
  }, 120_000);

  test("test_app reports what broke: a JS error, a CSP violation, a handler traceback, a missing element", async () => {
    if (!hasSandbox || !hasBrowser) return console.warn("skipped: needs the sandbox and Chrome");
    const bad = must(
      await tool(f.ids.mem!, "write_app", {
        title: "معطوب",
        files: {
          "index.html": '<button id="go">اذهب</button><button onclick="x()">inline</button><img src="https://example.com/t.png"><script src="app.js"></script>',
          "app.js": 'document.getElementById("go").addEventListener("click", async () => { try { await onespace.call("boom", {}); } catch (e) { console.error("CALLFAIL " + e.message); } undefinedFn(); });',
          "server/boom.py": "def handle(request):\n    return 1/0\n",
        },
      }),
    );
    const appId = /appId=([A-Za-z0-9_-]+)/.exec(bad.content)![1]!;
    const r = must(await tool(f.ids.mem!, "test_app", { appId, steps: [{ do: "click", selector: "#go" }, { do: "wait", ms: 300 }, { do: "click", selector: "#missing", ms: 300 }] }));
    expect(r.content).toContain("❌");
    expect(r.content).toContain("undefinedFn");
    expect(r.content).toContain("ZeroDivisionError");
    expect(r.content).toContain("Content Security Policy");
    expect(r.content).toContain("#missing");
  }, 120_000);
});

describe("skills keep an app", () => {
  test("«احفظ كمهارة» keeps the app's files (server/ too); write_app fromSkill starts a new app from them", async () => {
    const threadId = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await tool(f.ids.mem!, "write_app", { title: "قالب", files: QUIZ_FILES }, { threadId }));
    const saved = must(await tool(f.ids.mem!, "create_skill", { name: "quiz-app", title: "اختبار", description: "تطبيق اختبار", instructions: "ابنِ اختباراً بنفس الشكل." }, { threadId }));
    expect(saved.content).toContain("app/server/mark.py");
    const used = must(await tool(f.ids.mem!, "use_skill", { name: "quiz-app" }, { threadId }));
    expect(used.content).toContain('fromSkill="quiz-app"');
    const r = must(await tool(f.ids.mem!, "write_app", { title: "نسخة جديدة", fromSkill: "quiz-app", files: { "data/questions.json": "[]" } }, { threadId }));
    const appId = /appId=([A-Za-z0-9_-]+)/.exec(r.content)![1]!;
    const files = must(await tool(f.ids.mem!, "read_app", { appId })).content;
    expect(files).toContain("KEYSECRET-31");
    expect(files).toContain("===== data/questions.json =====\n[]");
    expect(files).toContain("القوائم:\nلا شيء"); // grants aren't kept
  });
});

describe("the quiz migration's app", () => {
  const files = quizAppFiles({
    title: "اختبار قديم",
    introHtml: "<h1>مقدمة</h1>",
    questions: [{ id: "q1", name: "س1", options: ["am", "is"], required: true }, { id: "q2", name: "س2", options: ["a", "an"], required: true }],
    answers: [{ column: "س1", correct: "is", points: 1 }, { column: "س2", correct: "an", points: 2 }],
    bands: [{ min: 0, label: "مبتدئ" }, { min: 2, label: "متوسط" }],
    scoreColumn: "الدرجة",
    levelColumn: "المستوى",
    showResult: true,
    onePerReader: true,
    thanks: "شكراً",
  });

  test("the key stays in server/; the page shows the same questions", () => {
    const { html } = bundlePage(files, { api: "http://x/a/test", token: "t", visitor: { signedIn: true, name: null }, lists: {} }, { title: "t", footer: "f", origin: "http://x" });
    expect(html).toContain("<option>an</option>");
    expect(html).not.toContain('"correct"');
    expect(appWarnings({ files, data: {} })).toEqual([]);
  });

  test("its handler marks like the old quiz: score, level, once per reader", async () => {
    if (!hasSandbox) return console.warn("skipped: no sandbox");
    const r = await runHandler(files, "mark", { payload: { "س1": "is", "س2": "a" }, visitor: { signedIn: true, name: "x", rows: 0 }, test: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response).toEqual({ ok: true, thanks: "شكراً", score: 1, max: 3, level: "مبتدئ" });
    expect(r.rows).toEqual([{ list: "results", cells: { "س1": "is", "س2": "a", "الدرجة": 1, "المستوى": "مبتدئ" } }]);
    const again = await runHandler(files, "mark", { payload: { "س1": "is", "س2": "an" }, visitor: { signedIn: true, name: "x", rows: 1 }, test: false });
    expect(again.ok && again.rows).toEqual([]);
  }, 60_000);
});
