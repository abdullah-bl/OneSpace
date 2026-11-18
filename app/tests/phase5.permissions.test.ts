// Permission matrix for every Phase 5 public function: (actor × space kind × action) against
// the independent role model in fixture.ts. Sandbox cases need Docker + the image; without them
// only those operations are skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, addFile, buildFixture, expectedAllowed, expectedRole, SPACES, type ActorKey, type Fixture, type SpaceKey } from "./fixture";
import { sandboxAvailable, startRunner, type Runner } from "./sandbox";

const HAS_SANDBOX = await sandboxAvailable();

let s: Server;
let f: Fixture;
let runner: Runner | undefined;

const CSV = "id,name,score\n1,أ,90\n2,ب,80\n";
const SPEC = {
  name: "معايير",
  idField: "id",
  nameField: "name",
  criteria: [{ field: "score", label: "الدرجة", weight: 100, direction: "desc", min: 0, max: 100 }],
  tieBreak: [],
};

/** Per space: a data file, an approved criteria version, a draft one, and a ranking run. */
const setup = {} as Record<SpaceKey, { owner: string; file: string; approved: string; draft: string; run: string }>;

beforeAll(async () => {
  if (HAS_SANDBOX) runner = await startRunner();
  s = await new Server().start();
  f = await buildFixture(s);
  for (const sp of SPACES) {
    const owner = sp === "P_mem" ? f.tokens.mem! : f.tokens.mgr!;
    const file = await addFile(s, owner, f.spaces[sp], "data.csv", CSV);
    const approved = must(await s.call("mutation", "ranking:createCriteria", { spaceId: f.spaces[sp], ...SPEC }, owner));
    must(await s.call("mutation", "ranking:approveCriteria", { criteriaId: approved }, owner));
    const draft = must(await s.call("mutation", "ranking:createCriteria", { spaceId: f.spaces[sp], ...SPEC, name: "مسودة" }, owner));
    const run = must(await s.call("action", "ranking:createRun", { criteriaId: approved, fileId: file }, owner));
    setup[sp] = { owner, file, approved, draft, run };
  }
}, 120_000);

afterAll(async () => {
  await s?.stop();
  await runner?.stop();
});

const tok = (a: ActorKey) => f.tokens[a];

type Rule = (a: ActorKey, sp: SpaceKey) => boolean;
const need = (n: "read" | "write"): Rule => (a, sp) => expectedAllowed(a, sp, n);
/** Approving criteria/runs: the space's managers, or the owner of a personal space. */
const approver: Rule = (a, sp) => ["manager", "owner"].includes(expectedRole(a, sp) ?? "");
/** Analysing a file: read it; outputs default to its space if writable, else the personal space — which a sensitive space forbids. */
const analyseFrom: Rule = (a, sp) => expectedAllowed(a, sp, sp === "S_sens" ? "write" : "read");

type Op = { name: string; allowed: Rule; sandbox?: boolean; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> };

