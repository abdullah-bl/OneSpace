// UX redesign (app/UX.md): free-form chats, space chats, @mentions (scope narrowing in chats,
// people in task comments + the "الإشارات" inbox) and scheduled tasks — behaviour and the
// permission matrix for every new public function. Model: the deterministic fake (fake-ai.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, expectedAllowed, FILE_NAMES, SPACES, type ActorKey, type Fixture } from "./fixture";
import { aiEnv, GENERAL_ANSWER, FAKE_TITLE, startFakeAI, type FakeAI } from "./fake-ai";
import { addBytes, ask, waitIngest } from "./rag-helpers";
import { chatRequestsWith, publishedAgent, systemOf } from "./agents-helpers";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;
const ACTIVE = (a: ActorKey) => !["pend", "dis", "anon"].includes(a);

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai, { PROPOSAL_TTL_MS: "600000", CHAT_HISTORY_MAX: "12" /* a small window, so 10 turns exercise the summary */ })).start();
  f = await buildFixture(s);
  for (const sp of SPACES) await waitIngest(s, sp === "P_mem" ? tok("mem")! : tok("mgr")!, f.spaces[sp], f.files[sp]);
}, 90_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

function check(r: Result, allowed: boolean) {
  if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
  if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
}

/** Waits until the thread has `n` assistant messages and no turn in progress. */
async function waitAnswers(token: string, threadId: string, n: number, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = must(await s.call("query", "chat:messages", { threadId }, token));
    if (r.turn?.state === "failed") throw new Error("turn failed: " + r.turn.error);
    const answers = r.messages.filter((m: any) => m.role === "assistant");
    if (!r.turn && answers.length >= n) return r;
    await Bun.sleep(40);
  }
  throw new Error("timeout waiting for answers");
}

async function dump(threadId: string, token: string) {
  return JSON.stringify(must(await s.call("query", "chat:messages", { threadId }, token)));
}

// ---------------------------------------------------------------- free-form chats

describe("free-form chats", () => {
  test("a general question gets a general answer: no documents, no citations, no abstention; the fast model names the chat", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    const a = await ask(s, tok("mem")!, t, "ترجم إلى الإنجليزية: صباح الخير FREEQ-1");
    expect(a.text).toBe(GENERAL_ANSWER);
    expect(a.abstained).toBe(false);
    expect(a.citations).toEqual([]);
    const req = chatRequestsWith(ai, "FREEQ-1").at(-1);
    expect(systemOf(req)).toContain("تجيب عن أي سؤال");
    expect(JSON.stringify(req.body.messages)).not.toContain("(ملف:");
    // Title: generated after the first answer.
    let title = "";
    for (let i = 0; i < 50 && title !== FAKE_TITLE; i++) {
      title = must(await s.call("query", "chat:threads", {}, tok("mem"))).find((x: any) => x.threadId === t)?.title;
      await Bun.sleep(40);
    }
    expect(title).toBe(FAKE_TITLE);
    // Searchable by title.
    expect(must(await s.call("query", "chat:threads", { q: "مقترح" }, tok("mem"))).some((x: any) => x.threadId === t)).toBe(true);
    expect(must(await s.call("query", "chat:threads", { q: "لا-يوجد-هذا" }, tok("mem"))).length).toBe(0);
  }, 30_000);

  test("a question about my files still uses them, with citations", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    const a = await ask(s, tok("mem")!, t, "ما محتوى PERSONAL-CONTENT-PF55؟");
    expect(a.citations.some((c: any) => c.fileId === f.files.P_mem)).toBe(true);
  }, 30_000);

  test("retry answers the last question again (no new question saved)", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem")!, t, "سؤال عام RETRYQ-1");
    must(await s.call("mutation", "chat:retry", { threadId: t }, tok("mem")));
    const r = await waitAnswers(tok("mem")!, t, 2);
    expect(r.messages.filter((m: any) => m.role === "user").length).toBe(1);
    expect(r.messages.filter((m: any) => m.role === "assistant").length).toBe(2);
  }, 30_000);
});

// ---------------------------------------------------------------- space chats

