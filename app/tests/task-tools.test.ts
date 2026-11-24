// create_task / update_task: the assistant creates, assigns and moves tasks exactly as the person
// could on the screen (tasks.ts), names resolved by the server, and every call waits for «نفّذ»
// because it notifies other people. A call the person can't make gets no card: the model is told
// why. Deterministic fake model: an agent's instructions «CALL_TOOL name {json}» make it call.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { ask } from "./rag-helpers";
import { cfg, chatRequestsWith, proposalsOf, publishedAgent } from "./agents-helpers";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string;

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

/** One question to an agent whose instructions make the fake model call `tool` with `args`. */
async function callAs(who: string, name: string, tool: string, args: unknown, question: string) {
  const agent = await publishedAgent(s, tok("admin"), cfg({ name, allowedTools: [], maxSteps: 2, instructions: `CALL_TOOL ${tool} ${JSON.stringify(args)}` }));
  const t = must(await s.call("mutation", "chat:createThread", { agentId: agent }, tok(who)));
  await ask(s, tok(who), t, question);
  return { threadId: t, props: (await proposalsOf(s, tok(who), t)).filter((p: any) => p.tool === tool) };
}
const board = async () => must(await s.call("query", "tasks:board", { spaceId: f.spaces.S_plain }, tok("mgr"))) as any[];
const toolRun = async (who: string, threadId: string, tool: string) =>
  must(await s.call("query", "chat:messages", { threadId }, tok(who))).messages.flatMap((m: any) => m.toolRuns ?? []).find((r: any) => r.name === tool);

describe("create_task", () => {
  test("a manager's call is a «نفّذ» card with the space and people in words; confirming creates, assigns and notifies", async () => {
    const space = must(await s.call("query", "spaces:get", { spaceId: f.spaces.S_plain }, tok("mgr"))).name;
    const { props } = await callAs("mgr", "مسند-1", "create_task", { title: "مراجعة العقد TT-1", assignees: ["mem"], space, due: "2026-12-01", priority: "high" }, "أسند مراجعة العقد TTQ-1");
    expect(props).toHaveLength(1);
    const p = props[0];
    expect([p.state, p.tier]).toEqual(["pending", 2]);
    expect(p.args.summary.lines).toEqual([`في «${space}»`, "إلى: موظف mem", "الموعد: 2026-12-01", "الأولوية: عالية"]);
    expect((await board()).some((x) => x.title === "مراجعة العقد TT-1")).toBe(false); // nothing before «نفّذ»
    must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, tok("mgr")));
    const task = (await board()).find((x) => x.title === "مراجعة العقد TT-1");
    expect(task.assigneeIds).toEqual([f.ids.mem]);
    expect([task.status, task.priority, new Date(task.due).toISOString().slice(0, 10)]).toEqual(["new", "high", "2026-12-01"]);
    const feed = must(await s.call("query", "notifications:list", {}, tok("mem"))) as any[];
    expect(feed.some((n) => n.kind === "task.assigned" && n.title.includes("مراجعة العقد TT-1"))).toBe(true);
  }, 30_000);

  test("several spaces they manage and none named: no card, the model is asked which", async () => {
    const { threadId, props } = await callAs("mgr", "مسند-2", "create_task", { title: "TT-2", assignees: ["mem"] }, "سوّ مهمة TTQ-2");
    expect(props).toEqual([]);
    expect((await toolRun("mgr", threadId, "create_task")).ok).toBe(false);
    expect(JSON.stringify(chatRequestsWith(ai, "TTQ-2"))).toContain("في أي مساحة؟");
  }, 30_000);

  test("a member can't create tasks, and a reader can't be assigned one: refused with the reason, no card", async () => {
    const space = must(await s.call("query", "spaces:get", { spaceId: f.spaces.S_plain }, tok("mgr"))).name;
    const a = await callAs("mem", "مسند-3", "create_task", { title: "TT-3", assignees: ["mgr"], space }, "سوّ مهمة TTQ-3");
    expect(a.props).toEqual([]);
    expect(JSON.stringify(chatRequestsWith(ai, "TTQ-3"))).toContain("المهام ينشئها ويسندها مدير المساحة");
    const b = await callAs("mgr", "مسند-4", "create_task", { title: "TT-4", assignees: ["rdr"], space }, "سوّ مهمة TTQ-4");
    expect(b.props).toEqual([]);
    expect(JSON.stringify(chatRequestsWith(ai, "TTQ-4"))).toContain("لا يوجد عضو في");
    expect((await board()).some((x) => x.title === "TT-3" || x.title === "TT-4")).toBe(false);
  }, 30_000);
});

describe("update_task", () => {
  test("the assignee moves it forward by title; a step outside the flow is refused with the allowed ones", async () => {
    const t1 = await callAs("mem", "محدث-1", "update_task", { task: "مراجعة العقد TT-1", status: "inProgress", comment: "بدأت المراجعة TT-C" }, "بدأت فيها TTQ-5");
    expect(t1.props).toHaveLength(1);
    expect(t1.props[0].args.summary.lines).toContain("الحالة: جديدة ← قيد التنفيذ");
    must(await s.call("action", "chat:confirmProposal", { proposalId: t1.props[0].id }, tok("mem")));
    const task = (await board()).find((x) => x.title === "مراجعة العقد TT-1");
    expect(task.status).toBe("inProgress");
    const detail = must(await s.call("query", "tasks:get", { taskId: task._id }, tok("mem")));
    expect(detail.comments.some((c: any) => c.body === "بدأت المراجعة TT-C")).toBe(true);
    // Closing is the manager's: the model hears where it can go instead.
    const t2 = await callAs("mem", "محدث-2", "update_task", { task: task._id, status: "done" }, "خلصتها TTQ-6");
    expect(t2.props).toEqual([]);
    expect(JSON.stringify(chatRequestsWith(ai, "TTQ-6"))).toContain("تنتقل فقط إلى: review");
  }, 30_000);

  test("reassigning is the manager's; read_tasks gives the manager every task of the space, with ids", async () => {
    const t = await callAs("mem", "محدث-3", "update_task", { task: "مراجعة العقد TT-1", assignees: ["mgr"] }, "حوّلها TTQ-7");
    expect(t.props).toEqual([]);
    expect(JSON.stringify(chatRequestsWith(ai, "TTQ-7"))).toContain("إسناد المهمة لمدير المساحة فقط");
    await callAs("mgr", "قارئ-مهام", "read_tasks", {}, "وش مهام الفريق TTQ-8");
    const sent = JSON.stringify(chatRequestsWith(ai, "TTQ-8"));
    expect(sent).toContain("مراجعة العقد TT-1");
    expect(sent).toMatch(/taskId=[a-z0-9]{20}/);
  }, 30_000);
});
