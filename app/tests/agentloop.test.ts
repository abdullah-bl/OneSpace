// plans/07 phase 2: the router (one assistant, skills chosen per question), risk tiers (tier 1 runs
// at once in my personal space and can be undone; shared and sensitive targets still ask), the
// per-turn budget, parallel reads and the step timeline. Deterministic fake model (tests/fake-ai.ts):
// "SKILL=<name>" in a question makes the router pick that skill, "SKILL-UNSURE" makes it unsure.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { addBytes, ask, waitIngest } from "./rag-helpers";
import { cfg, chatRequestsWith, offered, proposalsOf, publishedAgent } from "./agents-helpers";

let ai: FakeAI;
let s: Server;
let f: Fixture;
let analysisAgent: string;
let defaultAgent: string;
const tok = (a: string) => (f.tokens as any)[a] as string;

const routerRequests = () => ai.requests.filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.response_format ?? "").includes('"skill"'));
const routerListFor = (marker: string) => {
  const req = routerRequests().filter((r) => JSON.stringify(r.body.messages).includes(marker)).at(-1);
  return req ? String(req.body.messages.find((m: any) => m.role === "system")?.content ?? "") : null;
};
async function lastAnswer(token: string, threadId: string) {
  return must(await s.call("query", "chat:messages", { threadId }, token)).messages.filter((m: any) => m.role === "assistant").at(-1);
}

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
  for (const [sp, who] of [["P_mem", "mem"], ["S_plain", "mgr"], ["S_sens", "mgr"]] as const) {
    expect((await waitIngest(s, tok(who), f.spaces[sp], f.files[sp])).state).toBe("ready");
  }
  const list = must(await s.call("query", "agents:list", {}, tok("admin")));
  analysisAgent = list.find((a: any) => a.key === "analysis")._id;
  defaultAgent = list.find((a: any) => a.isDefault)._id;
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

describe("router: one assistant, the skill is chosen per question", () => {
  test("an unpinned chat routes; the answer carries the chosen skill and a timeline step", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem"), t, "SKILL=التحليل حلّل بياناتي ROUTE-1");
    const a = await lastAnswer(tok("mem"), t);
    expect(a.skill).toEqual({ agentId: analysisAgent, name: "التحليل", routed: true });
    expect(a.steps[0].label).toBe("يختار الوكيل…");
    expect(a.steps[0].detail).toBe("→ التحليل");
    // The analysis skill's tools are what the main model was offered for this question.
    const req = ai.requests.filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format && JSON.stringify(r.body.messages).includes("ROUTE-1")).at(-1);
    expect(offered(req).sort()).toEqual(["create_artifact", "export_document", "read_file", "run_analysis"]);
  }, 30_000);

  test("nothing specific → the default skill; an unsure router → the default skill", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem"), t, "اكتب تهنئة قصيرة ROUTE-2");
    expect((await lastAnswer(tok("mem"), t)).skill.agentId).toBe(defaultAgent);
    await ask(s, tok("mem"), t, "SKILL=التحليل SKILL-UNSURE ROUTE-3");
    expect((await lastAnswer(tok("mem"), t)).skill.agentId).toBe(defaultAgent);
  }, 30_000);

  test("a pinned chat doesn't route", async () => {
    const before = routerRequests().length;
    const t = must(await s.call("mutation", "chat:createThread", { agentId: analysisAgent }, tok("mem")));
    await ask(s, tok("mem"), t, "SKILL=المساعد العام سؤال ROUTE-4");
    expect(routerRequests().length).toBe(before);
    const a = await lastAnswer(tok("mem"), t);
    expect(a.skill).toEqual({ agentId: analysisAgent, name: "التحليل", routed: false });
  }, 30_000);

  test("candidates are only skills this user may use, and that can reach the files the question names", async () => {
    // A skill visible only to members of the sensitive space: «out» isn't one, mem is.
    const hidden = await publishedAgent(s, tok("admin"), { name: "مخفي-ROUTE", description: "سري", visibility: { kind: "spaces", spaceIds: [f.spaces.S_sens] } });
    expect(hidden).toBeTruthy();
    const o = must(await s.call("mutation", "chat:createThread", {}, tok("out")));
    await ask(s, tok("out"), o, "سؤال عام ROUTE-5");
    expect(routerListFor("ROUTE-5")).not.toContain("مخفي-ROUTE");
    expect(routerListFor("ROUTE-5")).toContain("السياسات");
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem"), t, "سؤال عام ROUTE-5b");
    expect(routerListFor("ROUTE-5b")).toContain("مخفي-ROUTE");
    // @ a personal file: «السياسات» (scope: the everyone space, file tools only) can't reach it.
    must(await s.call("mutation", "chat:send", { threadId: t, text: "لخّص هذا ROUTE-6", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    for (let i = 0; i < 200 && !routerListFor("ROUTE-6"); i++) await Bun.sleep(25);
    const list = routerListFor("ROUTE-6")!;
    expect(list).not.toContain("السياسات");
    expect(list).toContain("التحليل");
  }, 30_000);

  test("the router never widens access: a routed skill still only searches what the user can read", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("out")));
    await ask(s, tok("out"), t, "SKILL=التحليل ما في CONTENT-S_sens ROUTE-7");
    const msgs = JSON.stringify(must(await s.call("query", "chat:messages", { threadId: t }, tok("out"))).messages.filter((m: any) => m.role === "assistant"));
    expect(msgs).not.toContain("CONTENT-S_sens");
  }, 30_000);
});