describe("space chats", () => {
  let spaceThread: string;

  test("a chat started in a space is scoped to it, carries its instructions and files, and is listed on the space page for its owner only (a private one)", async () => {
    must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "SPACEINSTR-UX1: أجب بإيجاز." }, tok("mgr")));
    spaceThread = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    const m = must(await s.call("query", "chat:messages", { threadId: spaceThread }, tok("mem")));
    expect(m.scope).toEqual({ kind: "space", id: f.spaces.S_plain });
    expect(m.spaceId).toBe(f.spaces.S_plain);
    const a = await ask(s, tok("mem")!, spaceThread, "ما محتوى CONTENT-S_plain و CONTENT-S_sens و PERSONAL-CONTENT-PF55؟ SPACEQ-1");
    expect(a.citations.length).toBeGreaterThan(0);
    expect(a.citations.every((c: any) => c.fileId === f.files.S_plain)).toBe(true);
    const req = chatRequestsWith(ai, "SPACEQ-1").at(-1);
    const sys = systemOf(req);
    expect(sys).toContain("SPACEINSTR-UX1");
    expect(sys).toContain(FILE_NAMES.S_plain); // the space's files as context
    expect(JSON.stringify(req.body)).not.toContain(FILE_NAMES.S_sens);
    expect(JSON.stringify(req.body)).not.toContain(FILE_NAMES.P_mem);
    // Listed on the space page — for mem only. mgr (manager of the space) sees none of mem's chats.
    expect(must(await s.call("query", "chat:spaceThreads", { spaceId: f.spaces.S_plain }, tok("mem"))).map((x: any) => x.threadId)).toContain(spaceThread);
    expect(must(await s.call("query", "chat:spaceThreads", { spaceId: f.spaces.S_plain }, tok("mgr"))).map((x: any) => x.threadId)).not.toContain(spaceThread);
    expect((await s.call("query", "chat:messages", { threadId: spaceThread }, tok("mgr"))).ok).toBe(false);
  }, 30_000);

  test("a space chat's scope can't be moved outside its space", async () => {
    expect((await s.call("mutation", "chat:setScope", { threadId: spaceThread, scope: { kind: "all" } }, tok("mem"))).ok).toBe(true); // = the space
    expect(must(await s.call("query", "chat:messages", { threadId: spaceThread }, tok("mem"))).scope).toEqual({ kind: "space", id: f.spaces.S_plain });
    expect((await s.call("mutation", "chat:setScope", { threadId: spaceThread, scope: { kind: "space", id: f.spaces.S_sens } }, tok("mem"))).ok).toBe(false);
    expect((await s.call("mutation", "chat:setScope", { threadId: spaceThread, scope: { kind: "file", id: f.files.P_mem } }, tok("mem"))).ok).toBe(false);
    must(await s.call("mutation", "chat:setScope", { threadId: spaceThread, scope: { kind: "file", id: f.files.S_plain } }, tok("mem")));
  });

  test("losing access to the space empties the chat's scope at once", async () => {
    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp, role: "reader" }, tok("mgr")));
    const t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_sens }, tok("tmp")));
    expect((await ask(s, tok("tmp")!, t, "CONTENT-S_sens")).citations.some((c: any) => c.fileId === f.files.S_sens)).toBe(true);
    must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp }, tok("mgr")));
    const after = await ask(s, tok("tmp")!, t, "CONTENT-S_sens LOSTQ-1");
    expect(after.citations).toEqual([]);
    for (const r of chatRequestsWith(ai, "LOSTQ-1")) expect(JSON.stringify(r.body)).not.toContain(FILE_NAMES.S_sens);
    expect(must(await s.call("query", "chat:threads", {}, tok("tmp"))).find((x: any) => x.threadId === t).spaceName).toBe(null);
    expect((await s.call("query", "chat:spaceThreads", { spaceId: f.spaces.S_sens }, tok("tmp"))).ok).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------- @mentions in chat

