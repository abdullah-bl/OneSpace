// Working on the same thing (plans/18, phase 0): a chat has no 500-message wall, and nothing is
// saved over a version its author didn't see, whether a person saves it or «نفّذ» does.
// Model: the deterministic fake (fake-ai.ts), which obeys CALL_TOOL lines and stalls on SLOW-TURN.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { buildFixture, SPACES, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { ask, waitIngest } from "./rag-helpers";
import { chatRequestsWith, proposalsOf, publishedAgent } from "./agents-helpers";
import { foldUpTo } from "../onebase/lib/chatSummary";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string;
const mutate = async (path: string, args: any, as = "mem") => must(await s.call("mutation", path, args, tok(as)));
const view = async (threadId: string, as = "mem", limit?: number) => must(await s.call("query", "chat:messages", { threadId, ...(limit !== undefined ? { limit } : {}) }, tok(as)));

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
  for (const sp of SPACES) await waitIngest(s, sp === "P_mem" ? tok("mem") : tok("mgr"), f.spaces[sp], f.files[sp]);
}, 90_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

async function until<T>(what: string, get: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let i = 0; i < 1000; i++) {
    const v = await get();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(20);
  }
  throw new Error(`timeout: ${what}`);
}
const idle = (t: string, as = "mem") => until("the answer", async () => !(await view(t, as)).turn);

async function teamChat(n: number, text = (i: number) => `TEAMMSG-${i}.`) {
  const t = await mutate("chat:createThread", { spaceId: f.spaces.S_plain });
  for (let i = 1; i <= n; i++) await mutate("chat:send", { threadId: t, text: text(i) }, i % 2 ? "mem" : "mgr");
  return t as string;
}

describe("a chat longer than 500 messages", () => {
  const N = 1205; // more than two of the old pages, and more than one of the new
  let t: string;
  beforeAll(async () => {
    t = await teamChat(N);
  }, 120_000);

  test("opens on its newest messages and says how many are earlier", async () => {
    const v = await view(t);
    expect(v.messages.length).toBe(500);
    expect(v.messages.at(-1).text).toBe(`TEAMMSG-${N}.`);
    expect(v.messages[0].text).toBe(`TEAMMSG-${N - 499}.`);
    expect(v.earlier).toBe(N - 500);
  });

  test("a bigger limit reaches the first message, in order, none missing or repeated", async () => {
    const v = await view(t, "rdr", 5000);
    expect(v.messages.map((m: any) => m.text)).toEqual(Array.from({ length: N }, (_, i) => `TEAMMSG-${i + 1}.`));
    expect(v.earlier).toBe(0);
  });

  test("an odd limit still gives a window, and opens nothing to someone outside", async () => {
    for (const limit of [0, -3, 1.5]) expect((await view(t, "mem", limit)).messages.length).toBe(500);
    for (const a of ["out", "anon"]) expect((await s.call("query", "chat:messages", { threadId: t, limit: 5000 }, (f.tokens as any)[a])).ok).toBe(false);
  });

  test("the assistant gets the new question and the newest history", async () => {
    const a = await ask2(t, "وش آخر ما اتفقنا عليه؟ NEWQUESTION-1");
    expect(a.messages.at(-2).text).toContain("NEWQUESTION-1");
    expect(a.messages.at(-1).role).toBe("assistant");
    const req = chatRequestsWith(ai, "NEWQUESTION-1").find((r) => !r.body.response_format)!;
    expect(req).toBeTruthy();
    expect(JSON.stringify(req.body.messages)).toContain(`TEAMMSG-${N}.`);
    expect(String(req.body.messages.at(-1).content)).toContain("NEWQUESTION-1");
  }, 30_000);

  test("retry answers that question again, not an old one", async () => {
    const before = chatRequestsWith(ai, "NEWQUESTION-1").length;
    await mutate("chat:retry", { threadId: t });
    await idle(t);
    expect(chatRequestsWith(ai, "NEWQUESTION-1").length).toBeGreaterThan(before);
  }, 30_000);

  test("a late message can be handed to the assistant", async () => {
    await mutate("chat:send", { threadId: t, text: "راجع البند HANDOFF-9", people: [f.ids.mgr] });
    const m = (await view(t)).messages.at(-1);
    expect(m.text).toContain("HANDOFF-9");
    await mutate("chat:handoff", { messageId: m.id, action: "assistant" }, "mgr");
    await idle(t);
    expect(chatRequestsWith(ai, "HANDOFF-9").length).toBeGreaterThan(0);
  }, 30_000);

  test("read_chat reads the end of the chat", async () => {
    const r = must(await s.adminRun("chat:readForTool", { userId: f.ids.mem, threadId: t, query: `TEAMMSG-${N}` }));
    expect(r).toContain(`TEAMMSG-${N}.`);
  });

  test("a skill drafted from the chat learns from its newest messages", async () => {
    await ask2(t, "اكتبها رسمية دائماً SKILLMARK-77");
    const d = must(await s.call("action", "skills:draftFromThread", { threadId: t }, tok("mem")));
    expect(d.instructions).toContain("SKILLMARK-77");
  }, 30_000);
});