describe("risk tiers: my personal space runs at once (with undo); shared and sensitive ask", () => {
  const writer = (name: string, json: string) => publishedAgent(s, tok("admin"), cfg({ name, allowedTools: ["create_artifact", "update_artifact"], maxSteps: 2, instructions: `CALL_TOOL ${json}` }));

  test("tier 1: an output in my personal space is created at once; tier 2 (shared) and 3 (sensitive) wait", async () => {
    const t1 = must(await s.call("mutation", "chat:createThread", { agentId: await writer("خاص-T1", 'create_artifact {"title":"خاص-TIER1","kind":"markdown","content":"x"}') }, tok("mem")));
    await ask(s, tok("mem"), t1, "أنشئ");
    const [p1] = await proposalsOf(s, tok("mem"), t1);
    expect([p1.state, p1.tier, p1.auto]).toEqual(["executed", 1, true]);

    const t2 = must(await s.call("mutation", "chat:createThread", { agentId: await writer("مشترك-T2", `create_artifact {"title":"مشترك-TIER2","kind":"markdown","content":"x","spaceId":"${f.spaces.S_plain}"}`) }, tok("mem")));
    await ask(s, tok("mem"), t2, "أنشئ");
    const [p2] = await proposalsOf(s, tok("mem"), t2);
    expect([p2.state, p2.tier, p2.auto]).toEqual(["pending", 2, false]);

    const t3 = must(await s.call("mutation", "chat:createThread", { agentId: await writer("حساس-T3", `create_artifact {"title":"حساس-TIER3","kind":"markdown","content":"x","sources":[{"type":"file","id":"${f.files.S_sens}"}]}`) }, tok("mgr")));
    await ask(s, tok("mgr"), t3, "أنشئ");
    const [p3] = await proposalsOf(s, tok("mgr"), t3);
    expect([p3.state, p3.tier]).toEqual(["pending", 3]);
    const arts = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.S_sens }, tok("mgr")));
    expect(arts.some((a: any) => a.title === "حساس-TIER3")).toBe(false);
  }, 60_000);

  test("undo of an update restores the previous version as a new one", async () => {
    const art = must(await s.call("mutation", "artifacts:create", { title: "قابل للاسترجاع", kind: "markdown", content: "الأصل UNDO-ORIG" }, tok("mem"))).artifactId;
    const t = must(await s.call("mutation", "chat:createThread", { agentId: await writer("محدّث-T4", `update_artifact {"artifactId":"${art}","content":"تعديل الوكيل UNDO-NEW"}`) }, tok("mem")));
    await ask(s, tok("mem"), t, "عدّل");
    const [p] = await proposalsOf(s, tok("mem"), t);
    expect([p.state, p.auto]).toEqual(["executed", true]);
    expect(must(await s.call("mutation", "artifacts:open", { artifactId: art }, tok("mem"))).content).toBe("تعديل الوكيل UNDO-NEW");
    must(await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mem")));
    const now = must(await s.call("mutation", "artifacts:open", { artifactId: art }, tok("mem")));
    expect([now.version, now.content]).toEqual([3, "الأصل UNDO-ORIG"]);
  }, 30_000);

  test("undo leaves what was moved out of my personal space since, and says so", async () => {
    const t = must(await s.call("mutation", "chat:createThread", { agentId: await writer("ناقل-T5", 'create_artifact {"title":"منقول-TIER5","kind":"markdown","content":"x"}') }, tok("mem")));
    await ask(s, tok("mem"), t, "أنشئ");
    const [p] = await proposalsOf(s, tok("mem"), t);
    must(await s.call("mutation", "artifacts:move", { artifactId: p.artifactIds[0], toSpaceId: f.spaces.S_plain }, tok("mem")));
    const r = must(await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mem")));
    expect(r.kept).toEqual(["منقول-TIER5"]);
    const shared = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.S_plain }, tok("mgr")));
    expect(shared.some((a: any) => a.title === "منقول-TIER5")).toBe(true);
  }, 30_000);

  test("a reader's write never auto-runs into a space they only read", async () => {
    const art = must(await s.call("mutation", "artifacts:create", { title: "للقراءة", kind: "markdown", content: "x", spaceId: f.spaces.S_plain }, tok("mgr"))).artifactId;
    const t = must(await s.call("mutation", "chat:createThread", { agentId: await writer("قارئ-T6", `update_artifact {"artifactId":"${art}","content":"تغيير"}`) }, tok("rdr")));
    await ask(s, tok("rdr"), t, "عدّل");
    const [p] = await proposalsOf(s, tok("rdr"), t);
    expect(p.state).toBe("pending");
    expect(must(await s.call("mutation", "artifacts:open", { artifactId: art }, tok("mgr"))).content).toBe("x");
  }, 30_000);

  test("audit: an auto-run and its undo are both recorded", async () => {
    const log = must(await s.call("query", "audit:list", { userId: f.ids.mem, limit: 500 }, tok("admin")));
    expect(log.some((r: any) => r.action === "ai.autorun")).toBe(true);
    expect(log.some((r: any) => r.action === "ai.undo")).toBe(true);
  });
});