describe("@mentions in chat narrow the scope and can never widen it", () => {
  test("@file narrows a question to that file", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "ما محتوى CONTENT-S_plain و PERSONAL-CONTENT-PF55؟", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    const r = await waitAnswers(tok("mem")!, t, 1);
    const cites = r.messages.at(-1).citations;
    expect(cites.length).toBeGreaterThan(0);
    expect(cites.every((c: any) => c.fileId === f.files.P_mem)).toBe(true);
  }, 30_000);

  test("@space narrows to that space", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "CONTENT-S_plain CONTENT-S_every PERSONAL-CONTENT-PF55", mentions: [{ kind: "space", id: f.spaces.S_every }] }, tok("mem")));
    const r = await waitAnswers(tok("mem")!, t, 1);
    expect(r.messages.at(-1).citations.every((c: any) => c.fileId === f.files.S_every)).toBe(true);
  }, 30_000);

  for (const sp of SPACES) {
    for (const a of ACTORS) {
      if (!ACTIVE(a)) continue;
      const allowed = expectedAllowed(a, sp, "read");
      test(`chat:send mentioning the file / space of ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        const t = must(await s.call("mutation", "chat:createThread", {}, tok(a)));
        check(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "MENTIONQ", mentions: [{ kind: "file", id: f.files[sp] }] }, tok(a)), allowed);
        check(await s.call("mutation", "chat:send", { to: "assistant", threadId: must(await s.call("mutation", "chat:createThread", {}, tok(a))), text: "MENTIONQ", mentions: [{ kind: "space", id: f.spaces[sp] }] }, tok(a)), allowed);
      }, 30_000);
    }
  }

  test("a mention outside the agent's scope or the thread's scope narrows to nothing (never widens)", async () => {
    // The policies agent only sees 'everyone' spaces: mentioning a readable S_plain file finds nothing.
    const policies = must(await s.call("query", "agents:available", {}, tok("mem"))).find((x: any) => x.name === "السياسات")._id;
    const t = must(await s.call("mutation", "chat:createThread", { agentId: policies }, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "CONTENT-S_plain WIDENQ-1", mentions: [{ kind: "file", id: f.files.S_plain }] }, tok("mem")));
    const r = await waitAnswers(tok("mem")!, t, 1);
    expect(r.messages.at(-1).citations).toEqual([]);
    for (const req of chatRequestsWith(ai, "WIDENQ-1")) expect(JSON.stringify(req.body)).not.toContain("CONTENT-S_plain\n");
    // A thread scoped to S_every: mentioning S_plain doesn't reach S_plain.
    // (A private chat: a shared one refuses an outside mention outright, see shared-chats.test.ts.)
    const t2 = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_every, shared: false }, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t2, text: "CONTENT-S_plain WIDENQ-2", mentions: [{ kind: "space", id: f.spaces.S_plain }] }, tok("mem")));
    const r2 = await waitAnswers(tok("mem")!, t2, 1);
    expect(r2.messages.at(-1).citations).toEqual([]);
    expect(await dump(t2, tok("mem")!)).not.toContain(FILE_NAMES.S_plain);
  }, 30_000);

  test("an unknown or malformed mention is the same denial; @agent picks an agent I may use", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    for (const id of ["nope", f.spaces.S_plain]) expect((await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "x", mentions: [{ kind: "file", id }] }, tok("mem"))).ok).toBe(false);
    const policies = must(await s.call("query", "agents:available", {}, tok("mem"))).find((x: any) => x.name === "السياسات")._id;
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "AGENTMENTION-1", mentions: [{ kind: "agent", id: policies }] }, tok("mem")));
    expect(must(await s.call("query", "chat:messages", { threadId: t }, tok("mem"))).agentId).toBe(policies);
  }, 30_000);

  test("an agent that can't read the @file says so and points to the general assistant (no bare 'not found', no model call)", async () => {
    const agents = must(await s.call("query", "agents:available", {}, tok("mem")));
    const grades = agents.find((x: any) => x.name === "الدرجات والتقارير")._id;
    const def = agents.find((x: any) => x.isDefault);
    const t = must(await s.call("mutation", "chat:createThread", { agentId: grades }, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "لخّص الملف NOREADQ-1", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    const r = await waitAnswers(tok("mem")!, t, 1);
    const text: string = r.messages.at(-1).text;
    expect(text).toContain("لا يستطيع قراءة");
    expect(text).toContain(FILE_NAMES.P_mem);
    expect(text).toContain(def.name);
    expect(text).not.toContain("لم أجد هذا");
    expect(chatRequestsWith(ai, "NOREADQ-1")).toEqual([]);
    // The same question with the default agent reads and cites the file.
    const t2 = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t2, text: "لخّص الملف NOREADQ-2", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    const r2 = await waitAnswers(tok("mem")!, t2, 1);
    expect(r2.messages.at(-1).citations.every((c: any) => c.fileId === f.files.P_mem)).toBe(true);
    expect(r2.messages.at(-1).citations.length).toBeGreaterThan(0);
  }, 30_000);

  test("mentions:suggest offers files and spaces only (agents are picked in the agent picker)", async () => {
    const r = must(await s.call("query", "mentions:suggest", { q: "" }, tok("mem")));
    expect(r.agents).toEqual([]);
  });

  test("mentions:suggest lists only what I can read", async () => {
    for (const a of ACTORS) {
      const r = await s.call("query", "mentions:suggest", {}, tok(a));
      check(r, ACTIVE(a));
      if (!r.ok) continue;
      const files = r.value.files.map((x: any) => x.id);
      const spaces = r.value.spaces.map((x: any) => x.id);
      for (const sp of SPACES) {
        if (!expectedAllowed(a, sp, "read")) {
          expect(files).not.toContain(f.files[sp]);
          expect(spaces).not.toContain(f.spaces[sp]);
          expect(JSON.stringify(r.value)).not.toContain(FILE_NAMES[sp]);
        }
      }
    }
    // In a space: only that space's files.
    const inSpace = must(await s.call("query", "mentions:suggest", { spaceId: f.spaces.S_plain, q: "" }, tok("mem")));
    expect(inSpace.files.every((x: any) => x.detail === "لجنة-المشتريات-QX71")).toBe(true);
    expect(inSpace.spaces).toEqual([]);
  });
});

// ---------------------------------------------------------------- @people in task comments, the inbox

describe("@mentions in task comments and the الإشارات inbox", () => {
  test("a mention notifies people who can view the task; anyone else is ignored silently", async () => {
    const people = must(await s.call("query", "mentions:people", { taskId: f.tasks.S_plain }, tok("mgr"))).map((p: any) => p.userId);
    expect(people).toContain(f.ids.mem);
    expect(people).toContain(f.ids.rdr);
    expect(people).not.toContain(f.ids.out);
    expect(people).not.toContain(f.ids.mgr); // not me
    must(await s.call("mutation", "tasks:comment", { taskId: f.tasks.S_plain, body: "@موظف mem @موظف rdr راجعا العرض MENTIONC-1", mentions: [f.ids.mem, f.ids.rdr, f.ids.out, f.ids.admin, "nope"] }, tok("mgr")));
    const memBox = must(await s.call("query", "mentions:inbox", {}, tok("mem")));
    expect(memBox.some((m: any) => m.excerpt.includes("MENTIONC-1") && m.taskId === f.tasks.S_plain && !m.read)).toBe(true);
    expect(must(await s.call("query", "mentions:unreadCount", {}, tok("mem")))).toBeGreaterThan(0);
    expect(must(await s.call("query", "mentions:inbox", {}, tok("rdr"))).some((m: any) => m.excerpt.includes("MENTIONC-1"))).toBe(true);
    for (const who of ["out", "admin"]) {
      expect(JSON.stringify(must(await s.call("query", "mentions:inbox", {}, tok(who))))).not.toContain("MENTIONC-1");
      expect(JSON.stringify(must(await s.call("query", "notifications:list", {}, tok(who))))).not.toContain("MENTIONC-1");
    }
    const notes = must(await s.call("query", "notifications:list", {}, tok("mem")));
    expect(notes.some((n: any) => n.kind === "task.mention" && n.taskId === f.tasks.S_plain)).toBe(true);
  });

  test("only my own mentions can be marked read; losing access hides them", async () => {
    const memBox = must(await s.call("query", "mentions:inbox", {}, tok("mem")));
    const id = memBox.find((m: any) => m.excerpt.includes("MENTIONC-1")).id;
    expect((await s.call("mutation", "mentions:markRead", { ids: [id] }, tok("rdr"))).ok).toBe(false);
    must(await s.call("mutation", "mentions:markRead", { ids: [id] }, tok("mem")));
    expect(must(await s.call("query", "mentions:inbox", {}, tok("mem"))).find((m: any) => m.id === id).read).toBe(true);
    // tmp is mentioned in S_sens, then removed from the space: the mention disappears.
    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp, role: "reader" }, tok("mgr")));
    must(await s.call("mutation", "tasks:comment", { taskId: f.tasks.S_sens, body: "انظر MENTIONC-2", mentions: [f.ids.tmp] }, tok("mgr")));
    expect(must(await s.call("query", "mentions:inbox", {}, tok("tmp"))).some((m: any) => m.excerpt.includes("MENTIONC-2"))).toBe(true);
    must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp }, tok("mgr")));
    expect(JSON.stringify(must(await s.call("query", "mentions:inbox", {}, tok("tmp"))))).not.toContain("MENTIONC-2");
  });

  for (const sp of SPACES) {
    for (const a of ACTORS) {
      const allowed = expectedAllowed(a, sp, "taskComment");
      test(`mentions:people on the task of ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        check(await s.call("query", "mentions:people", { taskId: f.tasks[sp] }, tok(a)), allowed);
      });
    }
  }
  for (const a of ACTORS) {
    test(`mentions:inbox / unreadCount / markRead (own) | ${a} → ${ACTIVE(a) ? "allowed" : "denied"}`, async () => {
      check(await s.call("query", "mentions:inbox", {}, tok(a)), ACTIVE(a));
      check(await s.call("query", "mentions:unreadCount", {}, tok(a)), ACTIVE(a));
      check(await s.call("mutation", "mentions:markRead", {}, tok(a)), ACTIVE(a));
    });
  }
});

