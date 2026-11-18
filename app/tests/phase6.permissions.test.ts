// Permission matrix for every Phase 6 public function: agent administration (workspace admin
// only), picking an agent (visibility × space × actor), opening a task's thread (task viewers),
// and write-tool proposals (the thread's owner only). Expected results come from the independent
// role model in fixture.ts. The model is the deterministic fake (tests/fake-ai.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, expectedAllowed, SPACES, type ActorKey, type Fixture, type SpaceKey } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { ask, newThread } from "./rag-helpers";
import { cfg, proposalsOf, publishedAgent } from "./agents-helpers";
import { PHASE6_COVERED } from "./phase6.coverage";

let ai: FakeAI;
let s: Server;
let f: Fixture;
let draftAgent: string; // created as a draft; the admin matrix publishes/reverts it
let defaultAgent: string;
let writer: string; // an agent whose model always proposes create_artifact
let memThread: string;
let toConfirm: string;
let toCancel: string;
let toUndo: string;
const bySpace = {} as Record<SpaceKey, string>; // agents visible to one shared space each

const tok = (a: ActorKey) => f.tokens[a];

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai, { PROPOSAL_TTL_MS: "600000" })).start();
  f = await buildFixture(s);
  const admin = tok("admin")!;
  const list = must(await s.call("query", "agents:list", {}, admin));
  defaultAgent = list.find((a: any) => a.isDefault)._id;
  draftAgent = must(await s.call("mutation", "agents:create", { config: cfg({ name: "مسودة المصفوفة" }) }, admin));
  writer = await publishedAgent(s, admin, {
    name: "كاتب",
    allowedTools: ["create_artifact"],
    // Into a shared space: tier 2, a card that waits for «نفّذ».
    instructions: `CALL_TOOL create_artifact {"title":"مخرج-المصفوفة","kind":"markdown","content":"نص المخرج","spaceId":"${f.spaces.S_plain}"}`,
    maxSteps: 2,
  });
  // Into mem's personal space: tier 1, runs at once with «تراجع».
  const privateWriter = await publishedAgent(s, admin, {
    name: "كاتب خاص",
    allowedTools: ["create_artifact"],
    instructions: `CALL_TOOL create_artifact {"title":"مخرج-خاص-المصفوفة","kind":"markdown","content":"نص"}`,
    maxSteps: 2,
  });
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
    bySpace[sp] = await publishedAgent(s, admin, { name: `وكيل-${sp}`, visibility: { kind: "spaces", spaceIds: [f.spaces[sp]] } });
  }
  memThread = must(await s.call("mutation", "chat:createThread", { agentId: writer }, tok("mem")));
  await ask(s, tok("mem")!, memThread, "أنشئ مخرجاً");
  await ask(s, tok("mem")!, memThread, "أنشئ مخرجاً آخر");
  const ps = await proposalsOf(s, tok("mem")!, memThread);
  expect(ps.length).toBe(2);
  [toConfirm, toCancel] = ps.map((p) => p.id);
  const privThread = must(await s.call("mutation", "chat:createThread", { agentId: privateWriter }, tok("mem")));
  await ask(s, tok("mem")!, privThread, "أنشئ مخرجاً خاصاً");
  const auto = (await proposalsOf(s, tok("mem")!, privThread)).find((p) => p.auto);
  expect(auto?.state).toBe("executed");
  toUndo = auto.id;
}, 90_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

function check(r: Result, allowed: boolean) {
  if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
  if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
}

