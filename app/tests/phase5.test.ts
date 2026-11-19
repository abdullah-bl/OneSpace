// Phase 5 acceptance: sandbox (through the run_analysis tool and the UI action) and ranking,
// against a real onebase server and a real sandbox-runner with Docker.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { addFile, buildFixture, type Fixture } from "./fixture";
import { xlsxBase64 } from "./outputsFixture";
import { makeXlsx, sandboxAvailable, startRunner, type Runner } from "./sandbox";

const HAS_SANDBOX = await sandboxAvailable();
if (!HAS_SANDBOX) console.warn("[phase5] Docker or onespace-sandbox image missing: sandbox tests skipped");

let s: Server;
let f: Fixture;
let runner: Runner | undefined;

beforeAll(async () => {
  if (HAS_SANDBOX) runner = await startRunner();
  s = await new Server().start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  await runner?.stop();
});

const T = 90_000;

/** run_analysis.run() with a ToolContext, exactly as the agent loop calls it. */
function tool(actor: string, args: any, scopeSpaceIds?: string[]) {
  return s.adminRun("analysis:runToolAs", { userId: f.ids[actor], args, ...(scopeSpaceIds ? { scopeSpaceIds } : {}) });
}

async function audit(action: string, userId: string) {
  return must(await s.call("query", "audit:list", { userId, limit: 500 }, f.tokens.admin)).filter((r: any) => r.action === action);
}

