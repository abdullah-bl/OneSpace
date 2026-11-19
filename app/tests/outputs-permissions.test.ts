// Phase 4 permission matrix: every new public function × space kind × actor, against the same
// independent role model as Phase 1 (fixture.ts), on a real onebase server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, expectedAllowed, expectedRole, SPACES, type ActorKey, type Fixture, type Need, type SpaceKey } from "./fixture";
import { buildOutputs, COLUMNS, COURSE_HEADERS, COURSE_ROWS, FIELDS, IDS, layoutFor, tool, xlsxBase64, type OutputsFixture } from "./outputsFixture";
import { PHASE4_PUBLIC } from "./phase4-coverage";

let s: Server;
let f: Fixture;
let o: OutputsFixture;
let xlsx: string;

beforeAll(async () => {
  s = await new Server().start();
  f = await buildFixture(s);
  o = await buildOutputs(s, f);
  xlsx = await xlsxBase64(COURSE_HEADERS, COURSE_ROWS);
}, 120_000);

afterAll(async () => {
  await s?.stop();
});

const tok = (a: ActorKey) => f.tokens[a];
const SHARED: SpaceKey[] = ["S_plain", "S_every", "S_sens"];
const fail = (error: string): Result => ({ ok: false, error, status: 0 });

async function personalOf(a: ActorKey): Promise<string | null> {
  const r = await s.call("query", "spaces:mine", {}, tok(a));
  return r.ok ? (r.value.find((x: any) => x.kind === "personal")?._id ?? null) : null;
}

/** A draft or approved document for (space, record), created by mem and approved by mgr when needed. */
async function docFor(sp: SpaceKey, nid: string, course: string, want: "draft" | "approved") {
  for (let i = 0; i < 3; i++) {
    const r = must(await s.call("mutation", "documents:request", { templateId: o.templates[sp], recordId: await o.recordOf(sp, nid, course) }, tok("mem")));
    if (r.status === want || (want === "approved" && r.status === "issued")) return r.documentId as string;
    if (want === "approved" && r.status === "draft") {
      must(await s.call("mutation", "documents:approve", { documentId: r.documentId }, tok("mgr")));
      return r.documentId as string;
    }
    must(await s.call("mutation", "documents:reject", { documentId: r.documentId }, tok("mgr")));
  }
  throw new Error("could not prepare document");
}

/** A sensitive artifact in S_sens (built on a file there) by mem. */
async function sensitiveArtifact() {
  const r = must(await tool(s, f.ids.mem!, "create_artifact", { title: "ملخص حساس", kind: "markdown", content: "# x", sources: [{ type: "file", id: f.files.S_sens }] }));
  return r.artifactIds[0] as string;
}

/** Without a sandbox, an export that got past every access check stops at "not configured": count it as allowed. */
const SANDBOX_OFF = /الساندبوكس غير مهيأ|تعذّر الاتصال بالساندبوكس/;
const passedAccess = (r: Result): Result => (!r.ok && SANDBOX_OFF.test(r.error) ? { ok: true, value: "access ok (no sandbox)" } : r);

type Op = { name: string; need: Need; spaces: readonly SpaceKey[]; expect?: (a: ActorKey, sp: SpaceKey) => boolean; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> };

