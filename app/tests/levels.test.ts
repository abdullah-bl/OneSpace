// Per-employee levels and sub-agents (plans/08 §A, §D). Fake model. Each test sets up the levels it
// needs and leaves "no levels" behind, so the order of tests doesn't matter.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, type ActorKey, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { waitIngest } from "./rag-helpers";
import { chatRequestsWith } from "./agents-helpers";
import { scrubIds } from "../onebase/chat";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string;
const ACTIVE: ActorKey[] = ["admin", "mgr", "mem", "rdr", "out"];
const LEVEL = { name: "أساسي", description: "", model: "main" as "main" | "fast", deep: false, tools: null as string[] | null, subagents: 0, dailyQuestions: 0 };

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

beforeEach(async () => {
  const d = must(await s.call("query", "levels:list", {}, tok("admin")));
  for (const l of d.levels) must(await s.call("mutation", "levels:remove", { levelId: l._id }, tok("admin")));
});

/** A level of its own for mem, with these settings. */
async function memOn(over: Partial<typeof LEVEL>) {
  const id = must(await s.call("mutation", "levels:save", { ...LEVEL, name: `مستوى-${Math.random().toString(36).slice(2, 7)}`, ...over }, tok("admin")));
  must(await s.call("mutation", "levels:assign", { userId: f.ids.mem, levelId: id }, tok("admin")));
  return id;
}

async function answerWith(text: string, effort?: string) {
  const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
  must(await s.call("mutation", "chat:send", { threadId: t, text, ...(effort ? { effort } : {}) }, tok("mem")));
  for (let i = 0; i < 600; i++) {
    const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
    if (!r.turn && r.messages.at(-1)?.role === "assistant") return r.messages.at(-1);
    await Bun.sleep(25);
  }
  throw new Error("no answer");
}
const answerReq = (marker: string) => chatRequestsWith(ai, marker).filter((r) => !r.body.response_format).at(-1);