async function uploadBytes(token: string, bytes: Uint8Array, name: string, spaceId: string, type = "application/octet-stream") {
  const u = must(await s.call("mutation", "files:generateUploadUrl", {}, token));
  const res = await fetch(u, { method: "POST", headers: { "Content-Type": type }, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
  const { storageId } = (await res.json()) as any;
  return must(await s.call("mutation", "files:create", { storageId, name, spaceId }, token)) as string;
}

describe.skipIf(!HAS_SANDBOX)("sandbox: run_analysis tool", () => {
  let csvPlain: string;
  beforeAll(async () => {
    csvPlain = await addFile(s, f.tokens.mgr!, f.spaces.S_plain, "عروض.csv", "item,price\nA,10\nB,30\n");
  });

  test(
    "runs code on a picked file; stdout comes back, /output becomes files in the space, the run is recorded and audited",
    async () => {
      const code = `
import pandas as pd, matplotlib.pyplot as plt, onespace
df = pd.read_csv("/input/عروض.csv")
print("TOTAL", df["price"].sum())
df.to_csv("/output/summary.csv", index=False)
onespace.arabic_plots(); plt.bar(df["item"], df["price"]); plt.title(onespace.ar("الأسعار")); plt.savefig("/output/chart.png")
`;
      const r = must(await tool("mem", { code, fileIds: [csvPlain] }));
      expect(r.content).toContain("نجح");
      expect(r.content).toContain("TOTAL 40");
      expect(r.spaceIds).toEqual([f.spaces.S_plain]);
      const ids = [...r.content.matchAll(/fileId: (\w+)/g)].map((m: any) => m[1]);
      expect(ids.length).toBe(2);
      const listed = must(await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, f.tokens.mem));
      expect(listed.map((x: any) => x.name)).toEqual(expect.arrayContaining(["summary.csv", "chart.png"]));
      const dl = await s.get(`/download?fileId=${ids.find((id: string) => listed.find((x: any) => x._id === id)?.name === "summary.csv")}`, f.tokens.mem);
      expect(dl.text).toContain("B,30");
      const runs = must(await s.call("query", "analysis:myRuns", {}, f.tokens.mem));
      const run = must(await s.call("query", "analysis:getRun", { runId: runs[0]._id }, f.tokens.mem));
      expect(run).toMatchObject({ kind: "sandbox", status: "done", code, spaceId: f.spaces.S_plain });
      expect(run.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(run.inputs[0]).toMatchObject({ fileId: csvPlain, name: "عروض.csv" });
      expect(run.inputs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(run.outputs.length).toBe(2);
      expect(run.limits).toMatchObject({ memoryMb: 2048, cpus: 2, pids: 64 });
      expect(run.exit).toMatchObject({ code: 0, timedOut: false, oomKilled: false });
      expect((await audit("sandbox.export", f.ids.mem!)).some((a: any) => a.resourceId === csvPlain)).toBe(true);
      expect((await audit("sandbox.run", f.ids.mem!)).some((a: any) => a.detail.runId === run._id)).toBe(true);
      // someone else can't see this run
      expect((await s.call("query", "analysis:getRun", { runId: run._id }, f.tokens.mgr)).ok).toBe(false);
    },
    T,
  );

  test(
    "viewable outputs also become artifacts (artifactVersions.runId), next to the files; artifactIds are returned",
    async () => {
      const code = `
import pandas as pd, matplotlib.pyplot as plt, onespace
df = pd.read_csv("/input/عروض.csv")
df.to_csv("/output/summary.csv", index=False)
open("/output/report.md", "w").write("# تقرير\\n\\nالمجموع 40")
open("/output/raw.json", "w").write("{}")
onespace.arabic_plots(); plt.bar(df["item"], df["price"]); plt.savefig("/output/chart.png")
`;
      const r = must(await tool("mem", { code, fileIds: [csvPlain] }));
      expect(r.artifactIds.length).toBe(3); // csv → table, md → markdown, png → markdown image; json stays a file only
      expect(r.content).toContain(`artifactId=${r.artifactIds[0]}`);
      const runs = must(await s.call("query", "analysis:myRuns", {}, f.tokens.mem));
      expect(runs[0].artifactIds).toEqual(r.artifactIds);
      expect(runs[0].outputs.length).toBe(4);
      const listed = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.S_plain }, f.tokens.rdr));
      const mine = listed.filter((a: any) => r.artifactIds.includes(a._id));
      expect(mine.map((a: any) => [a.title, a.kind, a.classification]).sort()).toEqual([
        ["chart.png", "markdown", "normal"],
        ["report.md", "markdown", "normal"],
        ["summary.csv", "table", "normal"],
      ]);
      for (const id of r.artifactIds) {
        const v = must(await s.call("query", "artifacts:versions", { artifactId: id }, f.tokens.mem));
        expect(v.versions[0].runId).toBe(runs[0]._id);
      }
      const table = must(await s.call("mutation", "artifacts:open", { artifactId: mine.find((a: any) => a.title === "summary.csv")._id }, f.tokens.mem));
      expect(JSON.parse(table.content)).toEqual({ columns: ["item", "price"], rows: [["A", "10"], ["B", "30"]] }); // CSV cells stay text, as in the file
      const chart = must(await s.call("mutation", "artifacts:open", { artifactId: mine.find((a: any) => a.title === "chart.png")._id }, f.tokens.mem));
      expect(chart.content).toStartWith("![chart.png](data:image/png;base64,");
      const created = (await audit("artifact.create", f.ids.mem!)).filter((a: any) => r.artifactIds.includes(a.resourceId));
      expect(created.map((a: any) => a.detail.via)).toEqual(["sandbox", "sandbox", "sandbox"]);
      // the UI action returns them too
      const ui = must(await s.call("action", "analysis:run", { code: "open('/output/t.csv','w').write('a\\n1\\n')", fileIds: [csvPlain] }, f.tokens.mem));
      expect(ui.artifactIds.length).toBe(1);
    },
    T,
  );

  test(
    "run artifacts follow Phase 4 placement: sensitive inputs make sensitive artifacts; several spaces → personal",
    async () => {
      const out = "open('/output/t.csv','w').write('a\\n1\\n')";
      // sensitive input, default target = the sensitive space; classified sensitive
      const sens = must(await tool("mem", { code: out, fileIds: [f.files.S_sens] }));
      expect(sens.spaceIds).toEqual([f.spaces.S_sens]);
      const inSens = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.S_sens }, f.tokens.mem)).find((a: any) => a._id === sens.artifactIds[0]);
      expect(inSens).toMatchObject({ classification: "sensitive", spaceId: f.spaces.S_sens });
      // its manager may send outputs elsewhere; they stay classified sensitive, so a member can't move them on
      const exported = must(await tool("mgr", { code: out, fileIds: [f.files.S_sens], targetSpaceId: f.spaces.S_plain }));
      const inPlain = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.S_plain }, f.tokens.mem)).find((a: any) => a._id === exported.artifactIds[0]);
      expect(inPlain).toMatchObject({ classification: "sensitive", spaceId: f.spaces.S_plain });
      const moved = await s.call("mutation", "artifacts:move", { artifactId: exported.artifactIds[0], toSpaceId: f.spaces.P_mem }, f.tokens.mem);
      expect(moved.ok ? "" : moved.error).toContain("حسّاسة");
      // sensitive mixed with another space: refused before anything is exported
      expect((await tool("mgr", { code: out, fileIds: [f.files.S_sens, csvPlain] })).ok).toBe(false);
      // inputs from several spaces: personal space by default, and a shared target is refused (plans/02 rule 4)
      const multi = must(await tool("mem", { code: out, fileIds: [csvPlain, f.files.S_every] }));
      expect(multi.spaceIds).toContain(f.spaces.P_mem);
      expect(must(await s.call("query", "artifacts:list", { spaceId: f.spaces.P_mem }, f.tokens.mem)).some((a: any) => a._id === multi.artifactIds[0])).toBe(true);
      const shared = await tool("mem", { code: out, fileIds: [csvPlain, f.files.S_every], targetSpaceId: f.spaces.S_plain });
      expect(shared.ok).toBe(false);
    },
    T,
  );

  test(
    "inside the container: no network (not even OneBase), no database, no files outside /input",
    async () => {
      const port = new URL(s.url).port;
      const code = `
import os, socket, json
res = {}
def tcp(h, p):
    try:
        socket.create_connection((h, p), timeout=3).close(); return True
    except Exception:
        return False
res["onebase_local"] = tcp("127.0.0.1", ${port})
res["onebase_bridge"] = tcp("172.17.0.1", ${port})
res["internet"] = tcp("1.1.1.1", 443)
res["data_dir"] = os.path.exists(${JSON.stringify(s.dataDir)})
res["sqlite"] = [p for p in ["/data", "/onebase_data", ${JSON.stringify(s.dataDir)}] if os.path.exists(p)]
res["input"] = sorted(os.listdir("/input"))
res["root"] = sorted(os.listdir("/"))
print(json.dumps(res))
`;
      const r = must(await tool("mem", { code, fileIds: [csvPlain] }));
      const res = JSON.parse(r.content.match(/\{.*\}/)![0]);
      expect(res.onebase_local).toBe(false);
      expect(res.onebase_bridge).toBe(false);
      expect(res.internet).toBe(false);
      expect(res.data_dir).toBe(false);
      expect(res.sqlite).toEqual([]);
      expect(res.input).toEqual(["عروض.csv"]); // only the picked file, not the rest of the space
    },
    T,
  );

  test(
    "can't export data the user can't read, or outside the turn's scope",
    async () => {
      const before = (await audit("sandbox.export", f.ids.out!)).length;
      // non-member
      expect((await tool("out", { code: "print(1)", fileIds: [f.files.S_plain] })).ok).toBe(false);
      // someone else's personal file, even for the workspace admin
      expect((await tool("admin", { code: "print(1)", fileIds: [f.files.P_mem] })).ok).toBe(false);
      expect((await tool("mgr", { code: "print(1)", fileIds: [f.files.P_mem] })).ok).toBe(false);
      // disabled and pending accounts
      expect((await tool("dis", { code: "print(1)", fileIds: [f.files.S_plain] })).ok).toBe(false);
      expect((await tool("pend", { code: "print(1)", fileIds: [f.files.S_every] })).ok).toBe(false);
      // readable but not in this turn's scope (agent data scope / scope chips)
      expect((await tool("mem", { code: "print(1)", fileIds: [f.files.S_plain] }, [f.spaces.P_mem])).ok).toBe(false);
      // one bad file poisons the whole request: nothing is exported
      expect((await tool("out", { code: "print(1)", fileIds: [f.files.S_every, f.files.S_sens] })).ok).toBe(false);
      // a made-up id
      expect((await tool("mem", { code: "print(1)", fileIds: ["not-an-id"] })).ok).toBe(false);
      expect((await audit("sandbox.export", f.ids.out!)).length).toBe(before);
      // the public action applies the same checks with the session's identity
      expect((await s.call("action", "analysis:run", { code: "print(1)", fileIds: [f.files.S_plain] }, f.tokens.out)).ok).toBe(false);
      expect((await s.call("action", "analysis:run", { code: "print(1)", fileIds: [f.files.S_plain] })).ok).toBe(false);
    },
    T,
  );

  test(
    "outputs need write access to the target, and sensitive inputs keep their outputs in their space",
    async () => {
      // reader of an "everyone" space can analyse it, but not write into it…
      expect((await tool("rdr", { code: "print(1)", fileIds: [f.files.S_every], targetSpaceId: f.spaces.S_every })).ok).toBe(false);
      // …so by default outputs go to their personal space
      const ok = must(await tool("rdr", { code: "open('/output/x.txt','w').write('x')", fileIds: [f.files.S_every] }));
      const rdrSpaces = must(await s.call("query", "spaces:mine", {}, f.tokens.rdr));
      const personal = rdrSpaces.find((x: any) => x.kind === "personal")._id;
      expect(ok.spaceIds).toContain(personal);
      // sensitive → personal: refused for a member, allowed into the sensitive space itself
      const sens = await tool("mem", { code: "print(1)", fileIds: [f.files.S_sens], targetSpaceId: f.spaces.P_mem });
      expect(sens.ok).toBe(false);
      expect(sens.ok ? "" : sens.error).toContain("حسّاسة");
      expect((await tool("mem", { code: "print(1)", fileIds: [f.files.S_sens] })).ok).toBe(true);
      expect((await tool("rdr", { code: "print(1)", fileIds: [f.files.S_sens] })).ok).toBe(false);
      // the manager of the sensitive space may take outputs elsewhere
      expect((await tool("mgr", { code: "print(1)", fileIds: [f.files.S_sens], targetSpaceId: f.spaces.S_plain })).ok).toBe(true);
    },
    T,
  );

  test(
    "an infinite loop and a memory bomb are killed within limits; OneBase keeps serving",
    async () => {
      const t0 = Date.now();
      const loop = must(await tool("mem", { code: "while True: pass", fileIds: [], timeoutSeconds: 2 }));
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(loop.content).toContain("الحد الزمني");
      const bomb = must(await tool("mem", { code: "x = []\nwhile True: x.append(bytearray(64 * 1024 * 1024))", fileIds: [] }));
      expect(bomb.content).toContain("حد الذاكرة");
      const runs = must(await s.call("query", "analysis:myRuns", {}, f.tokens.mem));
      expect(runs[0].exit).toMatchObject({ oomKilled: true });
      expect(runs[1].exit).toMatchObject({ timedOut: true });
      expect(runs[0].status).toBe("failed");
      expect((await fetch(`${s.url}/api/health`)).ok).toBe(true);
      expect(must(await s.call("query", "spaces:mine", {}, f.tokens.mem)).length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "the UI action returns structured results",
    async () => {
      const r = must(await s.call("action", "analysis:run", { code: "print('مرحبا')\nopen('/output/a.txt','w').write('1')", fileIds: [f.files.P_mem] }, f.tokens.mem));
      expect(r).toMatchObject({ ok: true, exitCode: 0, targetSpaceId: f.spaces.P_mem });
      expect(r.stdout.trim()).toBe("مرحبا");
      expect(r.outputs.map((o: any) => o.name)).toEqual(["a.txt"]);
    },
    T,
  );
});