const OPS: Op[] = [
  // read
  { name: "artifacts:list", need: "read", spaces: SPACES, run: (a, sp) => s.call("query", "artifacts:list", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "artifacts:versions", need: "read", spaces: SPACES, run: (a, sp) => s.call("query", "artifacts:versions", { artifactId: o.artifacts[sp] }, tok(a)) },
  { name: "artifacts:open", need: "read", spaces: SPACES, run: (a, sp) => s.call("mutation", "artifacts:open", { artifactId: o.artifacts[sp] }, tok(a)) },
  { name: "artifacts:exportTable", need: "read", spaces: SPACES, run: (a, sp) => s.call("action", "artifacts:exportTable", { artifactId: o.artifacts[sp], format: "csv" }, tok(a)) },
  { name: "records:sets", need: "read", spaces: SPACES, run: (a, sp) => s.call("query", "records:sets", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "records:imports", need: "read", spaces: SHARED, run: (a, sp) => s.call("query", "records:imports", { recordSetId: o.sets[sp] }, tok(a)) },
  { name: "records:rows", need: "read", spaces: SHARED, run: (a, sp) => s.call("query", "records:rows", { recordSetId: o.sets[sp] }, tok(a)) },
  {
    name: "query_records (tool)",
    need: "read",
    spaces: SHARED,
    run: async (a, sp) => {
      if (!f.ids[a]) return fail("anonymous");
      const r = await tool(s, f.ids[a]!, "query_records", { recordSetId: o.sets[sp] });
      return r.ok && r.value.content.includes(IDS.out) ? r : r.ok ? fail("no rows") : r;
    },
  },
  { name: "templates:list", need: "read", spaces: SPACES, run: (a, sp) => s.call("query", "templates:list", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "templates:versions", need: "read", spaces: SHARED, run: (a, sp) => s.call("query", "templates:versions", { templateId: o.templates[sp] }, tok(a)) },
  { name: "documents:list", need: "read", spaces: SPACES, run: (a, sp) => s.call("query", "documents:list", { spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "documents:requestDownload + GET /document",
    need: "read",
    spaces: SHARED,
    run: async (a, sp) => {
      const r = await s.call("mutation", "documents:requestDownload", { documentId: o.docs[sp] }, tok(a));
      if (!r.ok) return r;
      const g = await s.get(r.value);
      return g.status === 200 && g.text.startsWith("%PDF") ? { ok: true, value: "pdf" } : fail(`GET ${g.status}`);
    },
  },
  { name: "documents:reproduce", need: "read", spaces: SHARED, run: (a, sp) => s.call("action", "documents:reproduce", { documentId: o.docs[sp] }, tok(a)) },

  // write
  { name: "artifacts:create", need: "write", spaces: SPACES, run: (a, sp) => s.call("mutation", "artifacts:create", { title: "t", kind: "markdown", content: "x", spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "create_artifact (tool, into the space)",
    need: "write",
    spaces: SPACES,
    run: (a, sp) => (f.ids[a] ? tool(s, f.ids[a]!, "create_artifact", { title: "t", kind: "markdown", content: "x", spaceId: f.spaces[sp] }) : Promise.resolve(fail("anon"))),
  },
  {
    name: "artifacts:exportDocument",
    need: "read",
    spaces: SPACES,
    run: async (a, sp) => passedAccess(await s.call("action", "artifacts:exportDocument", { artifactId: o.artifacts[sp], format: "docx" }, tok(a))),
  },
  {
    name: "export_document (tool)",
    need: "write",
    spaces: SPACES,
    run: async (a, sp) => (f.ids[a] ? passedAccess(await tool(s, f.ids[a]!, "export_document", { artifactId: o.artifacts[sp], format: "pdf" })) : fail("anon")),
  },
  {
    name: "artifacts:edit",
    need: "write",
    spaces: SPACES,
    run: async (a, sp) => {
      const owner = sp === "P_mem" ? tok("mem") : tok("mgr");
      const id = must(await s.call("mutation", "artifacts:create", { title: "ed", kind: "markdown", content: "قبل", spaceId: f.spaces[sp] }, owner)).artifactId;
      return s.call("mutation", "artifacts:edit", { artifactId: id, content: `بعد ${a}` }, tok(a));
    },
  },
  {
    name: "update_artifact (tool)",
    need: "write",
    spaces: SPACES,
    run: (a, sp) => (f.ids[a] ? tool(s, f.ids[a]!, "update_artifact", { artifactId: o.artifacts[sp], table: { columns: ["أ", "ب"], rows: [[a, 1]] } }) : Promise.resolve(fail("anon"))),
  },
  {
    name: "artifacts:remove",
    need: "write",
    spaces: SPACES,
    run: async (a, sp) => {
      const owner = sp === "P_mem" ? tok("mem") : tok("mgr");
      const id = must(await s.call("mutation", "artifacts:create", { title: "del", kind: "markdown", content: "x", spaceId: f.spaces[sp] }, owner)).artifactId;
      const r = await s.call("mutation", "artifacts:remove", { artifactId: id }, tok(a));
      if (!r.ok) must(await s.call("mutation", "artifacts:remove", { artifactId: id }, owner));
      return r;
    },
  },
  {
    // Out of a sensitive space only by its manager; elsewhere write on both sides.
    name: "artifacts:move (to my personal space)",
    need: "write",
    spaces: SPACES,
    expect: (a, sp) => (sp === "S_sens" ? expectedAllowed(a, sp, "manage") : sp === "P_mem" ? false : expectedAllowed(a, sp, "write")),
    run: async (a, sp) => {
      const owner = sp === "P_mem" ? tok("mem") : tok("mgr");
      const id = must(await s.call("mutation", "artifacts:create", { title: "mv", kind: "markdown", content: "x", spaceId: f.spaces[sp] }, owner)).artifactId;
      const to = await personalOf(a);
      if (!to) return fail("no personal space");
      return s.call("mutation", "artifacts:move", { artifactId: id, toSpaceId: to }, tok(a));
    },
  },
  {
    name: "artifacts:requestTransfer",
    need: "write",
    spaces: ["S_sens"],
    run: async (a) => {
      const id = await sensitiveArtifact();
      const to = await personalOf(a);
      if (!to) return fail("no personal space");
      return s.call("mutation", "artifacts:requestTransfer", { artifactId: id, toSpaceId: to }, tok(a));
    },
  },
  {
    name: "documents:request",
    need: "write",
    spaces: SHARED,
    run: async (a, sp) => s.call("mutation", "documents:request", { templateId: o.templates[sp], recordId: await o.recordOf(sp, IDS.mem, "إدارة المشاريع") }, tok(a)),
  },
  {
    name: "fill_template (tool)",
    need: "write",
    spaces: SHARED,
    run: async (a, sp) => (f.ids[a] ? tool(s, f.ids[a]!, "fill_template", { templateId: o.templates[sp], recordId: await o.recordOf(sp, IDS.mem, "إدارة المشاريع") }) : fail("anon")),
  },
  {
    // The requester (mem) or a manager, and only after approval.
    name: "documents:issue",
    need: "write",
    spaces: SHARED,
    expect: (a, sp) => expectedAllowed(a, sp, "manage") || (a === "mem" && expectedRole(a, sp) !== null),
    run: async (a, sp) => s.call("action", "documents:issue", { documentId: await docFor(sp, IDS.out, "السلامة المهنية", "approved") }, tok(a)),
  },

  // manage
  {
    name: "records:createSet",
    need: "manage",
    spaces: SPACES,
    run: (a, sp) => s.call("mutation", "records:createSet", { spaceId: f.spaces[sp], name: "x", columns: COLUMNS, subjectColumn: "nid", subjectKind: "nationalId" }, tok(a)),
  },
  { name: "records:previewImport", need: "manage", spaces: SHARED, run: (a, sp) => s.call("action", "records:previewImport", { recordSetId: o.sets[sp], fileName: "a.xlsx", dataBase64: xlsx }, tok(a)) },
  { name: "records:commitImport", need: "manage", spaces: SHARED, run: (a, sp) => s.call("action", "records:commitImport", { recordSetId: o.sets[sp], fileName: "a.xlsx", dataBase64: xlsx }, tok(a)) },
  {
    name: "templates:saveVersion",
    need: "manage",
    spaces: SPACES,
    run: (a, sp) =>
      s.call(
        "action",
        "templates:saveVersion",
        { spaceId: f.spaces[sp], name: "قالب", layout: layoutFor("x"), fieldsSchema: FIELDS, dataBinding: { recordSetId: o.sets[sp === "P_mem" ? "S_plain" : sp], fields: { name: "name", course: "course", date: "date" } } },
        tok(a),
      ),
  },
  { name: "templates:approveVersion", need: "manage", spaces: SHARED, run: (a, sp) => s.call("mutation", "templates:approveVersion", { templateId: o.templates[sp], version: 1 }, tok(a)) },
  { name: "documents:approve", need: "manage", spaces: SHARED, run: async (a, sp) => s.call("mutation", "documents:approve", { documentId: await docFor(sp, IDS.mem, "Excel المتقدم", "draft") }, tok(a)) },
  { name: "documents:reject", need: "manage", spaces: SHARED, run: async (a, sp) => s.call("mutation", "documents:reject", { documentId: await docFor(sp, IDS.ghost, "التفاوض", "draft") }, tok(a)) },
  { name: "artifacts:transfers", need: "manage", spaces: SPACES, run: (a, sp) => s.call("query", "artifacts:transfers", { spaceId: f.spaces[sp] }, tok(a)) },
  {
    name: "artifacts:decideTransfer",
    need: "manage",
    spaces: ["S_sens"],
    run: async (a) => {
      const id = await sensitiveArtifact();
      const transferId = must(await s.call("mutation", "artifacts:requestTransfer", { artifactId: id, toSpaceId: f.spaces.P_mem }, tok("mem")));
      return s.call("mutation", "artifacts:decideTransfer", { transferId, approve: false }, tok(a));
    },
  },
];

describe("Phase 4 permission matrix", () => {
  for (const op of OPS) {
    for (const sp of op.spaces) {
      for (const a of ACTORS) {
        const allowed = op.expect ? op.expect(a, sp) : expectedAllowed(a, sp, op.need);
        test(`${op.name} | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
          const r = await op.run(a, sp);
          if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
          if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
        });
      }
    }
  }
});

describe("Phase 4 workspace-level functions", () => {
  for (const a of ACTORS) {
    const active = !["pend", "dis", "anon"].includes(a);
    test(`admin:setIdentifiers | ${a} → ${a === "admin" ? "allowed" : "denied"}`, async () => {
      const r = await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.rdr, nationalId: IDS.rdr }, tok(a));
      expect(r.ok).toBe(a === "admin");
    });
    test(`records:mine | ${a} → ${active ? "allowed" : "denied"}`, async () => {
      expect((await s.call("query", "records:mine", {}, tok(a))).ok).toBe(active);
    });
    test(`my_records (tool) | ${a} → ${active ? "allowed" : "denied"}`, async () => {
      if (!f.ids[a]) return;
      expect((await tool(s, f.ids[a]!, "my_records", {})).ok).toBe(active);
    });
    test(`templates:suggestLayout | ${a} → ${active ? "allowed" : "denied"}`, async () => {
      expect((await s.call("query", "templates:suggestLayout", { title: "x", fields: FIELDS }, tok(a))).ok).toBe(active);
    });
    test(`artifacts:create (personal, no space) | ${a} → ${active ? "allowed" : "denied"}`, async () => {
      expect((await s.call("mutation", "artifacts:create", { title: "x", kind: "markdown", content: "x" }, tok(a))).ok).toBe(active);
    });
    test(`documents:verify | ${a} → allowed (public, minimal facts)`, async () => {
      const r = must(await s.call("query", "documents:verify", { code: "AAAA-BBBB-CCCC" }, tok(a)));
      expect(r.valid).toBe(false);
    });
  }

  test("every Phase 4 public function is exercised here", async () => {
    const res = await fetch(`${s.url}/_admin/api/functions`, { method: "POST", headers: { Authorization: `Bearer ${s.adminKey}` }, body: "{}" });
    const fns: any[] = (await res.json()).value;
    const publicFns = new Set(fns.filter((x) => x.visibility === "public").map((x) => x.name));
    for (const n of PHASE4_PUBLIC) expect(publicFns.has(n)).toBe(true);
    const exercised = new Set([...OPS.flatMap((o) => o.name.split(/[ +]/).filter((w) => /^[a-z]+:[a-zA-Z]+$/.test(w))), "admin:setIdentifiers", "records:mine", "templates:suggestLayout", "documents:verify"]);
    expect(PHASE4_PUBLIC.filter((n) => !exercised.has(n))).toEqual([]);
    // Tools are internal-only: nothing in tools/ or the harness is callable by a client.
    expect([...publicFns].some((n) => n.startsWith("tools/") || n.startsWith("toolHarness:"))).toBe(false);
  });
});
