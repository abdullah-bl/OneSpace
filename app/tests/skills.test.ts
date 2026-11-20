// «إيقاف», the user's own skills ("/name"), AI drafts (a skill from a chat, an agent from a goal),
// and follow-up routing that remembers the chat's files and agent (plans/07). Fake model.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, type ActorKey, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { ask, waitIngest } from "./rag-helpers";
import { chatRequestsWith, systemOf } from "./agents-helpers";
import { SKILLS_COVERED } from "./skills.coverage";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string;
const ACTIVE: ActorKey[] = ["admin", "mgr", "mem", "rdr", "out"];

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
  expect((await waitIngest(s, tok("mem"), f.spaces.P_mem, f.files.P_mem)).state).toBe("ready");
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

const skillArgs = (name: string, instructions = "اكتب بصيغة رسمية") => ({ name, title: name, description: "", instructions });

describe("«إيقاف»", () => {
  test("a running answer stops and keeps what it wrote", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "SLOW-TURN اكتب طويلاً STOP-1" }, tok("mem")));
    for (let i = 0; i < 200; i++) {
      const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (r.turn?.state === "running" && r.turn.streamId) break;
      await Bun.sleep(20);
    }
    await Bun.sleep(300);
    // Only the owner.
    expect((await s.call("mutation", "chat:stop", { threadId: t }, tok("mgr"))).ok).toBe(false);
    expect(must(await s.call("mutation", "chat:stop", { threadId: t }, tok("mem"))).stopped).toBe(true);
    let last: any;
    for (let i = 0; i < 300; i++) {
      const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (!r.turn) {
        last = r.messages.at(-1);
        break;
      }
      await Bun.sleep(20);
    }
    expect(last.role).toBe("assistant");
    expect(last.text).toContain("أُوقفت الإجابة");
  }, 30_000);

  test("stopping when nothing runs does nothing", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem"), t, "سؤال قصير");
    expect(must(await s.call("mutation", "chat:stop", { threadId: t }, tok("mem"))).stopped).toBe(false);
  }, 30_000);
});

describe("my skills: /name", () => {
  test("create / list / update / remove are mine only; names are checked", async () => {
    const id = must(await s.call("mutation", "skills:create", skillArgs("خطاب-رسمي"), tok("mem")));
    expect((await s.call("mutation", "skills:create", skillArgs("خطاب-رسمي"), tok("mem"))).ok).toBe(false); // duplicate
    expect((await s.call("mutation", "skills:create", skillArgs("فيه مسافة!"), tok("mem"))).ok).toBe(false);
    expect((await s.call("mutation", "skills:create", { ...skillArgs("فارغة"), instructions: " " }, tok("mem"))).ok).toBe(false);
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).map((x: any) => x.name)).toContain("خطاب-رسمي");
    expect(must(await s.call("query", "skills:list", {}, tok("mgr"))).map((x: any) => x.name)).not.toContain("خطاب-رسمي");
    expect((await s.call("mutation", "skills:update", { skillId: id, ...skillArgs("مسروقة") }, tok("mgr"))).ok).toBe(false);
    expect((await s.call("mutation", "skills:remove", { skillId: id }, tok("mgr"))).ok).toBe(false);
    must(await s.call("mutation", "skills:update", { skillId: id, ...skillArgs("خطاب-رسمي", "ابدأ بسعادة") }, tok("mem")));
    must(await s.call("mutation", "skills:remove", { skillId: id }, tok("mem")));
    expect(must(await s.call("query", "skills:list", {}, tok("mem")))).toEqual([]);
  });

  test("a skill joins that answer's instructions, steers the router, and shows on the answer", async () => {
    const id = must(await s.call("mutation", "skills:create", skillArgs("تقرير", "SKILLINSTR-7 اكتب جدولاً"), tok("mem")));
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "/تقرير عن الحضور SKILLQ-1", skillId: id }, tok("mem")));
    let answered: any;
    for (let i = 0; i < 400 && !answered; i++) {
      const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (!r.turn && r.messages.at(-1)?.role === "assistant") answered = r.messages.at(-1);
      else await Bun.sleep(25);
    }
    expect(answered.userSkill).toBe("تقرير");
    expect(answered.steps.some((x: any) => x.label === "يطبّق مهارتك /تقرير")).toBe(true);
    const req = chatRequestsWith(ai, "SKILLQ-1").filter((r) => !r.body.response_format).at(-1);
    expect(systemOf(req)).toContain("SKILLINSTR-7");
    const routerReq = ai.requests.filter((r) => JSON.stringify(r.body.response_format ?? "").includes('"skill"') && JSON.stringify(r.body.messages).includes("SKILLQ-1")).at(-1);
    expect(JSON.stringify(routerReq.body.messages)).toContain("طريقة العمل التي اختارها المستخدم");
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x._id === id).uses).toBe(1);
  }, 30_000);

  test("someone else's skill can't be used", async () => {
    const id = must(await s.call("mutation", "skills:create", skillArgs("سري"), tok("mgr")));
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    expect((await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "/سري", skillId: id }, tok("mem"))).ok).toBe(false);
  });
});

