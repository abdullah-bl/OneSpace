// The same file uploaded twice into one space is stored and indexed once (files.ts addFile): the
// second upload returns the first file. Another space keeps its own copy. A new version with the
// current bytes adds nothing. Duplicates already there are marked and removed on request.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { addFile, buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { waitIngest } from "./rag-helpers";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string;
const list = async (spaceId: string, who = "mem") => must(await s.call("query", "files:list", { spaceId }, tok(who))) as any[];

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

describe("identical uploads", () => {
  test("the same bytes in the same space: the existing file comes back, under its own name, and nothing new is stored", async () => {
    const first = await addFile(s, tok("mem"), f.spaces.P_mem, "تقرير-DUP.txt", "محتوى واحد DUP-1");
    const before = (await list(f.spaces.P_mem)).length;
    const storageId = await s.upload(tok("mem"), "محتوى واحد DUP-1");
    const r = must(await s.call("mutation", "files:upload", { storageId, name: "نسخة-DUP.txt", spaceId: f.spaces.P_mem }, tok("mem")));
    expect(r).toEqual({ fileId: first, reused: true, name: "تقرير-DUP.txt" });
    expect((await list(f.spaces.P_mem)).length).toBe(before);
    // files:create (older callers) reuses too, returning the id.
    expect(await addFile(s, tok("mem"), f.spaces.P_mem, "ثالثة-DUP.txt", "محتوى واحد DUP-1")).toBe(first);
    // Different bytes are a new file, even under the same name.
    expect(await addFile(s, tok("mem"), f.spaces.P_mem, "تقرير-DUP.txt", "محتوى آخر DUP-2")).not.toBe(first);
  });

  test("another space keeps its own copy (its readers differ)", async () => {
    const mine = await addFile(s, tok("mem"), f.spaces.P_mem, "مشترك-DUP.txt", "محتوى DUP-3");
    const shared = await addFile(s, tok("mem"), f.spaces.S_plain, "مشترك-DUP.txt", "محتوى DUP-3");
    expect(shared).not.toBe(mine);
  });

  test("a new version with the current bytes adds no version", async () => {
    const id = await addFile(s, tok("mem"), f.spaces.P_mem, "نسخ-DUP.txt", "النسخة الأولى DUP-4");
    const same = await s.upload(tok("mem"), "النسخة الأولى DUP-4");
    expect(must(await s.call("mutation", "files:uploadVersion", { fileId: id, storageId: same }, tok("mem")))).toBe(1);
    const next = await s.upload(tok("mem"), "النسخة الثانية DUP-4");
    expect(must(await s.call("mutation", "files:uploadVersion", { fileId: id, storageId: next }, tok("mem")))).toBe(2);
  });
});

describe("duplicates already in a space", () => {
  test("marked against the first upload; «احذف النسخ المكررة» keeps it and removes the rest; a reader can't", async () => {
    // Like a space from before reuse: the same bytes twice. A copy to another space, moved back, does it.
    const orig = await addFile(s, tok("mgr"), f.spaces.S_plain, "أصل-DUP.txt", "محتوى قديم DUP-5");
    const copy = must(await s.call("mutation", "files:copy", { fileId: orig, toSpaceId: f.spaces.S_every }, tok("mgr")));
    must(await s.call("mutation", "files:move", { fileId: copy, toSpaceId: f.spaces.S_plain }, tok("mgr")));
    const rows = await list(f.spaces.S_plain, "mgr");
    expect(rows.find((r) => r._id === orig).duplicateOf).toBeNull();
    expect(rows.find((r) => r._id === copy).duplicateOf).toBe("أصل-DUP.txt");
    expect((await s.call("mutation", "files:removeDuplicates", { spaceId: f.spaces.S_plain }, tok("rdr"))).ok).toBe(false);
    expect(must(await s.call("mutation", "files:removeDuplicates", { spaceId: f.spaces.S_plain }, tok("mgr")))).toBe(1);
    const after = await list(f.spaces.S_plain, "mgr");
    expect(after.some((r) => r._id === orig)).toBe(true);
    expect(after.some((r) => r._id === copy)).toBe(false);
  });
});

describe("search", () => {
  test("the same passage from two identical files in spaces I read shows once", async () => {
    const text = "سياسة السفر الخارجي SRCHDUP-1: يُعتمد طلب السفر من المدير المباشر قبل أسبوعين.";
    const a = await addFile(s, tok("mgr"), f.spaces.S_plain, "سفر-أ.txt", text);
    const b = await addFile(s, tok("mgr"), f.spaces.S_every, "سفر-ب.txt", text);
    for (const [sp, id] of [[f.spaces.S_plain, a], [f.spaces.S_every, b]] as const) expect((await waitIngest(s, tok("mgr"), sp, id)).state).toBe("ready");
    const r = must(await s.adminRun("search:debugSearch", { userId: f.ids.mgr, query: "سياسة السفر الخارجي SRCHDUP-1", spaceIds: [f.spaces.S_plain, f.spaces.S_every] }));
    const hits = r.hits.filter((h: any) => h.text.includes("SRCHDUP-1"));
    expect(hits).toHaveLength(1);
  }, 60_000);
});