// ---------------------------------------------------------------- @people in a space chat

describe("@person in a shared space's chat tells them this one message; the chat stays private", () => {
  const inbox = async (who: string) => must(await s.call("query", "mentions:inbox", {}, tok(who))) as any[];
  const bell = async (who: string) => must(await s.call("query", "notifications:list", {}, tok(who))) as any[];

  test("mentions:suggest lists the space's named members in its chat (not me, not outsiders); none outside a shared space", async () => {
    const r = must(await s.call("query", "mentions:suggest", { spaceId: f.spaces.S_plain, q: "" }, tok("mem")));
    const ids = r.people.map((p: any) => p.id);
    expect(ids).toContain(f.ids.mgr);
    expect(ids).toContain(f.ids.rdr);
    for (const x of ["mem", "out", "admin", "pend", "dis"]) expect(ids).not.toContain(f.ids[x]);
    expect(r.people.every((p: any) => p.kind === "person")).toBe(true);
    // Narrowed by the query.
    expect(must(await s.call("query", "mentions:suggest", { spaceId: f.spaces.S_plain, q: "rdr" }, tok("mem"))).people.map((p: any) => p.id)).toEqual([f.ids.rdr]);
    // No people in a general chat, in my personal space, or for an "everyone" reader of S_every.
    expect(must(await s.call("query", "mentions:suggest", { q: "" }, tok("mem"))).people).toEqual([]);
    expect(must(await s.call("query", "mentions:suggest", { spaceId: f.spaces.P_mem, q: "" }, tok("mem"))).people).toEqual([]);
    expect(must(await s.call("query", "mentions:suggest", { spaceId: f.spaces.S_every, q: "" }, tok("out"))).people).toEqual([]);
  });

  test("in a private space chat each named member gets a notification and a «الإشارات» row with that message only; the assistant still answers", async () => {
    const t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    const text = "أعمل الآن على مقارنة عروض الموردين CHATMENTION-1";
    must(await s.call("mutation", "chat:send", { threadId: t, text, people: [f.ids.mgr, f.ids.rdr, f.ids.out, f.ids.admin, f.ids.dis, f.ids.mem, "nope"] }, tok("mem")));
    const answered = await waitAnswers(tok("mem")!, t, 1);
    const answer = answered.messages.filter((x: any) => x.role === "assistant").at(-1).text as string;
    for (const who of ["mgr", "rdr"]) {
      const row = (await inbox(who)).find((x: any) => x.excerpt.includes("CHATMENTION-1"));
      expect(row).toMatchObject({ source: "chat", taskId: null, threadId: null, spaceId: f.spaces.S_plain, spaceName: "لجنة-المشتريات-QX71", by: "موظف mem", excerpt: text, read: false });
      const note = (await bell(who)).find((n: any) => n.kind === "chat.mention" && n.body?.includes("CHATMENTION-1"));
      expect(note).toMatchObject({ spaceId: f.spaces.S_plain, threadId: null, taskId: null });
      // Nothing that reaches them carries the thread or the answer.
      const seen = JSON.stringify([await inbox(who), await bell(who)]);
      expect(seen).not.toContain(t);
      if (answer) expect(seen).not.toContain(answer);
      expect((await s.call("query", "chat:messages", { threadId: t }, tok(who))).ok).toBe(false);
    }
    // Outsiders, the workspace admin, a disabled account, me: nothing (and no error at send).
    for (const who of ["out", "admin", "mem"]) {
      expect(JSON.stringify(await inbox(who))).not.toContain("CHATMENTION-1");
      expect(JSON.stringify(await bell(who))).not.toContain("CHATMENTION-1");
    }
  }, 30_000);

  test("outside a shared space's chat, @person does nothing; losing access to the space hides the row and the notification", async () => {
    const general = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    must(await s.call("mutation", "chat:send", { threadId: general, text: "CHATMENTION-2", people: [f.ids.mgr] }, tok("mem")));
    const personal = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.P_mem }, tok("mem")));
    must(await s.call("mutation", "chat:send", { threadId: personal, text: "CHATMENTION-3", people: [f.ids.mgr] }, tok("mem")));
    expect(JSON.stringify(await inbox("mgr"))).not.toMatch(/CHATMENTION-[23]/);
    expect(JSON.stringify(await bell("mgr"))).not.toMatch(/CHATMENTION-[23]/);

    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp, role: "reader" }, tok("mgr")));
    const t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_sens, shared: false }, tok("mem")));
    must(await s.call("mutation", "chat:send", { threadId: t, text: "CHATMENTION-4", people: [f.ids.tmp] }, tok("mem")));
    expect((await inbox("tmp")).some((x: any) => x.excerpt === "CHATMENTION-4")).toBe(true);
    expect((await bell("tmp")).some((n: any) => n.kind === "chat.mention" && n.body === "CHATMENTION-4")).toBe(true);
    must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp }, tok("mgr")));
    expect(JSON.stringify(await inbox("tmp"))).not.toContain("CHATMENTION-4");
    expect(JSON.stringify(await bell("tmp"))).not.toContain("CHATMENTION-4");
    expect(must(await s.call("query", "mentions:unreadCount", {}, tok("tmp")))).toBe(0);
    // Too many people in one message is refused before anything is sent.
    const t2 = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    expect((await s.call("mutation", "chat:send", { threadId: t2, text: "x", people: Array.from({ length: 21 }, () => f.ids.mgr) }, tok("mem"))).ok).toBe(false);
  }, 30_000);

  test("in a shared chat the mention opens the chat itself, while the reader can read it; made private, it falls back to the space", async () => {
    const t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: true }, tok("mem")));
    // A message to colleagues (plans/16): no answer from the assistant, so nothing to wait for.
    must(await s.call("mutation", "chat:send", { threadId: t, text: "تابعوا هنا CHATMENTION-S1", people: [f.ids.mgr, f.ids.rdr, f.ids.out] }, tok("mem")));
    for (const who of ["mgr", "rdr"]) {
      const row = (await inbox(who)).find((x: any) => x.excerpt.includes("CHATMENTION-S1"));
      expect(row).toMatchObject({ source: "chat", threadId: t, spaceId: f.spaces.S_plain });
      expect(typeof row.threadTitle).toBe("string");
      expect((await bell(who)).find((n: any) => n.kind === "chat.mention" && n.body?.includes("CHATMENTION-S1"))).toMatchObject({ threadId: t, spaceId: f.spaces.S_plain });
      check(await s.call("query", "chat:messages", { threadId: t }, tok(who)), true); // the link works for them
    }
    expect(JSON.stringify(await inbox("out"))).not.toContain("CHATMENTION-S1");
    // The owner makes it private: the row stays (that message only) and opens the space; the notification goes.
    must(await s.call("mutation", "chat:setShared", { threadId: t, shared: false }, tok("mem")));
    for (const who of ["mgr", "rdr"]) {
      const row = (await inbox(who)).find((x: any) => x.excerpt.includes("CHATMENTION-S1"));
      expect(row).toMatchObject({ threadId: null, threadTitle: null, spaceId: f.spaces.S_plain });
      expect(JSON.stringify(await inbox(who))).not.toContain(t);
      expect(JSON.stringify(await bell(who))).not.toContain("CHATMENTION-S1");
    }
  }, 30_000);

  // Per actor, in mem's shared chat of S_plain: only those who may ask there can mention; the
  // recipient's row links the chat.
  for (const a of ACTORS) {
    const asks = a === "mgr" || a === "mem";
    test(`chat:send with @person in a shared chat | ${a} → ${asks ? "delivered, linked" : "denied"}`, async () => {
      const t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: true }, tok("mem")));
      const marker = `CHATMENTION-SM-${a}`;
      const target = a === "rdr" ? "mgr" : "rdr";
      check(await s.call("mutation", "chat:send", { threadId: t, text: marker, people: [f.ids[target]] }, tok(a)), asks);
      const row = (await inbox(target)).find((x: any) => x.excerpt === marker);
      if (asks) expect(row).toMatchObject({ threadId: t });
      else expect(row).toBeUndefined();
    }, 20_000);
  }

  // Per actor × space: the sender must be a named member who can read the space; the recipient
  // (rdr, or mgr when rdr is the sender) gets the row only then.
  for (const sp of SPACES) {
    for (const a of ACTORS) {
      const role = expectedAllowed(a, sp, "taskView"); // named member of a shared space
      test(`chat:send with @person in a chat of ${sp} | ${a} → ${role ? "delivered" : "nothing"}`, async () => {
        const marker = `CHATMENTION-M-${sp}-${a}`;
        const target = a === "rdr" ? "mgr" : "rdr";
        const created = await s.call("mutation", "chat:createThread", { spaceId: f.spaces[sp], shared: false }, tok(a));
        check(created, expectedAllowed(a, sp, "read"));
        if (created.ok) must(await s.call("mutation", "chat:send", { threadId: created.value, text: marker, people: [f.ids[target]] }, tok(a)));
        expect((await inbox(target)).some((x: any) => x.excerpt === marker)).toBe(role);
      }, 20_000);
    }
  }
});

