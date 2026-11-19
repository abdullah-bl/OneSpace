// «مهارات المساحة» (plans/09 §2): a member proposes, a manager approves; active skills reach every
// member's chats in that space (the index, use_skill, /name) and nowhere else.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;
const skill = (name: string, mark: string) => ({ name, title: `مهارة ${name}`, description: `حين يُطلب ${mark}`, instructions: `خطوات العمل ${mark}` });

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

async function ask(token: string, text: string, spaceId?: string, skillId?: string) {
  const t = must(await s.call("mutation", "chat:createThread", spaceId ? { spaceId } : {}, token));
  must(await s.call("mutation", "chat:send", { threadId: t, text, ...(skillId ? { skillId } : {}) }, token));
  for (let i = 0; i < 800; i++) {
    const r = must(await s.call("query", "chat:messages", { threadId: t }, token));
    if (!r.turn && r.messages.at(-1)?.role === "assistant") return { threadId: t, messages: r.messages as any[] };
    await Bun.sleep(25);
  }
  throw new Error("no answer");
}
const setInstr = async (instructions: string) => must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions }, tok("mgr")));
const spaceView = async (a: string) => must(await s.call("query", "skills:space", { spaceId: f.spaces.S_plain }, tok(a)));
/** Everything the model was sent for chats whose question carries this mark. */
const sentFor = (mark: string) =>
  ai.requests.filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.messages ?? []).includes(mark)).map((r) => JSON.stringify(r.body.messages));

describe("permissions", () => {
  test("skills:space: named members of a shared space only; never a personal space", async () => {
    for (const a of ACTORS) {
      const r = await s.call("query", "skills:space", { spaceId: f.spaces.S_plain }, tok(a));
      expect(r.ok).toBe(["mgr", "mem", "rdr"].includes(a));
    }
    expect((await s.call("query", "skills:space", { spaceId: f.spaces.P_mem }, tok("mem"))).ok).toBe(false);
    expect((await s.call("query", "skills:forChat", {}, tok("anon"))).ok).toBe(false);
  });

  test("adding: a manager's is active, a member's is proposed, a reader or outsider can't", async () => {
    for (const a of ACTORS) {
      const r = await s.call("mutation", "skills:addSpace", { spaceId: f.spaces.S_plain, ...skill(`perm-${a}`, `PERM-${a}`) }, tok(a));
      expect(r.ok).toBe(["mgr", "mem"].includes(a));
      if (r.ok) expect(r.value.state).toBe(a === "mgr" ? "active" : "proposed");
    }
  });

  test("approve, edit, delete: managers; a member only withdraws or edits their own proposal", async () => {
    const p = must(await s.call("mutation", "skills:addSpace", { spaceId: f.spaces.S_plain, ...skill("rev-1", "REV-1") }, tok("mem")));
    for (const a of ACTORS) if (a !== "mgr") expect((await s.call("mutation", "skills:reviewSpace", { skillId: p.id, approve: true }, tok(a))).ok).toBe(false);
    expect((await s.call("mutation", "skills:updateSpace", { skillId: p.id, ...skill("rev-1", "REV-1b") }, tok("mem"))).ok).toBe(true);
    must(await s.call("mutation", "skills:reviewSpace", { skillId: p.id, approve: true }, tok("mgr")));
    // Active now: the member can't change or remove it any more.
    expect((await s.call("mutation", "skills:updateSpace", { skillId: p.id, ...skill("rev-1", "REV-1c") }, tok("mem"))).ok).toBe(false);
    expect((await s.call("mutation", "skills:removeSpace", { skillId: p.id }, tok("mem"))).ok).toBe(false);
    must(await s.call("mutation", "skills:updateSpace", { skillId: p.id, ...skill("rev-1", "REV-1d") }, tok("mgr")));
    const row = (await spaceView("rdr")).skills.find((x: any) => x._id === p.id);
    expect(row.version).toBe(2);
    expect(row.instructions).toContain("REV-1d");
    for (const a of ACTORS) if (a !== "mgr") expect((await s.call("mutation", "skills:removeSpace", { skillId: p.id }, tok(a))).ok).toBe(false);
    must(await s.call("mutation", "skills:removeSpace", { skillId: p.id }, tok("mgr")));
  });

  test("a proposal is seen by managers and its author only; a space skill is not in «مهاراتي»", async () => {
    const p = must(await s.call("mutation", "skills:addSpace", { spaceId: f.spaces.S_plain, ...skill("seen-1", "SEEN-1") }, tok("mem")));
    expect((await spaceView("mgr")).proposals.map((x: any) => x._id)).toContain(p.id);
    expect((await spaceView("mem")).proposals.map((x: any) => x._id)).toContain(p.id);
    expect((await spaceView("rdr")).proposals.map((x: any) => x._id)).not.toContain(p.id);
    expect(JSON.stringify(must(await s.call("query", "skills:list", {}, tok("mem"))))).not.toContain("SEEN-1");
  });

  test("«شارك مع المساحة»: only my own skill, copied as a proposal", async () => {
    const mine = must(await s.call("mutation", "skills:create", skill("share-1", "SHARE-1"), tok("mem")));
    for (const a of ACTORS) if (a !== "mem") expect((await s.call("mutation", "skills:shareToSpace", { skillId: mine, spaceId: f.spaces.S_plain }, tok(a))).ok).toBe(false);
    const r = must(await s.call("mutation", "skills:shareToSpace", { skillId: mine, spaceId: f.spaces.S_plain }, tok("mem")));
    expect(r.state).toBe("proposed");
    expect((await s.call("mutation", "skills:shareToSpace", { skillId: mine, spaceId: f.spaces.P_mem }, tok("mem"))).ok).toBe(false);
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).map((x: any) => x.name)).toContain("share-1");
  });
});

