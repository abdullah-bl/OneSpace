// A skill saved from a chat keeps what made the answer (plans/09 §2): the Python that ran there
// (rerun unchanged on new files, INPUTS in fileIds order) and the last output the assistant wrote.
// Nothing built on a sensitive space leaves it this way.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { addFile, buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { sandboxAvailable, startRunner, type Runner } from "./sandbox";
import { generalizeInputs, inputsPreamble } from "../onebase/skills";

const HAS_SANDBOX = await sandboxAvailable();

let ai: FakeAI;
let s: Server;
let f: Fixture;
let runner: Runner | undefined;
const tok = (a: string) => (f.tokens as any)[a] as string;

beforeAll(async () => {
  if (HAS_SANDBOX) runner = await startRunner();
  ai = startFakeAI();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
  await runner?.stop();
});

const setInstr = async (space: "S_plain" | "S_sens", instructions: string) => must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces[space], instructions }, tok("mgr")));

/** One message in a thread; any card it raises is confirmed by the asker. Returns the thread's messages. */
async function say(token: string, threadId: string, text: string) {
  must(await s.call("mutation", "chat:send", { to: "assistant", threadId, text }, token));
  const confirmed = new Set<string>();
  for (let i = 0; i < 1600; i++) {
    const r = must(await s.call("query", "chat:messages", { threadId }, token));
    const pending = r.messages.flatMap((m: any) => m.proposals ?? []).filter((p: any) => p.state === "pending" && !confirmed.has(p.id));
    for (const p of pending) {
      confirmed.add(p.id);
      must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, token));
    }
    if (!pending.length && !r.turn && r.messages.at(-1)?.role === "assistant") return r.messages as any[];
    await Bun.sleep(25);
  }
  throw new Error("no answer");
}
const newThread = async (token: string, spaceId?: string) => must(await s.call("mutation", "chat:createThread", spaceId ? { spaceId } : {}, token)) as string;
const call = (name: string, args: unknown) => `CALL_TOOL ${name} ${JSON.stringify(args)}`;

describe("generalizing a script's inputs", () => {
  test("file names in string literals become INPUTS[i]; f-strings and other text stay", () => {
    const code = `import pandas as pd\na = pd.read_csv("/input/درجات.csv")\nb = pd.read_excel('بيانات 2.xlsx')\nc = f"/input/درجات.csv"\nprint("درجات.csv في النص")`;
    const out = generalizeInputs(code, ["درجات.csv", "بيانات 2.xlsx"]);
    expect(out).toContain("pd.read_csv(INPUTS[0])");
    expect(out).toContain("pd.read_excel(INPUTS[1])");
    expect(out).toContain('f"/input/درجات.csv"');
    expect(out).toContain('print("درجات.csv في النص")');
    expect(inputsPreamble(["a.csv", 'b"x.csv'])).toBe('INPUTS = ["/input/a.csv", "/input/b\\"x.csv"]  # files of this run, in order\n');
  });
});

