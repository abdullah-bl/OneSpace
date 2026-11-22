// Government demo — «المالية والمشتريات» (sensitive; manager finance, procure member, strategy reader)
// and «التخطيط الاستراتيجي والأداء» (manager strategy, office member, finance reader).
// Sets both spaces up as their real owners would, through the public API (same permissions, same
// audit log as the web client). Re-runnable: each step skips what already exists.
//   cd app && bun scripts/gov-demo/spaces/numbers.ts setup     # files, instructions, memory, records, template, documents, tasks, lists, schedule
//   cd app && bun scripts/gov-demo/spaces/numbers.ts chats     # the persona chats (slow: one at a time), log in content/numbers/chats.json
//   cd app && bun scripts/gov-demo/spaces/numbers.ts chats 3   # only chat #3
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Answer, type Client, login } from "../lib.ts";

const DIR = join(import.meta.dir, "..", "content", "numbers");
const FIN = "المالية والمشتريات";
const STR = "التخطيط الاستراتيجي والأداء";
const f = (name: string) => join(DIR, name);
const b64 = (name: string) => readFileSync(f(name)).toString("base64");
const DAY = 86_400_000;
const at = (iso: string) => new Date(`${iso}T12:00:00+03:00`).getTime();

const FIN_FILES = [
  "لائحة_الصلاحيات_المالية_وإجراءات_الشراء.docx",
  "الميزانية_مقابل_الفعلي_2025.xlsx",
  "طلبات_الشراء_2026.xlsx",
  "كراسة_الشروط_منافسة_2026-14_نظام_إدارة_الوثائق.pdf",
  "عرض_شركة_الأفق_الرقمي.pdf",
  "عرض_مؤسسة_سحابة_الإتقان.docx",
  "عرض_شركة_البيانات_المتقدمة.pdf",
];
const STR_FILES = [
  "الخطة_الاستراتيجية_2025-2027.pdf",
  "مؤشرات_الأداء_2026.xlsx",
  "سجل_المبادرات_الاستراتيجية_2026.xlsx",
  "محضر_لجنة_الأداء_المؤسسي_الربع_الثالث_2026.docx",
  "دليل_إعداد_تقرير_الأداء_الربعي.docx",
];

const FIN_INSTRUCTIONS = `هذه مساحة إدارة المالية والمشتريات (مساحة حساسة: لا تُنقل بياناتها خارجها).
- المرجع الحاكم لأي سؤال عن الصلاحيات والحدود هو «لائحة الصلاحيات المالية وإجراءات الشراء»؛ اذكر رقم المادة دائماً.
- المبالغ بالريال السعودي، بفواصل الآلاف (مثال: 1,250,000 ريال)، والنسب بمنزلة عشرية واحدة.
- عند تحليل الميزانية: احسب نسبة التنفيذ = المصروف الفعلي ÷ الاعتماد × 100، وأبرز البنود التي تجاوزت 100% أو قلّت عن 70% (المادة الخامسة عشرة).
- عند تقييم العروض: استبعد أولاً العرض غير المستوفي لأي متطلب إلزامي في كراسة الشروط، ثم طبّق الأوزان (فني 70 / مالي 30) والحد الأدنى الفني 60 من 100.
- عند مراجعة طلبات الشراء: نبّه إلى أي طلب «شراء مباشر» تتجاوز قيمته 100,000 ريال دون استثناء موثّق (المادة السادسة).
- المخرجات الرسمية (ملخص تنفيذي، محضر تقييم) بلغة عربية رسمية مختصرة، تبدأ بالخلاصة ثم التفاصيل.`;

const STR_INSTRUCTIONS = `هذه مساحة التخطيط الاستراتيجي والأداء.
- مصادر الحقيقة: «مؤشرات_الأداء_2026» (المستهدفات والفعلي الربعي)، «سجل المبادرات»، «الخطة الاستراتيجية 2025–2027»، ومحاضر لجنة الأداء.
- صنّف المؤشرات وفق الخطة: متحقق ≥ 95% من المستهدف، تحت المراقبة 85% إلى أقل من 95%، متعثر < 85%. للمؤشرات التي الأقل فيها أفضل: نسبة التحقق = المستهدف ÷ الفعلي.
- اتبع «دليل إعداد تقرير الأداء الربعي» في هيكل أي تقرير ربعي: ملخص تنفيذي، الأداء حسب الهدف، المؤشرات المتعثرة (السبب، الخطة، المالك، الموعد)، المبادرات المتأخرة، القرارات المطلوبة.
- اذكر مالك كل مؤشر متعثر بالاسم، ولا تخترع سبباً غير موثّق: اكتب «بانتظار تفسير المالك».`;