// ---------- ranking ----------

const SPEC = {
  name: "مفاضلة القبول",
  idField: "رقم الهوية",
  nameField: "الاسم",
  criteria: [
    { field: "المعدل", label: "المعدل التراكمي", weight: 60, direction: "desc", min: 0, max: 5 },
    { field: "الاختبار", label: "درجة الاختبار", weight: 30, direction: "desc", min: 0, max: 100 },
    { field: "الغياب", label: "أيام الغياب", weight: 10, direction: "asc", min: 0, max: 20 },
  ],
  tieBreak: [{ field: "الاختبار", direction: "desc" }],
};
const CSV = "رقم الهوية,الاسم,المعدل,الاختبار,الغياب\n103,سارة,4.5,80,2\n101,أحمد,4.5,80,2\n102,خالد,٤٫٥,٩٠,12\n104,منى,5,,0\n105,ريم,4,100,0\n";

describe("ranking", () => {
  let criteriaId: string;
  let csvId: string;
  let runId: string;

  beforeAll(async () => {
    csvId = await addFile(s, f.tokens.mgr!, f.spaces.S_sens, "طلاب.csv", CSV);
  });

  test("criteria: drafted by a member, approved by the manager, then frozen; changes are new versions", async () => {
    criteriaId = must(await s.call("mutation", "ranking:createCriteria", { spaceId: f.spaces.S_sens, ...SPEC }, f.tokens.mem));
    // no run on unapproved criteria
    expect((await s.call("action", "ranking:createRun", { criteriaId, fileId: csvId }, f.tokens.mem)).ok).toBe(false);
    expect((await s.call("mutation", "ranking:approveCriteria", { criteriaId }, f.tokens.mem)).ok).toBe(false);
    must(await s.call("mutation", "ranking:approveCriteria", { criteriaId }, f.tokens.mgr));
    expect((await s.call("mutation", "ranking:updateCriteria", { criteriaId, ...SPEC, name: "x" }, f.tokens.mgr)).ok).toBe(false);
    const list = must(await s.call("query", "ranking:listCriteria", { spaceId: f.spaces.S_sens }, f.tokens.rdr));
    expect(list[0]).toMatchObject({ status: "approved", version: 1, totalWeight: 100 });
    const v2 = must(await s.call("mutation", "ranking:newCriteriaVersion", { criteriaId }, f.tokens.mem));
    const again = must(await s.call("mutation", "ranking:newCriteriaVersion", { criteriaId }, f.tokens.mem));
    expect(again).toBe(v2); // one draft at a time
    const all = must(await s.call("query", "ranking:listCriteria", { spaceId: f.spaces.S_sens }, f.tokens.mem));
    expect(all.find((c: any) => c._id === v2)).toMatchObject({ version: 2, status: "draft", seriesId: list[0].seriesId });
    // invalid specs are refused (no zero weights, no empty scales)
    const bad = { ...SPEC, criteria: [{ ...SPEC.criteria[0], weight: 0 }] };
    expect((await s.call("mutation", "ranking:createCriteria", { spaceId: f.spaces.S_sens, ...bad }, f.tokens.mem)).ok).toBe(false);
  });

  test("a run ranks a snapshot of the file; the numbers follow the formula", async () => {
    runId = must(await s.call("action", "ranking:createRun", { criteriaId, fileId: csvId }, f.tokens.mem));
    const run = must(await s.call("query", "ranking:getRun", { rankingRunId: runId }, f.tokens.rdr));
    expect(run).toMatchObject({ status: "draft", criteriaVersion: 1, count: 5, algorithm: "onespace-ranking/1", source: { name: "طلاب.csv", version: 1 } });
    expect(run.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.results.map((r: any) => [r.key, r.rank, r.total])).toEqual([
      ["105", 1, 88], // 48 + 30 + 10
      ["101", 2, 87], // 54 + 24 + 9, same as 103 on total and tie-break → shared rank, id order
      ["103", 2, 87],
      ["102", 4, 85], // 54 + 27 + 4
      ["104", 5, 70], // 60 + 0 (missing exam) + 10
    ]);
    const ranking = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, f.tokens.mgr)).filter((a: any) => a.action === "ranking.run");
    expect(ranking.some((a: any) => a.resourceId === runId)).toBe(true);
  });

  test("re-running on the same snapshot gives literally the same numbers", async () => {
    const first = must(await s.call("query", "ranking:getRun", { rankingRunId: runId }, f.tokens.mem));
    const rerunId = must(await s.call("action", "ranking:rerun", { rankingRunId: runId }, f.tokens.mem));
    const second = must(await s.call("query", "ranking:getRun", { rankingRunId: rerunId }, f.tokens.mem));
    expect(second.snapshotHash).toBe(first.snapshotHash);
    expect(second.criteriaHash).toBe(first.criteriaHash);
    expect(second.resultsHash).toBe(first.resultsHash);
    expect(JSON.stringify(second.results)).toBe(JSON.stringify(first.results));
    // and a fresh run from the same file reproduces the same snapshot and results
    const third = must(await s.call("query", "ranking:getRun", { rankingRunId: must(await s.call("action", "ranking:createRun", { criteriaId, fileId: csvId }, f.tokens.mem)) }, f.tokens.mem));
    expect(third.snapshotHash).toBe(first.snapshotHash);
    expect(third.resultsHash).toBe(first.resultsHash);
    // the per-student justification is identical too
    const j1 = must(await s.call("query", "ranking:justification", { rankingRunId: runId, key: "102" }, f.tokens.mem));
    const j2 = must(await s.call("query", "ranking:justification", { rankingRunId: rerunId, key: "102" }, f.tokens.mem));
    expect(JSON.stringify(j2.breakdown)).toBe(JSON.stringify(j1.breakdown));
  });

  test("draft → human approval; approved runs are immutable and a correction is a new run", async () => {
    expect((await s.call("mutation", "ranking:approveRun", { rankingRunId: runId }, f.tokens.mem)).ok).toBe(false);
    must(await s.call("mutation", "ranking:approveRun", { rankingRunId: runId }, f.tokens.mgr));
    const approved = must(await s.call("query", "ranking:getRun", { rankingRunId: runId }, f.tokens.mem));
    expect(approved).toMatchObject({ status: "approved", approvedByName: "موظف mgr" });
    expect((await s.call("mutation", "ranking:approveRun", { rankingRunId: runId }, f.tokens.mgr)).ok).toBe(false);
    // correction: a new criteria version (exam weight 40, absence 0→ removed) re-run on the same snapshot
    const v2 = must(await s.call("mutation", "ranking:newCriteriaVersion", { criteriaId }, f.tokens.mem));
    must(await s.call("mutation", "ranking:updateCriteria", { criteriaId: v2, ...SPEC, criteria: SPEC.criteria.slice(0, 2).map((c, i) => ({ ...c, weight: i === 0 ? 60 : 40 })) }, f.tokens.mem));
    expect((await s.call("action", "ranking:rerun", { rankingRunId: runId, criteriaId: v2 }, f.tokens.mem)).ok).toBe(false); // not approved yet
    must(await s.call("mutation", "ranking:approveCriteria", { criteriaId: v2 }, f.tokens.mgr));
    const fixId = must(await s.call("action", "ranking:rerun", { rankingRunId: runId, criteriaId: v2 }, f.tokens.mem));
    const fix = must(await s.call("query", "ranking:getRun", { rankingRunId: fixId }, f.tokens.mem));
    expect(fix).toMatchObject({ status: "draft", criteriaVersion: 2, correctsRunId: runId, snapshotHash: approved.snapshotHash });
    expect(fix.resultsHash).not.toBe(approved.resultsHash);
    // the approved run did not change
    expect(JSON.stringify(must(await s.call("query", "ranking:getRun", { rankingRunId: runId }, f.tokens.mem)))).toBe(JSON.stringify(approved));
  });

  test("justification page per student: their data, the formula, their points, their rank", async () => {
    const j = must(await s.call("query", "ranking:justification", { rankingRunId: runId, key: "102" }, f.tokens.rdr));
    expect(j.student).toMatchObject({ key: "102", name: "خالد", rank: 4, of: 5, total: 85, maxTotal: 100, sharedWith: 0 });
    expect(j.data).toEqual([
      { field: "رقم الهوية", value: "102" },
      { field: "الاسم", value: "خالد" },
      { field: "المعدل", value: "٤٫٥" },
      { field: "الاختبار", value: "٩٠" },
      { field: "الغياب", value: "12" },
    ]);
    expect(j.formula).toContain("الوزن × (القيمة − الحد الأدنى) ÷ (الحد الأعلى − الحد الأدنى)");
    expect(j.breakdown.map((b: any) => b.explanation)).toEqual([
      "المعدل التراكمي: 60 × (4.5 − 0) ÷ (5 − 0) = 54",
      "درجة الاختبار: 30 × (90 − 0) ÷ (100 − 0) = 27",
      "أيام الغياب: 10 × (20 − 12) ÷ (20 − 0) = 4",
    ]);
    expect(j.totalLine).toBe("54 + 27 + 4 = 85");
    expect(j.run).toMatchObject({ status: "approved", criteriaName: "مفاضلة القبول", criteriaVersion: 1 });
    expect(j.run.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const tied = must(await s.call("query", "ranking:justification", { rankingRunId: runId, key: "101" }, f.tokens.rdr));
    expect(tied.student).toMatchObject({ rank: 2, sharedWith: 1 });
    const missing = must(await s.call("query", "ranking:justification", { rankingRunId: runId, key: "104" }, f.tokens.rdr));
    expect(missing.breakdown[1]).toMatchObject({ missing: true, points: 0 });
    expect(missing.breakdown[1].explanation).toContain("لا توجد قيمة رقمية");
    // outsiders see nothing
    expect((await s.call("query", "ranking:justification", { rankingRunId: runId, key: "102" }, f.tokens.out)).ok).toBe(false);
    expect((await s.call("query", "ranking:justification", { rankingRunId: runId, key: "999" }, f.tokens.rdr)).ok).toBe(false);
  });

  test("XLSX input; data must be in the criteria's space; missing columns are named", async () => {
    const xlsx = makeXlsx([
      ["رقم الهوية", "الاسم", "المعدل", "الاختبار", "الغياب"],
      ["201", "هند", 3, 70, 1],
      ["202", "فهد", 4, 60, 5],
    ]);
    const xId = await uploadBytes(f.tokens.mgr!, xlsx, "طلاب.xlsx", f.spaces.S_sens);
    const id = must(await s.call("action", "ranking:createRun", { criteriaId, fileId: xId }, f.tokens.mgr));
    const run = must(await s.call("query", "ranking:getRun", { rankingRunId: id }, f.tokens.mgr));
    // هند: 36 + 21 + 9.5 = 66.5 ; فهد: 48 + 18 + 7.5 = 73.5
    expect(run.results.map((r: any) => [r.key, r.total])).toEqual([
      ["202", 73.5],
      ["201", 66.5],
    ]);
    const elsewhere = await addFile(s, f.tokens.mgr!, f.spaces.S_plain, "طلاب.csv", CSV);
    const e1 = await s.call("action", "ranking:createRun", { criteriaId, fileId: elsewhere }, f.tokens.mgr);
    expect(e1.ok).toBe(false);
    const noCols = await addFile(s, f.tokens.mgr!, f.spaces.S_sens, "ناقص.csv", "رقم الهوية,الاسم\n1,أ\n");
    const e2 = await s.call("action", "ranking:createRun", { criteriaId, fileId: noCols }, f.tokens.mgr);
    expect(e2.ok ? "" : e2.error).toContain("المعدل");
  });

  describe("input from an imported record set (Phase 4 records)", () => {
    const COLS = [
      { key: "nid", header: "رقم الهوية", type: "text", required: true },
      { key: "name", header: "الاسم", type: "text", required: true },
      { key: "gpa", header: "المعدل", type: "number", required: true },
      { key: "exam", header: "الاختبار", type: "number", required: false },
      { key: "absence", header: "الغياب", type: "number", required: true },
    ];
    // the same students as CSV, in the same order
    const ROWS = [
      ["103", "سارة", 4.5, 80, 2],
      ["101", "أحمد", 4.5, 80, 2],
      ["102", "خالد", 4.5, 90, 12],
      ["104", "منى", 5, null, 0],
      ["105", "ريم", 4, 100, 0],
    ];
    const newSet = async (spaceKey: "S_sens" | "S_plain", rows: unknown[][] = ROWS) => {
      const id = must(await s.call("mutation", "records:createSet", { spaceId: f.spaces[spaceKey], name: `طلاب-سجلات-${spaceKey}`, columns: COLS, subjectColumn: "nid", subjectKind: "nationalId" }, f.tokens.mgr));
      must(await s.call("action", "records:commitImport", { recordSetId: id, fileName: "طلاب.xlsx", dataBase64: await xlsxBase64(COLS.map((c) => c.header), rows) }, f.tokens.mgr));
      return id as string;
    };
    let setId: string;
    beforeAll(async () => {
      setId = await newSet("S_sens");
    });

    test("ranks the current import version; same numbers as the file; snapshot hash is deterministic", async () => {
      const id = must(await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId }, f.tokens.mem));
      const run = must(await s.call("query", "ranking:getRun", { rankingRunId: id }, f.tokens.rdr));
      expect(run).toMatchObject({ status: "draft", count: 5, source: { kind: "records", recordSetId: setId, name: "طلاب-سجلات-S_sens", version: 1, fileId: null } });
      expect(run.results.map((r: any) => [r.key, r.rank, r.total])).toEqual([
        ["105", 1, 88],
        ["101", 2, 87],
        ["103", 2, 87],
        ["102", 4, 85],
        ["104", 5, 70],
      ]);
      // a second run on the same version: byte-identical snapshot and results
      const again = must(await s.call("query", "ranking:getRun", { rankingRunId: must(await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId, recordVersion: 1 }, f.tokens.mem)) }, f.tokens.mem));
      expect(again.snapshotHash).toBe(run.snapshotHash);
      expect(again.resultsHash).toBe(run.resultsHash);
      // rerun verifies the stored snapshot by hash and reproduces the results
      const rerun = must(await s.call("query", "ranking:getRun", { rankingRunId: must(await s.call("action", "ranking:rerun", { rankingRunId: id }, f.tokens.mem)) }, f.tokens.mem));
      expect(rerun).toMatchObject({ snapshotHash: run.snapshotHash, resultsHash: run.resultsHash, correctsRunId: id });
      // the justification shows the student's data as imported
      const j = must(await s.call("query", "ranking:justification", { rankingRunId: id, key: "102" }, f.tokens.rdr));
      expect(j.student).toMatchObject({ rank: 4, total: 85 });
      expect(j.run.source).toMatchObject({ kind: "records", version: 1 });
      // the run is recorded in `runs` with the set (no file) and audited
      const audit = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, f.tokens.mgr)).filter((a: any) => a.action === "ranking.run");
      expect(audit.some((a: any) => a.resourceId === id && a.detail.snapshotHash === run.snapshotHash)).toBe(true);
    });

    test("a new import is a new version: the default follows it, an older version can still be named", async () => {
      const v1 = must(await s.call("query", "ranking:getRun", { rankingRunId: must(await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId }, f.tokens.mem)) }, f.tokens.mem));
      must(await s.call("action", "records:commitImport", { recordSetId: setId, fileName: "طلاب2.xlsx", dataBase64: await xlsxBase64(COLS.map((c) => c.header), [...ROWS.slice(0, 4), ["105", "ريم", 3, 100, 0]]) }, f.tokens.mgr));
      const v2 = must(await s.call("query", "ranking:getRun", { rankingRunId: must(await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId }, f.tokens.mem)) }, f.tokens.mem));
      expect(v2.source.version).toBe(2);
      expect(v2.snapshotHash).not.toBe(v1.snapshotHash);
      const old = must(await s.call("query", "ranking:getRun", { rankingRunId: must(await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId, recordVersion: 1 }, f.tokens.mem)) }, f.tokens.mem));
      expect(old.snapshotHash).toBe(v1.snapshotHash);
      expect((await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId, recordVersion: 3 }, f.tokens.mem)).ok).toBe(false);
    });

    test("same-space rule and read access: a set in another space, or one the user can't read, is refused", async () => {
      const plainSet = await newSet("S_plain");
      const e1 = await s.call("action", "ranking:createRun", { criteriaId, recordSetId: plainSet }, f.tokens.mgr);
      expect(e1.ok ? "" : e1.error).toContain("مساحة المعايير نفسها");
      // readers can't run (write on the criteria's space); outsiders get "not found"
      expect((await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId }, f.tokens.rdr)).ok).toBe(false);
      expect((await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId }, f.tokens.out)).ok).toBe(false);
      // exactly one source
      expect((await s.call("action", "ranking:createRun", { criteriaId }, f.tokens.mem)).ok).toBe(false);
      expect((await s.call("action", "ranking:createRun", { criteriaId, recordSetId: setId, fileId: csvId }, f.tokens.mem)).ok).toBe(false);
      expect((await s.call("action", "ranking:createRun", { criteriaId, recordSetId: "not-an-id" }, f.tokens.mem)).ok).toBe(false);
      // an empty set (nothing imported yet)
      const empty = must(await s.call("mutation", "records:createSet", { spaceId: f.spaces.S_sens, name: "فارغة", columns: COLS, subjectColumn: "nid", subjectKind: "nationalId" }, f.tokens.mgr));
      const e2 = await s.call("action", "ranking:createRun", { criteriaId, recordSetId: empty }, f.tokens.mem);
      expect(e2.ok ? "" : e2.error).toContain("لم تُستورد");
    });
  });
});
