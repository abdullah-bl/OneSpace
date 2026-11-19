// Model usage (usage.ts): every model call is counted per day × model × purpose × employee, and
// only a workspace admin can read the totals. No prompt or answer text is kept.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

async function ask(token: string, text: string) {
  const t = must(await s.call("mutation", "chat:createThread", {}, token));
  must(await s.call("mutation", "chat:send", { threadId: t, text }, token));
  for (let i = 0; i < 800; i++) {
    const r = must(await s.call("query", "chat:messages", { threadId: t }, token));
    if (!r.turn && r.messages.at(-1)?.role === "assistant") return;
    await Bun.sleep(25);
  }
  throw new Error("no answer");
}

describe("usage", () => {
  test("usage:summary: workspace admins only", async () => {
    for (const a of ACTORS) expect([a, (await s.call("query", "usage:summary", { days: 7 }, tok(a))).ok]).toEqual([a, a === "admin"]);
  });

  test("a chat's model calls are counted for the person who asked, by model and purpose; no text is kept", async () => {
    const before = must(await s.call("query", "usage:summary", { days: 1 }, tok("admin")));
    await ask(tok("mem")!, "سؤال للعدّ USG-1");
    let after: any;
    for (let i = 0; i < 100; i++) {
      after = must(await s.call("query", "usage:summary", { days: 1 }, tok("admin")));
      if (after.total.calls > before.total.calls && after.byPurpose.some((p: any) => p.purpose === "title")) break;
      await Bun.sleep(50);
    }
    expect(after.total.calls).toBeGreaterThan(before.total.calls);
    expect(after.today.prompt + after.today.completion).toBeGreaterThan(before.today.prompt + before.today.completion);
    expect(after.byPurpose.map((p: any) => p.purpose)).toEqual(expect.arrayContaining(["answer", "title"]));
    const answer = after.byPurpose.find((p: any) => p.purpose === "answer");
    expect(answer.prompt).toBeGreaterThan(0);
    expect(after.byModel.length).toBeGreaterThan(0);
    expect(after.byUser.map((u: any) => u.name)).toContain("موظف mem");
    expect(after.daily.length).toBe(1);
    expect(JSON.stringify(after)).not.toContain("USG-1");
  });

  test("days are clamped and every day is listed", async () => {
    expect(must(await s.call("query", "usage:summary", { days: 30 }, tok("admin"))).daily.length).toBe(30);
    expect(must(await s.call("query", "usage:summary", { days: 500 }, tok("admin"))).days).toBe(90);
  });
});
