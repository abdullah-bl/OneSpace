// Permission matrix: (actor role × space kind × action) → allowed/denied, on every public
// function, against a real onebase server over HTTP. Expected results come from the
// independent role model in fixture.ts, not from access.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { PHASE5_COVERED } from "./phase5.coverage";
import { PHASE4_PUBLIC } from "./phase4-coverage";
import { PHASE2_COVERED } from "./phase2-covered";
import { PHASE6_COVERED } from "./phase6.coverage";
import { UX_COVERED } from "./ux.coverage";
import { ACTORS, addFile, buildFixture, expectedAllowed, SPACES, type ActorKey, type Fixture, type Need, type SpaceKey } from "./fixture";

let s: Server;
let f: Fixture;

beforeAll(async () => {
  s = await new Server().start();
  f = await buildFixture(s);
}, 60_000);

afterAll(async () => {
  await s?.stop();
});

const tok = (a: ActorKey) => f.tokens[a];

/** Turns a /download response into a Result. */
async function download(path: string, token?: string): Promise<Result> {
  const r = await s.get(path, token);
  return r.status === 200 ? { ok: true, value: r.text } : { ok: false, error: r.text, status: r.status };
}

type Op = { name: string; need: Need; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> };

const OPS: Op[] = [
  { name: "spaces:get", need: "read", run: (a, sp) => s.call("query", "spaces:get", { spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "spaces:mine (sidebar lists the space)",
    need: "read",
    run: async (a, sp) => {
      const r = await s.call("query", "spaces:mine", {}, tok(a));
      return r.ok && r.value.some((x: any) => x._id === f.spaces[sp]) ? r : { ok: false, error: "not listed", status: 0 };
    },
  },
  { name: "files:list", need: "read", run: (a, sp) => s.call("query", "files:list", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "files:versions", need: "read", run: (a, sp) => s.call("query", "files:versions", { fileId: f.files[sp] }, tok(a)) },
  { name: "spaces:members", need: "read", run: (a, sp) => s.call("query", "spaces:members", { spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "files:requestDownload + GET /download?t=",
    need: "read",
    run: async (a, sp) => {
      const r = await s.call("mutation", "files:requestDownload", { fileId: f.files[sp] }, tok(a));
      if (!r.ok) return r;
      return download(r.value);
    },
  },
  { name: "GET /download?fileId= (Bearer session)", need: "read", run: (a, sp) => download(`/download?fileId=${f.files[sp]}`, tok(a)) },
  {
    name: "files:create (upload into space)",
    need: "write",
    run: async (a, sp) => {
      const t = tok(a);
      let storageId: string;
      try {
        storageId = await s.upload(t!, "new upload");
      } catch (e) {
        return { ok: false, error: String(e), status: 0 };
      }
      return s.call("mutation", "files:create", { storageId, name: "new.txt", spaceId: f.spaces[sp] }, t);
    },
  },
  {
    name: "files:uploadVersion",
    need: "write",
    run: async (a, sp) => {
      const t = tok(a);
      let storageId: string;
      try {
        storageId = await s.upload(t!, "v-next");
      } catch (e) {
        return { ok: false, error: String(e), status: 0 };
      }
      return s.call("mutation", "files:uploadVersion", { fileId: f.files[sp], storageId }, t);
    },
  },
  {
    name: "files:remove",
    need: "write",
    run: async (a, sp) => {
      const owner = sp === "P_mem" ? tok("mem")! : tok("mgr")!;
      const fileId = await addFile(s, owner, f.spaces[sp], "to-delete.txt", "bye");
      const r = await s.call("mutation", "files:remove", { fileId }, tok(a));
      if (!r.ok) await s.call("mutation", "files:remove", { fileId }, owner);
      return r;
    },
  },
  { name: "spaces:candidates", need: "manage", run: (a, sp) => s.call("query", "spaces:candidates", { spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "spaces:addMember",
    need: "manage",
    run: async (a, sp) => {
      const r = await s.call("mutation", "spaces:addMember", { spaceId: f.spaces[sp], userId: f.ids.tmp, role: "reader" }, tok(a));
      if (r.ok) must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces[sp], userId: f.ids.tmp }, tok("mgr")));
      return r;
    },
  },
  {
    name: "spaces:setMemberRole",
    need: "manage",
    run: async (a, sp) => {
      const r = await s.call("mutation", "spaces:setMemberRole", { spaceId: f.spaces[sp], userId: f.ids.rdr, role: "member" }, tok(a));
      if (r.ok) must(await s.call("mutation", "spaces:setMemberRole", { spaceId: f.spaces[sp], userId: f.ids.rdr, role: "reader" }, tok("mgr")));
      return r;
    },
  },
  {
    name: "spaces:removeMember",
    need: "manage",
    run: async (a, sp) => {
      const shared = sp !== "P_mem";
      if (shared) must(await s.call("mutation", "spaces:addMember", { spaceId: f.spaces[sp], userId: f.ids.tmp, role: "reader" }, tok("mgr")));
      const r = await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces[sp], userId: f.ids.tmp }, tok(a));
      if (!r.ok && shared) must(await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces[sp], userId: f.ids.tmp }, tok("mgr")));
      return shared || !r.ok ? r : { ok: false, error: "personal space has no members", status: 0 };
    },
  },
  { name: "audit:list (space log)", need: "audit", run: (a, sp) => s.call("query", "audit:list", { spaceId: f.spaces[sp] }, tok(a)) },

  // ---- Phase 3: space instructions and tasks ----
  {
    name: "spaces:setInstructions",
    need: "manage",
    run: (a, sp) => s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces[sp], instructions: "تعليمات المشروع" }, tok(a)),
  },
  { name: "tasks:board", need: "taskView", run: (a, sp) => s.call("query", "tasks:board", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "tasks:get", need: "taskView", run: (a, sp) => s.call("query", "tasks:get", { taskId: f.tasks[sp] }, tok(a)) },
  { name: "tasks:assignees", need: "taskManage", run: (a, sp) => s.call("query", "tasks:assignees", { spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "tasks:create",
    need: "taskManage",
    run: async (a, sp) => {
      const r = await s.call("mutation", "tasks:create", { spaceId: f.spaces[sp], title: "مهمة اختبار", assigneeId: f.ids.mem, priority: "high", due: Date.now() + 86_400_000 }, tok(a));
      if (r.ok) must(await s.call("mutation", "tasks:remove", { taskId: r.value }, tok("mgr")));
      return r;
    },
  },
  {
    name: "tasks:update",
    need: "taskManage",
    run: (a, sp) => s.call("mutation", "tasks:update", { taskId: f.tasks[sp], priority: "normal", due: null }, tok(a)),
  },
  {
    name: "tasks:assign",
    need: "taskManage",
    run: (a, sp) => withTask(sp, async (taskId) => s.call("mutation", "tasks:assign", { taskId, assigneeId: f.ids.mgr }, tok(a))),
  },
  {
    name: "tasks:setStatus (new → inProgress)",
    need: "taskWork",
    run: (a, sp) => withTask(sp, async (taskId) => s.call("mutation", "tasks:setStatus", { taskId, status: "inProgress" }, tok(a))),
  },
  {
    name: "tasks:addLink (a file of the same space)",
    need: "taskWork",
    run: (a, sp) => withTask(sp, async (taskId) => s.call("mutation", "tasks:addLink", { taskId, type: "file", id: f.files[sp] }, tok(a))),
  },
  {
    // Phase 4 artifacts as task links: same rule as files (an output of the task's own space)
    name: "tasks:addLink (an artifact of the same space)",
    need: "taskWork",
    run: (a, sp) =>
      withTask(sp, async (taskId) => {
        const owner = sp === "P_mem" ? "mem" : "mgr";
        const art = must(await s.call("mutation", "artifacts:create", { title: "مخرج", kind: "markdown", content: "x", spaceId: f.spaces[sp] }, tok(owner))).artifactId;
        return s.call("mutation", "tasks:addLink", { taskId, type: "artifact", id: art }, tok(a));
      }),
  },
  {
    name: "tasks:removeLink",
    need: "taskWork",
    run: (a, sp) =>
      withTask(sp, async (taskId) => {
        if (sp !== "P_mem") must(await s.call("mutation", "tasks:addLink", { taskId, type: "file", id: f.files[sp] }, tok("mgr")));
        return s.call("mutation", "tasks:removeLink", { taskId, type: "file", id: f.files[sp] }, tok(a));
      }),
  },
  {
    name: "tasks:setThread",
    need: "taskWork",
    run: (a, sp) => withTask(sp, async (taskId) => s.call("mutation", "tasks:setThread", { taskId, threadId: "thread-123" }, tok(a))),
  },
  { name: "tasks:comment", need: "taskComment", run: (a, sp) => s.call("mutation", "tasks:comment", { taskId: f.tasks[sp], body: `تعليق من ${a}` }, tok(a)) },
  {
    name: "tasks:remove",
    need: "taskManage",
    run: (a, sp) =>
      withTask(sp, async (taskId) => {
        const r = await s.call("mutation", "tasks:remove", { taskId }, tok(a));
        return r;
      }),
  },
];

/** Runs `fn` on a fresh task in the space (mgr creates it for mem, removes it after). P_mem: a dead id. */
async function withTask(sp: SpaceKey, fn: (taskId: string) => Promise<Result>): Promise<Result> {
  if (sp === "P_mem") return fn(f.tasks.P_mem);
  const taskId = must(await s.call("mutation", "tasks:create", { spaceId: f.spaces[sp], title: "مهمة مؤقتة", assigneeId: f.ids.mem }, tok("mgr")));
  try {
    return await fn(taskId);
  } finally {
    await s.call("mutation", "tasks:remove", { taskId }, tok("mgr"));
  }
}
describe("permission matrix", () => {
  for (const op of OPS) {
    for (const sp of SPACES) {
      for (const a of ACTORS) {
        const allowed = expectedAllowed(a, sp, op.need);
        test(`${op.name} | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
          const r = await op.run(a, sp);
          if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
          if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
        });
      }
    }
  }
});

describe("workspace-level functions", () => {
  const ADMIN_ONLY: [string, "query" | "mutation", () => any][] = [
    ["admin:users", "query", () => ({})],
    ["admin:spaces", "query", () => ({})],
    ["admin:activate", "mutation", () => ({ userId: f.ids.tmp })],
    ["admin:setRole", "mutation", () => ({ userId: f.ids.tmp, role: "member" })],
    ["admin:createSharedSpace", "mutation", () => ({ name: "مساحة-اختبار", managerId: f.ids.tmp })],
    ["admin:setSpaceManager", "mutation", () => ({ spaceId: f.spaces.S_plain, userId: f.ids.mgr })],
    ["admin:updateSpace", "mutation", () => ({ spaceId: f.spaces.S_plain, name: "لجنة-المشتريات-QX71" })],
    ["admin:disable", "mutation", () => ({ userId: f.ids.dis })],
    ["audit:list", "query", () => ({})],
  ];
  for (const [fn, kind, args] of ADMIN_ONLY) {
    for (const a of ACTORS) {
      const allowed = a === "admin";
      test(`${fn} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        const r = await s.call(kind, fn, args(), tok(a));
        expect(r.ok).toBe(allowed);
      });
    }
  }

  for (const a of ACTORS) {
    const allowed = !["pend", "dis", "anon"].includes(a);
    test(`files:generateUploadUrl | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
      expect((await s.call("mutation", "files:generateUploadUrl", {}, tok(a))).ok).toBe(allowed);
    });
    test(`spaces:mine | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
      expect((await s.call("query", "spaces:mine", {}, tok(a))).ok).toBe(allowed);
    });
    // Phase 3: per-user lists. Who may call them; what they contain is checked below and in acceptance.
    for (const [fn, kind] of [
      ["tasks:mine", "query"],
      ["notifications:list", "query"],
      ["notifications:unreadCount", "query"],
      ["notifications:markAllRead", "mutation"],
    ] as const) {
      test(`${fn} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
        expect((await s.call(kind, fn, {}, tok(a))).ok).toBe(allowed);
      });
    }
  }

  test("tasks:mine lists exactly the visible tasks assigned to me", async () => {
    for (const a of ACTORS) {
      const r = await s.call("query", "tasks:mine", {}, tok(a));
      if (!r.ok) continue;
      const ids = r.value.map((t: any) => t._id);
      const expected = a === "mem" ? [f.tasks.S_plain, f.tasks.S_every, f.tasks.S_sens] : [];
      for (const id of expected) expect(ids).toContain(id);
      if (a !== "mem") for (const sp of SPACES) expect(ids).not.toContain(f.tasks[sp]);
      expect(ids).not.toContain(f.tasks.P_mem);
    }
  });

  test("notifications:list shows a task notification only to people who can view the task", async () => {
    for (const sp of SPACES) {
      for (const a of ACTORS) {
        const r = await s.call("query", "notifications:list", {}, tok(a));
        if (!r.ok) continue;
        const has = r.value.some((n: any) => n.taskId === f.tasks[sp]);
        if (has) expect(expectedAllowed(a, sp, "taskView")).toBe(true);
      }
    }
  });

  test("every public function is covered by this matrix", async () => {
    const res = await fetch(`${s.url}/_admin/api/functions`, { method: "POST", headers: { Authorization: `Bearer ${s.adminKey}` }, body: "{}" });
    const fns: any[] = (await res.json()).value;
    const publicFns = fns.filter((x) => x.visibility === "public").map((x) => x.name).sort();
    const covered = new Set([
      ...OPS.flatMap((o) => o.name.split(/[ +]/).filter((w) => /^[a-z]+:[a-zA-Z]+$/.test(w))),
      ...ADMIN_ONLY.map(([n]) => n),
      ...PHASE4_PUBLIC, // checked in outputs-permissions.test.ts
      "files:generateUploadUrl",
      "spaces:mine",
      "files:move",
      "files:copy",
      "account:me",
      "tasks:mine",
      "notifications:list",
      "notifications:unreadCount",
      "notifications:markAllRead",
      ...PHASE5_COVERED,
      ...PHASE2_COVERED,
      ...PHASE6_COVERED, // checked in phase6.permissions.test.ts
      ...UX_COVERED, // checked in ux.test.ts
    ]);
    expect(publicFns.filter((n) => !covered.has(n))).toEqual([]);
    // Nothing public writes or deletes audit rows, and no component function is exposed.
    expect(publicFns.some((n) => n.startsWith("audit:") && n !== "audit:list")).toBe(false);
    expect(publicFns.some((n) => n.startsWith("components/"))).toBe(false);
  });
});