// ---------------------------------------------------------------- scheduled tasks

const daily = { kind: "daily", time: "08:00" };
const FAR = () => Date.now() + 3 * 86_400_000;

describe("scheduled tasks", () => {
  test("runs as its creator with their permissions, lands in their thread, notifies them, is audited", async () => {
    const id = must(await s.call("mutation", "schedules:create", { title: "ملخص المشتريات", prompt: "لخّص CONTENT-S_plain CONTENT-S_sens SCHEDQ-1", spaceId: f.spaces.S_plain, recurrence: daily }, tok("mem")));
    const list = must(await s.call("query", "schedules:mine", {}, tok("mem")));
    const sch = list.find((x: any) => x._id === id);
    expect(sch.nextRunAt).toBeGreaterThan(Date.now());
    expect(sch.spaceName).toBe("لجنة-المشتريات-QX71");
    expect(must(await s.adminRun("schedules:tick", { now: FAR() }))).toBeGreaterThanOrEqual(1);
    const r = await waitAnswers(tok("mem")!, sch.threadId, 1);
    const ans = r.messages.at(-1);
    expect(ans.citations.length).toBeGreaterThan(0);
    expect(ans.citations.every((c: any) => c.fileId === f.files.S_plain)).toBe(true);
    expect(r.scheduled).toBe(true);
    // Results thread is mem's only.
    expect((await s.call("query", "chat:messages", { threadId: sch.threadId }, tok("mgr"))).ok).toBe(false);
    let notes: any[] = [];
    for (let i = 0; i < 50 && !notes.some((n) => n.kind === "schedule.result"); i++) {
      notes = must(await s.call("query", "notifications:list", {}, tok("mem")));
      await Bun.sleep(40);
    }
    expect(notes.some((n) => n.kind === "schedule.result" && n.threadId === sch.threadId)).toBe(true);
    const after = must(await s.call("query", "schedules:mine", {}, tok("mem"))).find((x: any) => x._id === id);
    expect(after.runs).toBe(1);
    expect(after.nextRunAt).toBeGreaterThan(FAR() - 1000);
    const audit = must(await s.call("query", "audit:list", { limit: 500 }, tok("admin")));
    expect(audit.some((x: any) => x.action === "schedule.run" && x.resourceId === id)).toBe(true);
    must(await s.call("mutation", "schedules:remove", { scheduleId: id }, tok("mem")));
  }, 30_000);

  test("stops when the creator loses access to its space (re-checked on every run)", async () => {
    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp, role: "reader" }, tok("mgr")));
    const id = must(await s.call("mutation", "schedules:create", { title: "حساس", prompt: "CONTENT-S_sens SCHEDQ-2", spaceId: f.spaces.S_sens, recurrence: daily }, tok("tmp")));
    must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp }, tok("mgr")));
    const before = chatRequestsWith(ai, "SCHEDQ-2").length;
    await s.adminRun("schedules:tick", { now: FAR() });
    await Bun.sleep(300);
    const sch = must(await s.call("query", "schedules:mine", {}, tok("tmp"))).find((x: any) => x._id === id);
    expect(sch.enabled).toBe(false);
    expect(sch.runs).toBe(0);
    expect(sch.stoppedReason).toContain("صلاحية");
    expect(sch.spaceName).toBe(null);
    expect(chatRequestsWith(ai, "SCHEDQ-2").length).toBe(before);
    expect(must(await s.call("query", "notifications:list", {}, tok("tmp"))).some((n: any) => n.kind === "schedule.stopped")).toBe(true);
    // Turning it back on checks again: still denied.
    expect((await s.call("mutation", "schedules:setEnabled", { scheduleId: id, enabled: true }, tok("tmp"))).ok).toBe(false);
  }, 30_000);

  test("stops when the creator's account is disabled", async () => {
    // A fresh user, activated, schedules, then gets disabled.
    const u = await s.auth("signUp", "sched-user@onespace.test", "password-123", "مجدول");
    must(await s.call("mutation", "admin:activate", { userId: u.userId }, tok("admin")));
    const id = must(await s.call("mutation", "schedules:create", { title: "عام", prompt: "SCHEDQ-3", recurrence: daily }, u.token));
    must(await s.call("mutation", "admin:disable", { userId: u.userId }, tok("admin")));
    const before = chatRequestsWith(ai, "SCHEDQ-3").length;
    await s.adminRun("schedules:tick", { now: FAR() });
    await Bun.sleep(300);
    expect(chatRequestsWith(ai, "SCHEDQ-3").length).toBe(before);
    const audit = must(await s.call("query", "audit:list", { limit: 500 }, tok("admin")));
    expect(audit.some((x: any) => x.action === "schedule.stopped" && x.resourceId === id)).toBe(true);
  }, 30_000);

  test("write tools in a scheduled run that touch a shared space never execute: they become pending proposals for the creator", async () => {
    const writer = await publishedAgent(s, tok("admin")!, {
      name: "كاتب مجدول",
      allowedTools: ["create_artifact"],
      instructions: `CALL_TOOL create_artifact {"title":"مخرج-مجدول-SCH9","kind":"markdown","content":"نص","spaceId":"${f.spaces.S_plain}"}`,
      maxSteps: 2,
    });
    const id = must(await s.call("mutation", "schedules:create", { title: "تقرير", prompt: "أنشئ تقريراً SCHEDQ-4", agentId: writer, recurrence: { kind: "weekly", time: "07:30", weekday: 0 } }, tok("mem")));
    const { threadId, error } = must(await s.call("mutation", "schedules:runNow", { scheduleId: id }, tok("mem")));
    expect(error).toBe(null);
    const r = await waitAnswers(tok("mem")!, threadId, 1);
    const proposals = r.messages.flatMap((m: any) => m.proposals ?? []);
    expect(proposals.length).toBe(1);
    expect(proposals[0].state).toBe("pending");
    expect(proposals[0].expiresAt - Date.now()).toBeGreaterThan(20 * 3600_000);
    const arts = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.S_plain }, tok("mem")));
    expect(JSON.stringify(arts)).not.toContain("مخرج-مجدول-SCH9");
    must(await s.call("mutation", "schedules:remove", { scheduleId: id }, tok("mem")));
  }, 30_000);

  test("recurrences are validated (time, weekday, cron, at least 15 minutes apart)", async () => {
    const bad = [{ kind: "daily", time: "25:00" }, { kind: "weekly", time: "08:00", weekday: 9 }, { kind: "monthly", time: "08:00", monthDay: 31 }, { kind: "cron", cron: "* * * * *" }, { kind: "cron", cron: "nonsense" }];
    for (const recurrence of bad) expect((await s.call("mutation", "schedules:create", { title: "x", prompt: "y", recurrence }, tok("mem"))).ok).toBe(false);
    const ok = must(await s.call("mutation", "schedules:create", { title: "x", prompt: "y", recurrence: { kind: "cron", cron: "0 9 * * 0-4" } }, tok("mem")));
    must(await s.call("mutation", "schedules:remove", { scheduleId: ok }, tok("mem")));
  });
});

