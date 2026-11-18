// Phase 1 acceptance criteria (plans/04-phases.md, "المرحلة 1"), one describe per checkbox,
// plus the storage-URL finding, transfers with versions, and the audit log.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OnebaseClient } from "onebase/browser";
import { Server, must } from "./harness";
import { addFile, buildFixture, FILE_NAMES, PW, SPACE_NAMES, type Fixture } from "./fixture";

let s: Server;
let f: Fixture;

beforeAll(async () => {
  s = await new Server().start();
  f = await buildFixture(s);
}, 60_000);

afterAll(async () => {
  await s?.stop();
});

const T = (k: string) => (f.tokens as any)[k] as string | undefined;

/** Calls every read-ish public function as `token` and returns all response text. */
async function everythingVisibleTo(token: string | undefined) {
  const out: string[] = [];
  const calls: [string, string, any][] = [
    ["query", "account:me", {}],
    ["query", "spaces:mine", {}],
    ["query", "admin:spaces", {}],
    ["query", "admin:users", {}],
    ["query", "audit:list", {}],
  ];
  for (const sp of Object.values(f.spaces)) {
    calls.push(["query", "spaces:get", { spaceId: sp }], ["query", "files:list", { spaceId: sp }], ["query", "spaces:members", { spaceId: sp }], ["query", "audit:list", { spaceId: sp }], ["query", "spaces:candidates", { spaceId: sp }]);
  }
  for (const fileId of Object.values(f.files)) {
    calls.push(["query", "files:versions", { fileId }], ["mutation", "files:requestDownload", { fileId }]);
  }
  for (const [kind, fn, args] of calls) out.push(JSON.stringify(await s.call(kind as any, fn, args, token)));
  for (const fileId of Object.values(f.files)) out.push((await s.get(`/download?fileId=${fileId}`, token)).text);
  return out.join("\n");
}

describe("storage URLs (plans/02: verify /api/storage/<id> at the start of Phase 1)", () => {
  test("onebase serves /api/storage/<id> to anyone holding the id, with no auth (confirmed)", async () => {
    const storageId = await s.upload(T("mem")!, "RAW-BYTES-CHECK");
    const r = await s.get(`/api/storage/${storageId}`); // no token at all
    expect(r.status).toBe(200);
    expect(r.text).toBe("RAW-BYTES-CHECK");
  });

  test("so the app never sends storage ids or /api/storage URLs to the client", async () => {
    const text = await everythingVisibleTo(T("mgr"));
    expect(text).not.toContain("/api/storage/");
    expect(text).not.toContain("storageId");
  });

  test("a storage id uploaded by someone else can't be claimed into my space", async () => {
    const storageId = await s.upload(T("mem")!, "MEM-UPLOAD");
    const r = await s.call("mutation", "files:create", { storageId: storageId, name: "x.txt" }, T("mem"));
    expect(r.ok).toBe(true);
    const steal = await s.call("mutation", "files:create", { storageId, name: "stolen.txt" }, T("out"));
    expect(steal.ok).toBe(false);
  });
});

describe("✓ an employee's upload in their space is invisible to colleagues and the admin, in lists and by direct link", () => {
  test("default upload goes to the personal space", async () => {
    const list = must(await s.call("query", "files:list", { spaceId: f.spaces.P_mem }, T("mem")));
    expect(list.map((x: any) => x.name)).toContain(FILE_NAMES.P_mem);
  });

  for (const who of ["mgr", "rdr", "out", "admin"]) {
    test(`${who} sees no trace of it`, async () => {
      const text = await everythingVisibleTo(T(who));
      expect(text).not.toContain(FILE_NAMES.P_mem);
      expect(text).not.toContain("PERSONAL-CONTENT-PF55");
    });
    test(`${who}: direct link /download?fileId= fails`, async () => {
      const r = await s.get(`/download?fileId=${f.files.P_mem}`, T(who));
      expect(r.status).toBe(404);
      expect(r.text).not.toContain("PERSONAL");
    });
  }

  test("a download ticket works once, then the link is dead", async () => {
    const link = must(await s.call("mutation", "files:requestDownload", { fileId: f.files.P_mem }, T("mem")));
    expect((await s.get(link)).text).toBe("PERSONAL-CONTENT-PF55");
    const again = await s.get(link);
    expect(again.status).toBe(404);
  });

  test("forged or unknown tickets fail", async () => {
    expect((await s.get("/download?t=forged-token")).status).toBe(404);
    expect((await s.get(`/download?fileId=${f.files.P_mem}`)).status).toBe(404);
  });
});