describe("levels", () => {
  test("no levels: nobody is limited", async () => {
    const m = must(await s.call("query", "levels:mine", {}, tok("mem")));
    expect(m.configured).toBe(false);
    expect(m.deep).toBe(true);
    expect(m.dailyQuestions).toBe(0);
  });

  test("the first level becomes the default; an assignment beats it; removing returns to the default", async () => {
    const a = must(await s.call("mutation", "levels:save", { ...LEVEL, name: "أ" }, tok("admin")));
    const b = must(await s.call("mutation", "levels:save", { ...LEVEL, name: "ب" }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mgr"))).name).toBe("أ");
    must(await s.call("mutation", "levels:assign", { userId: f.ids.mgr, levelId: b }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mgr"))).name).toBe("ب");
    must(await s.call("mutation", "levels:remove", { levelId: b }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mgr"))).name).toBe("أ");
    must(await s.call("mutation", "levels:setDefault", { levelId: null }, tok("admin")));
    expect(must(await s.call("query", "levels:mine", {}, tok("mgr"))).configured).toBe(false);
    expect((await s.call("mutation", "levels:save", { ...LEVEL, name: "أ" }, tok("admin"))).ok).toBe(false); // name taken
    expect((await s.call("mutation", "levels:save", { ...LEVEL, name: "ج", tools: ["no_such_tool"] }, tok("admin"))).ok).toBe(false);
    void a;
  });

  test("daily limit: the next question is refused with the level's name", async () => {
    await memOn({ name: "محدود", dailyQuestions: 1 });
    const used = must(await s.call("query", "levels:mine", {}, tok("mem"))).usedToday;
    must(await s.call("mutation", "levels:save", { ...LEVEL, levelId: must(await s.call("query", "levels:list", {}, tok("admin"))).levels[0]._id, name: "محدود", dailyQuestions: used + 1 }, tok("admin")));
    await answerWith("سؤال LIMQ-1");
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    const r = await s.call("mutation", "chat:send", { threadId: t, text: "سؤال LIMQ-2" }, tok("mem"));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("محدود");
    expect(chatRequestsWith(ai, "LIMQ-2").length).toBe(0);
  }, 30_000);

  test("fast-only level answers with the small model and never thinks", async () => {
    await memOn({ model: "fast", deep: true });
    await answerWith("اكتب سطراً LVLQ-1", "deep");
    const req = answerReq("LVLQ-1");
    expect(req.body.model).toBe("fake-fast");
    expect(req.body.chat_template_kwargs.enable_thinking).toBe(false);
  }, 30_000);

  test("a level without «تفكير عميق» runs «عميق» without thinking", async () => {
    await memOn({ deep: false });
    await answerWith("اكتب سطراً LVLQ-2", "deep");
    expect(answerReq("LVLQ-2").body.chat_template_kwargs.enable_thinking).toBe(false);
  }, 30_000);

  test("tools: only the level's tools are offered", async () => {
    await memOn({ tools: ["search_documents"] });
    await answerWith("ابحث LVLQ-3");
    const names = (answerReq("LVLQ-3").body.tools ?? []).map((t: any) => t.function.name);
    // Memory tools follow the level's memory switch, not its tool list (plans/09).
    expect(names.every((n: string) => n === "search_documents" || n === "remember" || n === "recall" || n === "create_skill" || n === "use_skill" || n === "create_list" || n === "update_list" || n === "read_list")).toBe(true);
    expect(names).toContain("search_documents");
  }, 30_000);
});

describe("sub-agents", () => {
  test("a multi-part request is split, the parts run, and one answer is merged from them", async () => {
    await memOn({ subagents: 2 });
    const m = await answerWith("قارن الملفين SPLIT-Q SUBQ-1");
    expect(m.parts.length).toBe(2);
    expect(m.parts.map((p: any) => p.goal).join(" ")).toContain("PART-A");
    expect(m.steps.some((x: any) => x.label === "يقسّم المهمة…")).toBe(true);
    expect(m.steps.filter((x: any) => x.label.startsWith("جزء ")).length).toBe(2);
    // Each part ran with its own agent's prompt, read tools only.
    const partReqs = chatRequestsWith(ai, "PART-A").filter((r) => !r.body.response_format && JSON.stringify(r.body.messages).includes("جزؤك"));
    expect(partReqs.length).toBeGreaterThan(0);
    // run_analysis may be offered (it runs only when it touches the user's own space); file writes never.
    const writes = ["create_artifact", "update_artifact", "export_document", "fill_template"];
    for (const r of partReqs) expect((r.body.tools ?? []).some((t: any) => writes.includes(t.function.name))).toBe(false);
    // The merge saw both parts.
    const merge = answerReq("SUBQ-1");
    expect(JSON.stringify(merge.body.messages)).toContain("نتائج أجزاء هذا الطلب");
    expect(JSON.stringify(merge.body.messages)).toContain("PART-B");
    // Both parts succeeded: the merge doesn't redo their reading or analysis, and doesn't think.
    const reads = ["search_documents", "read_file", "query_records", "my_records", "run_analysis"];
    expect((merge.body.tools ?? []).some((t: any) => reads.includes(t.function.name))).toBe(false);
    expect(merge.body.chat_template_kwargs.enable_thinking).toBe(false);
  }, 60_000);

  test("a level without sub-agents never splits", async () => {
    await memOn({ subagents: 0 });
    const m = await answerWith("قارن الملفين SPLIT-Q SUBQ-2");
    expect(m.parts.length).toBe(0);
    expect(m.steps.some((x: any) => x.label === "يقسّم المهمة…")).toBe(false);
  }, 30_000);
});

describe("answers never show internal ids", () => {
  test("ids copied into an answer are removed; source numbers and words stay", () => {
    expect(scrubIds("حتى توفر نصّه [ap7xqb5tfep392h9g4ge].")).toBe("حتى توفر نصّه.");
    expect(scrubIds("المصدر [1] و[12] (معرّف: ap7xqb5tfep392h9g4ge) هنا")).toBe("المصدر [1] و[12] هنا");
    expect(scrubIds("الطلب PO-5191 من administration [2]")).toBe("الطلب PO-5191 من administration [2]");
    expect(scrubIds("الملف k5fn9t5x28ag1awt هنا", ["k5fn9t5x28ag1awt"])).toBe("الملف  هنا");
  });

  test("a file id the model writes into its answer doesn't reach the saved answer", async () => {
    const m = await answerWith(`اذكر المعرّف IDQ-1 ECHO-ID[${f.files.P_mem}]`);
    expect(m.text).toContain("هذا هو الملف");
    expect(m.text).not.toContain(f.files.P_mem);
  }, 30_000);
});

describe("attached files are chips, not text", () => {
  test("the model is told which files are attached, and the question shows them", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { threadId: t, text: "لخّص هذا الملف ATTQ-1", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    let r: any;
    for (let i = 0; i < 400; i++) {
      r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (!r.turn && r.messages.at(-1)?.role === "assistant") break;
      await Bun.sleep(25);
    }
    const user = r.messages.find((m: any) => m.role === "user");
    expect(user.text).toBe("لخّص هذا الملف ATTQ-1");
    expect(user.attached).toHaveLength(1);
    expect(user.attached[0].kind).toBe("file");
    expect(JSON.stringify(answerReq("ATTQ-1").body.messages)).toContain(`الملفات المرفقة بهذا الطلب: «${user.attached[0].name}»`);
  }, 30_000);
});

describe("permission matrix: levels", () => {
  test("list / save / remove / setDefault / assign: the workspace admin only; mine: active members", async () => {
    const id = must(await s.call("mutation", "levels:save", { ...LEVEL, name: "مصفوفة" }, tok("admin")));
    for (const a of ACTORS) {
      const admin = a === "admin";
      expect((await s.call("query", "levels:list", {}, tok(a))).ok).toBe(admin);
      expect((await s.call("query", "levels:mine", {}, tok(a))).ok).toBe(ACTIVE.includes(a));
      if (admin) continue;
      expect((await s.call("mutation", "levels:save", { ...LEVEL, name: `x-${a}` }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "levels:save", { ...LEVEL, levelId: id, name: "مخترق", dailyQuestions: 1 }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "levels:setDefault", { levelId: null }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "levels:assign", { userId: f.ids.mem, levelId: null }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "levels:remove", { levelId: id }, tok(a))).ok).toBe(false);
    }
    // Only workspace members can be assigned.
    expect((await s.call("mutation", "levels:assign", { userId: f.ids.out, levelId: id }, tok("admin"))).ok).toBe(true);
    expect((await s.call("mutation", "levels:assign", { userId: f.ids.pend, levelId: id }, tok("admin"))).ok).toBe(false);
  }, 60_000);
});
