// Government demo — people: «الموارد البشرية» (sensitive) and «التدريب والتطوير».
// Sets the two spaces up the way their owners would, each action as the right persona:
//   bun scripts/gov-demo/spaces/people.ts setup     files, instructions, memory, records, Word templates, tasks, lists, schedule
//   bun scripts/gov-demo/spaces/people.ts chats     the demo conversations (one at a time), logged to content/people/chat-log.json
//   bun scripts/gov-demo/spaces/people.ts chats T3  only the chat with that id
//   bun scripts/gov-demo/spaces/people.ts publish   publishes the training plan page with a feedback form; 5 colleagues answer
// Re-runnable: every step checks what already exists and skips it.
// Content (all fictional) comes from content/people/make_content.py.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { login, type Answer, type Client } from "../lib.ts";

const C = join(import.meta.dir, "..", "content", "people");
const HR_FILES = ["سجل الموظفين 2026.xlsx", "لائحة الإجازات والدوام الرسمي.docx", "دليل إجراءات إصدار التعريفات والشهادات.pdf", "محضر اجتماع لجنة شؤون الموظفين 9-2026.docx", "خطة الاحتياج الوظيفي 2027.xlsx"];
const TR_FILES = ["سياسة التدريب والتطوير.pdf", "الخطة التدريبية 2027.xlsx", "كشف حضور دورة الكتابة الرسمية.xlsx", "نتائج تقييم الدورات 2026.xlsx", "تقرير الاحتياجات التدريبية الربع الثالث 2026.docx"];
const HR = "الموارد البشرية";
const TR = "التدريب والتطوير";

const b64 = (p: string) => readFileSync(p).toString("base64");
const log = (...a: any[]) => console.log("·", ...a);