describe("✓ a shared space's name and files are visible only to its members; nobody joins without its manager", () => {
  test("non-members never see the name anywhere (lists, errors, downloads)", async () => {
    for (const who of ["out", "pend", "dis", "anon"]) {
      const text = await everythingVisibleTo(T(who));
      for (const [key, name] of Object.entries(SPACE_NAMES)) {
        if (key === "S_every" && who === "out") continue; // everyone-space: out is a reader
        expect(text).not.toContain(name);
      }
      expect(text).not.toContain(FILE_NAMES.S_plain);
      expect(text).not.toContain(FILE_NAMES.S_sens);
    }
  });

  test("the workspace admin sees existence and manager, not the files", async () => {
    const spaces = must(await s.call("query", "admin:spaces", {}, T("admin")));
    const plain = spaces.find((x: any) => x._id === f.spaces.S_plain);
    expect(plain.name).toBe(SPACE_NAMES.S_plain);
    expect(plain.managers.map((m: any) => m.userId)).toEqual([f.ids.mgr]);
    expect((await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, T("admin"))).ok).toBe(false);
    expect((await s.get(`/download?fileId=${f.files.S_plain}`, T("admin"))).status).toBe(404);
    const mine = must(await s.call("query", "spaces:mine", {}, T("admin")));
    expect(mine.some((x: any) => x._id === f.spaces.S_plain)).toBe(false);
  });

  test("no self-join: a non-member can't add themselves, a member can't add others", async () => {
    expect((await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.out, role: "member" }, T("out"))).ok).toBe(false);
    expect((await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.out, role: "member" }, T("mem"))).ok).toBe(false);
    expect((await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.out, role: "member" }, T("rdr"))).ok).toBe(false);
    // the workspace admin assigns managers but is not a member and can't add members directly
    expect((await s.call("mutation", "spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.out, role: "member" }, T("admin"))).ok).toBe(false);
  });

  test("denials don't reveal whether a space exists", async () => {
    const real = await s.call("query", "spaces:get", { spaceId: f.spaces.S_plain }, T("out"));
    const fake = await s.call("query", "files:list", { spaceId: f.spaces.S_plain.replace(/.$/, (c) => (c === "a" ? "b" : "a")) }, T("out"));
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    if (!real.ok && !fake.ok && !fake.error.includes("Invalid")) expect(real.error).toBe(fake.error);
  });
});

describe("✓ an 'everyone' space is read by all employees and written only by named members", () => {
  test("an employee who isn't named can list and download", async () => {
    expect(must(await s.call("query", "files:list", { spaceId: f.spaces.S_every }, T("out"))).length).toBeGreaterThan(0);
    expect((await s.get(`/download?fileId=${f.files.S_every}`, T("out"))).text).toBe("CONTENT-S_every");
  });
  test("…but can't upload, version, delete or move into it", async () => {
    const sid = await s.upload(T("out")!, "nope");
    expect((await s.call("mutation", "files:create", { storageId: sid, name: "n.txt", spaceId: f.spaces.S_every }, T("out"))).ok).toBe(false);
    expect((await s.call("mutation", "files:uploadVersion", { fileId: f.files.S_every, storageId: sid }, T("out"))).ok).toBe(false);
    expect((await s.call("mutation", "files:remove", { fileId: f.files.S_every }, T("out"))).ok).toBe(false);
    const own = await addFile(s, T("out")!, undefined, "mine.txt", "x");
    expect((await s.call("mutation", "files:move", { fileId: own, toSpaceId: f.spaces.S_every }, T("out"))).ok).toBe(false);
  });
  test("a named member writes", async () => {
    const id = await addFile(s, T("mem")!, f.spaces.S_every, "policy-draft.txt", "x");
    expect(id).toBeTruthy();
  });
  test("a named reader can't write", async () => {
    const sid = await s.upload(T("rdr")!, "nope");
    expect((await s.call("mutation", "files:create", { storageId: sid, name: "n.txt", spaceId: f.spaces.S_every }, T("rdr"))).ok).toBe(false);
  });
});