describe("AI drafts", () => {
  test("a skill from my chat: a draft (not saved), with a free name; not from someone else's chat", async () => {
    must(await s.call("mutation", "skills:create", skillArgs("خطاب-رسمي"), tok("mem")));
    const before = must(await s.call("query", "skills:list", {}, tok("mem"))).length;
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem"), t, "اكتب خطاباً رسمياً SKILLMARK-42");
    const d = must(await s.call("action", "skills:draftFromThread", { threadId: t }, tok("mem")));
    expect(d.name).toBe("خطاب-رسمي-2"); // "خطاب رسمي" → "خطاب-رسمي", taken → suffixed
    expect(d.instructions).toContain("SKILLMARK-42");
    // Hidden reasoning is turned off, so a reasoning model can't spend the budget and cut the JSON off.
    const req = ai.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.response_format).at(-1);
    expect(req.body.reasoning).toEqual({ enabled: false });
    expect(req.body.max_tokens).toBeGreaterThanOrEqual(6000);
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).length).toBe(before); // nothing saved yet
    expect((await s.call("action", "skills:draftFromThread", { threadId: t }, tok("mgr"))).ok).toBe(false);
    const id = must(await s.call("mutation", "skills:create", { ...d, fromThreadId: t }, tok("mem")));
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x._id === id).source).toBe("chat");
  }, 30_000);

  test("an agent from a goal: admin only; only registry tools and allowed values come back", async () => {
    const d = must(await s.call("action", "agentDrafts:draftWithAI", { goal: "يراجع العقود" }, tok("admin")));
    expect(d.allowedTools).toEqual(["read_file", "search_documents"]); // run_shell is not in the registry
    expect([d.dataScope, d.grounding, d.maxSteps]).toEqual(["member", "documents", 3]);
    expect(d.description).toContain("DRAFTAGENT-1");
    for (const a of ["mgr", "mem", "out"]) expect((await s.call("action", "agentDrafts:draftWithAI", { goal: "x" }, tok(a))).ok).toBe(false);
  }, 30_000);
});

describe("follow-ups remember the chat's files and agent", () => {
  test("a question without @ inherits the last mentioned file: skills that can't reach it aren't candidates", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "لخّص هذا FOLLOW-1", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    for (let i = 0; i < 400; i++) {
      const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (!r.turn && r.messages.at(-1)?.role === "assistant") break;
      await Bun.sleep(25);
    }
    await ask(s, tok("mem"), t, "على نفس الملف FOLLOW-2");
    const req = ai.requests.filter((r) => JSON.stringify(r.body.response_format ?? "").includes('"skill"') && JSON.stringify(r.body.messages).includes("FOLLOW-2")).at(-1);
    const all = JSON.stringify(req.body.messages);
    expect(all).toContain("من سؤال سابق في المحادثة");
    expect(all).toContain("المهارة التي أجابت عن السؤال السابق");
    expect(String(req.body.messages[0].content)).not.toContain("السياسات"); // can't reach a personal file
    // ...and the answer itself is about that file: its passages reach the model.
    const answerReq = chatRequestsWith(ai, "FOLLOW-2").filter((r) => !r.body.response_format).at(-1);
    expect(JSON.stringify(answerReq.body.messages)).toContain("PERSONAL-CONTENT");
  }, 30_000);
});