describe("agent administration: workspace admin only", () => {
  const ADMIN_ONLY: [string, "query" | "mutation", () => any][] = [
    ["agents:toolRegistry", "query", () => ({})],
    ["agents:list", "query", () => ({})],
    ["agents:versions", "query", () => ({ agentId: draftAgent })],
    ["agents:create", "mutation", () => ({ config: cfg({ name: "جديد" }) })],
    ["agents:saveDraft", "mutation", () => ({ agentId: draftAgent, config: cfg({ name: "مسودة المصفوفة", instructions: "تعديل" }) })],
    ["agents:publish", "mutation", () => ({ agentId: draftAgent })],
    ["agents:discardDraft", "mutation", () => ({ agentId: draftAgent })],
    ["agents:revert", "mutation", () => ({ agentId: draftAgent, version: 1 })],
    ["agents:setEnabled", "mutation", () => ({ agentId: draftAgent, enabled: true })],
    ["agents:setDefault", "mutation", () => ({ agentId: defaultAgent })],
    ["agents:seedStarterAgents", "mutation", () => ({})],
    ["agents:setTestQuestions", "mutation", () => ({ agentId: draftAgent, questions: ["سؤال اختبار"] })],
    ["agents:runTests", "mutation", () => ({ agentId: draftAgent })],
    ["agents:testResults", "query", () => ({ agentId: draftAgent })],
  ];
  for (const [fn, kind, args] of ADMIN_ONLY) {
    for (const a of ACTORS) {
      const allowed = a === "admin";
      test(`${fn} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        check(await s.call(kind, fn, args(), tok(a)), allowed);
      });
    }
  }

  test("an unknown or malformed agent id is the same denial as a forbidden one", async () => {
    for (const id of ["nope", f.spaces.S_plain, "agents:123"]) {
      const r = await s.call("query", "agents:versions", { agentId: id }, tok("admin"));
      expect(r.ok).toBe(false);
    }
  });
});

describe("picking an agent: available to active members, restricted agents to readers of their space", () => {
  for (const a of ACTORS) {
    const active = !["pend", "dis", "anon"].includes(a);
    test(`agents:available | ${a} → ${active ? "allowed" : "denied"}`, async () => {
      check(await s.call("query", "agents:available", {}, tok(a)), active);
    });
  }
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
    for (const a of ACTORS) {
      const allowed = expectedAllowed(a, sp, "read");
      test(`chat:createThread with an agent for ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        check(await s.call("mutation", "chat:createThread", { agentId: bySpace[sp] }, tok(a)), allowed);
      });
      test(`chat:setAgent (own thread → agent for ${sp}) | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        const own = await s.call("mutation", "chat:createThread", {}, tok(a));
        if (!own.ok) return check(own, allowed);
        check(await s.call("mutation", "chat:setAgent", { threadId: own.value, agentId: bySpace[sp] }, tok(a)), allowed);
      });
      test(`agents:available lists the agent for ${sp} | ${a} → ${allowed ? "listed" : "hidden"}`, async () => {
        const r = await s.call("query", "agents:available", {}, tok(a));
        expect(r.ok && r.value.some((x: any) => x._id === bySpace[sp])).toBe(allowed);
      });
    }
  }
  test("an unpublished or disabled agent can't be picked by anyone", async () => {
    const draft = must(await s.call("mutation", "agents:create", { config: cfg({ name: "لم ينشر" }) }, tok("admin")));
    const off = await publishedAgent(s, tok("admin")!, { name: "معطّل" });
    must(await s.call("mutation", "agents:setEnabled", { agentId: off, enabled: false }, tok("admin")));
    for (const a of ACTORS) {
      for (const id of [draft, off]) expect((await s.call("mutation", "chat:createThread", { agentId: id }, tok(a))).ok).toBe(false);
    }
  });
});

describe("chat:openTaskThread: anyone who can view the task, nobody else", () => {
  for (const sp of SPACES) {
    for (const a of ACTORS) {
      const allowed = expectedAllowed(a, sp, "taskView");
      test(`chat:openTaskThread | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        check(await s.call("mutation", "chat:openTaskThread", { taskId: f.tasks[sp] }, tok(a)), allowed);
      });
    }
  }
  test("malformed task ids are denied", async () => {
    for (const id of ["x", f.spaces.S_plain, f.files.S_plain]) expect((await s.call("mutation", "chat:openTaskThread", { taskId: id }, tok("mgr"))).ok).toBe(false);
  });
});

describe("proposals and the thread's agent: the thread's owner only", () => {
  const OWNER_OPS: [string, (a: ActorKey) => Promise<Result>][] = [
    ["chat:setAgent", (a) => s.call("mutation", "chat:setAgent", { threadId: memThread, agentId: writer }, tok(a))],
    ["chat:confirmProposal", (a) => s.call("action", "chat:confirmProposal", { proposalId: toConfirm }, tok(a))],
    ["chat:cancelProposal", (a) => s.call("mutation", "chat:cancelProposal", { proposalId: toCancel }, tok(a))],
    ["chat:undo", (a) => s.call("mutation", "chat:undo", { proposalId: toUndo }, tok(a))],
  ];
  for (const [name, run] of OWNER_OPS) {
    for (const a of ACTORS) {
      const allowed = a === "mem";
      test(`${name} on mem's thread | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        check(await run(a), allowed);
      });
    }
  }
  test("garbage proposal ids are denied", async () => {
    for (const id of ["x", memThread, f.files.P_mem]) {
      expect((await s.call("action", "chat:confirmProposal", { proposalId: id }, tok("mem"))).ok).toBe(false);
      expect((await s.call("mutation", "chat:cancelProposal", { proposalId: id }, tok("mem"))).ok).toBe(false);
      expect((await s.call("mutation", "chat:undo", { proposalId: id }, tok("mem"))).ok).toBe(false);
    }
    // A confirmed (not auto-run) action can't be undone this way.
    expect((await s.call("mutation", "chat:undo", { proposalId: toConfirm }, tok("mem"))).ok).toBe(false);
  });
});

describe("coverage", () => {
  test("every Phase 6 public function is in this matrix", async () => {
    const res = await fetch(`${s.url}/_admin/api/functions`, { method: "POST", headers: { Authorization: `Bearer ${s.adminKey}` }, body: "{}" });
    const fns: string[] = (await res.json()).value.filter((x: any) => x.visibility === "public").map((x: any) => x.name);
    const phase6 = fns.filter((n) => n.startsWith("agents:") || ["chat:setAgent", "chat:openTaskThread", "chat:confirmProposal", "chat:cancelProposal", "chat:undo"].includes(n));
    expect(phase6.sort()).toEqual([...PHASE6_COVERED].sort());
  });
});