describe("✓ a member removed from a space loses access immediately", () => {
  test("lists, versions, Bearer downloads and already-issued tickets all stop", async () => {
    const spaceId = f.spaces.S_plain;
    // give out a fresh membership, and let it collect a ticket and a live subscription
    must(await s.call("mutation", "spaces:addMember", { spaceId, userId: f.ids.out, role: "member" }, T("mgr")));
    expect((await s.call("query", "files:list", { spaceId }, T("out"))).ok).toBe(true);
    const ticket = must(await s.call("mutation", "files:requestDownload", { fileId: f.files.S_plain }, T("out")));

    const client = new OnebaseClient(s.url, { authStorage: null });
    await client.signIn("password", { flow: "signIn", email: f.emails.out, password: PW });
    const updates: string[] = [];
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    let resolveErr!: () => void;
    const errored = new Promise<void>((r) => (resolveErr = r));
    const stop = client.onUpdate(
      "files:list" as any,
      { spaceId },
      (rows: any) => {
        updates.push(`rows:${rows.length}`);
        resolveFirst();
      },
      (err: any) => {
        updates.push(`error:${err?.message}`);
        resolveErr();
      },
    );
    await first;

    must(await s.call("mutation", "spaces:removeMember", { spaceId, userId: f.ids.out }, T("mgr")));

    expect((await s.call("query", "files:list", { spaceId }, T("out"))).ok).toBe(false);
    expect((await s.call("query", "files:versions", { fileId: f.files.S_plain }, T("out"))).ok).toBe(false);
    expect((await s.get(`/download?fileId=${f.files.S_plain}`, T("out"))).status).toBe(404);
    expect((await s.get(ticket)).status).toBe(404);
    expect(must(await s.call("query", "spaces:mine", {}, T("out"))).some((x: any) => x._id === spaceId)).toBe(false);

    // the open live query is pushed an error, not stale rows
    await Promise.race([errored, Bun.sleep(5000)]);
    stop();
    client.close?.();
    expect(updates.some((u) => u.startsWith("error:"))).toBe(true);
  });

  test("a disabled employee loses everything at once, even with a valid session", async () => {
    const text = await everythingVisibleTo(T("dis"));
    expect(text).not.toContain("CONTENT-");
    expect(text).not.toContain(SPACE_NAMES.S_plain);
    const me = must(await s.call("query", "account:me", {}, T("dis")));
    expect(me.status).toBe("disabled");
    expect(me.workspaceName).toBeNull();
  });
});