describe("thinking level: تلقائي / سريع / عميق", () => {
  async function answerWith(text: string, effort?: string) {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text, ...(effort ? { effort } : {}) }, tok("mem")));
    for (let i = 0; i < 400; i++) {
      const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (!r.turn && r.messages.at(-1)?.role === "assistant") return r.messages.at(-1);
      await Bun.sleep(25);
    }
    throw new Error("no answer");
  }
  const answerReq = (marker: string) => chatRequestsWith(ai, marker).filter((r) => !r.body.response_format).at(-1);

  test("«عميق» thinks (hidden), shows «يفكّر», and never shows the reasoning", async () => {
    const m = await answerWith("اكتب جملة EFFQ-1", "deep");
    expect(answerReq("EFFQ-1").body.chat_template_kwargs.enable_thinking).toBe(true);
    expect(m.steps.some((x: any) => x.label === "يفكّر…" && x.state === "done")).toBe(true);
    expect(m.text).not.toContain("REASONING-HIDDEN");
  }, 30_000);

  test("«سريع» never thinks, even when the router would", async () => {
    await answerWith("حلّل هذا DEEP-Q EFFQ-2", "fast");
    expect(answerReq("EFFQ-2").body.chat_template_kwargs.enable_thinking).toBe(false);
  }, 30_000);

  test("«تلقائي» follows the router's judgement of the question", async () => {
    await answerWith("سؤال يحتاج تأملاً DEEP-Q EFFQ-3");
    expect(answerReq("EFFQ-3").body.chat_template_kwargs.enable_thinking).toBe(true);
    const plain = await answerWith("اكتب تحية EFFQ-4", "auto");
    expect(answerReq("EFFQ-4").body.chat_template_kwargs.enable_thinking).toBe(false);
    expect(plain.steps.some((x: any) => x.label === "يفكّر…")).toBe(false);
  }, 30_000);

  test("an unknown level is refused", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    expect((await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "x", effort: "max" }, tok("mem"))).ok).toBe(false);
  });
});

describe("permission matrix: new public functions", () => {
  test("skills:list / create are for active members; anonymous, pending and disabled are refused", async () => {
    for (const a of ACTORS) {
      const active = ACTIVE.includes(a);
      expect((await s.call("query", "skills:list", {}, tok(a))).ok).toBe(active);
      expect((await s.call("mutation", "skills:create", skillArgs(`مهارة-${a}`), tok(a))).ok).toBe(active);
    }
  });

  test("update / remove / draftFromThread / stop: the owner only", async () => {
    const id = must(await s.call("mutation", "skills:create", skillArgs("مالك"), tok("mem")));
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem"), t, "سؤال");
    for (const a of ACTORS) {
      if (a === "mem") continue;
      expect((await s.call("mutation", "skills:update", { skillId: id, ...skillArgs("مالك") }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "skills:remove", { skillId: id }, tok(a))).ok).toBe(false);
      expect((await s.call("action", "skills:draftFromThread", { threadId: t }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "chat:stop", { threadId: t }, tok(a))).ok).toBe(false);
    }
    expect((await s.call("mutation", "skills:update", { skillId: id, ...skillArgs("مالك") }, tok("mem"))).ok).toBe(true);
  }, 60_000);

  test("agentDrafts:draftWithAI: the workspace admin only", async () => {
    for (const a of ACTORS) expect((await s.call("action", "agentDrafts:draftWithAI", { goal: "x" }, tok(a))).ok).toBe(a === "admin");
  }, 60_000);

  test("home:suggestions: my recent files and skills only; a space I can't read is refused", async () => {
    must(await s.call("mutation", "skills:create", skillArgs("اقتراح-منزلي"), tok("mem")));
    const mine = must(await s.call("query", "home:suggestions", {}, tok("mem")));
    expect(mine.some((x: any) => x.kind === "file" && x.file.id === f.files.P_mem && x.text && !x.text.includes("@"))).toBe(true);
    expect(mine.some((x: any) => x.kind === "skill" && x.text.startsWith("/"))).toBe(true);
    for (const a of ACTORS) {
      const r = await s.call("query", "home:suggestions", {}, tok(a));
      expect(r.ok).toBe(ACTIVE.includes(a));
      if (a !== "mem" && r.ok) {
        expect(r.value.some((x: any) => x.kind === "file" && x.file.id === f.files.P_mem)).toBe(false);
        expect(r.value.some((x: any) => x.kind === "skill" && x.skill.name === "اقتراح-منزلي")).toBe(false);
      }
      if (a !== "mem") expect((await s.call("query", "home:suggestions", { spaceId: f.spaces.P_mem }, tok(a))).ok).toBe(false);
    }
  }, 60_000);

  test("every function in SKILLS_COVERED exists and is public", async () => {
    const res = await fetch(`${s.url}/_admin/api/functions`, { method: "POST", headers: { Authorization: `Bearer ${s.adminKey}` }, body: "{}" });
    const publicFns = new Set((await res.json()).value.filter((x: any) => x.visibility === "public").map((x: any) => x.name));
    for (const n of SKILLS_COVERED) expect(publicFns.has(n)).toBe(true);
    expect([...publicFns].filter((n: any) => n.startsWith("skills:") || n.startsWith("agentDrafts:") || n.startsWith("home:") || n.startsWith("levels:")).sort()).toEqual(SKILLS_COVERED.filter((n) => !n.startsWith("chat:")).sort());
  });
});