describe("the loop: parallel reads, timeline", () => {
  test("two reads in one step both run, in call order, each as a timeline step", async () => {
    const id = await publishedAgent(s, tok("admin"), cfg({ name: "قارئ مزدوج", allowedTools: ["read_file"], maxSteps: 2, instructions: `CALL_TOOL read_file {"fileId":"${f.files.P_mem}"}\nCALL_TOOL read_file {"fileId":"${f.files.S_plain}"}` }));
    const t = must(await s.call("mutation", "chat:createThread", { agentId: id }, tok("mem")));
    await ask(s, tok("mem"), t, "اقرأ الملفين PAR-1");
    const a = await lastAnswer(tok("mem"), t);
    expect(a.steps.filter((x: any) => x.label === "يقرأ الملف…" && x.state === "done").length).toBe(2);
    const req = ai.requests.filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.messages).includes("PAR-1") && r.body.messages.some((m: any) => m.role === "tool")).at(-1);
    const toolMsgs = req.body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]).toContain("PERSONAL-CONTENT");
    expect(toolMsgs[1]).toContain("CONTENT-S_plain");
  }, 30_000);
});

describe("budget and the auto-run switch (second server)", () => {
  let ai2: FakeAI;
  let s2: Server;
  let f2: Fixture;
  beforeAll(async () => {
    ai2 = startFakeAI();
    s2 = await new Server(undefined, aiEnv(ai2, { TURN_BUDGET_MS: "1", TIER1_AUTORUN: "0" })).start();
    f2 = await buildFixture(s2);
    await addBytes(s2, f2.tokens.mem!, f2.spaces.P_mem, "budget.txt", "BUDGETFILE", "text/plain");
  }, 120_000);
  afterAll(async () => {
    await s2?.stop();
    ai2?.stop();
  });

  test("over the turn's budget the agent answers now and says what's left", async () => {
    const id = await publishedAgent(s2, f2.tokens.admin!, cfg({ name: "طويل", allowedTools: ["read_file"], maxSteps: 6, instructions: `CALL_TOOL read_file {"fileId":"${f2.files.P_mem}"}` }));
    const t = must(await s2.call("mutation", "chat:createThread", { agentId: id }, f2.tokens.mem!));
    await ask(s2, f2.tokens.mem!, t, "اقرأ BUDGET-1");
    const reqs = chatRequestsWith(ai2, "BUDGET-1");
    expect(reqs.at(-1)!.body.tools).toBeUndefined();
    expect(JSON.stringify(reqs.at(-1)!.body.messages)).toContain("انتهى الوقت المتاح");
    expect(reqs.length).toBe(2); // one tool step, then the final answer
  }, 30_000);

  test("TIER1_AUTORUN=0: even my personal space asks first", async () => {
    const id = await publishedAgent(s2, f2.tokens.admin!, cfg({ name: "كاتب", allowedTools: ["create_artifact"], maxSteps: 2, instructions: 'CALL_TOOL create_artifact {"title":"OFF-1","kind":"markdown","content":"x"}' }));
    const t = must(await s2.call("mutation", "chat:createThread", { agentId: id }, f2.tokens.mem!));
    await ask(s2, f2.tokens.mem!, t, "أنشئ");
    const [p] = await proposalsOf(s2, f2.tokens.mem!, t);
    expect([p.state, p.tier, p.auto]).toEqual(["pending", 1, false]);
  }, 30_000);
});