describe.skipIf(!HAS_SANDBOX)("a space skill made from a chat, rerun on new data", () => {
  const CODE = "import pandas as pd\ndf = pd.read_csv('/input/درجات.csv')\nprint('TOTAL', int(df['x'].sum()) * 2)";

  test(
    "the run's code is kept with the skill and the same code runs on a new file",
    async () => {
      const first = await addFile(s, tok("mgr"), f.spaces.S_plain, "درجات.csv", "x\n1\n2\n");
      const t = await newThread(tok("mem"), f.spaces.S_plain);
      try {
        await setInstr("S_plain", call("run_analysis", { code: CODE, fileIds: [first] }));
        await say(tok("mem"), t, "احسب الدرجات FL-1");
        await setInstr("S_plain", call("create_skill", { name: "files-1", description: "حساب الدرجات", instructions: "رتّب ثم احسب", scope: "space" }));
        await say(tok("mem"), t, "احفظها مهارة للمساحة FL-2");
      } finally {
        await setInstr("S_plain", "");
      }
      const v = must(await s.call("query", "skills:space", { spaceId: f.spaces.S_plain }, tok("mgr")));
      const p = v.proposals.find((x: any) => x.name === "files-1");
      expect(p.files.map((x: any) => x.name)).toEqual(["script.py"]);
      expect(p.files[0].inputs).toEqual(["درجات.csv"]);
      expect(p.files[0].content).toContain("pd.read_csv(INPUTS[0])");
      expect(p.files[0].content).not.toContain("/input/درجات.csv");
      must(await s.call("mutation", "skills:reviewSpace", { skillId: p._id, approve: true }, tok("mgr")));

      // Next time, on other data: the model names the skill's script; the code comes from the skill.
      const second = await addFile(s, tok("mgr"), f.spaces.S_plain, "دفعة 2.csv", "x\n10\n20\n30\n");
      const t2 = await newThread(tok("mem"), f.spaces.S_plain);
      try {
        await setInstr("S_plain", call("run_analysis", { skill: "files-1", script: "script.py", code: "print('ignored')", fileIds: [second] }));
        await say(tok("mem"), t2, "طبّق المهارة FL-3");
      } finally {
        await setInstr("S_plain", "");
      }
      const runs = must(await s.call("query", "analysis:myRuns", {}, tok("mem")));
      const run = must(await s.call("query", "analysis:getRun", { runId: runs[0]._id }, tok("mem")));
      expect(run.skill).toMatchObject({ name: "files-1", version: 1, script: "script.py" });
      expect(run.code.startsWith('INPUTS = ["/input/دفعة 2.csv"]')).toBe(true);
      expect(run.code).not.toContain("ignored");
      expect(run.stdout).toContain("TOTAL 120");
      // The skill index tells the model this skill carries a saved script.
      expect(ai.requests.some((r) => JSON.stringify(r.body.messages ?? []).includes("FL-3") && JSON.stringify(r.body.messages).includes("/files-1: حساب الدرجات (مهارة المساحة"))).toBe(true);
      expect(ai.requests.some((r) => JSON.stringify(r.body.messages ?? []).includes("FL-3") && JSON.stringify(r.body.messages).includes("فيها سكربت محفوظ"))).toBe(true);
    },
    180_000,
  );

  test(
    "a run on a sensitive space is not kept in a personal skill",
    async () => {
      const file = await addFile(s, tok("mgr"), f.spaces.S_sens, "سري.csv", "x\n5\n");
      const t = await newThread(tok("mem"), f.spaces.S_sens);
      try {
        await setInstr("S_sens", call("run_analysis", { code: "import pandas as pd\nprint(pd.read_csv('/input/سري.csv')['x'].sum())", fileIds: [file] }));
        await say(tok("mem"), t, "احسب FL-4");
        await setInstr("S_sens", call("create_skill", { name: "files-sens", instructions: "احسب المجموع" }));
        await say(tok("mem"), t, "احفظها مهارة FL-5");
      } finally {
        await setInstr("S_sens", "");
      }
      const mine = must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x.name === "files-sens");
      expect(mine).toBeTruthy();
      expect(mine.files).toEqual([]);
    },
    180_000,
  );
});

describe("an output the assistant wrote becomes the example", () => {
  test("create_artifact in the chat, then create_skill: example.md is kept; the editor can drop it", async () => {
    const t = await newThread(tok("mem"), f.spaces.S_plain);
    try {
      await setInstr("S_plain", call("create_artifact", { title: "منهج", kind: "markdown", content: "# الوحدة الأولى\n## الأهداف\n- هدف EXM-1" }));
      await say(tok("mem"), t, "اكتب منهجاً FL-6");
      await setInstr("S_plain", call("create_skill", { name: "files-doc", instructions: "اكتب منهجاً بنفس الأقسام" }));
      await say(tok("mem"), t, "احفظها مهارة FL-7");
    } finally {
      await setInstr("S_plain", "");
    }
    const sk = must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x.name === "files-doc");
    expect(sk.files.map((x: any) => [x.name, x.kind])).toEqual([["example.md", "example"]]);
    expect(sk.files[0].content).toContain("هدف EXM-1");

    // /name puts the example's shape in the prompt.
    const t2 = await newThread(tok("mem"));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t2, text: "/files-doc منهج جديد FL-8", skillId: sk._id }, tok("mem")));
    for (let i = 0; i < 800 && !ai.requests.some((r) => JSON.stringify(r.body.messages ?? []).includes("FL-8")); i++) await Bun.sleep(25);
    await Bun.sleep(200);
    expect(ai.requests.filter((r) => JSON.stringify(r.body.messages ?? []).includes("FL-8")).map((r) => JSON.stringify(r.body.messages)).join()).toContain("نموذج المخرج example.md");

    must(await s.call("mutation", "skills:update", { skillId: sk._id, name: sk.name, title: sk.title, description: sk.description, instructions: sk.instructions, keepFiles: [] }, tok("mem")));
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x.name === "files-doc").files).toEqual([]);
  }, 60_000);

  test("a skill shared to the space takes its files along", async () => {
    const sk = must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x.name === "files-sens");
    if (!sk) return; // made by the sandbox test
    const r = must(await s.call("mutation", "skills:shareToSpace", { skillId: sk._id, spaceId: f.spaces.S_plain }, tok("mem")));
    const v = must(await s.call("query", "skills:space", { spaceId: f.spaces.S_plain }, tok("mem")));
    expect(v.proposals.find((x: any) => x._id === r.id).files).toEqual(sk.files);
  });
});