describe("in the chat", () => {
  test("an approved skill is in the index of the space's chats only, and use_skill loads it", async () => {
    const p = must(await s.call("mutation", "skills:addSpace", { spaceId: f.spaces.S_plain, ...skill("idx-1", "IDX-1") }, tok("mem")));
    await ask(tok("rdr")!, "سؤال قبل الاعتماد IQ-0", f.spaces.S_plain);
    expect(sentFor("IQ-0").join()).not.toContain("/idx-1"); // proposed: never shown to the model
    must(await s.call("mutation", "skills:reviewSpace", { skillId: p.id, approve: true }, tok("mgr")));
    await ask(tok("rdr")!, "سؤال IQ-1", f.spaces.S_plain);
    expect(sentFor("IQ-1").join()).toContain("/idx-1");
    // Outside the space (my personal space), the same person doesn't get it.
    await ask(tok("rdr")!, "سؤال IQ-2");
    expect(sentFor("IQ-2").join()).not.toContain("/idx-1");

    await setInstr('CALL_TOOL use_skill {"name":"idx-1"}');
    try {
      await ask(tok("rdr")!, "طبّق الطريقة IQ-3", f.spaces.S_plain);
      expect(sentFor("IQ-3").join()).toContain("خطوات العمل IDX-1");
    } finally {
      await setInstr("");
    }
    expect((await spaceView("rdr")).skills.find((x: any) => x._id === p.id).uses).toBeGreaterThan(0);
  });

  test("/name: a space skill works in that space's chat, not elsewhere", async () => {
    const id = must(await s.call("mutation", "skills:addSpace", { spaceId: f.spaces.S_plain, ...skill("slash-1", "SLASH-1") }, tok("mgr"))).id;
    expect(must(await s.call("query", "skills:forChat", { spaceId: f.spaces.S_plain }, tok("mem"))).map((x: any) => x.name)).toContain("slash-1");
    expect(must(await s.call("query", "skills:forChat", {}, tok("mem"))).map((x: any) => x.name)).not.toContain("slash-1");
    await ask(tok("mem")!, "/slash-1 SQ-1", f.spaces.S_plain, id);
    expect(sentFor("SQ-1").join()).toContain("خطوات العمل SLASH-1");
    // In a chat outside the space it answers like a missing skill.
    const t = must(await s.call("mutation", "chat:createThread", {}, tok("mem")));
    expect((await s.call("mutation", "chat:send", { threadId: t, text: "/slash-1 SQ-2", skillId: id }, tok("mem"))).ok).toBe(false);
    // An outsider can't use it in their own chat either.
    const t2 = must(await s.call("mutation", "chat:createThread", {}, tok("out")));
    expect((await s.call("mutation", "chat:send", { threadId: t2, text: "/slash-1", skillId: id }, tok("out"))).ok).toBe(false);
  });

  test("create_skill for the space: a card first; a member's then waits for a manager", async () => {
    await setInstr('CALL_TOOL create_skill {"name":"from-chat-1","description":"للمفاضلة","instructions":"رتّب المتقدمين CHAT-1","scope":"space"}');
    try {
      const r = await ask(tok("mem")!, "احفظها مهارة للمساحة CQ-1", f.spaces.S_plain);
      const p = r.messages.flatMap((m) => m.proposals ?? []).find((x: any) => x.tool === "create_skill");
      expect(p?.state).toBe("pending");
      must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, tok("mem")));
      const v = await spaceView("mgr");
      expect(v.skills.map((x: any) => x.name)).not.toContain("from-chat-1");
      expect(v.proposals.map((x: any) => x.name)).toContain("from-chat-1");
    } finally {
      await setInstr("");
    }
  });
});
