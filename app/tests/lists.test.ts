// «القوائم» (plans/10): live tables in a space. Every public function per actor × space, cell
// checks, column changes, and the assistant's tools (create_list, update_list, read_list) with
// their tiers and «تراجع».

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, expectedAllowed, expectedRole, SPACES, type ActorKey, type Fixture, type SpaceKey } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;
/** Per space: a list made by its owner/manager, with one row. */
const setup = {} as Record<SpaceKey, { owner: string; list: string; row: string }>;
const owner = (sp: SpaceKey) => (sp === "P_mem" ? "mem" : "mgr");

beforeAll(async () => {
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
  for (const sp of SPACES) {
    const t = tok(owner(sp))!;
    const list = must(await s.call("mutation", "lists:create", { spaceId: f.spaces[sp], title: `قائمة ${sp}` }, t));
    const row = must(await s.call("mutation", "lists:addRow", { listId: list, cells: {} }, t));
    setup[sp] = { owner: t, list, row };
  }
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

type Op = { name: string; allowed: (a: ActorKey, sp: SpaceKey) => boolean; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> };
const need = (n: "read" | "write") => (a: ActorKey, sp: SpaceKey) => expectedAllowed(a, sp, n);
/** Deleting a list: its creator, a manager, or the personal space's owner. */
const deleter = (a: ActorKey, sp: SpaceKey) => a === owner(sp) || ["manager", "owner"].includes(expectedRole(a, sp) ?? "");

const OPS: Op[] = [
  { name: "lists:forSpace", allowed: need("read"), run: (a, sp) => s.call("query", "lists:forSpace", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "lists:get", allowed: need("read"), run: (a, sp) => s.call("query", "lists:get", { listId: setup[sp].list }, tok(a)) },
  { name: "lists:create", allowed: need("write"), run: (a, sp) => s.call("mutation", "lists:create", { spaceId: f.spaces[sp], title: `by ${a}` }, tok(a)) },
  { name: "lists:updateMeta", allowed: need("write"), run: (a, sp) => s.call("mutation", "lists:updateMeta", { listId: setup[sp].list, view: "table" }, tok(a)) },
  {
    name: "lists:setColumns",
    allowed: need("write"),
    run: async (a, sp) => {
      const g = must(await s.call("query", "lists:get", { listId: setup[sp].list }, setup[sp].owner));
      return s.call("mutation", "lists:setColumns", { listId: setup[sp].list, columns: g.list.columns }, tok(a));
    },
  },
  { name: "lists:addRow", allowed: need("write"), run: (a, sp) => s.call("mutation", "lists:addRow", { listId: setup[sp].list, cells: { المهمة: `من ${a}` } }, tok(a)) },
  { name: "lists:updateRow", allowed: need("write"), run: (a, sp) => s.call("mutation", "lists:updateRow", { rowId: setup[sp].row, cells: { المهمة: `عدّلها ${a}` } }, tok(a)) },
  {
    name: "lists:removeRow",
    allowed: need("write"),
    run: async (a, sp) => s.call("mutation", "lists:removeRow", { rowId: must(await s.call("mutation", "lists:addRow", { listId: setup[sp].list }, setup[sp].owner)) }, tok(a)),
  },
  {
    name: "lists:remove",
    allowed: deleter,
    run: async (a, sp) => s.call("mutation", "lists:remove", { listId: must(await s.call("mutation", "lists:create", { spaceId: f.spaces[sp], title: "للحذف" }, setup[sp].owner)) }, tok(a)),
  },
];

describe("permission matrix", () => {
  for (const op of OPS)
    for (const sp of SPACES)
      for (const a of ACTORS) {
        const allowed = op.allowed(a, sp);
        test(`${op.name} | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
          const r = await op.run(a, sp);
          if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
          if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
        });
      }

  test("lists:recent: only lists of spaces I can read", async () => {
    for (const a of ACTORS) {
      const r = await s.call("query", "lists:recent", {}, tok(a));
      if (["pend", "dis", "anon"].includes(a)) {
        expect(r.ok).toBe(false);
        continue;
      }
      const seen = new Set(must(r).map((l: any) => l.spaceId));
      for (const sp of SPACES) expect([a, sp, seen.has(f.spaces[sp])]).toEqual([a, sp, expectedAllowed(a, sp, "read")]);
    }
  });

  test("a member deletes their own list, not a manager's", async () => {
    const mine = must(await s.call("mutation", "lists:create", { spaceId: f.spaces.S_plain, title: "لي" }, tok("mem")));
    expect((await s.call("mutation", "lists:remove", { listId: setup.S_plain.list }, tok("mem"))).ok).toBe(false);
    must(await s.call("mutation", "lists:remove", { listId: mine }, tok("mem")));
  });
});

describe("cells and columns", () => {
  test("each type is checked; a status must be one of its options; a person must see the space", async () => {
    const list = must(
      await s.call(
        "mutation",
        "lists:create",
        {
          spaceId: f.spaces.S_plain,
          title: "أنواع",
          columns: [
            { name: "اسم", type: "text" },
            { name: "عدد", type: "number" },
            { name: "يوم", type: "date" },
            { name: "حالة", type: "status" },
            { name: "مسؤول", type: "person" },
            { name: "تم", type: "check" },
          ],
        },
        tok("mgr"),
      ),
    );
    const g = must(await s.call("query", "lists:get", { listId: list }, tok("mem")));
    const key = (n: string) => g.list.columns.find((c: any) => c.name === n).key;
    expect(g.list.columns.find((c: any) => c.name === "حالة").options).toEqual(["لم تبدأ", "قيد التنفيذ", "منجزة"]);
    const mgrId = g.people.find((p: any) => p.name).userId;
    const row = must(await s.call("mutation", "lists:addRow", { listId: list, cells: { [key("عدد")]: "١٢٫٥", [key("يوم")]: "2026-12-01", [key("حالة")]: "منجزة", [key("مسؤول")]: mgrId, [key("تم")]: true } }, tok("mem")));
    const after = must(await s.call("query", "lists:get", { listId: list }, tok("rdr"))).rows.find((r: any) => r._id === row);
    expect(after.cells).toEqual({ [key("عدد")]: 12.5, [key("يوم")]: "2026-12-01", [key("حالة")]: "منجزة", [key("مسؤول")]: mgrId, [key("تم")]: true });
    for (const bad of [{ [key("عدد")]: "كثير" }, { [key("يوم")]: "غداً" }, { [key("حالة")]: "مؤجلة" }, { [key("مسؤول")]: "شخص من خارج المساحة" }, { غير_موجود: "x" }])
      expect((await s.call("mutation", "lists:updateRow", { rowId: row, cells: bad }, tok("mem"))).ok).toBe(false);
  });

  test("dropping or retyping a column clears its values; a renamed one keeps them", async () => {
    const list = must(await s.call("mutation", "lists:create", { spaceId: f.spaces.S_plain, title: "أعمدة", columns: [{ name: "أ", type: "text" }, { name: "ب", type: "text" }, { name: "ج", type: "text" }] }, tok("mgr")));
    const g = must(await s.call("query", "lists:get", { listId: list }, tok("mgr")));
    const [a, b, c] = g.list.columns;
    const row = must(await s.call("mutation", "lists:addRow", { listId: list, cells: { [a.key]: "1", [b.key]: "2", [c.key]: "3" } }, tok("mgr")));
    must(await s.call("mutation", "lists:setColumns", { listId: list, columns: [{ ...a, name: "أأ" }, { ...b, type: "number" }, { name: "د", type: "check" }] }, tok("mgr")));
    const g2 = must(await s.call("query", "lists:get", { listId: list }, tok("mgr")));
    expect(g2.list.columns.map((x: any) => x.name)).toEqual(["أأ", "ب", "د"]);
    expect(g2.list.columns[2].key).not.toBe(c.key);
    expect(g2.rows.find((r: any) => r._id === row).cells).toEqual({ [a.key]: "1" });
  });

  test("a secret typed into a cell is masked", async () => {
    const r = must(await s.call("mutation", "lists:addRow", { listId: setup.S_plain.list, cells: { المهمة: "المفتاح sk-or-v1-0123456789abcdef0123456789abcdef0123" } }, tok("mgr")));
    const cell = must(await s.call("query", "lists:get", { listId: setup.S_plain.list }, tok("mgr"))).rows.find((x: any) => x._id === r).cells;
    expect(JSON.stringify(cell)).not.toContain("0123456789abcdef0123456789abcdef");
  });
});

// ---------------------------------------------------------------- the assistant

const setInstr = async (instructions: string) => must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions }, tok("mgr")));
const call = (name: string, args: unknown) => `CALL_TOOL ${name} ${JSON.stringify(args)}`;

async function ask(token: string, text: string, spaceId = f.spaces.S_plain, confirm = true) {
  const threadId = must(await s.call("mutation", "chat:createThread", { spaceId }, token));
  must(await s.call("mutation", "chat:send", { threadId, text }, token));
  const done = new Set<string>();
  for (let i = 0; i < 800; i++) {
    const r = must(await s.call("query", "chat:messages", { threadId }, token));
    const props = r.messages.flatMap((m: any) => m.proposals ?? []);
    const pending = props.filter((p: any) => p.state === "pending" && !done.has(p.id));
    if (confirm)
      for (const p of pending) {
        done.add(p.id);
        must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, token));
      }
    if ((!confirm || !pending.length) && !r.turn && r.messages.at(-1)?.role === "assistant") return { threadId, props: r.messages.flatMap((m: any) => m.proposals ?? []) as any[] };
    await Bun.sleep(25);
  }
  throw new Error("no answer");
}
const sentFor = (mark: string) => ai.requests.filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body.messages ?? []).includes(mark)).map((r) => JSON.stringify(r.body.messages)).join();

describe("the assistant's list tools", () => {
  const TASKS = { title: "مهام اليوم AI-1", columns: [{ name: "المهمة", type: "text" }, { name: "الحالة", type: "status" }, { name: "المسؤول", type: "person" }], rows: [{ المهمة: "تحضير الاجتماع", الحالة: "لم تبدأ" }, { المهمة: "مشروع مساحة", الحالة: "قيد التنفيذ" }] };

  test("create_list in a shared space: a card first, then the list is in that space", async () => {
    await setInstr(call("create_list", TASKS));
    try {
      const r = await ask(tok("mem")!, "رتّب مهامي LQ-1", f.spaces.S_plain, false);
      const p = r.props.find((x) => x.tool === "create_list");
      expect(p.state).toBe("pending");
      expect(p.tier).toBe(2);
      must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, tok("mem")));
    } finally {
      await setInstr("");
    }
    const l = must(await s.call("query", "lists:forSpace", { spaceId: f.spaces.S_plain }, tok("rdr"))).lists.find((x: any) => x.title === "مهام اليوم AI-1");
    expect(l.rowCount).toBe(2);
  });

  test("a reader's list goes to their personal space, runs at once, and «تراجع» removes it", async () => {
    await setInstr(call("create_list", { ...TASKS, title: "قائمتي AI-2" }));
    let p: any;
    try {
      p = (await ask(tok("rdr")!, "سوّ لي قائمة LQ-2", f.spaces.S_plain, false)).props.find((x) => x.tool === "create_list");
    } finally {
      await setInstr("");
    }
    expect([p.state, p.auto]).toEqual(["executed", true]);
    const mine = must(await s.call("query", "lists:recent", {}, tok("rdr"))).find((x: any) => x.title === "قائمتي AI-2");
    expect(mine.personal).toBe(true);
    must(await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("rdr")));
    expect(must(await s.call("query", "lists:recent", {}, tok("rdr"))).some((x: any) => x.title === "قائمتي AI-2")).toBe(false);
  });

  test("the list is in the space's chats' prompt; read_list then update_list by row id", async () => {
    const l = must(await s.call("query", "lists:forSpace", { spaceId: f.spaces.S_plain }, tok("mem"))).lists.find((x: any) => x.title === "مهام اليوم AI-1");
    await ask(tok("mem")!, "وش باقي LQ-3");
    expect(sentFor("LQ-3")).toContain(`listId=${l._id}`);

    await setInstr(call("read_list", { title: "مهام اليوم AI-1" }));
    try {
      await ask(tok("rdr")!, "اقرأ القائمة LQ-4");
    } finally {
      await setInstr("");
    }
    expect(sentFor("LQ-4")).toContain("تحضير الاجتماع");
    const g = must(await s.call("query", "lists:get", { listId: l._id }, tok("mem")));
    const row = g.rows.find((r: any) => Object.values(r.cells).includes("تحضير الاجتماع"));
    await setInstr(call("update_list", { listId: l._id, update: [{ rowId: row._id, cells: { الحالة: "منجزة", المسؤول: "موظف mem" } }], add: [{ المهمة: "تدوين المخرجات", الحالة: "مؤجلة" }] }));
    try {
      await ask(tok("mem")!, "خلصت التحضير LQ-5");
    } finally {
      await setInstr("");
    }
    const g2 = must(await s.call("query", "lists:get", { listId: l._id }, tok("mem")));
    const status = g2.list.columns.find((c: any) => c.name === "الحالة");
    expect(g2.rows.find((r: any) => r._id === row._id).cells[status.key]).toBe("منجزة");
    const person = g2.list.columns.find((c: any) => c.name === "المسؤول");
    expect(g2.people.find((p: any) => p.userId === g2.rows.find((r: any) => r._id === row._id).cells[person.key])?.name).toBe("موظف mem");
    expect(g2.rows.length).toBe(3);
    expect(status.options).toContain("مؤجلة"); // the assistant may add an option
  });

  test("a reader's update_list on a shared list is refused; another space's list is out of scope", async () => {
    const l = must(await s.call("query", "lists:forSpace", { spaceId: f.spaces.S_plain }, tok("mem"))).lists.find((x: any) => x.title === "مهام اليوم AI-1");
    await setInstr(call("update_list", { listId: l._id, add: [{ المهمة: "من القارئ RD-1" }] }));
    try {
      await ask(tok("rdr")!, "أضف LQ-6");
    } finally {
      await setInstr("");
    }
    expect(JSON.stringify(must(await s.call("query", "lists:get", { listId: l._id }, tok("mem"))).rows)).not.toContain("RD-1");

    await setInstr(call("read_list", { listId: setup.S_sens.list }));
    try {
      await ask(tok("mem")!, "اقرأ LQ-7");
    } finally {
      await setInstr("");
    }
    expect(sentFor("LQ-7")).not.toContain("قائمة S_sens");
  });
});