const OPS: Op[] = [
  { name: "ranking:listCriteria", allowed: need("read"), run: (a, sp) => s.call("query", "ranking:listCriteria", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "ranking:listRuns", allowed: need("read"), run: (a, sp) => s.call("query", "ranking:listRuns", { spaceId: f.spaces[sp] }, tok(a)) },
  { name: "ranking:getRun", allowed: need("read"), run: (a, sp) => s.call("query", "ranking:getRun", { rankingRunId: setup[sp].run }, tok(a)) },
  { name: "ranking:justification", allowed: need("read"), run: (a, sp) => s.call("query", "ranking:justification", { rankingRunId: setup[sp].run, key: "1" }, tok(a)) },
  { name: "ranking:createCriteria", allowed: need("write"), run: (a, sp) => s.call("mutation", "ranking:createCriteria", { spaceId: f.spaces[sp], ...SPEC, name: `by-${a}` }, tok(a)) },
  { name: "ranking:updateCriteria", allowed: need("write"), run: (a, sp) => s.call("mutation", "ranking:updateCriteria", { criteriaId: setup[sp].draft, ...SPEC, name: "مسودة" }, tok(a)) },
  { name: "ranking:newCriteriaVersion", allowed: need("write"), run: (a, sp) => s.call("mutation", "ranking:newCriteriaVersion", { criteriaId: setup[sp].approved }, tok(a)) },
  {
    name: "ranking:approveCriteria",
    allowed: approver,
    run: async (a, sp) => {
      const id = must(await s.call("mutation", "ranking:createCriteria", { spaceId: f.spaces[sp], ...SPEC, name: "للاعتماد" }, setup[sp].owner));
      return s.call("mutation", "ranking:approveCriteria", { criteriaId: id }, tok(a));
    },
  },
  { name: "ranking:createRun", allowed: need("write"), run: (a, sp) => s.call("action", "ranking:createRun", { criteriaId: setup[sp].approved, fileId: setup[sp].file }, tok(a)) },
  { name: "ranking:rerun", allowed: need("write"), run: (a, sp) => s.call("action", "ranking:rerun", { rankingRunId: setup[sp].run }, tok(a)) },
  {
    name: "ranking:approveRun",
    allowed: approver,
    run: async (a, sp) => {
      const id = must(await s.call("action", "ranking:rerun", { rankingRunId: setup[sp].run }, setup[sp].owner));
      return s.call("mutation", "ranking:approveRun", { rankingRunId: id }, tok(a));
    },
  },
  { name: "analysis:run (input from the space)", allowed: analyseFrom, sandbox: true, run: (a, sp) => s.call("action", "analysis:run", { code: "print(1)", fileIds: [setup[sp].file] }, tok(a)) },
  { name: "analysis:run (outputs into the space)", allowed: need("write"), sandbox: true, run: (a, sp) => s.call("action", "analysis:run", { code: "print(1)", fileIds: [], targetSpaceId: f.spaces[sp] }, tok(a)) },
];

describe("phase 5 permission matrix", () => {
  for (const op of OPS) {
    for (const sp of SPACES) {
      for (const a of ACTORS) {
        const allowed = op.allowed(a, sp);
        test.skipIf(!!op.sandbox && !HAS_SANDBOX)(`${op.name} | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
          const r = await op.run(a, sp);
          if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
          if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
        }, 60_000);
      }
    }
  }
});

describe("phase 5 workspace-level functions", () => {
  for (const a of ACTORS) {
    const allowed = !["pend", "dis", "anon"].includes(a);
    test(`analysis:myRuns | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
      expect((await s.call("query", "analysis:myRuns", {}, tok(a))).ok).toBe(allowed);
    });
  }

  test.skipIf(!HAS_SANDBOX)("analysis:getRun: only the user who ran it", async () => {
    const r = must(await s.call("action", "analysis:run", { code: "print(1)", fileIds: [setup.S_every.file] }, f.tokens.rdr));
    for (const a of ACTORS) {
      const got = await s.call("query", "analysis:getRun", { runId: r.runId }, tok(a));
      expect([a, got.ok]).toEqual([a, a === "rdr"]);
    }
  }, 60_000);

  test("approved runs and criteria can't be changed by anyone", async () => {
    const sp = "S_plain";
    must(await s.call("mutation", "ranking:approveRun", { rankingRunId: setup[sp].run }, f.tokens.mgr));
    for (const a of ACTORS) {
      expect((await s.call("mutation", "ranking:approveRun", { rankingRunId: setup[sp].run }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "ranking:updateCriteria", { criteriaId: setup[sp].approved, ...SPEC, name: "x" }, tok(a))).ok).toBe(false);
      expect((await s.call("mutation", "ranking:approveCriteria", { criteriaId: setup[sp].approved }, tok(a))).ok).toBe(false);
    }
  });
});