const FIN_MEMORY: [string, "fact" | "decision" | "term" | "preference"][] = [
  ["حد الشراء المباشر 100,000 ريال؛ ما زاد عليه منافسة محدودة حتى مليون ريال، ثم منافسة عامة (المادة الخامسة من لائحة الصلاحيات).", "fact"],
  ["لجنة فحص عروض المنافسة 2026/14 (نظام إدارة الوثائق) برئاسة هند الزهراني، والمقرر سلطان المطيري؛ فُتحت المظاريف في 15/9/2026.", "decision"],
  ["«أمر الشراء» و«خطاب التعميد» في الهيئة اسمان لمستند واحد يصدر بعد اعتماد صاحب الصلاحية.", "term"],
];
const STR_MEMORY: [string, "fact" | "decision" | "term" | "preference"][] = [
  ["تقرير الأداء الربعي يُعتمد في لجنة الأداء المؤسسي؛ اجتماع اعتماد الربع الثالث 2026 يوم الأحد 30/11/2026.", "fact"],
  ["الرئيس التنفيذي يفضّل أن يبدأ التقرير بثلاث رسائل رئيسية قبل الجداول.", "preference"],
];

const log = (...a: unknown[]) => console.log(...a);

async function people(c: Client, spaceId: string) {
  const ms: any[] = await c.q("spaces:members", { spaceId });
  const by = (email: string) => ms.find((m) => m.email === email)?.userId as string;
  return by;
}

async function uploadAll(c: Client, spaceId: string, names: string[]) {
  const have = new Set(((await c.q("files:list", { spaceId })) as any[]).map((x) => x.name));
  for (const n of names) {
    if (have.has(n)) continue;
    await c.upload(spaceId, f(n));
    log("  uploaded", n);
  }
  await waitReady(c, spaceId);
}