// ---------------------------------------------------------------- permission matrix for the new public functions

describe("permission matrix: new public functions", () => {
  let memThread: string;
  let memSchedule: string;

  beforeAll(async () => {
    memThread = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem")!, memThread, "سؤال للمصفوفة MATRIXQ");
    memSchedule = must(await s.call("mutation", "schedules:create", { title: "للمصفوفة", prompt: "MATRIXS", recurrence: daily }, tok("mem")));
  }, 30_000);

  for (const sp of SPACES) {
    for (const a of ACTORS) {
      const allowed = expectedAllowed(a, sp, "read");
      test(`chat:spaceThreads / chat:createThread{spaceId} / mentions:suggest{spaceId} / schedules:create{spaceId} on ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        check(await s.call("query", "chat:spaceThreads", { spaceId: f.spaces[sp] }, tok(a)), allowed);
        check(await s.call("mutation", "chat:createThread", { spaceId: f.spaces[sp] }, tok(a)), allowed);
        check(await s.call("query", "mentions:suggest", { spaceId: f.spaces[sp] }, tok(a)), allowed);
        const r = await s.call("mutation", "schedules:create", { title: `m-${sp}`, prompt: "p", spaceId: f.spaces[sp], recurrence: daily }, tok(a));
        check(r, allowed);
        if (r.ok) must(await s.call("mutation", "schedules:remove", { scheduleId: r.value }, tok(a)));
      });
    }
  }

  for (const a of ACTORS) {
    const owner = a === "mem";
    test(`chat:rename / chat:retry on mem's thread | ${a} → ${owner ? "allowed" : "denied"}`, async () => {
      check(await s.call("mutation", "chat:rename", { threadId: memThread, title: "عنوان جديد" }, tok(a)), owner);
      const r = await s.call("mutation", "chat:retry", { threadId: memThread }, tok(a));
      check(r, owner);
      if (r.ok) await waitAnswers(tok("mem")!, memThread, 2);
    }, 30_000);

    test(`schedules:update / setEnabled / runNow / remove on mem's schedule | ${a} → ${owner ? "allowed" : "denied"}`, async () => {
      if (owner) return; // the owner path is exercised above; here: nobody else can touch it
      check(await s.call("mutation", "schedules:update", { scheduleId: memSchedule, title: "x", prompt: "y", recurrence: daily }, tok(a)), false);
      check(await s.call("mutation", "schedules:setEnabled", { scheduleId: memSchedule, enabled: false }, tok(a)), false);
      check(await s.call("mutation", "schedules:runNow", { scheduleId: memSchedule }, tok(a)), false);
      check(await s.call("mutation", "schedules:remove", { scheduleId: memSchedule }, tok(a)), false);
    });

    test(`schedules:mine (only my own) | ${a} → ${ACTIVE(a) ? "allowed" : "denied"}`, async () => {
      const r = await s.call("query", "schedules:mine", {}, tok(a));
      check(r, ACTIVE(a));
      if (r.ok && a !== "mem") expect(r.value.some((x: any) => x._id === memSchedule)).toBe(false);
    });
  }

  test("the owner can update, pause, resume and delete; an unknown id is the same denial", async () => {
    must(await s.call("mutation", "schedules:update", { scheduleId: memSchedule, title: "معدّل", prompt: "MATRIXS2", recurrence: { kind: "monthly", time: "06:00", monthDay: 1 } }, tok("mem")));
    must(await s.call("mutation", "schedules:setEnabled", { scheduleId: memSchedule, enabled: false }, tok("mem")));
    must(await s.call("mutation", "schedules:setEnabled", { scheduleId: memSchedule, enabled: true }, tok("mem")));
    for (const id of ["nope", f.spaces.S_plain]) expect((await s.call("mutation", "schedules:remove", { scheduleId: id }, tok("mem"))).ok).toBe(false);
    must(await s.call("mutation", "schedules:remove", { scheduleId: memSchedule }, tok("mem")));
  });
});

