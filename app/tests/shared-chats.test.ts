// Shared space chats (plans/14): a chat in a shared space that its members read and ask in.
// Access follows the space (read → read the chat, write → ask), nothing personal of the asker
// goes in (their memory, records, files outside the space), and only the owner or a space
// manager changes who sees it. Model: the deterministic fake (fake-ai.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, FILE_NAMES, SPACES, type ActorKey, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { ask, waitIngest } from "./rag-helpers";
import { chatRequestsWith, systemOf } from "./agents-helpers";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
  for (const sp of SPACES) await waitIngest(s, sp === "P_mem" ? tok("mem")! : tok("mgr")!, f.spaces[sp], f.files[sp]);
}, 90_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

const listed = async (a: string, sp: string, threadId: string) => {
  const r = await s.call("query", "chat:spaceThreads", { spaceId: sp }, tok(a));
  return r.ok ? r.value.find((x: any) => x.threadId === threadId) : undefined;
};

describe("shared space chats", () => {
  let t: string;

  test("a new chat in a shared space is shared by default; members and readers see it, others don't", async () => {
    t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    const own = await listed("mem", f.spaces.S_plain, t);
    expect(own).toMatchObject({ shared: true, mine: true });
    expect(await listed("mgr", f.spaces.S_plain, t)).toMatchObject({ shared: true, mine: false, ownerName: "موظف mem" });
    expect(await listed("rdr", f.spaces.S_plain, t)).toMatchObject({ shared: true, mine: false });
    for (const a of ["out", "admin", "dis", "pend", "anon"]) expect(await listed(a, f.spaces.S_plain, t)).toBeUndefined();
    for (const a of ["mgr", "rdr"]) expect((await s.call("query", "chat:messages", { threadId: t }, tok(a))).ok).toBe(true);
    for (const a of ["out", "admin", "dis", "pend", "anon"]) expect((await s.call("query", "chat:messages", { threadId: t }, tok(a))).ok).toBe(false);
  });

  test("a private chat in a shared space, and any chat in a personal space, stay with their owner", async () => {
    const p = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    expect(await listed("mem", f.spaces.S_plain, p)).toMatchObject({ shared: false });
    expect(await listed("mgr", f.spaces.S_plain, p)).toBeUndefined();
    expect((await s.call("query", "chat:messages", { threadId: p }, tok("mgr"))).ok).toBe(false);
    const mine = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.P_mem }, tok("mem")));
    expect(must(await s.call("query", "chat:messages", { threadId: mine }, tok("mem"))).shared).toBe(false);
    // One personal chat: a chat asked for in my own space is the general chat (no space of its own).
    expect(must(await s.call("query", "chat:messages", { threadId: mine }, tok("mem")))).toMatchObject({ spaceId: null, scope: { kind: "all" } });
    // A reader can't start a shared chat (they can't ask in one).
    const r = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("rdr")));
    expect(must(await s.call("query", "chat:messages", { threadId: r }, tok("rdr"))).shared).toBe(false);
  });

  test("members ask in it as themselves; each question shows who asked; readers only read", async () => {
    await ask(s, tok("mem")!, t, "ما محتوى CONTENT-S_plain؟ SHQ-1");
    const a = await ask(s, tok("mgr")!, t, "وما الجديد؟ SHQ-2");
    const users = a.raw.messages.filter((m: any) => m.role === "user");
    expect(users.map((m: any) => m.author)).toEqual(["موظف mem", "موظف mgr"]);
    expect(users.map((m: any) => m.mine)).toEqual([false, true]);
    // The model is told it is a shared chat and who asks; earlier questions carry their asker.
    const req = chatRequestsWith(ai, "SHQ-2").at(-1);
    expect(systemOf(req)).toContain("محادثة مشتركة");
    expect(systemOf(req)).toContain("السؤال الحالي من موظف mgr");
    expect(JSON.stringify(req.body.messages)).toContain("[موظف mem]: ");
    // The reader reads, but can't ask, retry or stop.
    const view = must(await s.call("query", "chat:messages", { threadId: t }, tok("rdr")));
    expect(view).toMatchObject({ shared: true, canWrite: false, isOwner: false, canManage: false });
    expect((await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "سؤال" }, tok("rdr"))).ok).toBe(false);
    expect((await s.call("mutation", "chat:retry", { threadId: t }, tok("rdr"))).ok).toBe(false);
    expect((await s.call("mutation", "chat:stop", { threadId: t }, tok("rdr"))).ok).toBe(false);
    // Owner-only settings stay with the owner.
    for (const [fn, args] of [["chat:rename", { threadId: t, title: "x" }], ["chat:setPinned", { threadId: t, pinned: true }], ["chat:setNoMemory", { threadId: t, on: true }]] as const)
      expect((await s.call("mutation", fn, args, tok("mgr"))).ok).toBe(false);
  }, 40_000);

  test("nothing from outside the space: no @mentions of other spaces, no personal memory", async () => {
    const bad = await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "قارن", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem"));
    expect(bad.ok).toBe(false);
    expect((await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "قارن", mentions: [{ kind: "space", id: f.spaces.S_every }] }, tok("mem"))).ok).toBe(false);
    must(await s.call("mutation", "memory:add", { text: "يفضّل الإجابات المختصرة SHMEM-9", kind: "preference" }, tok("mem")));
    await ask(s, tok("mem")!, t, "سؤال في المشتركة SHQ-3");
    for (const r of chatRequestsWith(ai, "SHQ-3")) {
      expect(JSON.stringify(r.body)).not.toContain("SHMEM-9");
      expect(JSON.stringify(r.body)).not.toContain(FILE_NAMES.P_mem);
      expect((r.body.tools ?? []).map((x: any) => x.function?.name)).not.toContain("my_records");
    }
    // The same person in a private chat of the same space: their memory is there.
    const p = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    await ask(s, tok("mem")!, p, "سؤال في الخاصة SHQ-4");
    expect(JSON.stringify(chatRequestsWith(ai, "SHQ-4").at(-1).body)).toContain("SHMEM-9");
  }, 40_000);

  test("sharing an existing chat: only its owner, only with nothing from outside the space", async () => {
    const p = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    expect((await s.call("mutation", "chat:setShared", { threadId: p, shared: true }, tok("mgr"))).ok).toBe(false);
    must(await s.call("mutation", "chat:setShared", { threadId: p, shared: true }, tok("mem")));
    expect(await listed("mgr", f.spaces.S_plain, p)).toMatchObject({ shared: true });
    // A private chat that pointed at a personal file can't be shared: the members would see its name.
    const q = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: q, text: "SHQ-5", mentions: [{ kind: "file", id: f.files.P_mem }] }, tok("mem")));
    expect((await s.call("mutation", "chat:setShared", { threadId: q, shared: true }, tok("mem"))).ok).toBe(false);
    // Free-form and personal-space chats can't be shared.
    const free = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    expect((await s.call("mutation", "chat:setShared", { threadId: free, shared: true }, tok("mem"))).ok).toBe(false);
    const pers = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.P_mem }, tok("mem")));
    expect((await s.call("mutation", "chat:setShared", { threadId: pers, shared: true }, tok("mem"))).ok).toBe(false);
  }, 30_000);

  test("permission matrix: chat:setShared (make a colleague's shared chat private) | owner or space manager", async () => {
    const expected: Record<ActorKey, boolean> = { admin: false, mgr: true, mem: true, rdr: false, out: false, pend: false, dis: false, anon: false };
    for (const a of ACTORS) {
      const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
      const r: Result = await s.call("mutation", "chat:setShared", { threadId: c, shared: false }, tok(a));
      expect([a, r.ok]).toEqual([a, expected[a]]);
    }
  }, 30_000);

  test("making it private or deleting it: the owner or a space manager; then the members lose it", async () => {
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    for (const a of ["rdr", "out", "admin"]) expect((await s.call("mutation", "chat:deleteThread", { threadId: c }, tok(a))).ok).toBe(false);
    must(await s.call("mutation", "chat:setShared", { threadId: c, shared: false }, tok("mgr")));
    expect((await s.call("query", "chat:messages", { threadId: c }, tok("mgr"))).ok).toBe(false);
    expect((await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).ok).toBe(true);
    must(await s.call("mutation", "chat:setShared", { threadId: c, shared: true }, tok("mem")));
    must(await s.call("mutation", "chat:deleteThread", { threadId: c }, tok("mgr")));
    expect((await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).ok).toBe(false);
  }, 30_000);

  test("a shared chat I asked in joins my chat list; one I only read doesn't", async () => {
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_every }, tok("mem")));
    await ask(s, tok("mem")!, c, "سؤال أول JOINQ-1");
    const mineList = async (a: string) => must(await s.call("query", "chat:threads", {}, tok(a))).find((x: any) => x.threadId === c);
    expect(await mineList("mgr")).toBeUndefined();
    await ask(s, tok("mgr")!, c, "سؤال من المدير JOINQ-2");
    expect(await mineList("mgr")).toMatchObject({ shared: true, mine: false, ownerName: "موظف mem", spaceName: expect.any(String) });
    expect(await mineList("mem")).toMatchObject({ shared: true, mine: true });
    expect(await mineList("rdr")).toBeUndefined();
    // Made private: it leaves mgr's list.
    must(await s.call("mutation", "chat:setShared", { threadId: c, shared: false }, tok("mem")));
    expect(await mineList("mgr")).toBeUndefined();
  }, 40_000);

  test("asking in a shared chat notifies its followers (owner and askers), once an hour, never the asker or mere readers", async () => {
    const notes = async (a: string, c: string) => must(await s.call("query", "notifications:list", {}, tok(a))).filter((n: any) => n.threadId === c && n.kind === "chat.shared");
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    await ask(s, tok("mem")!, c, "NOTIFYQ-1");
    expect(await notes("mem", c)).toEqual([]); // nobody else follows yet
    await ask(s, tok("mgr")!, c, "NOTIFYQ-2 سؤال المدير");
    const forMem = await notes("mem", c);
    expect(forMem.length).toBe(1);
    expect(forMem[0].title).toContain("موظف mgr");
    expect(forMem[0].body).toContain("NOTIFYQ-2");
    expect(await notes("mgr", c)).toEqual([]);
    expect(await notes("rdr", c)).toEqual([]); // a reader who never asked isn't following
    await ask(s, tok("mgr")!, c, "NOTIFYQ-3");
    expect((await notes("mem", c)).length).toBe(1); // within the hour: no second notice
    await ask(s, tok("mem")!, c, "NOTIFYQ-4");
    expect((await notes("mgr", c)).length).toBe(1); // mgr asked here, so mgr follows
    // Made private, the colleague's notice disappears from their feed.
    must(await s.call("mutation", "chat:setShared", { threadId: c, shared: false }, tok("mem")));
    expect(await notes("mgr", c)).toEqual([]);
  }, 60_000);

  test("leaving the space ends access to its shared chats, the owner's own included", async () => {
    must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp, role: "member" }, tok("mgr")));
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_sens }, tok("tmp")));
    expect(must(await s.call("query", "chat:messages", { threadId: c }, tok("tmp"))).shared).toBe(true);
    must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_sens, userId: f.ids.tmp }, tok("mgr")));
    expect((await s.call("query", "chat:messages", { threadId: c }, tok("tmp"))).ok).toBe(false);
    expect((await s.call("mutation", "chat:send", { to: "assistant", threadId: c, text: "x" }, tok("tmp"))).ok).toBe(false);
    expect((await s.call("query", "chat:messages", { threadId: c }, tok("mgr"))).ok).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------- plans/16: messages to colleagues