describe("✓ an account no admin has added sees nothing, even though sign-in works", () => {
  test("sign-up succeeds and the account is pending", async () => {
    const r = await s.auth("signUp", "newcomer@onespace.test", PW, "قادم جديد");
    const me = must(await s.call("query", "account:me", {}, r.token));
    expect(me.status).toBe("pending");
    expect(me.workspaceRole).toBeNull();
    expect(me.workspaceName).toBeNull();
    const text = await everythingVisibleTo(r.token);
    expect(text).not.toContain("CONTENT-");
    for (const name of Object.values(SPACE_NAMES)) expect(text).not.toContain(name);
    expect(text).not.toContain(f.emails.mgr); // no other users' details
    expect((await s.call("mutation", "files:generateUploadUrl", {}, r.token)).ok).toBe(false);
  });

  test("a client can't make itself active through sign-up params", async () => {
    const res = await fetch(`${s.url}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "password", params: { flow: "signUp", email: "sneaky@onespace.test", password: PW, status: "active" } }),
    });
    const { token } = (await res.json()) as any;
    expect(must(await s.call("query", "account:me", {}, token)).status).toBe("pending");
    expect((await s.call("query", "spaces:mine", {}, token)).ok).toBe(false);
  });

  test("bootstrap can't be re-run once a workspace exists", async () => {
    expect((await s.adminRun("admin:bootstrap", { email: "newcomer@onespace.test" })).ok).toBe(false);
    expect((await s.call("mutation", "admin:bootstrap", { email: "newcomer@onespace.test" }, T("admin"))).ok).toBe(false);
  });

  test("activation creates the personal space", async () => {
    const r = await s.auth("signIn", "newcomer@onespace.test", PW);
    must(await s.call("mutation", "admin:activate", { userId: r.userId }, T("admin")));
    const mine = must(await s.call("query", "spaces:mine", {}, r.token));
    expect(mine.length).toBe(2); // personal + the everyone space
    expect(mine[0].kind).toBe("personal");
    expect(mine[1].name).toBe(SPACE_NAMES.S_every);
  });
});

describe("move and copy between spaces, with versions", () => {
  test("upload versions, move to a shared space: versions travel with the file", async () => {
    const fileId = await addFile(s, T("mem")!, undefined, "report.txt", "v1");
    const sid = await s.upload(T("mem")!, "v2");
    expect(must(await s.call("mutation", "files:uploadVersion", { fileId, storageId: sid }, T("mem")))).toBe(2);
    must(await s.call("mutation", "files:move", { fileId, toSpaceId: f.spaces.S_plain }, T("mem")));
    expect(must(await s.call("query", "files:versions", { fileId }, T("rdr"))).map((v: any) => v.version)).toEqual([2, 1]);
    expect((await s.get(`/download?fileId=${fileId}&v=1`, T("rdr"))).text).toBe("v1");
    expect((await s.get(`/download?fileId=${fileId}`, T("rdr"))).text).toBe("v2");
    expect(must(await s.call("query", "files:list", { spaceId: f.spaces.P_mem }, T("mem"))).some((x: any) => x._id === fileId)).toBe(false);
  });

  test("copy keeps the original; deleting the copy keeps the original's bytes", async () => {
    const fileId = await addFile(s, T("mem")!, undefined, "shared-bytes.txt", "SAME");
    const copyId = must(await s.call("mutation", "files:copy", { fileId, toSpaceId: f.spaces.S_plain }, T("mem")));
    must(await s.call("mutation", "files:remove", { fileId: copyId }, T("mgr")));
    expect((await s.get(`/download?fileId=${fileId}`, T("mem"))).text).toBe("SAME");
  });

  test("a reader can't move out; nobody can move into a space they can't write", async () => {
    expect((await s.call("mutation", "files:move", { fileId: f.files.S_plain, toSpaceId: f.spaces.S_every }, T("rdr"))).ok).toBe(false);
    const own = await addFile(s, T("out")!, undefined, "o.txt", "o");
    expect((await s.call("mutation", "files:move", { fileId: own, toSpaceId: f.spaces.S_plain }, T("out"))).ok).toBe(false);
    expect((await s.call("mutation", "files:copy", { fileId: own, toSpaceId: f.spaces.P_mem }, T("out"))).ok).toBe(false);
  });

  test("files leave a sensitive space only through its manager", async () => {
    const memPersonal = f.spaces.P_mem;
    expect((await s.call("mutation", "files:copy", { fileId: f.files.S_sens, toSpaceId: memPersonal }, T("mem"))).ok).toBe(false);
    expect((await s.call("mutation", "files:move", { fileId: f.files.S_sens, toSpaceId: f.spaces.S_plain }, T("mem"))).ok).toBe(false);
    const mgrMine = must(await s.call("query", "spaces:mine", {}, T("mgr")));
    const mgrPersonal = mgrMine.find((x: any) => x.kind === "personal")._id;
    expect((await s.call("mutation", "files:copy", { fileId: f.files.S_sens, toSpaceId: mgrPersonal }, T("mgr"))).ok).toBe(true);
  });
});

describe("audit log", () => {
  test("member add / role change / remove are recorded in the space log", async () => {
    const spaceId = f.spaces.S_plain;
    must(await s.call("mutation", "spaces:addMember", { spaceId, userId: f.ids.tmp, role: "reader" }, T("mgr")));
    must(await s.call("mutation", "spaces:setMemberRole", { spaceId, userId: f.ids.tmp, role: "member" }, T("mgr")));
    must(await s.call("mutation", "spaces:removeMember", { spaceId, userId: f.ids.tmp }, T("mgr")));
    const log = must(await s.call("query", "audit:list", { spaceId, userId: f.ids.mgr }, T("mgr")));
    const actions = log.filter((e: any) => e.resourceId === f.ids.tmp).map((e: any) => e.action);
    expect(actions.slice(0, 3)).toEqual(["member.remove", "member.role", "member.add"]);
  });

  test("sensitive downloads and opens are recorded; ordinary ones are not", async () => {
    const before = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr"))).length;
    await s.get(`/download?fileId=${f.files.S_sens}`, T("rdr"));
    const link = must(await s.call("mutation", "files:requestDownload", { fileId: f.files.S_sens, inline: true }, T("mem")));
    await s.get(link);
    const after = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr")));
    expect(after.length).toBe(before + 2);
    expect(after.slice(0, 2).map((e: any) => `${e.action}:${e.userId}`)).toEqual([`file.open:${f.ids.mem}`, `file.download:${f.ids.rdr}`]);
    const plainBefore = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_plain }, T("mgr"))).length;
    await s.get(`/download?fileId=${f.files.S_plain}`, T("rdr"));
    expect(must(await s.call("query", "audit:list", { spaceId: f.spaces.S_plain }, T("mgr"))).length).toBe(plainBefore);
  });

  test("a denied download writes nothing and leaks nothing", async () => {
    const before = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr"))).length;
    expect((await s.get(`/download?fileId=${f.files.S_sens}`, T("out"))).status).toBe(404);
    expect(must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr"))).length).toBe(before);
  });

  test("admin filters by user, space and period; file names in spaces they can't read are redacted", async () => {
    const all = must(await s.call("query", "audit:list", {}, T("admin")));
    expect(all.length).toBeGreaterThan(10);
    const byUser = must(await s.call("query", "audit:list", { userId: f.ids.rdr }, T("admin")));
    expect(byUser.every((e: any) => e.userId === f.ids.rdr)).toBe(true);
    const bySpace = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("admin")));
    expect(bySpace.every((e: any) => e.spaceId === f.spaces.S_sens)).toBe(true);
    expect(JSON.stringify(bySpace)).not.toContain(FILE_NAMES.S_sens);
    expect(JSON.stringify(bySpace)).toContain("•••");
    const future = must(await s.call("query", "audit:list", { from: Date.now() + 60_000 }, T("admin")));
    expect(future).toEqual([]);
    const personal = must(await s.call("query", "audit:list", { spaceId: f.spaces.P_mem }, T("admin")));
    expect(JSON.stringify(personal)).not.toContain(FILE_NAMES.P_mem);
  });

  test("a manager sees their space's log with names; not other spaces or the whole workspace", async () => {
    const own = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr")));
    expect(JSON.stringify(own)).toContain(FILE_NAMES.S_sens);
    expect((await s.call("query", "audit:list", {}, T("mgr"))).ok).toBe(false);
    expect((await s.call("query", "audit:list", { spaceId: f.spaces.P_mem }, T("mgr"))).ok).toBe(false);
    expect((await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mem"))).ok).toBe(false);
  });

  test("workspace admin actions are audited (activate, disable, role)", async () => {
    const log = must(await s.call("query", "audit:list", { userId: f.ids.admin }, T("admin")));
    const actions = new Set(log.map((e: any) => e.action));
    for (const a of ["workspace.bootstrap", "user.activate", "user.disable", "space.create", "member.add"]) expect(actions.has(a)).toBe(true);
  });
});

describe("workspace admin guard rails", () => {
  test("the admin can't disable themselves, and the last admin can't be demoted", async () => {
    expect((await s.call("mutation", "admin:disable", { userId: f.ids.admin }, T("admin"))).ok).toBe(false);
    expect((await s.call("mutation", "admin:setRole", { userId: f.ids.admin, role: "member" }, T("admin"))).ok).toBe(false);
  });
  test("a space can't lose its last manager", async () => {
    expect((await s.call("mutation", "spaces:removeMember", { spaceId: f.spaces.S_plain, userId: f.ids.mgr }, T("mgr"))).ok).toBe(false);
    expect((await s.call("mutation", "spaces:setMemberRole", { spaceId: f.spaces.S_plain, userId: f.ids.mgr, role: "member" }, T("mgr"))).ok).toBe(false);
  });
  test("promoting an employee to workspace admin gives admin screens but still no space contents", async () => {
    must(await s.call("mutation", "admin:setRole", { userId: f.ids.out, role: "admin" }, T("admin")));
    expect((await s.call("query", "admin:users", {}, T("out"))).ok).toBe(true);
    expect((await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, T("out"))).ok).toBe(false);
    must(await s.call("mutation", "admin:setRole", { userId: f.ids.out, role: "member" }, T("admin")));
    expect((await s.call("query", "admin:users", {}, T("out"))).ok).toBe(false);
  });
});