/** ask() compares message counts, which stop growing once the window is full. */
async function ask2(threadId: string, text: string) {
  await mutate("chat:send", { threadId, text, to: "assistant" });
  await idle(threadId);
  return await view(threadId);
}

describe("catching a long chat's summary up", () => {
  test("a fold takes the oldest messages that fit, and always moves forward", () => {
    expect(foldUpTo(Array(100).fill(1000), 0, 100, 10_000)).toBe(10);
    expect(foldUpTo(Array(100).fill(1000), 95, 100, 10_000)).toBe(100);
    expect(foldUpTo(Array(100).fill(1000), 20, 20, 10_000)).toBe(20);
    // Each message counts as it is sent to the summary (cut), and one always fits.
    expect(foldUpTo(Array(10).fill(500_000), 0, 10, 6000)).toBe(2);
    expect(foldUpTo(Array(10).fill(500_000), 3, 10, 10)).toBe(4);
  });

  test("a backlog isn't sent to the summary model all at once", async () => {
    const t = await teamChat(120, (i) => `BACKLOG-${i}. ${"تفصيل ".repeat(500)}`);
    await ask2(t, "لخّص BACKLOGQUESTION-1");
    const fold = await until("the fold", () => chatRequestsWith(ai, "BACKLOG-1.").find((r) => JSON.stringify(r.body.response_format ?? "").includes('"decisions"')));
    const sent = JSON.stringify(fold.body.messages);
    expect(sent.length).toBeLessThan(80_000);
    expect(sent).not.toContain("BACKLOG-80.");
  }, 60_000);
});

async function doc(space: "S_plain" | "S_sens" | "P_mem", content = "الأصل") {
  return (await mutate("artifacts:create", { title: "تقرير الربع", kind: "markdown", content, ...(space === "P_mem" ? {} : { spaceId: f.spaces[space] }) })).artifactId as string;
}
const current = async (artifactId: string) => await mutate("artifacts:open", { artifactId });

describe("saving an edit", () => {
  for (const sp of ["S_plain", "S_sens"] as const)
    test(`${sp}: an edit of an older version is refused and the colleague's stays`, async () => {
      const id = await doc(sp);
      await mutate("artifacts:edit", { artifactId: id, content: "تعديل المدير", baseVersion: 1 }, "mgr");
      const r: any = await s.call("mutation", "artifacts:edit", { artifactId: id, content: "تعديل العضو", baseVersion: 1 }, tok("mem"));
      expect(r.ok).toBe(false);
      expect(r.error).toContain("لم يُحفظ");
      expect(await current(id)).toMatchObject({ version: 2, content: "تعديل المدير" });
      await mutate("artifacts:edit", { artifactId: id, content: "التعديلان معاً", baseVersion: 2 });
      expect(await current(id)).toMatchObject({ version: 3, content: "التعديلان معاً" });
    });

  test("saves at the same moment: exactly one wins", async () => {
    const id = await doc("S_plain");
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => s.call("mutation", "artifacts:edit", { artifactId: id, content: `متزامن ${i}`, baseVersion: 1 }, tok(i % 2 ? "mem" : "mgr"))));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect((await current(id)).version).toBe(2);
  });

  test("a save that names no version (an old tab) or a future one is refused", async () => {
    const id = await doc("S_plain");
    for (const extra of [{}, { baseVersion: 9 }]) expect((await s.call("mutation", "artifacts:edit", { artifactId: id, content: "x", ...extra }, tok("mem"))).ok).toBe(false);
    expect((await current(id)).version).toBe(1);
  });

  test("who can't write learns nothing about versions", async () => {
    const id = await doc("S_plain");
    for (const a of ["rdr", "out"]) {
      const r: any = await s.call("mutation", "artifacts:edit", { artifactId: id, content: "x", baseVersion: 7 }, tok(a));
      expect(r.ok).toBe(false);
      expect(r.error).toContain("لا تملك");
    }
  });
});