async function uploadAll(c: Client, spaceId: string, dir: string, names: string[]) {
  const have = new Set(((await c.q("files:list", { spaceId })) as any[]).map((f) => f.name));
  for (const n of names) {
    if (have.has(n)) continue;
    await c.upload(spaceId, join(C, dir, n));
    log("uploaded", n);
  }
  // lib.ts waitIngest reads f.ingest from files:list, which doesn't return it: poll ingest:statuses instead.
  const end = Date.now() + 20 * 60_000;
  for (;;) {
    const st: any[] = await c.q("ingest:statuses", { spaceId });
    const busy = st.filter((x) => x.state === "pending" || x.state === "processing");
    if (!busy.length || Date.now() > end) {
      for (const x of st) log("ingest", x.fileId, x.state, x.chunks ?? "", x.error ?? "");
      return st;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/** Records from an Excel file, as the manager does on the records tab: analyse, accept the guesses, create. */
async function recordsFromFile(c: Client, spaceId: string, path: string, name: string, uniqueOverride?: string[]) {
  const sets: any[] = await c.q("records:sets", { spaceId });
  const existing = sets.find((s) => s.name === name);
  if (existing) return existing._id as string;
  const fileName = path.split("/").pop()!;
  const a: any = await c.a("records:analyzeFile", { spaceId, fileName, dataBase64: b64(path) });
  if (!a.ok) throw new Error("analyze: " + a.errors.join("; "));
  log(`analyze ${fileName}: ${a.rowCount} rows, owner`, JSON.stringify(a.owner), "unique", a.uniqueBy.join("+"), "types", a.columns.map((x: any) => `${x.header}:${x.type}`).join(", "));
  const r: any = await c.a("records:createFromFile", {
    spaceId,
    name,
    fileName,
    dataBase64: b64(path),
    columns: a.columns.map((x: any) => ({ header: x.header, type: x.type, required: x.required })),
    ownerHeader: a.owner.header,
    ownerKind: a.owner.kind,
    uniqueBy: uniqueOverride ?? a.uniqueBy,
  });
  if (!r.ok) throw new Error("create: " + r.errors.join("; "));
  log(`records «${name}»: v${r.version}, ${r.rowCount} rows`);
  return r.recordSetId as string;
}

/** A Word template with {{variables}}: analyse, save, approve (the manager). */
async function wordTemplate(c: Client, spaceId: string, recordSetId: string, file: string, name: string) {
  const list: any[] = await c.q("templates:list", { spaceId });
  const have = list.find((t) => t.name === name);
  const dataBase64 = b64(join(C, "templates", file));
  if (have) {
    // A changed Word file is a new version, approved again (plans/17 §4).
    const versions: any[] = (await c.q("templates:versions", { templateId: have._id })).versions;
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(join(C, "templates", file))).digest("hex");
    // LibreOffice writes new bytes on every make_content run: a new version only when asked.
    if (!process.env.UPDATE_TEMPLATES || versions.some((v) => v.docxSha256 === sha)) return have._id as string;
    const an: any = await c.a("templates:analyzeWord", { spaceId, recordSetId, dataBase64, templateId: have._id });
    const { version } = await c.a("templates:saveWord", { spaceId, recordSetId, dataBase64, name, templateId: have._id });
    await c.m("templates:approveVersion", { templateId: have._id, version });
    log(`template ${name}: new version v${version} approved; missing fonts`, an.missingFonts.join(",") || "none");
    return have._id as string;
  }
  const an: any = await c.a("templates:analyzeWord", { spaceId, recordSetId, dataBase64 });
  log(`template ${name}: vars`, an.variables.map((x: any) => x.name).join("، "), "unmatched", an.unmatched.join("،") || "none", "missing fonts", an.missingFonts.join(",") || "none");
  const { templateId, version } = await c.a("templates:saveWord", { spaceId, recordSetId, dataBase64, name });
  await c.m("templates:approveVersion", { templateId, version });
  log(`template ${name} saved v${version} and approved`);
  return templateId as string;
}

async function ensureList(c: Client, spaceId: string, title: string, description: string, columns: any[], rows: Record<string, any>[]) {
  const lists: any[] = (await c.q("lists:forSpace", { spaceId })).lists;
  if (lists.some((l) => l.title === title)) return;
  const listId = await c.m("lists:create", { spaceId, title, description, columns });
  for (const r of rows) await c.m("lists:addRow", { listId, cells: r });
  log(`list «${title}»: ${rows.length} rows`);
}

async function ensureTask(c: Client, spaceId: string, t: { title: string; body: string; assigneeIds: string[]; due: string; priority?: string }, comments: { by: Client; body: string; mentions?: string[] }[]) {
  const board: any = await c.q("tasks:board", { spaceId });
  const all: any[] = Array.isArray(board) ? board : [...(board.tasks ?? []), ...Object.values(board.columns ?? {}).flat()];
  if (all.some((x: any) => x.title === t.title)) return;
  const taskId = await c.m("tasks:create", { spaceId, title: t.title, body: t.body, assigneeIds: t.assigneeIds, due: Date.parse(t.due + "T09:00:00+03:00"), priority: t.priority ?? "normal" });
  for (const cm of comments) await cm.by.m("tasks:comment", { taskId, body: cm.body, ...(cm.mentions ? { mentions: cm.mentions } : {}) });
  log(`task «${t.title}» (+${comments.length} comments)`);
  return taskId;
}

async function setup() {
  const hr = await login("hr");
  const hrspec = await login("hrspec");
  const training = await login("training");
  const hrId = await hr.space(HR);
  const trId = await training.space(TR);

  // ---------------- الموارد البشرية (manager: hr)
  await uploadAll(hr, hrId, "hr", HR_FILES);
  await hr.m("spaces:setInstructions", {
    spaceId: hrId,
    instructions: [
      "هذه مساحة إدارة الموارد البشرية، وبياناتها سرية (رواتب وأرقام هوية).",
      "- أجب بلغة رسمية موجزة، واذكر المادة ورقمها عند الاستناد إلى اللائحة.",
      "- مصدر بيانات الموظفين هو «سجل الموظفين 2026» (السجلات) فقط، ولا تخمّن رقماً غير موجود فيه.",
      "- عند ذكر أعداد الموظفين فصّلها حسب الإدارة في جدول.",
      "- لا تنقل الرواتب أو أرقام الهوية إلى مخرجات أو قوائم خارج هذه المساحة، ولا تذكرها إلا إذا طُلبت صراحة.",
      "- الخطابات والتعاميم تبدأ بـ«السلام عليكم ورحمة الله وبركاته» وتنتهي بتوقيع «مدير الموارد البشرية».",
    ].join("\n"),
  });
  const mem: any[] = await hr.q("memory:space", { spaceId: hrId }).catch(() => []);
  const memTexts = new Set((Array.isArray(mem) ? mem : (mem as any).items ?? []).map((m: any) => m.text));
  for (const [text, kind] of [
    ["الحد الأعلى للرصيد المرحّل 30 يوماً لمن خدمته أقل من 10 سنوات و45 يوماً لمن خدمته 10 سنوات فأكثر (المادة 6 من لائحة الإجازات).", "fact"],
    ["قررت لجنة شؤون الموظفين (الاجتماع 9-2026) إصدار شهادات التعريف والخبرة من قوالب معتمدة على دفعات باعتماد واحد.", "decision"],
    ["يُحدَّث سجل الموظفين شهرياً من نظام الرواتب قبل اليوم الخامس من كل شهر، وتتولاه ريم الدوسري.", "fact"],
  ] as const)
    if (!memTexts.has(text)) await hr.m("memory:addSpace", { spaceId: hrId, text, kind });

  const staffSet = await recordsFromFile(hr, hrId, join(C, "hr", "سجل الموظفين 2026.xlsx"), "سجل الموظفين");
  await wordTemplate(hr, hrId, staffSet, "قالب شهادة تعريف بالراتب.docx", "شهادة تعريف بالراتب");
  await wordTemplate(hr, hrId, staffSet, "قالب شهادة خبرة.docx", "شهادة خبرة");

  await ensureList(
    hr,
    hrId,
    "طلبات التعريفات والشهادات — نوفمبر",
    "الطلبات الواردة من الموظفين ومتابعة إصدارها",
    [
      { name: "مقدم الطلب", type: "text" },
      { name: "الإدارة", type: "text" },
      { name: "نوع الوثيقة", type: "select", options: ["تعريف بالراتب", "تعريف بدون راتب", "شهادة خبرة", "إخلاء طرف"] },
      { name: "الجهة الموجهة إليها", type: "text" },
      { name: "تاريخ الطلب", type: "date" },
      { name: "الحالة", type: "status", options: ["جديد", "قيد المراجعة", "صدرت", "مرفوض"] },
    ],
    [
      { "مقدم الطلب": "ياسر الحارثي", "الإدارة": "خدمة المستفيدين", "نوع الوثيقة": "تعريف بالراتب", "الجهة الموجهة إليها": "بنك (جهة تمويل)", "تاريخ الطلب": "2026-11-16", "الحالة": "جديد" },
      { "مقدم الطلب": "أمل الغامدي", "الإدارة": "خدمة المستفيدين", "نوع الوثيقة": "تعريف بالراتب", "الجهة الموجهة إليها": "سفارة", "تاريخ الطلب": "2026-11-15", "الحالة": "قيد المراجعة" },
      { "مقدم الطلب": "سلطان المطيري", "الإدارة": "المشتريات والعقود", "نوع الوثيقة": "شهادة خبرة", "الجهة الموجهة إليها": "الهيئة السعودية للمهندسين (مثال)", "تاريخ الطلب": "2026-11-12", "الحالة": "قيد المراجعة" },
      { "مقدم الطلب": "لمى الشمري", "الإدارة": "التخطيط الاستراتيجي", "نوع الوثيقة": "تعريف بدون راتب", "الجهة الموجهة إليها": "مدرسة", "تاريخ الطلب": "2026-11-10", "الحالة": "صدرت" },
      { "مقدم الطلب": "فيصل الحربي", "الإدارة": "تقنية المعلومات", "نوع الوثيقة": "تعريف بالراتب", "الجهة الموجهة إليها": "جهة تمويل عقاري", "تاريخ الطلب": "2026-11-18", "الحالة": "جديد" },
      { "مقدم الطلب": "محمد العنزي", "الإدارة": "الشؤون القانونية", "نوع الوثيقة": "شهادة خبرة", "الجهة الموجهة إليها": "هيئة المحامين (مثال)", "تاريخ الطلب": "2026-11-09", "الحالة": "صدرت" },
    ],
  );

  await ensureTask(
    hr,
    hrId,
    { title: "حصر الموظفين الذين يتجاوز رصيد إجازاتهم 30 يوماً لكل إدارة", body: "تنفيذاً للقرار (1) من محضر لجنة شؤون الموظفين رقم 9-2026: حصر حسب الإدارة من سجل الموظفين، وإعداد خطاب لكل مدير إدارة بأسماء موظفيه لجدولة إجازاتهم (المادة 6 من اللائحة).", assigneeIds: [hrspec.userId], due: "2026-11-25", priority: "high" },
    [
      { by: hr, body: "@ريم الدوسري ابدئي بإدارتي تقنية المعلومات وخدمة المستفيدين، وأرفقي جدولاً بالعدد في كل إدارة.", mentions: [hrspec.userId] },
      { by: hrspec, body: "تم الحصر من السجل عبر المساعد: 28 موظفاً فوق 30 يوماً. أجهّز التعميم الآن وأرفعه للاعتماد." },
    ],
  );
  await ensureTask(
    hr,
    hrId,
    { title: "استيراد سجل الموظفين لشهر ديسمبر من نظام الرواتب", body: "قرار اللجنة (4): يُحدّث السجل قبل اليوم الخامس من كل شهر. كل استيراد نسخة مؤرخة ويُرفض الملف كاملاً إن كان فيه خطأ.", assigneeIds: [hrspec.userId], due: "2026-12-04" },
    [],
  );
  await ensureTask(
    hr,
    hrId,
    { title: "إصدار شهادات التعريف بالراتب المعلقة دفعة واحدة", body: "قرار اللجنة (3): من القالب المعتمد «شهادة تعريف بالراتب»، للطلبات الجديدة في قائمة «طلبات التعريفات والشهادات — نوفمبر».", assigneeIds: [hr.userId, hrspec.userId], due: "2026-11-24", priority: "high" },
    [{ by: hrspec, body: "@عبدالرحمن الشهري جهزت المسودات من المحادثة، تنتظر اعتمادك في «القوالب والمستندات».", mentions: [hr.userId] }],
  );

  const schedules: any[] = await hr.q("schedules:mine").catch(() => []);
  if (!schedules.some((s: any) => s.title === "تقرير أرصدة الإجازات الشهري")) {
    await hr.m("schedules:create", {
      title: "تقرير أرصدة الإجازات الشهري",
      prompt: "من سجل الموظفين: كم موظفاً يتجاوز رصيد إجازاته 30 يوماً في كل إدارة، ومن تجاوز 45 يوماً بالاسم؟ قدّمها في جدول مختصر مع التذكير بالمادة 6 من لائحة الإجازات.",
      spaceId: hrId,
      recurrence: { kind: "monthly", monthDay: 6, time: "08:00" },
    });
    log("schedule: monthly leave report");
  }

  // ---------------- التدريب والتطوير (manager: training)
  await uploadAll(training, trId, "training", TR_FILES);
  await training.m("spaces:setInstructions", {
    spaceId: trId,
    instructions: [
      "مساحة إدارة التدريب والتطوير: الخطة التدريبية، التقييمات، شهادات الحضور، الاختبارات القصيرة.",
      "- استند إلى «سياسة التدريب والتطوير» واذكر رقم المادة.",
      "- شهادة الحضور لمن نسبة حضوره 80% فأكثر فقط (المادة 4)، ويُستخدم عمود «مستحق للشهادة» في السجلات.",
      "- عند تحليل التقييمات: المتوسط العام = متوسط المحتوى والمدرب والفائدة العملية والتنظيم، والدورة دون 3.5 تُراجع.",
      "- اكتب بأسلوب رسمي مختصر، والأرقام بالأرقام العربية الغربية (1، 2، 3).",
    ].join("\n"),
  });
  const tmem: any[] = await training.q("memory:space", { spaceId: trId }).catch(() => []);
  const tmemTexts = new Set((Array.isArray(tmem) ? tmem : (tmem as any).items ?? []).map((m: any) => m.text));
  for (const [text, kind] of [
    ["المستهدف 40 ساعة تدريبية لكل موظف سنوياً، ونسبة الإكمال 63% حتى نهاية سبتمبر 2026.", "fact"],
    ["الاختبارات القصيرة لا تُستخدم في تقييم الأداء الوظيفي (المادة 8).", "fact"],
  ] as const)
    if (!tmemTexts.has(text)) await training.m("memory:addSpace", { spaceId: trId, text, kind });

  const attSet = await recordsFromFile(training, trId, join(C, "training", "كشف حضور دورة الكتابة الرسمية.xlsx"), "حضور الدورات التدريبية");
  await wordTemplate(training, trId, attSet, "قالب شهادة حضور دورة.docx", "شهادة حضور دورة");

  await ensureList(
    training,
    trId,
    "ترشيحات دورات الربع الأول 2027",
    "ترشيحات مديري الإدارات للدورات ذات الأولوية العالية",
    [
      { name: "الموظف", type: "text" },
      { name: "الإدارة", type: "text" },
      { name: "البرنامج", type: "text" },
      { name: "الساعات المنجزة 2026", type: "number" },
      { name: "الحالة", type: "status", options: ["مرشح", "مقبول", "قائمة انتظار", "معتذر"] },
    ],
    [
      { "الموظف": "ياسر الحارثي", "الإدارة": "خدمة المستفيدين", "البرنامج": "إدارة الشكاوى والمواقف الصعبة", "الساعات المنجزة 2026": 19, "الحالة": "مقبول" },
      { "الموظف": "سلطان المطيري", "الإدارة": "المشتريات والعقود", "البرنامج": "نظام المنافسات والمشتريات الحكومية", "الساعات المنجزة 2026": 27, "الحالة": "مرشح" },
      { "الموظف": "لمى الشمري", "الإدارة": "التخطيط الاستراتيجي", "البرنامج": "لوحات المؤشرات Power BI", "الساعات المنجزة 2026": 34, "الحالة": "مقبول" },
      { "الموظف": "ريم الدوسري", "الإدارة": "الموارد البشرية", "البرنامج": "المقابلات الوظيفية القائمة على الكفاءات", "الساعات المنجزة 2026": 22, "الحالة": "مرشح" },
      { "الموظف": "هند الزهراني", "الإدارة": "الشؤون المالية", "البرنامج": "تحليل البيانات باستخدام Excel المتقدم", "الساعات المنجزة 2026": 12, "الحالة": "قائمة انتظار" },
      { "الموظف": "فيصل الحربي", "الإدارة": "تقنية المعلومات", "البرنامج": "الحوسبة السحابية الحكومية", "الساعات المنجزة 2026": 41, "الحالة": "معتذر" },
    ],
  );

  await ensureTask(
    training,
    trId,
    { title: "رفع الخطة التدريبية 2027 بصيغتها النهائية مع التكلفة", body: "قرار لجنة شؤون الموظفين (6): ترفع للرئيس التنفيذي قبل 2026/12/10. المصدر: «الخطة التدريبية 2027» و«تقرير الاحتياجات التدريبية الربع الثالث».", assigneeIds: [training.userId], due: "2026-12-10", priority: "high" },
    [{ by: training, body: "@عبدالرحمن الشهري أحتاج اعتمادك المبدئي على البرامج ذات الأولوية العالية قبل الرفع.", mentions: [hr.userId] }, { by: hr, body: "موافق مبدئياً، مع مراجعة دورة إعداد الميزانية لانخفاض تقييمها." }],
  );
  await ensureTask(
    training,
    trId,
    { title: "إصدار شهادات حضور دورة الكتابة الرسمية لجميع المستحقين", body: "قرار اللجنة (5). المستحقون حسب المادة 4 من السياسة: نسبة حضور 80% فأكثر. دفعة واحدة باعتماد واحد من القالب «شهادة حضور دورة».", assigneeIds: [training.userId, hrspec.userId], due: "2026-11-20", priority: "high" },
    [{ by: training, body: "@ريم الدوسري راجعي كشف الحضور قبل الإصدار، فيه 3 متدربين دون 80%.", mentions: [hrspec.userId] }],
  );
  await ensureTask(
    training,
    trId,
    { title: "نشر اختبار قصير قبل دورة الكتابة الرسمية (تحديد المستوى)", body: "توصية تقرير الاحتياجات (3). خمسة أسئلة، النتائج في قائمة المساحة، ولا تستخدم في تقييم الأداء (المادة 8).", assigneeIds: [training.userId], due: "2026-11-30" },
    [],
  );
  console.log("setup done");
}

// ------------------------------------------------------------------ chats

type Entry = { id: string; account: string; space: string; prompt: string; ms: number | null; wallMs: number; tools: string[]; citations: number; proposals: any[]; text: string; error?: string; threadId: string; note?: string };
const LOG = join(C, "chat-log.json");
const readLog = (): Entry[] => (existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : []);
function save(e: Entry) {
  const all = readLog().filter((x) => x.id !== e.id);
  all.push(e);
  all.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  writeFileSync(LOG, JSON.stringify(all, null, 2));
}

async function turn(id: string, c: Client, account: string, spaceName: string, threadId: string, prompt: string, opts: Parameters<Client["ask"]>[2] = {}) {
  const t0 = Date.now();
  const a: Answer = await c.ask(threadId, prompt, opts);
  const e: Entry = {
    id,
    account,
    space: spaceName,
    prompt,
    ms: a.ms,
    wallMs: Date.now() - t0,
    tools: (a.toolRuns ?? []).map((r) => `${r.name}${r.ok ? "" : "✗"}: ${r.summary ?? ""}`.slice(0, 200)),
    citations: a.citations?.length ?? 0,
    proposals: (a.proposals ?? []).map((p: any) => ({ id: p.id ?? p._id, tool: p.tool, state: p.state ?? p.status })),
    text: a.text,
    error: a.error,
    threadId,
  };
  save(e);
  console.log(`\n=== ${id} [${account}] ${Math.round(e.wallMs / 1000)}s tools=${e.tools.length} cites=${e.citations} proposals=${e.proposals.length}${a.error ? " ERROR " + a.error : ""}\n> ${prompt}\n${a.text.slice(0, 1500)}\n`);
  for (const t of e.tools) console.log("   tool:", t);
  for (const p of e.proposals) console.log("   proposal:", JSON.stringify(p));
  return { a, e };
}

/**
 * «نفّذ» on each card. A confirmed card resumes the same answer (the turn continues with the tool's
 * result), so this waits for it, logs the continuation as "<id>+N", and confirms again if the
 * continuation asks for more (up to `depth` rounds).
 */
async function confirmAll(c: Client, id: string, proposals: any[], threadId?: string, depth = 6): Promise<any[]> {
  const out: any[] = [];
  let lastText = "";
  if (threadId) {
    const r: any = await c.q("chat:messages", { threadId });
    lastText = [...r.messages].reverse().find((m: any) => m.role === "assistant")?.text ?? "";
  }
  for (const p of proposals) {
    const pid = p.id ?? p._id;
    if (!pid) continue;
    try {
      const r = await c.confirm(pid);
      out.push({ tool: p.tool, ok: true, result: typeof r === "string" ? r.slice(0, 2500) : JSON.stringify(r).slice(0, 2500) });
    } catch (err: any) {
      out.push({ tool: p.tool, ok: false, error: String(err.message).slice(0, 300) });
    }
  }
  console.log(`   confirmed (${id}):`, JSON.stringify(out).slice(0, 1500));
  const all = readLog();
  const e = all.find((x) => x.id === id);
  if (e) {
    e.note = [e.note, "confirmed: " + JSON.stringify(out)].filter(Boolean).join(" | ");
    writeFileSync(LOG, JSON.stringify(all, null, 2));
  }
  if (!threadId || depth <= 0) return out;
  // Wait for the resumed answer.
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 4000));
  for (;;) {
    const r: any = await c.q("chat:messages", { threadId });
    const st = r.turn?.state;
    if (!r.turn || st === "done" || st === "failed") {
      const last = [...r.messages].reverse().find((m: any) => m.role === "assistant");
      if (st === "failed" || !last || last.text === lastText) {
        if (st === "failed") console.log(`   continuation failed: ${r.turn.error}`);
        return out;
      }
      const n = (readLog().filter((x) => x.id.startsWith(id + "+")).length ?? 0) + 1;
      const cont: Entry = {
        id: `${id}+${n}`,
        account: e?.account ?? "",
        space: e?.space ?? "",
        prompt: "(«نفّذ» على البطاقة، والمساعد يكمل)",
        ms: last.ms,
        wallMs: Date.now() - t0,
        tools: (last.toolRuns ?? []).map((x: any) => `${x.name}${x.ok ? "" : "✗"}: ${x.summary ?? ""}`.slice(0, 200)),
        citations: last.citations?.length ?? 0,
        proposals: (last.proposals ?? []).map((p: any) => ({ id: p.id ?? p._id, tool: p.tool, state: p.state ?? p.status })),
        text: last.text,
        threadId,
      };
      save(cont);
      console.log(`\n=== ${cont.id} ${Math.round(cont.wallMs / 1000)}s tools=${cont.tools.length} proposals=${cont.proposals.length}\n${last.text.slice(0, 1500)}\n`);
      for (const t of cont.tools) console.log("   tool:", t);
      const pending = (last.proposals ?? []).filter((p: any) => (p.state ?? p.status) === "pending");
      if (pending.length) return [...out, ...(await confirmAll(c, cont.id, pending, threadId, depth - 1))];
      return out;
    }
    if (Date.now() - t0 > 12 * 60_000) {
      console.log("   continuation timeout");
      return out;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * A chat in a space. Space chats are shared with the members by default (plans/14), and in a shared
 * chat the assistant answers only when called (@المساعد / to: "assistant"); lib.ts ask() doesn't
 * send that, so these demo chats are the person's own chats in the space (shared: false).
 */
// The router sent HR-space questions about «لائحة الإجازات» to the built-in «السياسات» agent, which
// only sees «للجميع» spaces, and it answered «لم أجد» (see the scenario's issues). The demo chats
// pick «المساعد العام» in the chat box, as a user would after seeing that.
let generalAgent: string | null = null;
async function spaceChat(c: Client, spaceId: string): Promise<string> {
  generalAgent ??= ((await c.q("agents:available")) as any[]).find((a) => a.isDefault)?._id ?? null;
  const r = await c.m("chat:createThread", { spaceId, shared: false, ...(generalAgent ? { agentId: generalAgent } : {}) });
  return typeof r === "string" ? r : (r.threadId ?? r._id);
}

/**
 * The manager's step in «القوالب والمستندات»: drafts for the chosen rows (if the chat didn't make
 * them), one approval that issues the whole batch, then a public check of one code and a copy of
 * one PDF in content/people/issued/.
 */
async function issueBatch(c: Client, id: string, spaceId: string, templateName: string, pick: (row: Record<string, string>, fields: any[]) => boolean) {
  const t = ((await c.q("templates:list", { spaceId })) as any[]).find((x) => x.name === templateName);
  let r: any = await c.q("documents:rowsForTemplate", { templateId: t._id });
  const label = (row: any) => Object.fromEntries(r.fields.map((f: any) => [f.label, row.data[f.key]]));
  const chosen = r.rows.filter((row: any) => pick(label(row), r.fields));
  const notes: string[] = [];
  const needDraft = chosen.filter((row: any) => row.status === "none").map((row: any) => row.recordId);
  if (needDraft.length) {
    const m: any = await c.m("documents:requestMany", { templateId: t._id, recordIds: needDraft });
    notes.push(`drafts from the documents tab: ${m.created}`);
  }
  r = await c.q("documents:rowsForTemplate", { templateId: t._id });
  const docs = r.rows.filter((row: any) => chosen.some((x: any) => x.recordId === row.recordId) && row.documentId && row.status !== "issued").map((row: any) => row.documentId);
  const t0 = Date.now();
  const out: any = docs.length ? await c.a("documents:approveAndIssue", { documentIds: docs }) : { issued: [], failed: [] };
  notes.push(`approveAndIssue: ${out.issued.length} issued, ${out.failed.length} failed in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (out.failed.length) notes.push("failed: " + JSON.stringify(out.failed.slice(0, 3)));
  const first = out.issued[0];
  if (first) {
    const ver: any = await c.q("documents:verify", { code: first.verifyCode.toLowerCase().replace(/-/g, " ") });
    notes.push(`verify ${first.verifyCode} → ${JSON.stringify(ver).slice(0, 200)}`);
    const fake: any = await c.q("documents:verify", { code: "AAAA-BBBB-CCCC" });
    notes.push(`verify fake code → ${JSON.stringify(fake)}`);
    const url = await c.m("documents:requestDownload", { documentId: first.documentId });
    const res = await fetch((await import("../lib.ts")).URL_ + url);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(C, "issued"), { recursive: true });
    const out2 = join(C, "issued", `${templateName} ${first.serial}.pdf`);
    writeFileSync(out2, Buffer.from(await res.arrayBuffer()));
    notes.push(`saved ${out2.split("/").slice(-2).join("/")} (${res.status})`);
  }
  console.log(`   ${id}.issue:`, notes.join(" | "));
  save({ id: `${id}.issue`, account: c.email, space: "", prompt: `(«القوالب والمستندات»: اعتماد وإصدار دفعة «${templateName}»)`, ms: null, wallMs: Date.now() - t0, tools: [], citations: 0, proposals: [], text: notes.join("\n"), threadId: "", note: JSON.stringify(out.issued.slice(0, 3)) });
  return out;
}

async function chats(only?: string) {
  const want = (id: string) => !only || only.split(",").includes(id);
  const hr = await login("hr");
  const hrspec = await login("hrspec");
  const training = await login("training");
  const hrId = await hr.space(HR);
  const trId = await training.space(TR);

  // H1 — records over the Excel staff file
  if (want("H1")) {
    const t = await spaceChat(hr, hrId);
    await turn("H1", hr, "hr", HR, t, "كم موظفاً رصيد إجازاته فوق 30 يوماً في إدارة تقنية المعلومات؟ اذكر أسماءهم وأرصدتهم.");
    const { a } = await turn("H1b", hr, "hr", HR, t, "حلّل ملف سجل الموظفين 2026: عدد الموظفين الذين يتجاوز رصيدهم 30 يوماً في كل إدارة في جدول، وأسماء من تجاوز 45 يوماً.");
    if (a.proposals?.length) await confirmAll(hr, "H1b", a.proposals, t);
    // H3 — a formal circular from the policy, the minutes and the counts above, saved as an output
    const r3 = await turn("H3", hr, "hr", HR, t, "اكتب تعميماً رسمياً مني إلى مديري الإدارات بشأن جدولة إجازات هؤلاء الموظفين، مستنداً إلى المادة 6 من لائحة الإجازات وقرارَي اللجنة (1) و(2) في محضر الاجتماع 9-2026، وضع فيه جدول العدد لكل إدارة. احفظه مستنداً.");
    if (r3.a.proposals?.length) await confirmAll(hr, "H3", r3.a.proposals, t);
  }
  // H2 — policy + minutes, citations
  if (want("H2")) {
    const t = await spaceChat(hrspec, hrId);
    await turn("H2", hrspec, "hrspec", HR, t, "ما الحد الأعلى للرصيد المرحّل حسب لائحة الإجازات؟ وماذا قررت لجنة شؤون الموظفين بشأن من تجاوزه، ومن المسؤول عن كل قرار؟");
  }
  // H4 — certificates in a batch from the Word template: hr asks, confirms the card, approves and issues once
  if (want("H4")) {
    const t = await spaceChat(hr, hrId);
    const { a } = await turn("H4", hr, "hr", HR, t, "جهّز شهادات تعريف بالراتب لجميع موظفي إدارة خدمة المستفيدين من القالب المعتمد.");
    if (a.proposals?.length) await confirmAll(hr, "H4", a.proposals, t);
  }
  if (want("H4") || want("H4i")) {
    await issueBatch(hr, "H4", hrId, "شهادة تعريف بالراتب", (row) => row["الإدارة"] === "خدمة المستفيدين");
  }
  // H5 — analysis with a chart
  if (want("H5")) {
    const t = await spaceChat(hr, hrId);
    const { a } = await turn("H5", hr, "hr", HR, t, "حلّل ملف سجل الموظفين 2026: متوسط رصيد الإجازات وعدد الموظفين لكل إدارة، مع رسم بياني بالأعمدة لمتوسط الرصيد.");
    if (a.proposals?.length) await confirmAll(hr, "H5", a.proposals, t);
  }
  // H6 — a reader (training) in the sensitive space: may read, must not write
  if (want("H6")) {
    const t = await spaceChat(training, hrId);
    await turn("H6", training, "training", HR, t, "ما مدة إجازة الامتحان حسب اللائحة؟");
    const { a } = await turn("H6b", training, "training", HR, t, "أضف مهمة في هذه المساحة لريم: «تحديث بيانات المتدربين»، وأنشئ قائمة بأسماء موظفي التدريب ورواتبهم.");
    if (a.proposals?.length) await confirmAll(training, "H6b", a.proposals, t);
  }
  // H7 — outsiders: the workspace admin and an employee cannot read HR files
  if (want("H7")) {
    const admin = await login("admin");
    const probe: string[] = [];
    try {
      await admin.q("files:list", { spaceId: hrId });
      probe.push("admin files:list HR → ALLOWED (unexpected)");
    } catch (e: any) {
      probe.push("admin files:list HR → " + String(e.message).slice(0, 120));
    }
    try {
      await admin.q("records:sets", { spaceId: hrId });
      probe.push("admin records:sets HR → ALLOWED (unexpected)");
    } catch (e: any) {
      probe.push("admin records:sets HR → " + String(e.message).slice(0, 120));
    }
    const t = await admin.newChat();
    const { e } = await turn("H7", admin, "admin", "(personal)", t, "كم راتب ريم الدوسري؟ وكم موظفاً في تقنية المعلومات رصيد إجازاته فوق 30 يوماً حسب سجل الموظفين؟");
    e.note = probe.join(" | ");
    save(e);
    const emp = await login("employee");
    const t2 = await emp.newChat();
    await turn("H8", emp, "employee", "(personal)", t2, "ما رواتب زملائي في إدارة خدمة المستفيدين؟ وما محتوى محضر لجنة شؤون الموظفين الأخير؟");
    await turn("H8b", emp, "employee", "(personal)", t2, "ما بياناتي في سجل الموظفين؟ وهل صدرت لي شهادة تعريف بالراتب أو شهادة حضور؟");
  }

  // H9 — the employee's own record and certificate (my_records), in a fresh personal chat with «المساعد العام»
  if (want("H9")) {
    const emp = await login("employee");
    generalAgent ??= ((await emp.q("agents:available")) as any[]).find((a) => a.isDefault)?._id ?? null;
    const r = await emp.m("chat:createThread", { agentId: generalAgent });
    const t = typeof r === "string" ? r : (r.threadId ?? r._id);
    await turn("H9", emp, "employee", "(personal)", t, "أريد شهادة التعريف بالراتب الخاصة بي، هل صدرت؟ وما رصيد إجازاتي؟");
  }
  // T1 — training plan analysis with a chart
  if (want("T1")) {
    const t = await spaceChat(training, trId);
    const { a } = await turn("T1", training, "training", TR, t, "لخّص الخطة التدريبية 2027: عدد البرامج والساعات والتكلفة التقديرية حسب الفئة، مع رسم بياني للتكلفة حسب الفئة.");
    if (a.proposals?.length) await confirmAll(training, "T1", a.proposals, t);
  }
  // T2 — evaluations vs policy
  if (want("T2")) {
    const t = await spaceChat(training, trId);
    const { a } = await turn("T2", training, "training", TR, t, "من نتائج تقييم الدورات 2026: ما الدورات التي يقل متوسط تقييمها العام عن 3.5؟ وماذا تقول سياسة التدريب عنها؟");
    if (a.proposals?.length) await confirmAll(training, "T2", a.proposals, t);
  }
  // T3 — attendance certificates for everyone eligible, one batch
  if (want("T3")) {
    const t = await spaceChat(training, trId);
    const { a } = await turn("T3", training, "training", TR, t, "أصدر شهادات حضور دورة الكتابة الرسمية لجميع المستحقين للشهادة.");
    if (a.proposals?.length) await confirmAll(training, "T3", a.proposals, t);
  }
  if (want("T3") || want("T3i")) {
    const set = ((await training.q("records:sets", { spaceId: trId })) as any[])[0];
    const rows: any = await training.q("records:rows", { recordSetId: set._id, limit: 200 });
    const eligibleCol = set.columns.find((c: any) => c.header === "مستحق للشهادة").key;
    const eligible = new Set(((rows.rows ?? rows) as any[]).filter((r: any) => r.data[eligibleCol] === true).map((r: any) => r.data[set.subjectColumn]));
    await issueBatch(training, "T3", trId, "شهادة حضور دورة", (row) => eligible.has(row["الرقم الوظيفي"]));
  }
  // T4 — a short quiz app published to employees, results in a list
  if (want("T4")) {
    const t = await spaceChat(training, trId);
    const { a } = await turn("T4", training, "training", TR, t, "اعمل اختباراً قصيراً لتحديد المستوى قبل دورة الكتابة الرسمية: 5 أسئلة اختيار من متعدد عن المراسلات الحكومية، يظهر للموظف درجته بعد الإرسال، وتُحفظ النتائج (الاسم، الإدارة، الدرجة) في قائمة في هذه المساحة. انشره لكل موظفي الهيئة.");
    if (a.proposals?.length) await confirmAll(training, "T4", a.proposals, t, 8);
  }
  // T4 again, as the coordinator would after the first attempt: same list, the app's files asked for explicitly.
  if (want("T4b")) {
    const t = await spaceChat(training, trId);
    const { a } = await turn("T4b", training, "training", TR, t, "ابنِ تطبيق اختبار قصير «اختبار تحديد المستوى — الكتابة الرسمية» من الصفر (ليس من مهارة): اكتب ملفاته بنفسك: index.html فيه 5 أسئلة اختيار من متعدد عن المراسلات الحكومية واسم الموظف وإدارته، ومفتاح الإجابات في server/key.json، ومعالج server/mark.py يحسب الدرجة من 5 ويعيدها للموظف ويحفظ الاسم والإدارة والدرجة في قائمة «نتائج اختبار المستوى — الكتابة الرسمية» الموجودة. ثم جرّبه وانشره لكل موظفي الهيئة.");
    if (a.proposals?.length) await confirmAll(training, "T4b", a.proposals, t, 8);
    for (let i = 1; i <= 4; i++) {
      const pubs: any = await training.q("publications:mine").catch(() => ({}));
      if ((pubs.mine ?? []).length + (pubs.pending ?? []).length) break;
      const r = await turn(`T4b.${i}`, training, "training", TR, t, "أكمل الخطوة التالية.");
      if (r.a.proposals?.length) await confirmAll(training, `T4b.${i}`, r.a.proposals, t, 8);
    }
  }
  if (want("T4") || want("T4c")) {
    // The answer stops after each confirmed step; the coordinator says «أكمل» until it is published.
    const t = readLog().find((x) => x.id === "T4")!.threadId;
    for (let i = 1; i <= 5; i++) {
      const pubs: any[] = await training.q("publications:mine").catch(() => []);
      if (((pubs as any).mine ?? []).length + ((pubs as any).pending ?? []).length) break;
      const { a } = await turn(`T4.${i}`, training, "training", TR, t, i === 1 ? "أكمل: ابنِ الاختبار وجرّبه ثم انشره لكل موظفي الهيئة." : "أكمل الخطوة التالية.");
      if (a.proposals?.length) await confirmAll(training, `T4.${i}`, a.proposals, t, 8);
    }
  }
  // T5 — the coordinator's own needs report, corrected, then turned into a skill
  if (want("T5")) {
    // Continues the coordinator's own evaluation chat (T2), where the figures are already computed.
    const t2 = readLog().find((x) => x.id === "T2");
    if (!t2) throw new Error("run T2 first");
    const t = t2.threadId;
    const files: any[] = await training.q("files:list", { spaceId: trId });
    const q3 = files.find((f) => f.name.startsWith("تقرير الاحتياجات"))._id;
    const r5 = await turn("T5", training, "training", TR, t, "ممتاز. اكتب الآن تقرير الاحتياجات التدريبية للربع الرابع 2026 بنفس هيكل @تقرير الاحتياجات التدريبية الربع الثالث وأسلوبه (ملخص تنفيذي، مصادر التحديد، الفجوات حسب الإدارة في جدول، التكلفة التقديرية، المخاطر، التوصيات)، مستنداً إلى نتائج التقييم أعلاه. لا حاجة لتحليل جديد.", { mentions: [{ kind: "file", id: q3 }] });
    if (r5.a.proposals?.length) await confirmAll(training, "T5", r5.a.proposals, t);
    const r5b = await turn("T5b", training, "training", TR, t, "جيد. اختصر الملخص التنفيذي في ثلاثة أسطر بالأرقام، وأضف في جدول الفجوات عمود «التكلفة التقديرية»، واذكر في المخاطر كل دورة تقييمها دون 3.5. لا تستخدم عبارات إنشائية. ثم احفظه مستنداً.");
    if (r5b.a.proposals?.length) await confirmAll(training, "T5b", r5b.a.proposals, t);
  }
  if (want("T6")) {
    // the skill from T5's thread, then reused with /name in a new chat
    const t5 = readLog().find((x) => x.id === "T5");
    if (!t5) throw new Error("run T5 first");
    const skills: any[] = await training.q("skills:list");
    let skill = (Array.isArray(skills) ? skills : (skills as any).mine ?? (skills as any).items ?? []).find((s: any) => s.fromThreadId === t5.threadId || String(s.name).startsWith("تقرير") || String(s.name).startsWith("تقارير"));
    if (!skill) {
      const d: any = await training.a("skills:draftFromThread", { threadId: t5.threadId });
      console.log("skill draft:", JSON.stringify(d).slice(0, 1500));
      const id = await training.m("skills:create", { name: d.name, title: d.title, description: d.description, instructions: d.instructions, fromThreadId: t5.threadId, files: [] });
      skill = { _id: id, ...d };
      save({ id: "T6.skill", account: "training", space: TR, prompt: "(«اجعلها مهارة» من محادثة T5)", ms: null, wallMs: 0, tools: [], citations: 0, proposals: [], text: `/${d.name} — ${d.title}\n${d.description}\n\n${d.instructions}`, threadId: t5.threadId });
    }
    const t = await spaceChat(training, trId);
    const r6 = await turn("T6", training, "training", TR, t, `/${skill.name} للربع الأول 2027، مع التركيز على إدارتي خدمة المستفيدين والمشتريات والعقود.`, { skillId: skill._id });
    if (r6.a.proposals?.length) await confirmAll(training, "T6", r6.a.proposals, t);
  }
  // P2 — the replies to the published plan, read by the coordinator
  if (want("P2")) {
    const t = await spaceChat(training, trId);
    await turn("P2", training, "training", TR, t, "لخّص ردود الزملاء على نموذج الملاحظات المنشور مع «ملخص الخطة التدريبية 2027»: متوسط التقييم، وأبرز الاقتراحات، وما يحتاج قراراً مني.");
  }
  // T6b — the skill used in the chat where the evaluation figures are (T2's), no new analysis needed
  if (want("T6b")) {
    const t2 = readLog().find((x) => x.id === "T2")!;
    const skills: any[] = await training.q("skills:list");
    const skill = skills.find((s: any) => String(s.name).includes("الاحتياجات"));
    const r = await turn("T6b", training, "training", TR, t2.threadId, `/${skill.name} للربع الأول 2027، مع التركيز على إدارتي خدمة المستفيدين والمشتريات والعقود، من نتائج التقييم أعلاه.`, { skillId: skill._id });
    if (r.a.proposals?.length) await confirmAll(training, "T6b", r.a.proposals, t2.threadId);
  }
  // T6c — the skill in a fresh chat with the figures typed in (no analysis step)
  if (want("T6c")) {
    const skills: any[] = await training.q("skills:list");
    const skill = skills.find((s: any) => String(s.name).includes("الاحتياجات"));
    const t = await spaceChat(training, trId);
    const r = await turn("T6c", training, "training", TR, t, `/${skill.name} اكتب تقرير الربع الأول 2027 الآن. المعطيات: إكمال الساعات 71% حتى أكتوبر؛ خدمة المستفيدين: دورة إدارة الشكاوى تقييمها 3.29 و14 معنياً؛ المشتريات والعقود: نظام المنافسات 3.44 و7 معنيين؛ 6 مرشحين من خدمة المستفيدين لدورة القنوات الرقمية؛ تكلفة البرامج المقترحة للربع 148,000 ريال.`, { skillId: skill._id });
    if (r.a.proposals?.length) await confirmAll(training, "T6c", r.a.proposals, t);
  }
  // T7 — a member (hrspec) follows up in the training space
  if (want("T7")) {
    const t = await spaceChat(hrspec, trId);
    const r7 = await turn("T7", hrspec, "hrspec", TR, t, "من سجل حضور الدورات التدريبية: من غير المستحق لشهادة دورة الكتابة الرسمية، ولماذا حسب سياسة التدريب؟");
    if (r7.a.proposals?.length) await confirmAll(hrspec, "T7", r7.a.proposals, t);
  }
}

/**
 * The training plan summary (an output from chat T1) published to every employee with a feedback
 * form, and colleagues answering it through the published page, as they would in a browser:
 * #/open/<slug> gives a one-time ticket, the page sets its cookie, the form posts to /f/<slug>.
 */
async function publishPlan() {
  const training = await login("training");
  const trId = await training.space(TR);
  const arts: any[] = await training.q("artifacts:list", { spaceId: trId });
  const art = arts.find((a) => a.title.startsWith("ملخص الخطة التدريبية 2027"));
  if (!art) throw new Error("run T1 first (its HTML output is what is published)");
  let pubs: any = await training.q("publications:forArtifact", { artifactId: art._id });
  let pub = (pubs.publications ?? pubs ?? []).find?.((p: any) => p.state !== "revoked");
  if (!pub) {
    const r: any = await training.m("publications:publish", { artifactId: art._id, audience: "workspace" });
    await training.m("publications:addFeedbackForm", { publicationId: r.id });
    log("published", r.url, r.state);
    pubs = await training.q("publications:forArtifact", { artifactId: art._id });
    pub = (pubs.publications ?? pubs).find((p: any) => p.state !== "revoked");
  }
  const slug = pub.slug ?? String(pub.url).split("/p/")[1];
  const answers: [string, string, string][] = [
    ["employee", "4 جيد جداً", "أتمنى أن تكون دورة إدارة الشكاوى في الربع الأول، فهي الأهم لخدمة المستفيدين."],
    ["hrspec", "5 ممتاز", "الخطة واضحة، وأقترح إضافة دورة في المقابلات الوظيفية للمديرين الجدد."],
    ["hr", "4 جيد جداً", "يُراجع محتوى دورة إعداد الميزانية قبل طرحها لانخفاض تقييمها."],
    ["office", "3 جيد", "تكلفة البرامج القيادية مرتفعة (252 ألفاً)؛ نحتاج تبريراً لها."],
    ["care", "5 ممتاز", "نرشح 6 موظفين لدورة خدمة العملاء عبر القنوات الرقمية."],
  ];
  const notes: string[] = [];
  for (const [key, rating, comment] of answers) {
    const c = await login(key);
    try {
      const ticketUrl: string = await c.m("publications:openTicket", { slug });
      const r1 = await fetch(ticketUrl, { redirect: "manual" });
      const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
      const base = new URL(ticketUrl).origin;
      const page = await (await fetch(`${base}/p/${slug}`, { headers: { cookie } })).text();
      const token = page.match(/name="_t" value="([^"]+)"/)?.[1];
      if (!token) {
        notes.push(`${key}: no form token (${page.includes("أرسلت ردك") ? "answered already" : "page without form"})`);
        continue;
      }
      const body = new URLSearchParams({ _t: token, f_c1: rating, f_c2: comment });
      const r2 = await fetch(`${base}/f/${slug}`, { method: "POST", body, headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" }, redirect: "manual" });
      notes.push(`${key}: ${r2.status} → ${r2.headers.get("location")}`);
    } catch (e: any) {
      notes.push(`${key}: ${String(e.message).slice(0, 160)}`);
    }
  }
  console.log(notes.join("\n"));
  save({ id: "P1", account: "training", space: TR, prompt: "(نشر «ملخص الخطة التدريبية 2027» لكل الموظفين مع نموذج ملاحظات، و5 زملاء يردّون من الرابط)", ms: null, wallMs: 0, tools: [], citations: 0, proposals: [], text: notes.join("\n"), threadId: "", note: `slug=${slug}` });
}

/** «نفّذ» on the cards still pending in a logged chat (e.g. after a run was stopped). */
async function confirmPending(id: string, key: string) {
  const e = readLog().find((x) => x.id === id);
  if (!e) throw new Error("no log entry " + id);
  const c = await login(key);
  const r: any = await c.q("chat:messages", { threadId: e.threadId });
  const pending = r.messages.flatMap((m: any) => m.proposals ?? []).filter((p: any) => p.state === "pending");
  await confirmAll(c, id, pending, e.threadId);
}

const [mode, only, key] = process.argv.slice(2);
if (mode === "setup") await setup();
else if (mode === "confirm") await confirmPending(only!, key!);
else if (mode === "publish") await publishPlan();
else if (mode === "chats") await chats(only);
else console.log("usage: bun scripts/gov-demo/spaces/people.ts setup | chats [ID,ID]");
