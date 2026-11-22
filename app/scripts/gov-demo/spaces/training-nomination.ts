// Training space, «مفاضلة الترشيح لدورات مارس 2027»: run as the space's own people, through the API.
//   bun scripts/gov-demo/spaces/training-nomination.ts setup     # the two input files
//   bun scripts/gov-demo/spaces/training-nomination.ts rank      # ranks them (needs the sandbox)
//   bun scripts/gov-demo/spaces/training-nomination.ts finish    # the committee's list and task
// Set ONESPACE_URL to the server to fill. Every step skips what already exists.
import { join } from "node:path";
import { login, URL_ } from "../lib.ts";

const DIR = join(import.meta.dir, "..", "content", "people", "nomination");
const INPUTS = ["طلبات_الترشيح_مارس_2027.csv", "ضوابط_المفاضلة_مارس_2027.md"];
const RESULT = "نتيجة_المفاضلة_مارس_2027.csv";
const MINUTES = "محضر_مفاضلة_مارس_2027.md";
const LIST = "اعتماد مفاضلة دورات مارس 2027";
const TASK = "اعتماد مفاضلة الترشيح لدورات مارس 2027";

const t = await login("training");
const space = await t.space("التدريب والتطوير");
const files = async () => {
  const r: any = await t.q("files:list", { spaceId: space });
  return (Array.isArray(r) ? r : (r.files ?? r.page)) as any[];
};

const step = process.argv[2];
if (step === "setup") {
  const have = await files();
  for (const name of INPUTS) if (!have.some((f) => f.name === name)) await t.upload(space, join(DIR, name));
  for (const f of (await t.waitIngest(space)) as any[]) console.log(f.state, f.name, f.error ?? "");
} else if (step === "rank") {
  // A fixed script in the platform's sandbox: the chat model only explored the file and never saved a result.
  const have = await files();
  if (!have.some((f) => f.name === RESULT)) {
    const fileIds = [String(idOf(have.find((f) => f.name === INPUTS[0])))];
    const r = await t.a("analysis:run", { code: await Bun.file(join(DIR, "rank_in_sandbox.py")).text(), fileIds, targetSpaceId: space });
    if (!r.ok) throw new Error(r.stderr || r.error);
    console.log(r.stdout, r.outputs.map((o: any) => o.name));
  }
  for (const f of (await t.waitIngest(space)) as any[]) if (f.state !== "ready") console.log(f.state, f.name, f.error ?? "");
} else if (step === "finish") {
  const out = (await files()).find((f) => f.name === RESULT);
  if (!out) throw new Error("run rank first");
  if (!(await t.q("lists:forSpace", { spaceId: space })).lists.some((l: any) => l.title === LIST)) {
    const csv = await download(String(idOf(out)));
    const [head, ...rows] = parse(csv);
    const at = (name: string) => head!.indexOf(name);
    const picked = rows
      .filter((r) => ["مرشح", "احتياطي"].includes(r[at("الحالة")]!))
      .sort((a, b) => a[at("البرنامج")]!.localeCompare(b[at("البرنامج")]!) || +a[at("الترتيب")]! - +b[at("الترتيب")]!);
    const listId = await t.m("lists:create", {
      spaceId: space,
      title: LIST,
      description: "المرشحون والاحتياط من ملف نتيجة المفاضلة. التوصية آلية، والقرار للجنة.",
      columns: [
        { name: "البرنامج", type: "text" },
        { name: "الموظف", type: "text" },
        { name: "الإدارة", type: "text" },
        { name: "الترتيب", type: "number" },
        { name: "المجموع", type: "number" },
        { name: "التوصية", type: "select", options: ["مرشح", "احتياطي"] },
        { name: "قرار اللجنة", type: "select", options: ["بانتظار الاعتماد", "معتمد", "غير معتمد"] },
      ],
    });
    for (const r of picked)
      await t.m("lists:addRow", {
        listId,
        cells: {
          "البرنامج": r[at("البرنامج")],
          "الموظف": r[at("الاسم")],
          "الإدارة": r[at("الإدارة")],
          "الترتيب": +r[at("الترتيب")]!,
          "المجموع": +r[at("المجموع")]!,
          "التوصية": r[at("الحالة")],
          "قرار اللجنة": "بانتظار الاعتماد",
        },
      });
    console.log("list", picked.length);
  }
  if (!JSON.stringify(await t.q("tasks:board", { spaceId: space })).includes(TASK)) {
    await t.m("tasks:create", {
      spaceId: space,
      title: TASK,
      body: `راجع «${MINUTES}» و«${RESULT}»، ثم سجّل القرار في قائمة «${LIST}». التوصية آلية ولا تنفذ قبل الاعتماد.`,
      assigneeIds: [(await login("hr")).userId],
      due: Date.parse("2026-12-03T09:00:00Z"),
    });
    console.log("task");
  }
} else console.log("usage: bun scripts/gov-demo/spaces/training-nomination.ts setup | rank | finish");

function idOf(f: any) {
  return f._id ?? f.id;
}

async function download(fileId: string) {
  const r: any = await t.m("files:requestDownload", { fileId });
  return await (await fetch(new URL(typeof r === "string" ? r : r.url, URL_))).text();
}

function parse(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = csv.replace(/^\uFEFF/, "").replace(/\r/g, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') {
      if (quoted && s[i + 1] === '"') (cell += c), i++;
      else quoted = !quoted;
    } else if (!quoted && c === ",") row.push(cell), (cell = "");
    else if (!quoted && c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else cell += c;
  }
  return rows;
}