// ---------------------------------------------------------------- long chats

describe("long chats keep their memory", () => {
  test("older messages are folded into a summary that every later turn gets; the verbatim window stays bounded", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    for (let i = 101; i <= 110; i++) {
      await ask(s, tok("mem")!, t, `سؤال رقم ${i} MEMQ-${i}`);
      await Bun.sleep(150); // let the summary land (it's written right after the answer)
    }
    const summaries = ai.requests.filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.response_format ?? "").includes('"decisions"') && JSON.stringify(r.body.messages).includes("MEMQ-101"));
    expect(summaries.length).toBeGreaterThan(0);
    // The last turn's answer request: the oldest questions only via the summary, inside the single system message.
    const req = ai.requests.filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format && JSON.stringify(r.body.messages).includes("MEMQ-110")).at(-1);
    const msgs: any[] = req.body.messages;
    expect(msgs.filter((m) => m.role === "system").length).toBe(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("SUMMARY-OF");
    expect(msgs[0].content).toContain("MEMQ-101");
    const rest = msgs.slice(1);
    expect(JSON.stringify(rest)).not.toContain("MEMQ-101");
    expect(rest.length).toBeLessThanOrEqual(13); // ≤ 12 verbatim + the question
    expect(JSON.stringify(rest)).toContain("MEMQ-109");
  }, 60_000);

  test("a short chat has no summary and sends its whole history", async () => {
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    await ask(s, tok("mem")!, t, "أول SHORTQ-1");
    await ask(s, tok("mem")!, t, "ثاني SHORTQ-2");
    const req = ai.requests.filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format && JSON.stringify(r.body.messages).includes("SHORTQ-2")).at(-1);
    expect(req.body.messages[0].content).not.toContain("ملخص الجزء الأقدم");
    expect(JSON.stringify(req.body.messages)).toContain("SHORTQ-1");
    expect(ai.requests.some((r) => JSON.stringify(r.body?.response_format ?? "").includes('"summary"') && JSON.stringify(r.body.messages).includes("SHORTQ-1"))).toBe(false);
  });
});
