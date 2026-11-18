// Permission matrix: (actor role × space kind × action) → allowed/denied, on every public
// function, against a real onebase server over HTTP. Expected results come from the
// independent role model in fixture.ts, not from access.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { PHASE2_COVERED } from "./phase2-covered";
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
];

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
  }

  test("every public function is covered by this matrix", async () => {
    const res = await fetch(`${s.url}/_admin/api/functions`, { method: "POST", headers: { Authorization: `Bearer ${s.adminKey}` }, body: "{}" });
    const fns: any[] = (await res.json()).value;
    const publicFns = fns.filter((x) => x.visibility === "public").map((x) => x.name).sort();
    const covered = new Set([
      ...OPS.flatMap((o) => o.name.split(/[ +]/).filter((w) => /^[a-z]+:[a-zA-Z]+$/.test(w))),
      ...ADMIN_ONLY.map(([n]) => n),
      "files:generateUploadUrl",
      "spaces:mine",
      "files:move",
      "files:copy",
      "account:me",
      ...PHASE2_COVERED,
    ]);
    expect(publicFns.filter((n) => !covered.has(n))).toEqual([]);
    // Nothing public writes or deletes audit rows, and no component function is exposed.
    expect(publicFns.some((n) => n.startsWith("audit:") && n !== "audit:list")).toBe(false);
    expect(publicFns.some((n) => n.startsWith("components/"))).toBe(false);
  });
});