describe("messages to colleagues and handing them to the assistant", () => {
  const chatReqs = (mark: string) => ai.requests.filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format && JSON.stringify(r.body.messages ?? []).includes(mark));
  const bell = async (a: string) => must(await s.call("query", "notifications:list", {}, tok(a))) as any[];
  const teamOf = async (a: string, t: string, mark: string) => must(await s.call("query", "chat:messages", { threadId: t }, tok(a))).messages.find((m: any) => m.text.includes(mark));
  let t: string;
  let msgId: string;

  test("@person in a shared chat goes to them: no answer from the assistant, they're notified, everyone sees who it's for", async () => {
    t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    const r = must(await s.call("mutation", "chat:send", { threadId: t, text: "خلّص مقارنة العروض TEAMQ-1", people: [f.ids.mgr, f.ids.rdr, f.ids.out] }, tok("mem")));
    expect(r).toBeNull();
    await Bun.sleep(300);
    expect(chatReqs("TEAMQ-1").length).toBe(0);
    const m = await teamOf("rdr", t, "TEAMQ-1");
    msgId = m.id;
    expect(m.author).toBe("موظف mem");
    // Only people who can read the chat are recipients (out can't).
    expect(m.team.to.map((x: any) => [x.name, x.state])).toEqual([["موظف mgr", "pending"], ["موظف rdr", "pending"]]);
    expect((await teamOf("mgr", t, "TEAMQ-1")).team.to.find((x: any) => x.mine).name).toBe("موظف mgr");
    expect((await bell("mgr")).some((n: any) => n.kind === "chat.mention" && n.threadId === t)).toBe(true);
    // The writer can still ask the assistant too, in the same message.
    const turn = must(await s.call("mutation", "chat:send", { threadId: t, text: "ولخّص لنا العروض TEAMQ-2", people: [f.ids.mgr], to: "assistant" }, tok("mem")));
    expect(turn).toBeTruthy();
    for (let i = 0; i < 400 && must(await s.call("query", "chat:messages", { threadId: t }, tok("mem"))).turn; i++) await Bun.sleep(25);
    expect(chatReqs("TEAMQ-2").length).toBeGreaterThan(0);
    await ask(s, tok("mem")!, t, "سؤال بعدها TEAMQ-3");
    // The assistant sees the message between colleagues marked as such, not as a question.
    expect(JSON.stringify(chatReqs("TEAMQ-3").at(-1)!.body.messages)).toContain("رسالة بين الزملاء وليست سؤالاً لك");
  }, 60_000);

  test("only a person it names acts on it; handing it to the assistant needs to be able to ask in the chat", async () => {
    for (const a of ["mem", "out", "admin", "anon"]) expect((await s.call("mutation", "chat:handoff", { messageId: msgId, action: "self" }, tok(a))).ok).toBe(false);
    // rdr is named but only reads the space: can take it or close it, not hand it to the assistant.
    expect((await s.call("mutation", "chat:handoff", { messageId: msgId, action: "assistant" }, tok("rdr"))).ok).toBe(false);
    must(await s.call("mutation", "chat:handoff", { messageId: msgId, action: "self" }, tok("rdr")));
    expect((await teamOf("mem", t, "TEAMQ-1")).team.to.find((x: any) => x.name === "موظف rdr").state).toBe("self");
    expect((await bell("mem")).some((n: any) => n.kind === "chat.handoff" && n.title.includes("موظف rdr تولّى طلبك"))).toBe(true);
    expect((await s.call("mutation", "chat:handoff", { messageId: "nope", action: "self" }, tok("mgr"))).ok).toBe(false);
  });

  test("handed to the assistant: it works as that person, the answer is in the chat for everyone, and the author is told", async () => {
    must(await s.call("mutation", "chat:handoff", { messageId: msgId, action: "assistant" }, tok("mgr")));
    for (let i = 0; i < 400; i++) {
      const v = must(await s.call("query", "chat:messages", { threadId: t }, tok("rdr")));
      if (!v.turn && v.messages.at(-1)?.role === "assistant" && v.messages.some((m: any) => m.handoffOf === msgId)) break;
      await Bun.sleep(25);
    }
    const view = must(await s.call("query", "chat:messages", { threadId: t }, tok("rdr")));
    const line = view.messages.find((m: any) => m.handoffOf === msgId);
    expect(line.author).toBe("موظف mgr");
    expect(view.messages.at(-1).role).toBe("assistant");
    // The turn ran as mgr: the model was told the current question is from mgr.
    const req = chatReqs("طلب موظف mem مني").at(-1)!;
    expect(JSON.stringify(req.body.messages)).toContain("السؤال الحالي من موظف mgr");
    expect((await teamOf("mem", t, "TEAMQ-1")).team.to.find((x: any) => x.name === "موظف mgr").state).toBe("assistant");
    expect((await s.call("mutation", "chat:handoff", { messageId: msgId, action: "assistant" }, tok("mgr"))).ok).toBe(false);
    const notes = await bell("mem");
    expect(notes.some((n: any) => n.kind === "chat.handoff" && n.title.includes("سلّم طلبك للمساعد"))).toBe(true);
    expect(notes.some((n: any) => n.kind === "chat.handoff" && n.title.includes("أنجز المساعد طلبك الذي سلّمه موظف mgr"))).toBe(true);
    must(await s.call("mutation", "chat:handoff", { messageId: msgId, action: "done" }, tok("mgr")));
    expect((await teamOf("mem", t, "TEAMQ-1")).team.to.find((x: any) => x.name === "موظف mgr").state).toBe("done");
  }, 60_000);

  test("outside a shared chat @person changes nothing: the assistant answers as before", async () => {
    const p = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    expect(must(await s.call("mutation", "chat:send", { threadId: p, text: "سؤال TEAMQ-9", people: [f.ids.mgr] }, tok("mem")))).toBeTruthy();
  });

  test("an output made in a shared chat lands in the chat's space (a card first), so the members see it", async () => {
    must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: 'CALL_TOOL create_artifact {"title":"مخرج الفريق TEAMOUT-1","kind":"markdown","content":"# جدول"}' }, tok("mgr")));
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    try {
      await ask(s, tok("mem")!, c, "سوّ لنا مخرج TEAMOUT-Q");
    } finally {
      must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "" }, tok("mgr")));
    }
    const view = must(await s.call("query", "chat:messages", { threadId: c }, tok("mem")));
    const p = view.messages.flatMap((m: any) => m.proposals ?? []).find((x: any) => x.tool === "create_artifact");
    // A write the team sees: it waits for «نفّذ», it doesn't run in the asker's personal space.
    expect(p.state).toBe("pending");
    expect(p.auto).toBeFalsy();
    must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, tok("mem")));
    for (const a of ["mgr", "rdr"]) {
      const seen = must(await s.call("query", "chat:messages", { threadId: c }, tok(a))).messages.flatMap((m: any) => m.proposals ?? []).find((x: any) => x.id === p.id);
      expect(seen.state).toBe("executed");
      expect(seen.artifactIds.length).toBe(1);
    }
  }, 60_000);

  test("the assistant answers only when called: a plain message is the team's; each answer says whose request it is", async () => {
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    expect(must(await s.call("mutation", "chat:send", { threadId: c, text: "الاجتماع بكرة TEAMQ-20", to: "team" }, tok("mem")))).toBeNull();
    await Bun.sleep(200);
    expect(chatReqs("TEAMQ-20").length).toBe(0);
    const plain = await teamOf("mgr", c, "TEAMQ-20");
    expect(plain.team.to).toEqual([]);
    // Called: it answers as the caller, and the answer names them.
    must(await s.call("mutation", "chat:send", { threadId: c, text: "لخّص لنا TEAMQ-21", to: "assistant" }, tok("mem")));
    for (let i = 0; i < 400 && must(await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).turn; i++) await Bun.sleep(25);
    const ans = must(await s.call("query", "chat:messages", { threadId: c }, tok("mgr"))).messages.at(-1);
    expect([ans.role, ans.forName, ans.mine]).toEqual(["assistant", "موظف mem", false]);
  }, 60_000);

  test("only the asker retries their answer; a colleague's later message never becomes the question", async () => {
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    must(await s.call("mutation", "chat:send", { threadId: c, text: "سؤال mem RETRYQ-1", to: "assistant" }, tok("mem")));
    for (let i = 0; i < 400 && must(await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).turn; i++) await Bun.sleep(25);
    // mgr can ask in the chat, but retrying mem's question would run it with mgr's permissions.
    const denied = await s.call("mutation", "chat:retry", { threadId: c }, tok("mgr"));
    expect(denied.ok).toBe(false);
    expect(String((denied as any).error)).toContain("سؤالك أنت فقط");
    // A team message after the answer; mem's retry still answers mem's own question.
    must(await s.call("mutation", "chat:send", { threadId: c, text: "ملاحظة للفريق RETRYQ-TEAM", to: "team" }, tok("mgr")));
    const before = chatReqs("RETRYQ-1").length;
    must(await s.call("mutation", "chat:retry", { threadId: c }, tok("mem")));
    for (let i = 0; i < 400 && must(await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).turn; i++) await Bun.sleep(25);
    const req = chatReqs("RETRYQ-1").at(-1)!;
    expect(chatReqs("RETRYQ-1").length).toBeGreaterThan(before);
    const msgs = req.body.messages as any[];
    expect(JSON.stringify(msgs.at(-1))).toContain("RETRYQ-1");
    expect(JSON.stringify(msgs)).not.toContain("RETRYQ-TEAM");
  }, 60_000);

  test("the server decides who a message is for: an old page or a typed «@ai» can't make the assistant answer uncalled", async () => {
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    // No `to` at all (an old page): the team's.
    expect(must(await s.call("mutation", "chat:send", { threadId: c, text: "block him CALLQ-1" }, tok("mem")))).toBeNull();
    // Typed in the text: called.
    expect(must(await s.call("mutation", "chat:send", { threadId: c, text: "@ai لخّص CALLQ-2" }, tok("mem")))).toBeTruthy();
    for (let i = 0; i < 400 && must(await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).turn; i++) await Bun.sleep(25);
    expect(must(await s.call("mutation", "chat:send", { threadId: c, text: "@المساعد، كمّل CALLQ-3" }, tok("mem")))).toBeTruthy();
    for (let i = 0; i < 400 && must(await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).turn; i++) await Bun.sleep(25);
    expect(chatReqs("CALLQ-1").filter((r) => JSON.stringify(r.body.messages.at(-1)).includes("CALLQ-1")).length).toBe(0);
  }, 60_000);
});

