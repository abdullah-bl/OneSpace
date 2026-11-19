// Permission matrix for every Phase 5 public function: (actor × space kind × action) against
// the independent role model in fixture.ts. Sandbox cases need Docker + the image; without them
// only those operations are skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, addFile, buildFixture, expectedAllowed, SPACES, type ActorKey, type Fixture, type SpaceKey } from "./fixture";
import { sandboxAvailable, startRunner, type Runner } from "./sandbox";

const HAS_SANDBOX = await sandboxAvailable();

let s: Server;
let f: Fixture;
let runner: Runner | undefined;

const CSV = "id,name,score\n1,أ,90\n2,ب,80\n";
/** Per space: a data file to analyse. */
const setup = {} as Record<SpaceKey, { owner: string; file: string }>;

beforeAll(async () => {
  if (HAS_SANDBOX) runner = await startRunner();
  s = await new Server().start();
  f = await buildFixture(s);
  for (const sp of SPACES) {
    const owner = sp === "P_mem" ? f.tokens.mem! : f.tokens.mgr!;
    setup[sp] = { owner, file: await addFile(s, owner, f.spaces[sp], "data.csv", CSV) };
  }
}, 120_000);

afterAll(async () => {
  await s?.stop();
  await runner?.stop();
});

const tok = (a: ActorKey) => f.tokens[a];

type Rule = (a: ActorKey, sp: SpaceKey) => boolean;
const need = (n: "read" | "write"): Rule => (a, sp) => expectedAllowed(a, sp, n);
/** Analysing a file: read it; outputs default to its space if writable, else the personal space — which a sensitive space forbids. */
const analyseFrom: Rule = (a, sp) => expectedAllowed(a, sp, sp === "S_sens" ? "write" : "read");

type Op = { name: string; allowed: Rule; sandbox?: boolean; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> };

const OPS: Op[] = [
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

});