let agents = 0;
/** A chat whose agent makes these tool calls, all in one step. */
async function chatCalling(calls: [string, any][], spaceId?: string) {
  const agentId = await publishedAgent(s, tok("admin"), {
    name: `محرر-${++agents}`,
    allowedTools: ["update_artifact", "write_app"],
    maxSteps: 2,
    instructions: calls.map(([name, args]) => `CALL_TOOL ${name} ${JSON.stringify(args)}`).join("\n"),
  });
  return (await mutate("chat:createThread", { agentId, ...(spaceId ? { spaceId } : {}) })) as string;
}
const confirm = async (proposalId: string) => await s.call("action", "chat:confirmProposal", { proposalId }, tok("mem"));

describe("«نفّذ» on an older version", () => {
  test("a colleague's edit after the proposal: the card says so and «نفّذ» changes nothing", async () => {
    const id = await doc("S_plain");
    const t = await chatCalling([["update_artifact", { artifactId: id, content: "نص الوكيل" }]], f.spaces.S_plain);
    await ask(s, tok("mem"), t, "حدّث التقرير");
    const [p] = await proposalsOf(s, tok("mem"), t);
    expect([p.state, p.stale]).toEqual(["pending", false]);
    await mutate("artifacts:edit", { artifactId: id, content: "تعديل المدير", baseVersion: 1 }, "mgr");
    expect((await proposalsOf(s, tok("mem"), t))[0].stale).toBe(true);
    const r: any = await confirm(p.id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("لم يُحفظ");
    const [after] = await proposalsOf(s, tok("mem"), t);
    expect(after.state).toBe("failed");
    expect(after.result).toContain("لم يُحفظ");
    expect(await current(id)).toMatchObject({ version: 2, content: "تعديل المدير" });
  }, 30_000);

  test("a colleague's edit while the assistant was working counts too", async () => {
    const id = await doc("S_plain");
    const t = await chatCalling([["update_artifact", { artifactId: id, content: "نص الوكيل" }]], f.spaces.S_plain);
    await mutate("chat:send", { threadId: t, text: "حدّث SLOW-TURN DURING-1", to: "assistant" });
    await until("the model call", () => chatRequestsWith(ai, "DURING-1").find((r) => r.body.tools?.length));
    await mutate("artifacts:edit", { artifactId: id, content: "تعديل أثناء العمل", baseVersion: 1 }, "mgr");
    await idle(t);
    const [p] = await proposalsOf(s, tok("mem"), t);
    expect(p.stale).toBe(true);
    expect((await confirm(p.id)).ok).toBe(false);
    expect((await current(id)).content).toBe("تعديل أثناء العمل");
  }, 30_000);

  test("untouched since: it saves", async () => {
    const id = await doc("S_plain");
    const t = await chatCalling([["update_artifact", { artifactId: id, content: "نص الوكيل" }]], f.spaces.S_plain);
    await ask(s, tok("mem"), t, "حدّث التقرير");
    expect(must(await confirm((await proposalsOf(s, tok("mem"), t))[0].id)).ok).toBe(true);
    expect(await current(id)).toMatchObject({ version: 2, content: "نص الوكيل" });
  }, 30_000);

  test("several edits from one answer run in their order", async () => {
    const id = await doc("S_plain");
    const t = await chatCalling(["الأولى", "الثانية", "الثالثة"].map((content) => ["update_artifact", { artifactId: id, content }]), f.spaces.S_plain);
    await ask(s, tok("mem"), t, "ثلاث خطوات");
    for (const p of await proposalsOf(s, tok("mem"), t)) expect(must(await confirm(p.id)).ok).toBe(true);
    expect(await current(id)).toMatchObject({ version: 4, content: "الثالثة" });
  }, 30_000);

  test("but an earlier one can't land on top of a later one", async () => {
    const id = await doc("S_plain");
    const t = await chatCalling(["الأولى", "الثانية"].map((content) => ["update_artifact", { artifactId: id, content }]), f.spaces.S_plain);
    await ask(s, tok("mem"), t, "خطوتان");
    const [first, second] = await proposalsOf(s, tok("mem"), t);
    expect(must(await confirm(second.id)).ok).toBe(true);
    expect((await confirm(first.id)).ok).toBe(false);
    expect((await current(id)).content).toBe("الثانية");
  }, 30_000);

  test("a colleague's edit between two edits of one answer stops the second", async () => {
    const id = await doc("S_plain");
    const t = await chatCalling(["الأولى", "الثانية"].map((content) => ["update_artifact", { artifactId: id, content }]), f.spaces.S_plain);
    await ask(s, tok("mem"), t, "خطوتان");
    const [first, second] = await proposalsOf(s, tok("mem"), t);
    expect(must(await confirm(first.id)).ok).toBe(true);
    await mutate("artifacts:edit", { artifactId: id, content: "تعديل بينهما", baseVersion: 2 }, "mgr");
    expect((await confirm(second.id)).ok).toBe(false);
    expect((await current(id)).content).toBe("تعديل بينهما");
  }, 30_000);

  test("two people's proposals on one version: the second is refused", async () => {
    const id = await doc("S_plain");
    const chats = [];
    for (const content of ["طلب أول", "طلب ثان"]) {
      const t = await chatCalling([["update_artifact", { artifactId: id, content }]], f.spaces.S_plain);
      await ask(s, tok("mem"), t, "حدّث");
      chats.push((await proposalsOf(s, tok("mem"), t))[0].id);
    }
    const rs = await Promise.all(chats.map(confirm));
    expect(rs.filter((r) => r.ok && r.value.ok).length).toBe(1);
    expect((await current(id)).version).toBe(2);
  }, 30_000);

  test("an app: write_app is refused the same way", async () => {
    const made = must(await s.adminRun("toolHarness:run", { userId: f.ids.mem, name: "write_app", args: { title: "تطبيق", files: { "index.html": "<h1>one</h1>" } }, scopeSpaceIds: [f.spaces.P_mem] }));
    const id = made.artifactIds[0];
    await mutate("artifacts:move", { artifactId: id, toSpaceId: f.spaces.S_plain });
    const t = await chatCalling([["write_app", { appId: id, files: { "a.js": "1" } }]], f.spaces.S_plain);
    await ask(s, tok("mem"), t, "عدّل التطبيق");
    const [p] = await proposalsOf(s, tok("mem"), t);
    must(await s.adminRun("toolHarness:run", { userId: f.ids.mgr, name: "write_app", args: { appId: id, files: { "b.js": "2" } }, scopeSpaceIds: [f.spaces.S_plain] }));
    expect((await confirm(p.id)).ok).toBe(false);
    expect((await current(id)).version).toBe(2);
  }, 30_000);
});

describe("edits that run without asking (my own space)", () => {
  test("my edit while the assistant was working isn't overwritten", async () => {
    const id = await doc("P_mem");
    const t = await chatCalling([["update_artifact", { artifactId: id, content: "نص الوكيل" }]]);
    await mutate("chat:send", { threadId: t, text: "حدّث SLOW-TURN DURING-2" });
    await until("the model call", () => chatRequestsWith(ai, "DURING-2").find((r) => r.body.tools?.length));
    await mutate("artifacts:edit", { artifactId: id, content: "تعديلي", baseVersion: 1 });
    await idle(t);
    expect(await current(id)).toMatchObject({ version: 2, content: "تعديلي" });
  }, 30_000);

  test("the assistant's own edits in one answer follow each other", async () => {
    const id = await doc("P_mem");
    const t = await chatCalling(["أولى", "ثانية"].map((content) => ["update_artifact", { artifactId: id, content }]));
    await ask(s, tok("mem"), t, "خطوتان");
    expect(await current(id)).toMatchObject({ version: 3, content: "ثانية" });
  }, 30_000);
});