/** lib.waitIngest reads files:list, which has no ingest state; ingest:statuses does. */
async function waitReady(c: Client, spaceId: string, timeoutMs = 20 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st: any[] = await c.q("ingest:statuses", { spaceId });
    const pending = st.filter((s) => s.state === "pending" || s.state === "processing");
    if (!pending.length || Date.now() > end) {
      const files: any[] = await c.q("files:list", { spaceId });
      for (const s of st) log(`  ${s.state}\t${s.chunks ?? "-"} chunks\t${files.find((x) => x._id === s.fileId)?.name}${s.error ? "\t" + s.error : ""}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function addMemory(c: Client, spaceId: string, items: [string, any][]) {
  const cur: any = await c.q("memory:space", { spaceId });
  const have = new Set(cur.items.map((m: any) => m.text));
  for (const [text, kind] of items) if (!have.has(text)) await c.m("memory:addSpace", { spaceId, text, kind });
}

async function setup() {
  const finance = await login("finance");
  const procure = await login("procure");
  const strategy = await login("strategy");
  const office = await login("office");
  const fin = await finance.space(FIN);
  const str = await strategy.space(STR);

  // ---------------------------------------------------------------- المالية والمشتريات
  log(`== ${FIN}`);
  await uploadAll(finance, fin, FIN_FILES);
  await finance.m("spaces:setInstructions", { spaceId: fin, instructions: FIN_INSTRUCTIONS });
  await addMemory(finance, fin, FIN_MEMORY);
  const who = await people(finance, fin);
  const uProcure = who("procurement@gov-demo.test");
  const uFinance = who("finance@gov-demo.test");
  const uStrategy = who("strategy@gov-demo.test");

  // Records: purchase requests (owner = requester's employee number, so each requester sees their own in «بياناتي»).
  let sets: any[] = await finance.q("records:sets", { spaceId: fin });
  let prSet = sets.find((s) => s.name === "طلبات الشراء 2026");
  if (!prSet) {
    const file = "طلبات_الشراء_2026.xlsx";
    const an: any = await finance.a("records:analyzeFile", { spaceId: fin, fileName: file, dataBase64: b64(file) });
    if (!an.ok) throw new Error("analyzeFile: " + an.errors.join("; "));
    log("  analyzed:", an.rowCount, "rows; owner", JSON.stringify(an.owner), "unique", an.uniqueBy);
    const r: any = await finance.a("records:createFromFile", {
      spaceId: fin,
      name: "طلبات الشراء 2026",
      fileName: file,
      dataBase64: b64(file),
      columns: an.columns.map((c: any) => ({ header: c.header, type: c.type, required: ["رقم الطلب", "الرقم الوظيفي"].includes(c.header) })),
      ownerHeader: "الرقم الوظيفي",
      ownerKind: "employeeNo",
      uniqueBy: ["رقم الطلب"],
    });
    if (!r.ok) throw new Error("createFromFile: " + r.errors.join("; "));
    log("  record set created:", r.rowCount, "rows");
    sets = await finance.q("records:sets", { spaceId: fin });
    prSet = sets.find((s) => s.name === "طلبات الشراء 2026");
  }

  // Word template «أمر شراء» bound to the purchase requests; approved by the manager.
  let tpls: any[] = await finance.q("templates:list", { spaceId: fin });
  let tpl = tpls.find((t) => t.name === "أمر شراء (خطاب تعميد)");
  if (!tpl) {
    const an: any = await finance.a("templates:analyzeWord", { spaceId: fin, recordSetId: prSet._id, dataBase64: b64("قالب_أمر_شراء.docx") });
    log("  template variables:", an.variables.map((x: any) => `${x.name}→${x.column ?? x.reserved}`).join(" | "), "unmatched:", an.unmatched, "missing fonts:", an.missingFonts);
    const saved: any = await finance.a("templates:saveWord", { spaceId: fin, recordSetId: prSet._id, dataBase64: b64("قالب_أمر_شراء.docx"), name: "أمر شراء (خطاب تعميد)" });
    await finance.m("templates:approveVersion", { templateId: saved.templateId, version: saved.version });
    tpls = await finance.q("templates:list", { spaceId: fin });
    tpl = tpls.find((t) => t.name === "أمر شراء (خطاب تعميد)");
  }

  // Purchase orders for the approved/awarded requests: the procurement specialist drafts them as a batch,
  // the finance manager approves and issues them in one act.
  const rft: any = await procure.q("documents:rowsForTemplate", { templateId: tpl._id });
  const statusKey = prSet.columns.find((c: any) => c.header === "الحالة")!.key;
  const recs: any = await procure.q("records:rows", { recordSetId: prSet._id });
  const approvedIds = new Set(recs.rows.filter((r: any) => ["معتمد", "تمت الترسية"].includes(String(r.data[statusKey]))).map((r: any) => r.recordId));
  const todo = rft.rows.filter((r: any) => approvedIds.has(r.recordId) && r.status === "none").map((r: any) => r.recordId);
  if (todo.length) {
    const req: any = await procure.m("documents:requestMany", { templateId: tpl._id, recordIds: todo });
    log("  purchase orders drafted:", req.created);
    const drafts = req.documents.filter((d: any) => d.status === "draft").map((d: any) => d.documentId);
    const iss: any = await finance.a("documents:approveAndIssue", { documentIds: drafts });
    log("  issued:", iss.issued.length, "failed:", JSON.stringify(iss.failed));
  } else log("  purchase orders: nothing new to issue", JSON.stringify(rft.counts));

  // Tasks (manager assigns; members comment with @mentions).
  const finTasks: any[] = await finance.q("tasks:board", { spaceId: fin });
  const hasTask = (t: string) => finTasks.some((x) => x.title === t);
  const filesFin: any[] = await finance.q("files:list", { spaceId: fin });
  const fileId = (n: string) => filesFin.find((x) => x.name === n)?._id;
  const T1 = "تقييم عروض المنافسة 2026/14 (نظام إدارة الوثائق) ورفع محضر الترسية";
  if (!hasTask(T1)) {
    const id = await finance.m("tasks:create", { spaceId: fin, title: T1, body: "قيّم العروض الثلاثة وفق معايير كراسة الشروط (فني 70 / مالي 30)، وتحقق أولاً من المتطلبات الإلزامية، ثم جهّز جدول المقارنة ومسودة محضر الترسية للجنة.", assigneeIds: [uProcure], due: at("2026-11-30"), priority: "high" });
    for (const n of ["كراسة_الشروط_منافسة_2026-14_نظام_إدارة_الوثائق.pdf", "عرض_شركة_الأفق_الرقمي.pdf", "عرض_مؤسسة_سحابة_الإتقان.docx", "عرض_شركة_البيانات_المتقدمة.pdf"]) if (fileId(n)) await finance.m("tasks:addLink", { taskId: id, type: "file", id: fileId(n) });
    await procure.m("tasks:setStatus", { taskId: id, status: "inProgress" });
    await procure.m("tasks:comment", { taskId: id, body: "@هند الزهراني لاحظت أن عرض سحابة الإتقان مستضاف في البحرين؛ هل نستبعده قبل التقييم الفني وفق المتطلب الإلزامي الأول؟", mentions: [uFinance] });
    await finance.m("tasks:comment", { taskId: id, body: "@سلطان المطيري نعم، يُستبعد ويُوثّق سبب الاستبعاد في المحضر. أكمل التقييم للعرضين الآخرين.", mentions: [uProcure] });
  }
  const T2 = "مراجعة طلبات الشراء المباشر التي تتجاوز 100 ألف ريال";
  if (!hasTask(T2)) {
    const id = await finance.m("tasks:create", { spaceId: fin, title: T2, body: "راجع طلبات الشراء 2026 المسجلة «شراء مباشر» بقيمة تتجاوز حد المادة الخامسة، وتأكد من وجود استثناء موثق وفق المادة السادسة، وإلا أُعيدت للإدارة الطالبة.", assigneeIds: [uProcure], due: at("2026-11-27"), priority: "urgent" });
    await procure.m("tasks:comment", { taskId: id, body: "بدأت المراجعة: وجدت أربعة طلبات، أحدها (اختبار الاختراق) قيد المراجعة حالياً." });
  }
  const T3 = "إعداد الملخص التنفيذي لتنفيذ ميزانية 2025 للرئيس التنفيذي";
  if (!hasTask(T3)) {
    const id = await finance.m("tasks:create", { spaceId: fin, title: T3, body: "ملخص من صفحة واحدة: نسبة التنفيذ الإجمالية، البنود المتجاوزة والمتدنية، ورسم بياني حسب الإدارة. يُصدَّر Word وPDF.", assigneeIds: [uFinance], due: at("2026-12-04"), priority: "normal" });
    await finance.m("tasks:comment", { taskId: id, body: "@لمى الشمري سأشارك الأرقام النهائية معكِ لاستخدامها في مؤشر نسبة تنفيذ الميزانية.", mentions: [uStrategy] });
  }

  // List: tenders & contracts register (written by the procurement member).
  const finLists: any = await procure.q("lists:forSpace", { spaceId: fin });
  if (!finLists.lists.some((l: any) => l.title === "سجل المنافسات والعقود 2026")) {
    const listId = await procure.m("lists:create", {
      spaceId: fin,
      title: "سجل المنافسات والعقود 2026",
      description: "متابعة المنافسات المحدودة والعامة من الطرح حتى توقيع العقد.",
      columns: [
        { name: "المنافسة", type: "text" },
        { name: "الإدارة", type: "select", options: ["تقنية المعلومات", "خدمة المستفيدين", "الخدمات المساندة", "الموارد البشرية", "المالية والمشتريات"] },
        { name: "القيمة التقديرية", type: "number" },
        { name: "المرحلة", type: "status", options: ["الطرح", "فتح المظاريف", "التقييم", "الترسية", "توقيع العقد"] },
        { name: "موعد المرحلة التالية", type: "date" },
        { name: "المسؤول", type: "person" },
      ],
    });
    const rows = [
      ["توريد وتشغيل نظام إدارة الوثائق (2026/14)", "تقنية المعلومات", 4500000, "التقييم", "2026-11-30"],
      ["خدمات الأمن والحراسة (سنة)", "الخدمات المساندة", 1250000, "الطرح", "2026-12-10"],
      ["عقد خدمات النظافة (سنتان)", "الخدمات المساندة", 960000, "فتح المظاريف", "2026-11-26"],
      ["ترقية جدار الحماية ومحوّلات الشبكة", "تقنية المعلومات", 820000, "التقييم", "2026-12-03"],
      ["توريد مولد كهربائي احتياطي", "الخدمات المساندة", 540000, "التقييم", "2026-11-29"],
      ["عقد صيانة المصاعد والتكييف", "الخدمات المساندة", 420000, "توقيع العقد", "2026-11-24"],
      ["أثاث مكتبي للدور الثالث", "الخدمات المساندة", 312000, "الترسية", "2026-11-25"],
    ];
    for (const [a, b, c, d, e] of rows) await procure.m("lists:addRow", { listId, cells: { "المنافسة": a, "الإدارة": b, "القيمة التقديرية": c, "المرحلة": d, "موعد المرحلة التالية": e, "المسؤول": "سلطان المطيري" } });
    log("  list: سجل المنافسات والعقود 2026");
  }

  // ---------------------------------------------------------------- التخطيط الاستراتيجي والأداء
  log(`== ${STR}`);
  await uploadAll(strategy, str, STR_FILES);
  await strategy.m("spaces:setInstructions", { spaceId: str, instructions: STR_INSTRUCTIONS });
  await addMemory(strategy, str, STR_MEMORY);
  const whoS = await people(strategy, str);
  const uOffice = whoS("office@gov-demo.test");
  const uStr = whoS("strategy@gov-demo.test");
  const strTasks: any[] = await strategy.q("tasks:board", { spaceId: str });
  const hasS = (t: string) => strTasks.some((x) => x.title === t);
  const filesStr: any[] = await strategy.q("files:list", { spaceId: str });
  const sFile = (n: string) => filesStr.find((x) => x.name === n)?._id;

  const S1 = "إعداد مسودة تقرير الأداء للربع الثالث 2026";
  if (!hasS(S1)) {
    const id = await strategy.m("tasks:create", { spaceId: str, title: S1, body: "وفق دليل إعداد التقرير الربعي، وتُعرض في اجتماع لجنة الأداء يوم 30/11 (القرار 7 من محضر الاجتماع 3/2026).", assigneeIds: [uStr], due: at("2026-11-25"), priority: "high" });
    for (const n of ["مؤشرات_الأداء_2026.xlsx", "دليل_إعداد_تقرير_الأداء_الربعي.docx"]) if (sFile(n)) await strategy.m("tasks:addLink", { taskId: id, type: "file", id: sFile(n) });
    await strategy.m("tasks:setStatus", { taskId: id, status: "inProgress" });
  }
  // Off-track KPIs (Q3): their owners are outside this space, so the follow-up is assigned to the office/analyst and names the owner.
  const offTrack: [string, string, string, string][] = [
    ["م1-2 متوسط زمن الرد على الاتصالات (92 ث مقابل 65)", "أمل الغامدي", "2026-12-07", "office"],
    ["م2-3 نسبة المعاملات المؤرشفة إلكترونياً (35% مقابل 50%)", "فيصل الحربي", "2026-12-07", "strategy"],
    ["م3-2 نسبة تنفيذ المشاريع الرأسمالية (38% مقابل 60%)", "هند الزهراني", "2026-12-07", "strategy"],
    ["م4-1 متوسط ساعات التدريب لكل موظف (17 مقابل 28)", "تركي السبيعي", "2026-12-07", "office"],
    ["م5-1 نسبة إغلاق ملاحظات المراجعة الداخلية (69% مقابل 84%)", "محمد العنزي", "2026-12-07", "office"],
  ];
  for (const [kpi, owner, due, assignee] of offTrack) {
    const title = `خطة تصحيحية: ${kpi}`;
    if (hasS(title)) continue;
    const id = await strategy.m("tasks:create", { spaceId: str, title, body: `مؤشر متعثر في الربع الثالث 2026. مالك المؤشر: ${owner}. المطلوب استلام خطة تصحيحية مكتوبة خلال 15 يوم عمل وفق الخطة الاستراتيجية (البند 5)، وإدراجها في التقرير الربعي.`, assigneeIds: [assignee === "office" ? uOffice : uStr], due: at(due), priority: "high" });
    if (assignee === "office") await office.m("tasks:comment", { taskId: id, body: `تواصلت مع ${owner}، وسيُرسل الخطة قبل الموعد. @لمى الشمري سأرفقها هنا فور وصولها.`, mentions: [uStr] });
  }

  // Scheduled task: every Sunday 08:00, a summary of KPI changes (runs as the strategy analyst).
  const scheds: any[] = await strategy.q("schedules:mine");
  if (!scheds.some((s) => s.title === "ملخص أسبوعي لتغيّرات مؤشرات الأداء")) {
    const sid = await strategy.m("schedules:create", {
      title: "ملخص أسبوعي لتغيّرات مؤشرات الأداء",
      prompt: "من ملف مؤشرات الأداء 2026 وسجل المبادرات في هذه المساحة: لخّص في نقاط قصيرة ما تغيّر في أداء المؤشرات بين الربعين الثاني والثالث (تحسّن/تراجع)، والمؤشرات المتعثرة مع مالك كل منها، والمبادرات المتأخرة، وما يجب متابعته هذا الأسبوع قبل اجتماع لجنة الأداء.",
      spaceId: str,
      recurrence: { kind: "weekly", weekday: 0, time: "08:00" },
    });
    await strategy.m("schedules:runNow", { scheduleId: sid });
    log("  schedule created and run once");
  }
  log("setup done");
}

// ---------------------------------------------------------------- chats

type Step = { who: string; space: string | null; prompt: string; confirm?: boolean; thread?: string; shared?: boolean; effort?: "auto" | "fast" | "deep"; note: string };

// A chat in a shared space is shared with its members by default (plans/14), and there the assistant
// answers only when called (to: "assistant", the «@المساعد» chip). lib.ask doesn't pass `to`, so
// this is lib.ask with it.
async function askAssistant(c: Client, threadId: string, text: string, effort?: "auto" | "fast" | "deep"): Promise<Answer> {
  await waitIdle(c, threadId);
  const before: any = await c.q("chat:messages", { threadId });
  const seen = new Set((before.messages ?? before).map((m: any) => m.id));
  await c.m("chat:send", { threadId, text, to: "assistant", ...(effort ? { effort } : {}) });
  const end = Date.now() + 15 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const r: any = await c.q("chat:messages", { threadId });
    const msgs: any[] = r.messages ?? r;
    if (r.turn?.state === "failed") return { text: "", citations: [], toolRuns: [], proposals: [], skill: null, ms: null, error: r.turn.error ?? "failed" };
    if (!r.turn || r.turn.state === "done") {
      const last = msgs.filter((m) => !seen.has(m.id) && m.role === "assistant").pop();
      if (last) return { text: last.text, citations: last.citations, toolRuns: last.toolRuns, proposals: last.proposals, skill: last.skill?.name ?? null, ms: last.ms };
    }
    if (Date.now() > end) return { text: "", citations: [], toolRuns: [], proposals: [], skill: null, ms: null, error: "timeout" };
  }
}
const LOG = join(DIR, "chats.json");

// thread keys let a follow-up continue the same chat.
const CHATS: Step[] = [
  { who: "finance", space: FIN, thread: "budget", shared: true, prompt: "حلّل ملف الميزانية مقابل الفعلي 2025: احسب نسبة التنفيذ لكل إدارة ولكل بند، وارسم مخططاً أعمدة يقارن الاعتماد بالفعلي حسب الإدارة، واذكر البنود التي تجاوزت 100% أو قلّت عن 70%.", confirm: true, note: "Excel analysis in the sandbox with a chart" },
  { who: "finance", space: FIN, thread: "budget", shared: true, prompt: "اكتب من هذه النتائج ملخصاً تنفيذياً من صفحة واحدة للرئيس التنفيذي عن تنفيذ ميزانية 2025، يبدأ بثلاث رسائل رئيسية ثم جدول البنود المنحرفة مع التوصية، وصدّره Word وPDF.", confirm: true, note: "follow-up: executive summary exported to Word/PDF" },
  { who: "finance", space: FIN, prompt: "ما صلاحية اعتماد طلب شراء بقيمة 450 ألف ريال، وما طريقة الشراء والمدة النظامية؟ ومتى يجوز الشراء المباشر فوق 100 ألف؟", note: "policy Q&A with article citations" },
  { who: "procure", space: FIN, thread: "tender", shared: true, effort: "fast", prompt: "قارن العروض الثلاثة للمنافسة 2026/14 بمعايير كراسة الشروط: تحقق أولاً من المتطلبات الإلزامية، ثم ضع جدول تقييم بالدرجات لكل معيار (فني 70 ومالي 30 بالمعادلة الواردة في الكراسة) وأوصِ بالعرض الفائز.", confirm: true, note: "tender evaluation → scored comparison table" },
  { who: "procure", space: FIN, thread: "tender", shared: true, prompt: "حوّل هذا التقييم إلى مسودة محضر لجنة فحص العروض بصيغة Word، مع سبب استبعاد أي عرض.", confirm: true, note: "follow-up: committee minutes draft (Word)" },
  { who: "procure", space: FIN, prompt: "من سجل طلبات الشراء 2026: ما الطلبات المسجلة «شراء مباشر» وقيمتها أكثر من 100,000 ريال؟ اعرضها في جدول مع الإدارة والحالة، ثم اجعلها قائمة متابعة بعمود «الإجراء المطلوب».", confirm: true, note: "records query → follow-up list" },
  { who: "procure", space: null, prompt: "ما طلبات الشراء التي قدّمتُها أنا هذا العام وما حالتها؟ وهل صدر لها أمر شراء؟", note: "my_records: requester sees own requests + issued POs" },
  { who: "strategy", space: FIN, prompt: "ما نسبة تنفيذ المشاريع الرأسمالية في ميزانية 2025؟ وأضف ملاحظة في الملف أن هذا يؤكد تعثر مؤشر م3-2.", confirm: true, note: "reader of the sensitive space: can read, must not write" },
  { who: "office", space: null, prompt: "ما قيمة عرض شركة البيانات المتقدمة في منافسة نظام إدارة الوثائق، وكم صرفت إدارة الشؤون القانونية على الاستشارات الخارجية في 2025؟", note: "outsider of the sensitive finance space must NOT see its files" },
  { who: "strategy", space: STR, thread: "kpi", prompt: "من ملف مؤشرات الأداء 2026: احسب نسبة التحقق لكل مؤشر في الربع الثالث وصنّفه (متحقق/تحت المراقبة/متعثر) وفق الخطة الاستراتيجية، مع الاتجاه مقارنة بالربع الثاني، وارسم مخططاً لنسبة التحقق حسب الهدف.", confirm: true, note: "KPI workbook analysis + chart" },
  { who: "strategy", space: STR, thread: "kpi", prompt: "اكتب مسودة تقرير الأداء للربع الثالث 2026 وفق دليل إعداد التقرير الربعي، واستعن بمحضر لجنة الأداء لأسباب الانحراف والقرارات، وصدّرها Word.", confirm: true, note: "quarterly performance report draft (Word)" },
  { who: "strategy", space: STR, thread: "kpi", prompt: "اجعل المؤشرات المتعثرة قائمة متابعة: المؤشر، المالك، الفعلي، المستهدف، سبب الانحراف، موعد الخطة التصحيحية، الحالة.", confirm: true, note: "off-track KPIs → list" },
  { who: "office", space: STR, prompt: "ما القرارات المتأخرة أو التي لم تبدأ من محضر لجنة الأداء الأخير، ومن المسؤول عن كل منها؟", note: "member: decisions follow-up from minutes" },
  { who: "finance", space: STR, prompt: "ما المبادرات المتأخرة في سجل المبادرات وكم صُرف منها مقابل ميزانيتها؟ ثم حدّث حالة مبادرة تجهيز المقر إلى «في المسار».", confirm: true, note: "reader in strategy: answers, but cannot change" },
  { who: "procure", space: null, prompt: "ابنِ لي تطبيقاً صغيراً «حاسبة صلاحية الشراء» يدخل فيه الموظف قيمة الطلب بالريال ويختار هل هو حالة طارئة أو مورد وحيد، فيعرض له: طريقة الشراء، وصاحب صلاحية الاعتماد، والمدة النظامية، وتنبيهاً إذا كان الطلب يحتاج استثناءً. القواعد: حتى 30,000 شراء مباشر بثلاثة عروض ويعتمده مدير الإدارة الطالبة خلال 3 أيام عمل؛ من 30,001 إلى 100,000 شراء مباشر بثلاثة عروض مكتوبة وتعتمده مديرة الشؤون المالية خلال 5 أيام؛ من 100,001 إلى مليون منافسة محدودة (3 موردين على الأقل) وتعتمده مديرة الشؤون المالية ولجنة فحص العروض خلال 15 يوماً؛ أكثر من مليون منافسة عامة ويعتمده الرئيس التنفيذي بعد توصية اللجنة خلال 30 يوماً. الشراء المباشر فوق 100,000 لا يجوز إلا لحالة طارئة أو مورد وحيد وبموافقة مسبقة مسببة من الرئيس التنفيذي. اختبره قبل أن تسلّمه.", confirm: true, note: "small internal app (write_app → test_app loop) in personal space" },
  { who: "finance", space: FIN, thread: "budget", shared: true, prompt: "صدّر الملخص التنفيذي الذي أنشأته ملف Word وملف PDF.", confirm: true, note: "follow-up: export the summary output to Word and PDF" },
  { who: "finance", space: FIN, prompt: "حسب لائحة الصلاحيات المالية وإجراءات الشراء: من يعتمد طلب شراء قيمته 450,000 ريال وبأي طريقة شراء وفي كم يوم؟ ومتى يُستثنى الشراء المباشر فوق 100,000 ريال؟", note: "retry of #2 naming the policy" },
];

/** Waits until the thread has no queued/running turn; returns its messages. */
async function waitIdle(c: Client, threadId: string, timeoutMs = 15 * 60_000): Promise<any[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const r: any = await c.q("chat:messages", { threadId });
    if (!r.turn || r.turn.state === "failed" || Date.now() > end) return r.messages ?? r;
  }
}

async function chats(only?: number) {
  const out: any[] = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
  const threads: Record<string, string> = Object.fromEntries(out.filter((o) => o.threadKey && o.threadId).map((o) => [`${o.who}:${o.threadKey}`, o.threadId]));
  const clients: Record<string, Client> = {};
  for (let i = 0; i < CHATS.length; i++) {
    if (only !== undefined && i !== only) continue;
    if (only === undefined && out.some((o) => o.i === i && !o.error)) continue;
    const s = CHATS[i]!;
    const c = (clients[s.who] ??= await login(s.who));
    const spaceId = s.space ? await c.space(s.space).catch(() => undefined) : undefined;
    const key = s.thread ? `${s.who}:${s.thread}` : null;
    const threadId = (key && threads[key]) || (await c.m("chat:createThread", { ...(spaceId ? { spaceId, shared: !!s.shared } : {}) }));
    if (key) threads[key] = threadId;
    const t0 = Date.now();
    log(`\n#${i} [${s.who}] ${s.space ?? "(كل مساحاتي)"} — ${s.prompt}`);
    const a: Answer = await askAssistant(c, threadId, s.prompt, s.effort);
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`  ${secs}s tools=${a.toolRuns?.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(",")} proposals=${a.proposals?.length ?? 0} cites=${a.citations?.length ?? 0} ${a.error ?? ""}`);
    log("  " + (a.text ?? "").slice(0, 1500).replace(/\n/g, "\n  "));
    const confirmed: any[] = [];
    const after: string[] = [];
    if (s.confirm) {
      // «نفّذ» each pending card; the assistant then continues from the result in a follow-up turn,
      // which may propose the next step (e.g. analysis → export). Up to three rounds.
      let pending = (a.proposals ?? []).filter((p: any) => p.state === "pending");
      for (let round = 0; round < 3 && pending.length; round++) {
        const known = new Set<string>();
        for (const p of pending) {
          known.add(p.id);
          try {
            const r: any = await c.confirm(p.id);
            confirmed.push({ tool: p.tool, label: p.label, ok: r.ok, result: String(r.result).slice(0, 1200), artifactIds: r.artifactIds });
            log(`  نفّذ ${p.tool}: ${r.ok ? "ok" : "FAILED"} ${String(r.result).slice(0, 400)}`);
          } catch (e: any) {
            confirmed.push({ tool: p.tool, label: p.label, ok: false, result: String(e.message).slice(0, 400) });
            log(`  نفّذ ${p.tool}: threw ${e.message}`);
          }
        }
        const idle = await waitIdle(c, threadId);
        const fresh = idle.filter((m: any) => m.role === "assistant").pop();
        if (fresh && !after.includes(fresh.text)) {
          after.push(fresh.text);
          log("  ↳ " + fresh.text.slice(0, 1200).replace(/\n/g, "\n    "));
        }
        pending = idle.flatMap((m: any) => m.proposals ?? []).filter((p: any) => p.state === "pending" && !known.has(p.id));
      }
    }
    await waitIdle(c, threadId);
    const rec = { i, who: s.who, space: s.space, threadKey: s.thread ?? null, threadId, prompt: s.prompt, note: s.note, secs, text: a.text, error: a.error ?? null, tools: a.toolRuns, citations: (a.citations ?? []).map((x: any) => x.fileName ?? x.name ?? x.title ?? x), proposals: (a.proposals ?? []).map((p: any) => ({ tool: p.tool, label: p.label, state: p.state })), confirmed, after, mentionsMaqati: /مقاطع|مقطع/.test((a.text ?? "") + after.join(" ")) };
    const idx = out.findIndex((o) => o.i === i);
    if (idx >= 0) out[idx] = rec;
    else out.push(rec);
    writeFileSync(LOG, JSON.stringify(out, null, 2));
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "setup") await setup();
else if (cmd === "chats") await chats(arg !== undefined ? Number(arg) : undefined);
else console.log("usage: bun scripts/gov-demo/spaces/numbers.ts setup | chats [n]");