describe("calling the assistant (unit)", () => {
  test("«@المساعد», «@مساعد», «@ai», «@assistant» call it; an email or a word inside doesn't", async () => {
    const { callsAssistant } = await import("../onebase/chat");
    for (const t of ["@ai print", "@المساعد لخّص", "لو سمحت @مساعد", "(@AI)", "@assistant, go", "شف هذا @المساعد"]) expect(callsAssistant(t)).toBe(true);
    for (const t of ["mail me at x@ai.com", "@airport", "المساعد لخّص", "@المساعدة", "block him"]) expect(callsAssistant(t)).toBe(false);
  });

  const chatReqs = (mark: string) => ai.requests.filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format && JSON.stringify(r.body.messages ?? []).includes(mark));
  const bell = async (a: string) => must(await s.call("query", "notifications:list", {}, tok(a))) as any[];

  test("asked to tell a colleague, the assistant sends a team message for its caller; «تراجع» withdraws it", async () => {
    must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: 'CALL_TOOL notify_colleague {"people":["موظف mgr"],"message":"راجع المقارنة NOTIFYMSG-1"}' }, tok("mgr")));
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    try {
      await ask(s, tok("mem")!, c, "جهّز المقارنة وخلّ موظف mgr يراجعها NOTIFYQ-1");
    } finally {
      must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "" }, tok("mgr")));
    }
    const view = must(await s.call("query", "chat:messages", { threadId: c }, tok("mgr")));
    const sent = view.messages.find((m: any) => m.text.includes("NOTIFYMSG-1"));
    expect(sent.team).toMatchObject({ viaAssistant: true });
    expect(sent.team.to.map((x: any) => [x.name, x.state, x.mine])).toEqual([["موظف mgr", "pending", true]]);
    expect(sent.author).toBe("موظف mem");
    expect((await bell("mgr")).some((n: any) => n.kind === "chat.mention" && n.threadId === c && n.body.includes("NOTIFYMSG-1"))).toBe(true);
    // It ran at once (asked for), with «تراجع» for mem only; undo hides the message for everyone.
    const p = view.messages.flatMap((m: any) => m.proposals ?? []).find((x: any) => x.tool === "notify_colleague");
    expect([p.state, p.auto]).toEqual(["executed", true]);
    expect((await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mgr"))).ok).toBe(false);
    must(await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mem")));
    for (const a of ["mem", "mgr", "rdr"]) expect(must(await s.call("query", "chat:messages", { threadId: c }, tok(a))).messages.some((m: any) => m.text.includes("NOTIFYMSG-1"))).toBe(false);
  }, 60_000);

  test("not asked to tell anyone, it's a card first; an unknown name is a failed step; a private chat doesn't offer it", async () => {
    must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: 'CALL_TOOL notify_colleague {"people":["موظف mgr"],"message":"NOTIFYMSG-2"}\nCALL_TOOL notify_colleague {"people":["شخص-غير-موجود"],"message":"NOTIFYMSG-3"}' }, tok("mgr")));
    const c = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
    const priv = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain, shared: false }, tok("mem")));
    try {
      await ask(s, tok("mem")!, c, "لخّص العروض NOTIFYQ-2");
      await ask(s, tok("mem")!, priv, "لخّص العروض NOTIFYQ-PRIV");
    } finally {
      must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "" }, tok("mgr")));
    }
    const view = must(await s.call("query", "chat:messages", { threadId: c }, tok("mem")));
    const props = view.messages.flatMap((m: any) => m.proposals ?? []).filter((x: any) => x.tool === "notify_colleague");
    expect(props.map((x: any) => x.state)).toEqual(["pending", "pending"]);
    expect(view.messages.some((m: any) => m.text === "NOTIFYMSG-2")).toBe(false);
    // The unknown name fails when confirmed, and nothing is sent.
    const bad = props.find((x: any) => JSON.stringify(x.args).includes("شخص-غير-موجود"));
    const r = must(await s.call("action", "chat:confirmProposal", { proposalId: bad.id }, tok("mem")));
    expect(r.ok).toBe(false);
    expect(String(r.result)).toContain("لا أحد باسم");
    expect(JSON.stringify(must(await s.call("query", "chat:messages", { threadId: c }, tok("mem"))).messages.map((m: any) => m.text))).not.toContain("NOTIFYMSG-3");
    // A private chat: the tool isn't offered.
    const req = chatReqs("NOTIFYQ-PRIV").at(-1)!;
    expect((req.body.tools ?? []).map((t: any) => t.function.name)).not.toContain("notify_colleague");
    expect((chatReqs("NOTIFYQ-2").at(-1)!.body.tools ?? []).map((t: any) => t.function.name)).toContain("notify_colleague");
  }, 60_000);
});

describe("asking the assistant to tell someone (unit)", () => {
  test("«خلّ محمد…», «أرسلها للمدير», «@محمد» are asks; a plain request isn't", async () => {
    const { asksToNotify } = await import("../onebase/chat");
    for (const t of ["جهّز المقارنة وخلّ محمد يراجعها", "أرسلها للمدير", "بلّغ سارة بالموعد", "@المساعد لخّص و@محمد يعتمد"]) expect(asksToNotify(t)).toBe(true);
    for (const t of ["لخّص العروض", "@المساعد اكتب تقرير", "كم الميزانية؟"]) expect(asksToNotify(t)).toBe(false);
  });
});
